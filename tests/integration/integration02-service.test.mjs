import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { parseYouTubeSource } from '../../lib/video-source.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const admin = principal('cp02-admin');
const member = principal('cp02-member');
const directory = new URL('../../drizzle/', import.meta.url);
const migration = '0012_video_platforms.sql';
const training = { title: '合成训练', date: '2026-11-15', description: '合成记录' };
const id = 'dQw4w9WgXcQ';
const youtube = { title: '合成视频', url: 'https://youtu.be/' + id + '?t=1m30s' };
const watch = seconds => 'https://www.youtube.com/watch?v=' + id + '&t=' + seconds + 's';
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);

async function migrate(db, file) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}

async function fixture(t, before0012 = false) {
    const runtime = new Miniflare({
        modules: true, script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22', d1Databases: ['DB'],
    });
    t.after(() => runtime.dispose());
    const db = await runtime.getD1Database('DB');
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && file < '0012').sort()) {
        await migrate(db, file);
    }
    if (!before0012) {
        await migrate(db, migration);
        await migrate(db, '0013_learning_posts.sql');
        await migrate(db, '0017_learning_activity.sql');
    }
    const make = () => createService({ db, accessInitialAdminEmail: admin.verifiedEmail });
    const s = make();
    await s.join(admin, { intent: 'register', confirmed: true, discName: '合成管理员', jerseyNumber: '07' }, 'join');
    await s.join(member, { intent: 'register', confirmed: true, discName: '合成队员', jerseyNumber: '02' }, 'join');
    const rows = async (table, where = '1') => (await db.prepare('SELECT * FROM ' + table + ' WHERE ' + where + ' ORDER BY 1').all()).results;
    return { db, s, make, rows };
}

test('normalizes approved YouTube forms and bounds with no extra query data', () => {
    for (const [input, seconds] of [
        ['https://www.youtube.com/watch?v=' + id, 0],
        ['https://youtube.com:443/watch?v=' + id + '&start=0&tracking=secret#discard', 0],
        ['https://m.youtube.com/watch?v=' + id + '&t=30', 30],
        [youtube.url, 90],
        ['https://www.youtube.com/shorts/' + id + '/?start=1h2m3s', 3723],
        ['https://youtu.be/' + id + '?t=604800s', 604800],
    ]) {
        assert.deepEqual(parseYouTubeSource(input), { videoId: id, startSec: seconds, url: watch(seconds) }, input);
    }
});

test('rejects unapproved YouTube origins, ambiguous parameters and invalid times', () => {
    const query = 'https://www.youtube.com/watch?v=' + id;
    for (const input of [
        'http://youtu.be/' + id, 'javascript://youtu.be/' + id, 'https://www.youtube.com.attacker.test/watch?v=' + id,
        'https://unknown.youtube.com/watch?v=' + id, 'https://youtube.com@evil.test/watch?v=' + id,
        'https://user:pass@youtu.be/' + id, 'https://@youtu.be/' + id, 'https://youtu.be:8443/' + id, 'https://youtu.be:99999/' + id,
        'https://youtu.be/' + id + '?v=' + id, 'https://www.youtube.com/embed/' + id, 'https://youtu.be/too-short',
        'https://youtu.be/undefined/../' + id, 'https://www.youtube.com/shorts/%2E%2E/watch?v=' + id,
        query + '&v=' + id, query + '&%76=another', query + '&t=0&t=0', query + '&start=1&start=2',
        query + '&t=0&start=1', query + '&t=-1', query + '&t=1.5', query + '&t=1m2h', query + '&t=',
        query + '&t=604801', query + '&start=169h', 'https://youtu.be/\t' + id,
    ]) assert.equal(parseYouTubeSource(input), null, input);
});

