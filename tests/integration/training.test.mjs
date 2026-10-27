import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
const owner = { subject: 'owner' };
const alice = { subject: 'alice' };
const outsider = { subject: 'outsider' };
const reject = (promise, code) => assert.rejects(promise, e => e.code === code);
async function fixture(t) {
    const mf = new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22',
        d1Databases: ['DB'],
        r2Buckets: ['BUCKET']
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('BUCKET');
    for(const file of ['0000_identity.sql', '0001_training.sql', '0002_upload_cleanup.sql', '0004_resumable_uploads.sql']) {
        const migration = await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8');
        for(const sql of migration.split(';').map(s => s.trim()).filter(Boolean))
            await db.prepare(sql).run();
    }
    const s = createService({ db, bucket, bootstrapSiteUserId: owner.subject });
    const boot = await s.bootstrap(owner, { discName: '领队', jerseyNumber: '01' }, 'boot');
    await s.join(alice, { discName: '木棉', jerseyNumber: '07', token: boot.inviteToken }, 'join');
    return { s, db, bucket };
}
const training = { title: '合成传盘训练', date: '2026-10-16', description: '合成训练记录', status: 'draft' };
async function published(s) {
    const x = await s.saveTraining(owner, null, training, 'training');
    return s.saveTraining(owner, x.id, { ...training, status: 'published', expectedVersion: x.version }, 'publish');
}
test(
    'training actual persistence, admin/member/draft boundary and immutable operation input',
    async (t) => {
        const { s } = await fixture(t);
        await reject(s.listTrainings(outsider), 'FORBIDDEN');
        await reject(s.saveTraining(alice, null, training, 'x'), 'FORBIDDEN');
        const d = await s.saveTraining(owner, null, training, 'create');
        assert.deepEqual(await s.listTrainings(alice), []);
        await reject(s.getTraining(alice, d.id), 'NOT_FOUND');
        assert.equal((await s.saveTraining(owner, null, training, 'create')).id, d.id);
        await reject(s.saveTraining(owner, null, { ...training, title: '换输入' }, 'create'), 'IDEMPOTENCY_CONFLICT');
        const p = await s.saveTraining(owner, d.id, { ...training, status: 'published', expectedVersion: 1 }, 'pub');
        assert.equal((await s.listTrainings(alice))[0].id, p.id);
        await reject(s.saveTraining(owner, d.id, { ...training, expectedVersion: 1 }, 'stale'), 'VERSION_CONFLICT');
        await reject(s.getTraining(alice, 'foreign'), 'NOT_FOUND');
    }
);

