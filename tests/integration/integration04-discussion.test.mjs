import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const [admin, author, reader] = ['discussion-admin', 'discussion-author', 'discussion-reader'].map(principal);
const directory = new URL('../../drizzle/', import.meta.url);
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
const publication = post => ({ expectedVersion: post.version, expectedMembershipEpoch: post.membershipEpoch });
const article = { kind: 'article', category: '战术', title: '合成标题', summary: '合成摘要', body: '合成正文' };

test('learning discussion persists direct replies and protects published sources, receipts and personal export', { timeout: 30000 }, async t => {
    const mf = new Miniflare({
        modules: true, script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22', d1Databases: ['DB'],
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    const make = (database = db) => createService({ db: database, accessInitialAdminEmail: admin.verifiedEmail });
    const s = make();
    for (const [p, discName] of [[admin, '管理员'], [author, '作者'], [reader, '读者']]) {
        await s.join(p, { intent: 'register', confirmed: true, discName, jerseyNumber: '01' }, 'join');
    }
    async function publish(input, key) {
        const draft = await s.saveLearningPost(author, null, input, key);
        await denied(s.listLearningComments(author, draft.id), 'NOT_FOUND');
        return s.publishLearningPost(author, draft.id, publication(draft), key);
    }
    async function api(p, path, method = 'GET', payload, database = db) {
        const origin = 'https://kapok.test';
        const headers = { Origin: origin, 'X-Kapok-Actor': await actorKey(p), 'Idempotency-Key': 'http-root', 'Content-Type': 'application/json' };
        return dispatchApi(new Request(origin + '/api/v1/' + path, { method, headers, body: payload && JSON.stringify(payload) }),
            path.split('/'), p, make(database));
    }
    const post = await publish(article, 'article');
    const path = 'learning/posts/' + post.id + '/comments';
    const submission = { text: '读者根讨论' };
    let committedBatch = false;
    let lookupFailed = false;
    const interrupted = {
        prepare(sql) {
            if (committedBatch && sql.startsWith('SELECT id, input_hash, status, result_json FROM operations')) {
                lookupFailed = true;
                throw new Error('Synthetic D1 receipt lookup transport failure');
            }
            return db.prepare(sql);
        },
        async batch(statements) {
            await db.batch(statements);
            committedBatch = true;
            throw new Error('Synthetic D1 batch response lost after commit');
        },
    };
    const unknown = await api(reader, path, 'POST', submission, interrupted);
    assert.equal(committedBatch, true);
    assert.equal(lookupFailed, true);
    assert.equal(unknown.status, 503);
    const { error } = await unknown.json();
    assert.equal(error.code, 'RESULT_UNKNOWN');
    assert.equal(error.retryable, true);
    const committed = await make().listLearningComments(reader, post.id);
    assert.equal(committed.length, 1);
    const replay = await api(reader, path, 'POST', submission);
    assert.equal(replay.status, 200);
    assert.match(replay.headers.get('Cache-Control'), /private, no-store/);
    const { data: root } = await replay.json();
    assert.deepEqual(root, { id: committed[0].id });
    assert.deepEqual(await make().listLearningComments(reader, post.id), committed);
    const self = await s.saveLearningComment(reader, post.id, null, { text: '自回', replyToId: root.id }, 'self');
    const reply = await s.saveLearningComment(author, post.id, null, { text: '直接回复', rootId: root.id, replyToId: self.id }, 'direct');
    const other = await s.saveLearningComment(author, post.id, null, { text: '另一串' }, 'second-root');
    const video = { kind: 'video', body: '', video: { source: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } };
    const videoPost = await publish({ ...article, ...video }, 'video');
    const currentVideo = (await s.getLearningPost(reader, videoPost.id)).video;
    await denied(s.saveLearningComment(reader, videoPost.id, null, { text: '跨资料', replyToId: root.id }, 'cross-source'), 'INVALID_INPUT');
    await denied(s.saveLearningComment(reader, post.id, null, { text: '跨串', rootId: other.id, replyToId: self.id }, 'cross-root'), 'INVALID_INPUT');
    await denied(s.saveLearningComment(reader, post.id, null, { text: '图文时刻', timestampSec: 0, mediaUrl: currentVideo.url }, 'article-time'), 'INVALID_INPUT');
    const at = await s.saveLearningComment(reader, videoPost.id, null, { text: '视频时刻', timestampSec: 13, mediaUrl: currentVideo.url }, 'video-time');
    assert.equal((await make().listLearningComments(author, videoPost.id))[0].timestampSec, 13);
    const newVideo = { ...video.video, url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' };
    const editedVideo = await s.saveLearningPost(author, videoPost.id, { ...article, ...video, video: newVideo, expectedVersion: videoPost.version }, 'change-media');
    await s.publishLearningPost(author, videoPost.id, publication(editedVideo), 'new-media');
    const previousTime = (await s.listLearningComments(reader, videoPost.id)).find(c => c.id === at.id);
    assert.equal(previousTime.timestampSec, 13);
    assert.equal(previousTime.matchesCurrentMedia, false);
    await denied(s.saveLearningComment(reader, videoPost.id, null, { text: '旧媒体时刻', timestampSec: 14, mediaUrl: currentVideo.url }, 'stale-media'), 'VERSION_CONFLICT');

    const edit = { expectedVersion: 1, text: '编辑后的自回' };
    await denied(s.saveLearningComment(author, post.id, self.id, edit, 'edit'), 'FORBIDDEN');
    await s.saveLearningComment(reader, post.id, self.id, edit, 'edit');
    await denied(s.saveLearningComment(reader, post.id, self.id, edit, 'stale'), 'VERSION_CONFLICT');
    const list = (await (await api(admin, path)).json()).data;
    assert.equal(list.length, 4);
    assert.equal(list.find(c => c.id === self.id).text, edit.text);
    assert.equal(list.find(c => c.id === self.id).edited, true);
    assert.deepEqual(list.find(c => c.id === reply.id).replyTarget, { id: self.id, authorName: '读者' });
    assert.equal(list.find(c => c.id === reply.id).rootId, root.id);
    const hide = { action: 'hide', expectedVersion: 1, reason: '合成理由' };
    await denied(s.moderateLearningComment(author, post.id, root.id, hide, 'hide'), 'FORBIDDEN');
    await s.moderateLearningComment(admin, post.id, root.id, hide, 'hide');
    await denied(s.saveLearningComment(reader, post.id, null, { text: '根已隐藏', replyToId: self.id }, 'hidden-root'), 'INVALID_INPUT');
    await s.moderateLearningComment(admin, post.id, root.id, { ...hide, action: 'restore', expectedVersion: 2 }, 'restore');
    await s.saveLearningComment(reader, post.id, self.id, { action: 'delete', expectedVersion: 2 }, 'delete');
    await denied(s.saveLearningComment(author, post.id, null, { text: '目标已删', replyToId: self.id }, 'removed-target'), 'INVALID_INPUT');
    const after = await s.listLearningComments(author, post.id);
    assert.equal(after.find(c => c.id === self.id).text, null);
    assert.equal(after.find(c => c.id === reply.id).replyTarget, null);
    const exported = (await s.exportOwnData(reader)).learningComments;
    assert.deepEqual(new Set(exported.map(c => c.id)), new Set([root.id, self.id, at.id]));
    assert.equal(exported.find(c => c.id === self.id).text, null);
    assert.deepEqual((await s.exportOwnData(admin)).learningComments, []);

    const readerId = (await s.me(reader)).user.id;
    const memberChange = make({
        prepare: db.prepare.bind(db),
        async batch(statements) {
            await db.prepare("UPDATE memberships SET status='paused',epoch=epoch+1 WHERE user_id=?").bind(readerId).run();
            return db.batch(statements);
        },
    });
    await denied(memberChange.saveLearningComment(reader, post.id, null, { text: '成员资格已变更' }, 'member-change'), 'VERSION_CONFLICT');
    assert.deepEqual(await s.listLearningComments(author, post.id), after);
    await denied(s.listLearningComments(reader, post.id), 'FORBIDDEN');
    assert.equal((await api(reader, path, 'POST', { text: '读者根讨论' })).status, 403);
    await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(readerId).run();
    assert.equal((await api(reader, path, 'POST', { text: '读者根讨论' })).status, 403);
    await s.withdrawLearningPost(author, post.id, publication(post), 'withdraw');
    await denied(s.listLearningComments(admin, post.id), 'NOT_FOUND');
    await denied(s.saveLearningComment(reader, post.id, null, { text: '读者根讨论' }, 'http-root'), 'NOT_FOUND');
});