test('atomic draft creation keeps the optional video private until the draft is published', async t => {
    const { db, s, make, rows } = await fixture(t);
    const originalFetch = fetch;
    const sourceRequests = t.mock.method(globalThis, 'fetch', (request, options) => {
        const href = String(request?.url ?? request);
        assert.doesNotMatch(href, /youtu(?:\.be|be\.com)/);
        return originalFetch(request, options);
    });
    const input = { ...training, status: 'draft', video: youtube };
    const deniedWrite = await dispatchApi(new Request('https://kapok.test/api/v1/trainings/publish', {
        method: 'POST', body: JSON.stringify(input),
        headers: {
            Origin: 'https://kapok.test', 'Content-Type': 'application/json',
            'X-Kapok-Actor': await actorKey(member), 'Idempotency-Key': 'blocked',
        },
    }), ['trainings', 'publish'], member, s);
    assert.equal(deniedWrite.status, 403);
    assert.equal((await deniedWrite.json()).error.code, 'FORBIDDEN');
    assert.deepEqual(await rows('trainings'), []);
    assert.deepEqual(await rows('videos'), []);
    await denied(s.publishTraining(admin, { ...input, status: 'archived' }, 'invalid-status'), 'INVALID_INPUT');
    await denied(s.publishTraining(admin, { ...input, video: { ...youtube, url: watch(1) + '&start=2' } }, 'invalid-video'), 'INVALID_INPUT');
    const draft = await s.publishTraining(admin, input, 'draft');
    assert.equal(draft.training.status, 'draft');
    assert.equal(draft.video.source, 'youtube');
    assert.equal(draft.video.url, watch(90));
    assert.equal(draft.video.trainingId, draft.training.id);
    assert.equal(draft.video.publisherId, (await s.me(admin)).user.id);
    const fresh = make();
    assert.deepEqual(await fresh.listTrainings(member), []);
    await denied(fresh.getTraining(member, draft.training.id), 'NOT_FOUND');
    await denied(fresh.getVideo(member, draft.video.id), 'NOT_FOUND');
    await denied(fresh.getTraining(admin, draft.training.id, 'member'), 'NOT_FOUND');
    assert.deepEqual((await fresh.listActivity(member)).items, []);
    assert.deepEqual(await rows('video_events'), []);
    assert.deepEqual(await fresh.publishTraining(admin, { ...input, video: { ...youtube, url: watch(90) } }, 'draft'), draft);
    await denied(fresh.publishTraining(admin, { ...input, status: 'published' }, 'draft'), 'IDEMPOTENCY_CONFLICT');
    assert.equal((await rows('videos')).length, 1);
    assert.equal((await rows('operations', "kind='training-publish'")).length, 1);
    const empty = await fresh.publishTraining(admin, { ...training, status: 'draft' }, 'empty-draft');
    assert.equal(empty.training.status, 'draft');
    assert.equal(empty.video, null);
    await fresh.saveTraining(admin, draft.training.id, { ...training, status: 'published', expectedVersion: draft.training.version }, 'publish');
    assert.deepEqual((await make().getTraining(member, draft.training.id)).videos, [draft.video]);
    const [event] = (await fresh.listActivity(member)).items;
    assert.equal(event.id, 'video:' + draft.video.id);
    assert.equal((await rows('video_events')).length, 1);
    await assert.rejects(db.prepare("UPDATE videos SET source='unsupported' WHERE id=?").bind(draft.video.id).run(), /CHECK constraint failed: video_source/);
    assert.ok(sourceRequests.mock.calls.every(call => !/youtu(?:\.be|be\.com)/.test(String(call.arguments[0]?.url ?? call.arguments[0]))));
});

test('final permission guard rolls back training, video, event and operation and allows same-key retry', async t => {
    const { db, s, make, rows } = await fixture(t);
    await db.prepare(`CREATE TRIGGER synthetic_late_permission AFTER INSERT ON videos
        BEGIN UPDATE memberships SET epoch=epoch+1 WHERE user_id=NEW.publisher_id; END`).run();
    const publishedInput = { ...training, video: youtube };
    const draftInput = { ...publishedInput, status: 'draft' };
    const guards = await rows('write_guards');
    const membership = await s.me(admin);
    await denied(s.publishTraining(admin, publishedInput, 'publish'), 'VERSION_CONFLICT');
    await denied(s.publishTraining(admin, draftInput, 'draft'), 'VERSION_CONFLICT');
    for (const table of ['trainings', 'videos', 'video_events']) assert.deepEqual(await rows(table), []);
    assert.deepEqual(await rows('operations', "kind='training-publish'"), []);
    assert.deepEqual(await rows('write_guards'), guards);
    assert.deepEqual(await s.me(admin), membership);
    await db.prepare('DROP TRIGGER synthetic_late_permission').run();
    const [a, b] = await Promise.all([s.publishTraining(admin, publishedInput, 'publish'), make().publishTraining(admin, publishedInput, 'publish')]);
    assert.deepEqual(a, b);
    assert.equal((await rows('video_events')).length, 1);
    const added = await s.addVideo(admin, a.training.id, { ...youtube, source: 'youtube', position: 4 }, 'add');
    assert.equal(added.url, watch(90));
    assert.equal(added.position, 4);
    assert.deepEqual(await make().addVideo(admin, a.training.id, { ...youtube, url: watch(90), source: 'youtube', position: 4 }, 'add'), added);
    await denied(s.addVideo(admin, a.training.id, { ...youtube, url: 'https://evil.test/', source: 'youtube', position: 9 }, 'invalid-add'), 'INVALID_INPUT');
    await denied(s.addVideo(member, a.training.id, { ...youtube, source: 'youtube', position: 5 }, 'denied-add'), 'FORBIDDEN');
    assert.equal((await rows('videos')).length, 2);
    assert.equal((await rows('video_events')).length, 2);
});