test(
    'Bilibili normalized multi videos ordered; archive stays readable but blocks writes',
    async (t) => {
        const { s } = await fixture(t);
        const tr = await published(s);
        const a = await s.addVideo(
            owner,
            tr.id,
            {
                title: '合成B站引用',
                source: 'bilibili',
                url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&junk=1',
                position: 2
            },
            'b1'
        );
        const b = await s.addVideo(owner, tr.id, { title: '另一个分P', source: 'bilibili', url: 'BV1xx411c7mD', position: 1 }, 'b2');
        const detail = await s.getTraining(alice, tr.id);
        assert.deepEqual(detail.videos.map(v => v.id), [b.id, a.id]);
        assert.equal(detail.videos[1].url, 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
        await reject(
            s.addVideo(
                owner,
                tr.id,
                {
                    title: '坏来源',
                    source: 'bilibili',
                    url: 'https://evil.test/video/BV1xx411c7mD',
                    position: 0
                },
                'evil'
            ),
            'INVALID_INPUT'
        );
        const comment = await s.saveComment(alice, a.id, null, { text: '归档前讨论', timestampSec: 13 }, 'before-archive');
        const reply = await s.saveComment(owner, a.id, null, { text: '归档前回复', rootId: comment.id }, 'reply-before-archive');
        await s.saveTraining(owner, tr.id, { ...training, status: 'archived', expectedVersion: tr.version }, 'archive');
        assert.equal((await s.getVideo(alice, a.id)).training.status, 'archived');
        for (const actor of [alice, owner]) {
            await reject(s.saveComment(actor, a.id, null, { text: 'blocked' }, 'c'), 'READ_ONLY');
            await reject(s.saveComment(actor, a.id, null, { text: 'blocked reply', rootId: comment.id }, 'reply'), 'READ_ONLY');
            const own = actor === alice ? comment : reply;
            await reject(s.saveComment(actor, a.id, own.id, { text: 'blocked edit', expectedVersion: 1 }, 'edit'), 'READ_ONLY');
            await reject(s.saveComment(actor, a.id, own.id, { action: 'delete', expectedVersion: 1 }, 'delete'), 'READ_ONLY');
        }
        assert.equal((await s.listComments(alice, a.id)).length, 2);
        await reject(s.addVideo(owner, tr.id, { title: 'blocked', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'v'), 'READ_ONLY');
    }
);

test(
    'comments enforce same-video root, one reply level, owner versions, hide/report and deleted root placeholder',
    async (t) => {
        const { s } = await fixture(t);
        const tr = await published(s);
        const v = await s.addVideo(owner, tr.id, { title: '视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'v');
        const v2 = await s.addVideo(owner, tr.id, { title: '视频2', source: 'bilibili', url: 'BV1xx411c7mD', position: 1 }, 'v2');
        const c = await s.saveComment(alice, v.id, null, { text: '原文', timestampSec: 32 }, 'c');
        const r = await s.saveComment(owner, v.id, null, { text: '回复', rootId: c.id }, 'r');
        await reject(s.saveComment(alice, v2.id, null, { text: '异视频', rootId: c.id }, 'bad'), 'INVALID_INPUT');
        await reject(s.saveComment(alice, v.id, null, { text: '二级', rootId: r.id }, 'bad2'), 'INVALID_INPUT');
        await reject(s.saveComment(owner, v.id, c.id, { text: '冒名', expectedVersion: 1 }, 'edit'), 'FORBIDDEN');
        await s.saveComment(alice, v.id, c.id, { text: '新文', expectedVersion: 1 }, 'edit');
        await reject(s.saveComment(alice, v.id, c.id, { text: '旧版本', expectedVersion: 1 }, 'stale'), 'VERSION_CONFLICT');
        await s.moderateComment(alice, r.id, { action: 'report', reason: '合成举报' }, 'report');
        await s.moderateComment(owner, r.id, { action: 'hide', reason: '合成治理' }, 'hide');
        assert.equal((await s.listComments(alice, v.id)).find(x => x.id === r.id).text, null);
        await s.moderateComment(owner, r.id, { action: 'restore', reason: '合成恢复' }, 'restore');
        await s.saveComment(alice, v.id, c.id, { action: 'delete', expectedVersion: 2 }, 'delete');
        const memberTime = await s.saveComment(alice, v.id, null, { text: '普通队员13秒', timestampSec: 13 }, 'member-13');
        const adminTime = await s.saveComment(owner, v.id, null, { text: '管理员13秒', timestampSec: 13 }, 'admin-13');
        for (const timestampSec of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await reject(s.saveComment(alice, v.id, null, { text: '无效时间', timestampSec }, 'invalid-' + timestampSec), 'INVALID_INPUT');
        let rows = await s.listComments(alice, v.id);
        assert.equal(rows.find(x => x.id === memberTime.id).timestampSec, 13);
        assert.equal(rows.find(x => x.id === adminTime.id).timestampSec, 13);
        await s.saveComment(alice, v.id, memberTime.id, { text: '修改时间', timestampSec: 8, expectedVersion: 1 }, 'member-edit-time');
        rows = await s.listComments(alice, v.id);
        assert.equal(rows.find(x => x.id === memberTime.id).timestampSec, 8);
        await s.saveComment(alice, v.id, memberTime.id, { text: '无时间', timestampSec: null, expectedVersion: 2 }, 'member-remove-time');
        rows = await s.listComments(alice, v.id);
        assert.equal(rows.find(x => x.id === memberTime.id).timestampSec, null);
        assert.equal(rows.find(x => x.id === c.id).text, null);
        assert.equal(rows.find(x => x.id === r.id).text, '回复');
        assert.equal(rows.find(x => x.id === r.id).authorJerseyNumber, '01');
        assert.equal(rows.find(x => x.id === r.id).replyTargetName, '木棉');
        assert.equal(rows.find(x => x.id === c.id).authorJerseyNumber, '07');
        assert.equal(Object.keys(rows[0]).some(key => /email|provider|subject/i.test(key)), false);
    }
);

test(
    'collection private note owner-only even admin; deleted source placeholder retains note and timestamp',
    async (t) => {
        const { s } = await fixture(t);
        const tr = await published(s);
        const v = await s.addVideo(owner, tr.id, { title: '视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'v');
        const c = await s.saveComment(alice, v.id, null, { text: '讨论源', timestampSec: 3 }, 'c');
        const item = await s.saveCollection(alice, null, { sourceKind: 'comment', sourceId: c.id, privateNote: '仅本人思考' }, 'save');
        assert.equal(
            (await s.saveCollection(alice, null, { sourceKind: 'comment', sourceId: c.id, privateNote: '仅本人思考' }, 'save')).id,
            item.id
        );
        assert.deepEqual(await s.listCollections(owner), []);
        assert.equal((await s.listCollections(alice))[0].source.href, '/videos/' + v.id + '?t=3#comment-' + c.id);
        await reject(s.saveCollection(owner, item.id, { privateNote: '管理员不可读改', expectedVersion: 1 }, 'bad'), 'NOT_FOUND');
        await s.saveComment(alice, v.id, c.id, { text: '当前讨论', timestampSec: 8, expectedVersion: 1 }, 'change-source-time');
        const retained = (await s.listCollections(alice))[0];
        assert.equal(retained.timestampSec, 3);
        assert.equal(retained.source.href, '/videos/' + v.id + '?t=3#comment-' + c.id);
        assert.equal(retained.source.text, '当前讨论');
        await s.saveComment(alice, v.id, c.id, { action: 'delete', expectedVersion: 2 }, 'delete');
        const lost = (await s.listCollections(alice))[0];
        assert.equal(lost.source, null);
        assert.equal(lost.privateNote, '仅本人思考');
        assert.equal(lost.timestampSec, 3);
        assert.ok(!JSON.stringify(lost).includes('讨论源'));
        assert.ok(!JSON.stringify(lost).includes('当前讨论'));
        await s.saveCollection(alice, item.id, { privateNote: '修改', expectedVersion: 1 }, 'note');
        assert.equal((await s.listCollections(alice))[0].privateNote, '修改');
        assert.equal((await s.listCollections(alice))[0].version, 2);
        await s.saveCollection(alice, item.id, { action: 'delete', expectedVersion: 2 }, 'drop');
        assert.deepEqual(await s.listCollections(alice), []);
    }
);

test('discussion reply collections remain unique per owner and explicit note edits persist on a fresh service read', async t => {
    const { s, db, bucket } = await fixture(t);
    const tr = await published(s);
    const video = await s.addVideo(owner, tr.id, { title: '讨论闭环视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
    const root = await s.saveComment(alice, video.id, null, { text: '根讨论', timestampSec: 13 }, 'root');
    const reply = await s.saveComment(owner, video.id, null, { text: '单层回复', rootId: root.id, timestampSec: 21 }, 'reply');
    const fresh = createService({ db, bucket });
    const comments = await fresh.listComments(alice, video.id);
    assert.equal(comments.find(x => x.id === reply.id).rootId, root.id);
    assert.equal(comments.find(x => x.id === reply.id).text, '单层回复');
    assert.equal(comments.find(x => x.id === reply.id).timestampSec, 21);
    assert.ok(Number.isFinite(Date.parse(comments.find(x => x.id === reply.id).createdAt)));
    const input = { sourceKind: 'comment', sourceId: reply.id, privateNote: '最初私人备注' };
    const saved = await s.saveCollection(alice, null, input, 'first');
    const duplicate = await s.saveCollection(alice, null, { ...input, privateNote: '重复提交的新备注' }, 'different-key');
    assert.equal(duplicate.id, saved.id);
    let own = await fresh.listCollections(alice);
    assert.equal(own.length, 1);
    assert.equal(own[0].privateNote, input.privateNote);
    assert.equal(own[0].version, 1);
    assert.equal(own[0].timestampSec, 21);
    assert.equal(own[0].source.href, `/videos/${video.id}?t=21#comment-${reply.id}`);
    assert.equal(own[0].source.text, '单层回复');
    const admin = await s.saveCollection(owner, null, { ...input, privateNote: '管理员自己的备注' }, 'admin-note');
    assert.notEqual(admin.id, saved.id);
    assert.equal((await fresh.listCollections(owner))[0].privateNote, '管理员自己的备注');
    await reject(s.saveCollection(owner, saved.id, { privateNote: '越权修改', expectedVersion: 1 }, 'denied-edit'), 'NOT_FOUND');
    await reject(s.saveCollection(owner, saved.id, { action: 'delete', expectedVersion: 1 }, 'denied-delete'), 'NOT_FOUND');
    const invite = await s.createInvite(owner, {}, 'third-member');
    await s.join(outsider, { token: invite.inviteToken, discName: '另一个合成成员', jerseyNumber: '09' }, 'join');
    assert.deepEqual(await fresh.listCollections(outsider), []);
    await reject(s.saveCollection(outsider, saved.id, { privateNote: '成员越权', expectedVersion: 1 }, 'denied-member'), 'NOT_FOUND');
    await s.saveCollection(alice, saved.id, { privateNote: '明确编辑后保存', expectedVersion: 1 }, 'explicit-edit');
    own = await fresh.listCollections(alice);
    assert.equal(own[0].privateNote, '明确编辑后保存');
    assert.equal(own[0].version, 2);
    await reject(s.saveCollection(alice, saved.id, { privateNote: '旧版本覆盖', expectedVersion: 1 }, 'stale-note'), 'VERSION_CONFLICT');
    await s.saveComment(owner, video.id, reply.id, { text: '作者修改后的回复', timestampSec: 25, expectedVersion: 1 }, 'reply-edit');
    own = await fresh.listCollections(alice);
    assert.equal(own[0].source.text, '作者修改后的回复');
    assert.equal(own[0].source.href, `/videos/${video.id}?t=21#comment-${reply.id}`);
    await s.saveComment(owner, video.id, reply.id, { action: 'delete', expectedVersion: 2 }, 'reply-delete');
    own = await fresh.listCollections(alice);
    assert.equal(own[0].source, null);
    assert.equal(own[0].privateNote, '明确编辑后保存');
    assert.equal(own[0].timestampSec, 21);
    assert.ok(!JSON.stringify(own).includes('作者修改后的回复'));
});

test('collections reject an unknown principal from another Site and never resolve foreign source or root IDs', async t => {
    const first = await fixture(t), second = await fixture(t);
    const localTraining = await published(first.s), foreignTraining = await published(second.s);
    const videoInput = { title: '合成隔离视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 };
    const localVideo = await first.s.addVideo(owner, localTraining.id, videoInput, 'video');
    const foreignVideo = await second.s.addVideo(owner, foreignTraining.id, videoInput, 'video');
    const invite = await second.s.createInvite(owner, {}, 'foreign-member');
    await second.s.join(outsider, { token: invite.inviteToken, discName: '仅另一站成员', jerseyNumber: '09' }, 'join');
    assert.equal((await first.s.me(outsider)).user, null);
    assert.equal((await second.s.me(outsider)).membership.status, 'active');
    const foreignRoot = await second.s.saveComment(outsider, foreignVideo.id, null, { text: '另一站根讨论', timestampSec: 8 }, 'root');
    const localSaved = await first.s.saveCollection(alice, null, { sourceKind: 'video', sourceId: localVideo.id, privateNote: '本站本人的私人备注' }, 'local-note');
    const foreignSaved = await second.s.saveCollection(outsider, null, { sourceKind: 'comment', sourceId: foreignRoot.id, privateNote: '另一站本人的私人备注' }, 'foreign-note');
    await reject(first.s.listCollections(outsider), 'FORBIDDEN');
    for (const sourceId of [localVideo.id, foreignVideo.id])
        await reject(first.s.saveCollection(outsider, null, { sourceKind: 'video', sourceId, privateNote: '外站尝试' }, 'foreign-create-' + sourceId), 'FORBIDDEN');
    await reject(first.s.saveCollection(outsider, localSaved.id, { privateNote: '外站尝试修改', expectedVersion: 1 }, 'foreign-patch'), 'FORBIDDEN');
    await reject(first.s.saveCollection(outsider, localSaved.id, { action: 'delete', expectedVersion: 1 }, 'foreign-delete'), 'FORBIDDEN');
    for (const [sourceKind, sourceId] of [['video', foreignVideo.id], ['comment', foreignRoot.id]])
        await reject(first.s.saveCollection(alice, null, { sourceKind, sourceId, privateNote: '本站不能解析外站来源' }, 'foreign-source-' + sourceKind), 'NOT_FOUND');
    await reject(first.s.saveCollection(alice, foreignSaved.id, { privateNote: '本站不能修改外站收藏', expectedVersion: 1 }, 'foreign-collection'), 'NOT_FOUND');
    await reject(first.s.saveComment(alice, localVideo.id, null, { text: '外站根不可回复', rootId: foreignRoot.id }, 'foreign-root'), 'INVALID_INPUT');
    await reject(first.s.listComments(alice, foreignVideo.id), 'NOT_FOUND');
    const local = await first.s.listCollections(alice), foreign = await second.s.listCollections(outsider);
    assert.equal(local.length, 1);assert.equal(local[0].id, localSaved.id);assert.equal(local[0].privateNote, '本站本人的私人备注');
    assert.equal(foreign.length, 1);assert.equal(foreign[0].id, foreignSaved.id);assert.equal(foreign[0].privateNote, '另一站本人的私人备注');
    assert.deepEqual(await first.s.listComments(alice, localVideo.id), []);
});

test(
    'real isolated R2 upload validates actual bytes, pending isolation, admin limits and authenticated Range',
    async (t) => {
        const { s, db, bucket } = await fixture(t);
        const tr = await published(s);
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        await reject(s.createUpload(alice, { bytes: bytes.length }, 'no'), 'FORBIDDEN');
        await reject(s.createUpload(owner, { bytes: 100 * 1024 * 1024 + 1 }, 'size'), 'UPLOAD_LIMIT');
        const upload = await s.createUpload(owner, { bytes: bytes.length }, 'up');
        await reject(s.getMedia(alice, upload.id, null), 'NOT_FOUND');
        await s.putUpload(owner, upload.id, new Request('https://kapok.test', { method: 'PUT', body: bytes }).body, 'content');
        const ready = await s.completeUpload(owner, upload.id, 'complete');
        assert.equal(ready.mime, 'video/mp4');
        assert.equal(ready.durationSec, 3);
        const v = await s.addVideo(owner, tr.id, { title: '合成上传', source: 'upload', uploadId: upload.id, position: 0 }, 'video');
        const response = await s.getMedia(alice, v.id, 'bytes=0-31');
        assert.equal(response.status, 206);
        assert.equal((await response.arrayBuffer()).byteLength, 32);
        assert.equal(response.headers.get('Content-Range'), `bytes 0-31/${bytes.length}`);
        const http = await dispatchApi(
            new Request(`https://kapok.test/api/v1/videos/${v.id}/media`, { headers: { Range: 'bytes=1-8' } }),
            ['videos', v.id, 'media'],
            alice,
            s
        );
        assert.equal(http.status, 206);
        assert.equal((await http.arrayBuffer()).byteLength, 8);
        assert.match(http.headers.get('Cache-Control'), /no-store/);
        assert.equal(
            (await dispatchApi(new Request(`https://kapok.test/api/v1/videos/${v.id}/media`), ['videos', v.id, 'media'], null, s)).status,
            401
        );
        assert.equal((await s.getMedia(alice, v.id, 'bytes=-8')).status, 206);
        assert.equal((await s.getMedia(alice, v.id, 'bytes=999999-')).status, 416);
        await db.prepare("UPDATE memberships SET status='left' WHERE user_id=?").bind((await s.me(alice)).user.id).run();
        await reject(s.getMedia(alice, v.id, 'bytes=0-31'), 'FORBIDDEN');
        assert.ok((await bucket.list()).objects.length > 0);
    }
);

test(
    'invalid actual container rejected; byte mismatch and team quota',
    async (t) => {
        const { s, db } = await fixture(t);
        const u = await s.createUpload(owner, { bytes: 16 }, 'bad');
        await s.putUpload(owner, u.id, new Request('https://k.test', { method: 'PUT', body: new Uint8Array(16) }).body, 'put');
        await reject(s.completeUpload(owner, u.id, 'done'), 'UNSUPPORTED_MEDIA');
        const x = await s.createUpload(owner, { bytes: 10 }, 'mismatch');
        await reject(
            s.putUpload(owner, x.id, new Request('https://k.test', { method: 'PUT', body: new Uint8Array(11) }).body, 'put2'),
            'UPLOAD_LIMIT'
        );
        await db.prepare("UPDATE uploads SET bytes=1073741824,status='ready' WHERE id=?").bind(u.id).run();
        await reject(s.createUpload(owner, { bytes: 1 }, 'quota'), 'UPLOAD_LIMIT');
    }
);

test(
    'HTTP raw upload retains identity Origin actor preconditions and files no-store',
    async (t) => {
        const { s } = await fixture(t);
        const req = new Request('https://kapok.test/api/v1/trainings', {
            method: 'POST',
            headers: {
                Origin: 'https://kapok.test',
                'Content-Type': 'application/json',
                'X-Kapok-Actor': owner.subject,
                'Idempotency-Key': 'http'
            },
            body: JSON.stringify(training)
        });
        const response = await dispatchApi(req, ['trainings'], owner, s);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Cache-Control'), /no-store/);
        const bad = new Request('https://kapok.test/api/v1/uploads/id/content', {
            method: 'PUT',
            headers: { Origin: 'https://evil.test', 'X-Kapok-Actor': owner.subject, 'Idempotency-Key': 'put' },
            body: new Uint8Array(1)
        });
        assert.equal((await dispatchApi(bad, ['uploads', 'id', 'content'], owner, s)).status, 403);
    }
);

test(
    'media rejects altered actual codecs, duration, sample tables, and invalid stream replay',
    async (t) => {
        const { s, bucket } = await fixture(t);
        const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        async function attempt(bytes, key, code) {
            const upload = await s.createUpload(owner, { bytes: bytes.length }, key);
            await s.putUpload(owner, upload.id, new Request('https://kapok.test', { method: 'PUT', body: bytes }).body, key + '-content');
            await reject(s.completeUpload(owner, upload.id, key + '-complete'), code);
            assert.equal((await bucket.list()).objects.length, 0);
        }
        const codec = Buffer.from(original);
        codec.write('hvc1', codec.indexOf('avc1'), 'ascii');
        await attempt(codec, 'codec', 'UNSUPPORTED_CODEC');
        const duration = Buffer.from(original);
        duration.writeUInt32BE(601000, duration.indexOf('mvhd') + 20);
        await attempt(duration, 'duration', 'UPLOAD_LIMIT');
        const samples = Buffer.from(original);
        samples.writeUInt32BE(1, samples.indexOf('stts') + 12);
        await attempt(samples, 'samples', 'UNSUPPORTED_MEDIA');
        const invalidOffset = Buffer.from(original);
        invalidOffset.writeUInt32BE(1, invalidOffset.indexOf('stco') + 12);
        await attempt(invalidOffset, 'offset', 'UNSUPPORTED_MEDIA');
        const truncated = original.subarray(0, original.length - 10);
        await attempt(truncated, 'truncated', 'UNSUPPORTED_MEDIA');
        const upload = await s.createUpload(owner, { bytes: original.length }, 'replay');
        const stream = bytes => new Request('https://kapok.test', { method: 'PUT', body: bytes }).body;
        await s.putUpload(owner, upload.id, stream(original), 'content');
        await s.putUpload(owner, upload.id, stream(original), 'content');
        const changed = Buffer.from(original);
        changed[100] ^= 1;
        await reject(s.putUpload(owner, upload.id, stream(changed), 'content'), 'IDEMPOTENCY_CONFLICT');
        await reject(s.putUpload(owner, upload.id, stream(original), 'different-key'), 'IDEMPOTENCY_CONFLICT');
    }
);

test(
    'versioned video metadata, delete retry and private-note delete replay do not resurrect content',
    async (t) => {
        const { s } = await fixture(t);
        const tr = await published(s);
        const v = await s.addVideo(owner, tr.id, { title: '旧视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
        const item = await s.saveCollection(alice, null, { sourceKind: 'video', sourceId: v.id, privateNote: '保留备注', timestampSec: 42 }, 'save');
        await s.updateVideo(owner, v.id, { title: '改名视频', position: 2, status: 'active', expectedVersion: 1 }, 'edit');
        assert.equal((await s.listCollections(alice))[0].source.title, '改名视频');
        await reject(
            s.updateVideo(owner, v.id, { title: '冲突', position: 0, status: 'active', expectedVersion: 1 }, 'stale'),
            'VERSION_CONFLICT'
        );
        await s.updateVideo(owner, v.id, { title: '改名视频', position: 2, status: 'hidden', expectedVersion: 2 }, 'hide-video');
        assert.equal((await s.listCollections(alice))[0].source, null);
        assert.equal((await s.getTraining(owner, tr.id)).videos[0].status, 'hidden');
        assert.deepEqual((await s.getTraining(alice, tr.id)).videos, []);
        await s.updateVideo(owner, v.id, { title: '改名视频', position: 2, status: 'active', expectedVersion: 3 }, 'restore-video');
        const deletion = { title: '改名视频', position: 2, status: 'deleted', expectedVersion: 4 };
        await s.updateVideo(owner, v.id, deletion, 'delete');
        await s.updateVideo(owner, v.id, deletion, 'delete');
        const lost = (await s.listCollections(alice))[0];
        assert.equal(lost.source, null);
        assert.equal(lost.timestampSec, 42);
        assert.equal(lost.privateNote, '保留备注');
        await s.saveCollection(alice, item.id, { action: 'delete', expectedVersion: 1 }, 'delete-note');
        await s.saveCollection(alice, item.id, { action: 'delete', expectedVersion: 1 }, 'delete-note');
        await reject(s.saveCollection(alice, item.id, { action: 'delete', expectedVersion: 2 }, 'delete-note'), 'IDEMPOTENCY_CONFLICT');
        assert.deepEqual(await s.listCollections(alice), []);
    }
);

test(
    'write guards roll back suppressed comment insert and late member epoch change',
    async (t) => {
        const { s, db } = await fixture(t);
        const tr = await published(s);
        const v = await s.addVideo(owner, tr.id, { title: '视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
        await db.exec('CREATE TRIGGER suppress_comment BEFORE INSERT ON video_comments BEGIN SELECT RAISE(IGNORE); END');
        await reject(s.saveComment(alice, v.id, null, { text: '不可假成功' }, 'suppressed'), 'VERSION_CONFLICT');
        assert.equal((await s.listComments(alice, v.id)).length, 0);
        await db.exec('DROP TRIGGER suppress_comment');
        const actor = (await s.me(alice)).user.id;
        await db.exec(`CREATE TRIGGER late_epoch AFTER INSERT ON video_comments BEGIN UPDATE memberships SET epoch=epoch+1 WHERE user_id='${actor}'; END`);
        await reject(s.saveComment(alice, v.id, null, { text: '旧epoch不得提交' }, 'late-epoch'), 'VERSION_CONFLICT');
        assert.equal((await s.me(alice)).membership.epoch, 1);
        await db.exec('DROP TRIGGER late_epoch');
        await db.exec(`CREATE TRIGGER late_withdraw AFTER INSERT ON operations WHEN NEW.kind='comment' BEGIN UPDATE trainings SET status='draft' WHERE id='${tr.id}'; END`);
        await reject(s.saveComment(alice, v.id, null, { text: '撤回后不得提交' }, 'late-withdraw'), 'VERSION_CONFLICT');
        assert.equal((await s.getTraining(alice, tr.id)).status, 'published');
        await db.exec('DROP TRIGGER late_withdraw');
        await s.saveComment(alice, v.id, null, { text: '重试成功' }, 'suppressed');
        assert.equal((await s.listComments(alice, v.id)).length, 1);
    }
);

test(
    'source training withdrawal blocks media and collections, membership loss retains only own private note',
    async (t) => {
        const { s, db } = await fixture(t);
        const tr = await published(s);
        const v = await s.addVideo(owner, tr.id, { title: '视频源', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
        await s.saveCollection(alice, null, { sourceKind: 'video', sourceId: v.id, privateNote: '本人私密' }, 'save');
        await s.saveTraining(owner, tr.id, { ...training, status: 'draft', expectedVersion: tr.version }, 'withdraw');
        assert.equal((await s.listCollections(alice))[0].source, null);
        await reject(s.getVideo(alice, v.id), 'NOT_FOUND');
        await s.saveTraining(owner, tr.id, { ...training, status: 'published', expectedVersion: tr.version + 1 }, 'publish-again');
        const user = (await s.me(alice)).user.id;
        await db.prepare("UPDATE memberships SET status='left',epoch=epoch+1 WHERE user_id=?").bind(user).run();
        const item = (await s.listCollections(alice))[0];
        assert.equal(item.source, null);
        assert.equal(item.privateNote, '本人私密');
        assert.deepEqual(await s.listCollections(owner), []);
        await reject(s.saveComment(alice, v.id, null, { text: '离队越权' }, 'comment'), 'FORBIDDEN');
    }
);

test(
    'uploads cannot consume another admin owner object; cancelled reservations release quota',
    async (t) => {
        const { s, db, bucket } = await fixture(t);
        await db.prepare("UPDATE memberships SET role='admin' WHERE user_id=?").bind((await s.me(alice)).user.id).run();
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const upload = await s.createUpload(alice, { bytes: bytes.length }, 'alice-upload');
        await reject(
            s.putUpload(owner, upload.id, new Request('https://kapok.test', { method: 'PUT', body: bytes }).body, 'foreign'),
            'NOT_FOUND'
        );
        assert.deepEqual((await s.listUploads(owner)).items, []);
        assert.equal((await s.listUploads(alice)).items.length, 1);
        await s.putUpload(alice, upload.id, new Request('https://kapok.test', { method: 'PUT', body: bytes }).body, 'content');
        await s.completeUpload(alice, upload.id, 'ready');
        const tr = await published(s);
        await reject(
            s.addVideo(owner, tr.id, { title: '冒用文件', source: 'upload', uploadId: upload.id, position: 0 }, 'foreign-file'),
            'VERSION_CONFLICT'
        );
        await s.cancelUpload(alice, upload.id, 'cancel');
        await s.cancelUpload(alice, upload.id, 'cancel');
        assert.deepEqual((await s.listUploads(alice)).items, []);
        assert.equal((await bucket.list()).objects.length, 0);
        for(let i = 0;i < 16;i++)
            await s.createUpload(owner, { bytes: 64 * 1024 * 1024 }, 'reserve-' + i);
        await reject(s.createUpload(owner, { bytes: 1 }, 'full'), 'UPLOAD_LIMIT');
        const pending = (await s.listUploads(owner)).items[0];
        await s.cancelUpload(owner, pending.id, 'release');
        assert.ok((await s.createUpload(owner, { bytes: 1 }, 'after-release')).id);
    }
);

test(
    'PRD G container identification does not pretend to decode SPS PPS or slice payloads',
    async (t) => {
        const { s } = await fixture(t);
        const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const config = original.indexOf('avcC') + 4;
        const spsStart = config + 8;
        const spsEnd = spsStart + original.readUInt16BE(config + 6);
        const ppsStart = spsEnd + 3;
        const ppsEnd = ppsStart + original.readUInt16BE(spsEnd + 1);
        const damaged = [
            ['sps', spsStart + 1, spsEnd],
            ['pps', ppsStart + 1, ppsEnd],
            ['sps-trailing', spsEnd - 1, spsEnd],
            ['pps-trailing', ppsEnd - 1, ppsEnd],
        ];
        let at = original.readUInt32BE(original.indexOf('stco') + 12);
        const sampleEnd = at + original.readUInt32BE(original.indexOf('stsz') + 16);
        while(at < sampleEnd) {
            const length = original.readUInt32BE(at);
            at += 4;
            if([1, 5].includes(original[at] & 31)) {
                damaged.push(['slice-header', at + 1, Math.min(at + 5, at + length)]);
                break;
            }
            at += length;
        }
        assert.ok(damaged.some(([name]) => name === 'slice-header'));
        for(const [name, start, end] of damaged) {
            const bytes = Buffer.from(original);
            bytes.fill(0, start, end);
            const upload = await s.createUpload(owner, { bytes: bytes.length }, 'fix1-' + name);
            await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body: bytes }).body, 'content');
            assert.equal((await s.completeUpload(owner, upload.id, 'complete')).mime, 'video/mp4');
        }
    }
);

test(
    'fix1 ready and cancelled zero-effect updates roll back operations and same keys recover',
    async (t) => {
        const { s, db } = await fixture(t);
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const upload = await s.createUpload(owner, { bytes: bytes.length }, 'fix-ready');
        await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body: bytes }).body, 'content');
        await db.exec("CREATE TRIGGER suppress_ready BEFORE UPDATE OF status ON uploads WHEN NEW.status='ready' BEGIN SELECT RAISE(IGNORE); END");
        await reject(s.completeUpload(owner, upload.id, 'complete'), 'VERSION_CONFLICT');
        assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(upload.id).first()).status, 'received');
        assert.equal(
            (await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-complete' AND target_id=?").bind(upload.id).first()).n,
            0
        );
        await db.exec('DROP TRIGGER suppress_ready');
        await s.completeUpload(owner, upload.id, 'complete');
        await db.exec("CREATE TRIGGER suppress_cancel BEFORE UPDATE OF status ON uploads WHEN NEW.status='cancelled' BEGIN SELECT RAISE(IGNORE); END");
        await reject(s.cancelUpload(owner, upload.id, 'cancel'), 'VERSION_CONFLICT');
        assert.notEqual((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(upload.id).first()).status, 'cancelled');
        assert.equal(
            (await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-cancel' AND target_id=?").bind(upload.id).first()).n,
            0
        );
        await db.exec('DROP TRIGGER suppress_cancel');
        await s.cancelUpload(owner, upload.id, 'cancel');
        assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(upload.id).first()).status, 'cancelled');
        const invalid = await s.createUpload(owner, { bytes: 16 }, 'suppressed-reject');
        await s.putUpload(owner, invalid.id, new Request('https://k.test', { method: 'PUT', body: new Uint8Array(16) }).body, 'content');
        await db.exec("CREATE TRIGGER suppress_reject BEFORE UPDATE OF status ON uploads WHEN NEW.status='rejected' BEGIN SELECT RAISE(IGNORE); END");
        await reject(s.completeUpload(owner, invalid.id, 'reject-complete'), 'VERSION_CONFLICT');
        assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(invalid.id).first()).status, 'received');
        assert.equal(
            (await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-reject' AND target_id=?").bind(invalid.id).first()).n,
            0
        );
        await db.exec('DROP TRIGGER suppress_reject');
        await reject(s.completeUpload(owner, invalid.id, 'reject-complete'), 'UNSUPPORTED_MEDIA');
        assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(invalid.id).first()).status, 'rejected');
    }
);

test(
    'fix1 failed R2 cleanup stays visible counted and retryable for cancel and reject',
    async (t) => {
        const { s, db, bucket } = await fixture(t);
        let failDelete = true;
        const faulty = new Proxy(bucket, {
            get(target, key) {
                if(key === 'delete')
                    return async (...args) => {
                        if(failDelete === 'ignore') return;
                        if(failDelete)
                            throw new Error('synthetic R2 delete failure');
                        return target.delete(...args);
                    };
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const service = createService({ db, bucket: faulty });
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        for(const mode of ['cancel', 'reject']) {
            failDelete = true;
            const body = mode === 'cancel' ? bytes : new Uint8Array(16);
            const upload = await s.createUpload(owner, { bytes: body.length }, 'cleanup-' + mode);
            await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body }).body, 'content');
            if(mode === 'cancel')
                await assert.rejects(service.cancelUpload(owner, upload.id, 'cleanup'));
            else
                await assert.rejects(service.completeUpload(owner, upload.id, 'invalid'));
            const row = await db.prepare('SELECT status,bytes,cleanup_state FROM uploads WHERE id=?').bind(upload.id).first();
            assert.ok(!['cancelled', 'rejected'].includes(row.status));
            assert.equal(row.cleanup_state, 'pending');
            assert.ok((await service.listUploads(owner)).items.some(item => item.id === upload.id));
            assert.equal((await bucket.list()).objects.length, 1);
            failDelete = 'ignore';
            if(mode === 'cancel') await reject(service.cancelUpload(owner, upload.id, 'cleanup'), 'CLEANUP_PENDING');
            else await reject(service.completeUpload(owner, upload.id, 'invalid'), 'CLEANUP_PENDING');
            assert.equal((await bucket.list()).objects.length, 1);
            await db.prepare('UPDATE uploads SET bytes=1073741824 WHERE id=?').bind(upload.id).run();
            await reject(service.createUpload(owner, { bytes: 1 }, 'blocked-' + mode), 'UPLOAD_LIMIT');
            failDelete = false;
            if(mode === 'reject')
                await reject(service.completeUpload(owner, upload.id, 'invalid'), 'UNSUPPORTED_MEDIA');
            await service.cancelUpload(owner, upload.id, 'cleanup');
            await service.cancelUpload(owner, upload.id, 'cleanup');
            assert.equal((await bucket.list()).objects.length, 0);
        }
    }
);

test(
    'fix1 admin collections use published source policy for video and comment',
    async (t) => {
        const { s } = await fixture(t);
        const tr = await published(s);
        const video = await s.addVideo(owner, tr.id, { title: '已发布源', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'admin-video');
        const comment = await s.saveComment(owner, video.id, null, { text: '源正文', timestampSec: 2 }, 'admin-comment');
        await s.saveCollection(owner, null, { sourceKind: 'video', sourceId: video.id, timestampSec: 1, privateNote: '视频备注' }, 'video-note');
        await s.saveCollection(owner, null, { sourceKind: 'comment', sourceId: comment.id, privateNote: '评论备注' }, 'comment-note');
        for(const [index, status] of ['draft', 'hidden', 'archived'].entries()) {
            await s.saveTraining(owner, tr.id, { ...training, status, expectedVersion: tr.version + index }, 'admin-status-' + status);
            const items = await s.listCollections(owner);
            assert.equal(items.length, 2);
            for(const item of items) {
                assert.equal(item.source === null, status !== 'archived');
                assert.ok(item.privateNote.endsWith('备注'));
                assert.ok(item.timestampSec >= 1);
            }
            assert.equal((await s.getTraining(owner, tr.id)).status, status);
        }
        await s.saveTraining(owner, tr.id, { ...training, status: 'published', expectedVersion: tr.version + 3 }, 'admin-reopen');
        await s.updateVideo(
            owner,
            video.id,
            { title: video.title, position: 0, status: 'hidden', expectedVersion: video.version },
            'admin-hide-video'
        );
        for(const item of await s.listCollections(owner)) {
            assert.equal(item.source, null);
            assert.ok(item.privateNote.endsWith('备注'));
            assert.ok(item.timestampSec >= 1);
        }
        assert.equal((await s.getTraining(owner, tr.id)).videos[0].status, 'hidden');
    }
);

test(
    'fix1 cancellation holds quota through an active receiver and removes its late object',
    async (t) => {
        // Arrange a real R2 receiver whose source is paused after its reservation is claimed.
        const { s, db, bucket } = await fixture(t);
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const upload = await s.createUpload(owner, { bytes: bytes.length }, 'active-receiver');
        let release;
        let started;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const claimed = new Promise(resolve => {
            started = resolve;
        });
        const delayedBucket = new Proxy(bucket, {
            get(target, key) {
                if(key === 'createMultipartUpload')
                    return async (...args) => {
                        const result = await target.createMultipartUpload(...args);
                        started();
                        return result;
                    };
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const service = createService({ db, bucket: delayedBucket });
        const source = new ReadableStream({
            async start(controller) {
                await gate;
                controller.enqueue(bytes);
                controller.close();
            },
        });
        const receiving = service.putUpload(owner, upload.id, source, 'content');
        const settled = receiving.then(() => null, error => error);
        await claimed;
        // Cancel cannot declare success or release quota while any writer can still finish.
        await reject(service.cancelUpload(owner, upload.id, 'cancel-active'), 'CLEANUP_PENDING');
        const pending = await db.prepare('SELECT status,cleanup_state,transfer_active FROM uploads WHERE id=?').bind(upload.id).first();
        assert.equal(pending.status, 'receiving');
        assert.equal(pending.cleanup_state, 'pending');
        assert.equal(pending.transfer_active, 1);
        assert.ok((await service.listUploads(owner)).items.some(item => item.id === upload.id));
        await db.prepare('UPDATE uploads SET bytes=1073741824 WHERE id=?').bind(upload.id).run();
        await reject(service.createUpload(owner, { bytes: 1 }, 'still-held'), 'UPLOAD_LIMIT');
        await db.prepare('UPDATE uploads SET bytes=? WHERE id=?').bind(bytes.length, upload.id).run();
        // The late multipart completion is cleaned before its state can become received/ready.
        release();
        assert.equal((await settled).code, 'UPLOAD_BUSY');
        await service.cancelUpload(owner, upload.id, 'cancel-active');
        assert.equal((await bucket.list()).objects.length, 0);
        const finished = await db.prepare('SELECT status,cleanup_state,transfer_active FROM uploads WHERE id=?').bind(upload.id).first();
        assert.equal(finished.status, 'cancelled');
        assert.equal(finished.cleanup_state, 'deleted');
        assert.equal(finished.transfer_active, 0);
    }
);

test(
    'fix1 late validation cannot mark ready after cancellation has confirmed deletion',
    async (t) => {
        const { s, db, bucket } = await fixture(t);
        const bytes = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const upload = await s.createUpload(owner, { bytes: bytes.length }, 'late-validation');
        await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body: bytes }).body, 'content');
        let release;
        let started;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const reading = new Promise(resolve => {
            started = resolve;
        });
        const delayedBucket = new Proxy(bucket, {
            get(target, key) {
                if(key === 'get')
                    return async (...args) => {
                        const object = await target.get(...args);
                        if (!object) return null;
                        const buffer = await object.arrayBuffer();
                        return {
                            size: object.size,
                            async arrayBuffer() {
                                started();
                                await gate;
                                return buffer;
                            },
                        };
                    };
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const service = createService({ db, bucket: delayedBucket });
        const completing = service.completeUpload(owner, upload.id, 'complete');
        const settled = completing.then(() => null, error => error);
        await reading;
        await s.cancelUpload(owner, upload.id, 'cancel');
        release();
        assert.equal((await settled).code, 'VERSION_CONFLICT');
        assert.equal((await bucket.list()).objects.length, 0);
        const row = await db.prepare('SELECT status,cleanup_state FROM uploads WHERE id=?').bind(upload.id).first();
        assert.equal(row.status, 'cancelled');
        assert.equal(row.cleanup_state, 'deleted');
        assert.equal(
            (await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-complete' AND target_id=?").bind(upload.id).first()).n,
            0
        );
    }
);

test(
    'fix1 failed partial transfer cleanup can be cancelled without losing reservation accounting',
    async t => {
        const { s, db, bucket } = await fixture(t);
        const upload = await s.createUpload(owner, { bytes: 16 }, 'partial-cleanup');
        let failAbort = true;
        const faulty = new Proxy(bucket, {
            get(target, key) {
                if(key === 'resumeMultipartUpload') return (...args) => {
                    const multipart = target.resumeMultipartUpload(...args);
                    return {
                        async abort() {
                            if(failAbort) throw new Error('synthetic abort failure');
                            return multipart.abort();
                        }
                    };
                };
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const service = createService({ db, bucket: faulty });
        const stream = new Request('https://k.test', { method: 'PUT', body: new Uint8Array(17) }).body;
        await reject(service.putUpload(owner, upload.id, stream, 'content'), 'CLEANUP_PENDING');
        const pending = (await service.listUploads(owner)).items[0];
        assert.equal(pending.cleanupState, 'pending');
        assert.equal(
            (await db.prepare('SELECT cleanup_target FROM uploads WHERE id=?').bind(upload.id).first()).cleanup_target,
            'pending'
        );
        failAbort = false;
        await service.cancelUpload(owner, upload.id, 'cancel-partial');
        await service.cancelUpload(owner, upload.id, 'cancel-partial');
        assert.deepEqual((await service.listUploads(owner)).items, []);
        assert.equal((await bucket.list()).objects.length, 0);
        assert.equal(
            (await db.prepare('SELECT status,cleanup_state FROM uploads WHERE id=?').bind(upload.id).first()).status,
            'cancelled'
        );
    }
);

test(
    'N1 preflight rejects repeated sample work before any codec validation or successful completion',
    async t => {
        const { referencedMP4 } = await import('../fixtures/mp4-workloads.mjs');
        const { inspectMP4 } = await import('../../lib/server/media.ts');
        const { s, db } = await fixture(t);
        const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        const repeated = referencedMP4(original, [2000]);
        assert.ok(repeated.bytes.length < 12000);
        assert.ok(repeated.referencedBytes > repeated.mdatBytes);
        assert.equal(repeated.samples, 2000);

        const upload = await s.createUpload(owner, { bytes: repeated.bytes.length }, 'n1-repeated');
        await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body: repeated.bytes }).body, 'content');
        await reject(s.completeUpload(owner, upload.id, 'complete'), 'UNSUPPORTED_MEDIA');
        const row = await db.prepare('SELECT status FROM uploads WHERE id=?').bind(upload.id).first();
        assert.notEqual(row.status, 'ready');
        const completed = await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-complete' AND target_id=? AND status='done'").bind(upload.id).first();
        assert.equal(completed.n, 0);
        assert.deepEqual(
            inspectMP4(original.buffer.slice(original.byteOffset, original.byteOffset + original.length)),
            { mime: 'video/mp4', durationSec: 3 }
        );
    }
);

test(
    'global sample and byte caps remain bounded under PRD G metadata policy',
    async t => {
        const { referencedMP4 } = await import('../fixtures/mp4-workloads.mjs');
        const { inspectMP4 } = await import('../../lib/server/media.ts');
        const { s, db } = await fixture(t);
        const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
        // The first SPS is deliberately invalid: a resource error, not the H.264 syntax error,
        // proves all tracks' budgets were checked before entering any codec validator.
        for(const [name, counts, options] of [
            ['single-track sample cap', [100001], { compactChunks: true, sampleSizeOverride: 1, mdatPadding: 100001 }],
            ['cross-track sample cap', [60000, 60000], { compactChunks: true, sampleSizeOverride: 1, mdatPadding: 120000 }],
            ['cross-chunk byte cap', [2], {}],
            ['cross-track byte cap', [1, 1], {}],
            ['large declared byte count', [2], { sampleSizeOverride: 0xffffffff }],
        ]) {
            const input = referencedMP4(original, counts, { ...options, corruptFirstSps: true });
            if(name.includes('sample cap')) assert.ok(input.referencedBytes <= input.mdatBytes);
            assert.throws(
                () => inspectMP4(input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.length)),
                error => {
                    assert.equal(error.code, 'UNSUPPORTED_MEDIA', name);
                    assert.equal(error.message, '此短片结构超出当前私有版本支持范围，请换用其他短片。', name);
                    return true;
                }
            );
            const upload = await s.createUpload(owner, { bytes: input.bytes.length }, name.replaceAll(' ', '-'));
            await s.putUpload(owner, upload.id, new Request('https://k.test', { method: 'PUT', body: input.bytes }).body, 'content');
            await reject(s.completeUpload(owner, upload.id, 'complete'), 'UNSUPPORTED_MEDIA');
            assert.notEqual((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(upload.id).first()).status, 'ready');
            const operation = await db.prepare("SELECT count(*) AS n FROM operations WHERE kind='upload-complete' AND target_id=? AND status='done'").bind(upload.id).first();
            assert.equal(operation.n, 0);
        }
        assert.deepEqual(
            inspectMP4(original.buffer.slice(original.byteOffset, original.byteOffset + original.length)),
            { mime: 'video/mp4', durationSec: 3 }
        );
    }
);

test('mobile Bilibili share creates canonical persisted video with guarded replay',async t=>{
 const {s,db}=await fixture(t);const tr=await published(s);let calls=0;let challenged=false;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return challenged?new Response(null,{status:200}):new Response(null,{status:302,headers:{location:'https://www.bilibili.com/video/BV1raQXYpEkG?spm_id_from=tracking'}});});
 const input={title:'分享验证',source:'bilibili',url:'【【华工飞盘】比赛-哔哩哔哩】 https://b23.tv/vP9CEuO',position:0};
 await reject(s.addVideo(alice,tr.id,input,'denied'),'FORBIDDEN');assert.equal(calls,0);
 const result=await s.addVideo(owner,tr.id,input,'share');assert.equal(result.url,'https://www.bilibili.com/video/BV1raQXYpEkG/');
 challenged=true;await assert.rejects(s.addVideo(owner,tr.id,input,'share'),e=>e.status===503&&e.retryable);challenged=false;
 assert.equal((await s.addVideo(owner,tr.id,input,'share')).id,result.id);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM videos WHERE training_id=?').bind(tr.id).first()).n,1);
});