test('0012 preserves a populated parent graph, exact and canonical receipts, FK enforcement and event behavior', async t => {
    const { db, s, make, rows } = await fixture(t, true);
    const bili = { title: '旧B站视频', url: 'B站分享 https://bilibili.com/video/BV1xx411c7mD?p=2&tracking=1' };
    const legacy = await s.publishTraining(admin, { ...training, video: bili }, 'legacy-publish');
    const empty = await s.publishTraining(admin, training, 'legacy-empty');
    const root = await s.saveComment(member, legacy.video.id, null, { text: '旧讨论', timestampSec: 0 }, 'root');
    await s.saveComment(admin, legacy.video.id, null, { text: '旧回复', replyToId: root.id }, 'reply');
    await s.saveCollection(member, null, { sourceKind: 'comment', sourceId: root.id, privateNote: '旧私人备注' }, 'collection');
    await s.saveReflection(member, null, { title: '旧复盘', text: '旧私人复盘', date: training.date, trainingId: legacy.training.id, videoId: legacy.video.id }, 'reflection');
    await s.moderateComment(admin, root.id, { action: 'report', reason: '合成报告' }, 'report');
    const at = '2026-11-01T00:00:00.000Z';
    const { user, membership } = await s.me(admin);
    await db.prepare("INSERT INTO uploads(id,team_id,owner_id,bytes,status,duration_sec,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind('fixture-upload', membership.teamId, user.id, 100, 'ready', 30, at).run();
    await db.prepare(`INSERT INTO videos(id,training_id,team_id,title,source,upload_id,position,status,version,created_at,updated_at,publisher_id)
        VALUES(?,?,?,?,'upload',?,7,'hidden',4,?,?,?)`)
        .bind('fixture-upload-video', legacy.training.id, membership.teamId, '旧私有视频', 'fixture-upload', at, at, user.id).run();
    const oldAdd = await s.addVideo(admin, legacy.training.id, { ...bili, title: '追加旧视频', source: 'bilibili', position: 4 }, 'legacy-add');
    const tables = ['profiles', 'trainings', 'uploads', 'videos', 'video_events', 'video_comments', 'comment_reports', 'collections', 'reflections', 'operations'];
    const before = await Promise.all(tables.map(table => rows(table)));
    const oldPublication = before.at(-1).find(row => row.kind === 'training-publish' && row.key === 'legacy-publish');
    const digest = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))).toString('hex');
    assert.equal(oldPublication.input_hash, await digest({ ...training, video: { title: bili.title, url: legacy.video.url } }));
    assert.equal(JSON.parse(oldPublication.result_json).requestHash, await digest({ ...training, video: bili }));
    await migrate(db, migration);
    assert.deepEqual(await Promise.all(tables.map(table => rows(table))), before);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.deepEqual((await db.prepare("PRAGMA index_list('videos')").all()).results.map(row => row.name).sort(),
        ['sqlite_autoindex_videos_1', 'video_training_order', 'videos_upload_id_unique']);
    await assert.rejects(db.prepare("DELETE FROM videos WHERE id=?").bind(legacy.video.id).run(), /FOREIGN KEY/);
    const fresh = make();
    assert.equal((await fresh.me(admin)).profile.jerseyNumber, '07');
    assert.deepEqual(await fresh.publishTraining(admin, { ...training, video: bili }, 'legacy-publish'), legacy);
    assert.deepEqual(await fresh.publishTraining(admin, { ...training, status: 'published', video: { ...bili, url: legacy.video.url } }, 'legacy-publish'), legacy);
    assert.deepEqual(await fresh.publishTraining(admin, { ...training, status: 'published' }, 'legacy-empty'), empty);
    assert.deepEqual(await fresh.addVideo(admin, legacy.training.id, { ...bili, title: '追加旧视频', source: 'bilibili', position: 4 }, 'legacy-add'), oldAdd);
    assert.deepEqual(await fresh.listComments(member, legacy.video.id), await s.listComments(member, legacy.video.id));
    assert.equal((await fresh.listCollections(member))[0].timestampSec, 0);
    const next = await fresh.addVideo(admin, legacy.training.id, { ...youtube, source: 'youtube', position: 9 }, 'new');
    assert.equal((await rows('video_events')).length, 3);
    await migrate(db, '0013_learning_posts.sql');
    await migrate(db, '0017_learning_activity.sql');
    assert.ok((await fresh.listActivity(member)).items.some(item => item.id === 'video:' + next.id));
    const oldVideo = (await fresh.getTraining(admin, legacy.training.id)).videos.find(video => video.id === 'fixture-upload-video');
    await denied(fresh.getVideo(member, oldVideo.id), 'NOT_FOUND');
    await fresh.updateVideo(admin, oldVideo.id, { title: oldVideo.title, position: oldVideo.position, status: 'active', expectedVersion: 4 }, 'restore-old-video');
    assert.equal((await fresh.getVideo(member, oldVideo.id)).durationSec, 30);
    assert.equal((await rows('video_events')).length, 4);
    await assert.rejects(db.prepare("UPDATE videos SET upload_id='fixture-upload' WHERE id=?").bind(next.id).run(), /UNIQUE constraint failed/);
});

test('YouTube discussion at zero and owner-only reflection reuse archive and visibility fences', async t => {
    const { s, make } = await fixture(t);
    const { training: published, video } = await s.publishTraining(admin, { ...training, video: youtube }, 'published');
    const { training: withoutVideo } = await s.publishTraining(admin, training, 'no-video');
    const root = await s.saveComment(member, video.id, null, { text: '起点', timestampSec: 0 }, 'root');
    await s.saveComment(admin, video.id, null, { text: '答复起点', replyToId: root.id }, 'reply');
    await denied(s.saveComment(member, video.id, null, { text: '越界时刻', timestampSec: -1 }, 'invalid-time'), 'INVALID_INPUT');
    const discussed = await make().listComments(member, video.id);
    assert.equal(discussed.find(comment => comment.id === root.id).timestampSec, 0);
    assert.equal(discussed.find(comment => comment.rootId === root.id).replyToId, root.id);
    const archived = await s.saveTraining(admin, published.id, { ...training, status: 'archived', expectedVersion: published.version }, 'archive');
    assert.equal((await make().getVideo(member, video.id)).training.status, 'archived');
    await denied(s.saveComment(member, video.id, null, { text: '归档新讨论' }, 'blocked-during-archive'), 'READ_ONLY');
    const attached = await s.saveReflection(member, null, { title: '复盘', text: '私人正文', date: training.date, trainingId: published.id, videoId: video.id }, 'archived-reflection');
    const privateInput = { title: '无视频复盘', text: '独立私人正文', date: training.date, trainingId: withoutVideo.id };
    const privateReview = await s.saveReflection(member, null, privateInput, 'training-reflection');
    assert.equal(privateReview.link.href, '/trainings/' + withoutVideo.id);
    assert.equal(attached.link.href, '/videos/' + video.id);
    await denied(s.getReflection(admin, privateReview.id), 'NOT_FOUND');
    await s.saveTraining(admin, published.id, { ...training, status: 'published', expectedVersion: archived.version }, 'reopen');
    await s.saveComment(member, video.id, null, { text: '重开后讨论' }, 'reopened-comment');
    await s.saveTraining(admin, withoutVideo.id, { ...training, status: 'hidden', expectedVersion: withoutVideo.version }, 'hide');
    const own = await make().getOwnReflection(member, privateReview.id);
    assert.equal(own.text, privateInput.text);
    assert.equal(own.link, null);
    await denied(s.getReflection(admin, privateReview.id), 'NOT_FOUND');
});
