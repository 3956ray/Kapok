import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const accessPrincipal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });

const admin = accessPrincipal('publish-admin');
const member = accessPrincipal('reply-member');
const training = { title: ' 合成训练 ', date: '2026-11-07', description: ' 合成记录 ' };
const video = { title: ' 合成视频 ', url: '分享 https://bilibili.com/video/BV1xx411c7mD?p=2&tracking=1' };
const canonicalUrl = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
const migrationDir = new URL('../../drizzle/', import.meta.url);
async function migrate(db, file) {
    const migration = await readFile(new URL(file, migrationDir), 'utf8');
    const statements = migration.split('--> statement-breakpoint')
        .flatMap(sql => sql.includes('CREATE TRIGGER') ? [sql] : sql.split(';'))
        .map(sql => sql.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
}
async function fixture(t, legacy = false) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir(migrationDir)).filter(x => x.endsWith('.sql') && (!legacy || x < '0010' || x === '0011_profile_bio.sql')).sort()) await migrate(db, file);
    const make = (database = db) => createService({ db: database, accessInitialAdminEmail: admin.verifiedEmail });
    const s = make();
    const profile = { intent: 'register', confirmed: true };
    const owner = await s.join(admin, { ...profile, discName: '合成管理员', jerseyNumber: '01' }, 'join');
    const player = await s.join(member, { ...profile, discName: '合成队员', jerseyNumber: '02' }, 'join');
    const count = async (table, where = '1') => (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first()).n;
    const counts = () => Promise.all([
        count('trainings'), count('videos'), count('video_events'), count('operations', "kind='training-publish'"),
    ]);
    return { s, db, make, count, counts, owner: owner.me, player: player.me };
}
async function api(s, principal, path, { method = 'GET', body, key = 'api', headers = {} } = {}) {
    const url = new URL('https://kapok.test/api/v1/' + path);
    const request = new Request(url, {
        method,
        ...(body === undefined ? {} : {
            body: JSON.stringify(body),
            headers: {
                'Origin': url.origin, 'Content-Type': 'application/json',
                'X-Kapok-Actor': await actorKey(principal), 'Idempotency-Key': key, ...headers,
            },
        }),
    });
    const response = await dispatchApi(request, url.pathname.slice('/api/v1/'.length).split('/'), principal, s);
    assert.match(response.headers.get('Cache-Control'), /private, no-store/);
    return { status: response.status, body: await response.json() };
}
function interceptBatch(db, batch) {
    return new Proxy(db, { get(target, property) {
        if (property === 'batch') return batch;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}
const add = (s, trainingId, key = 'add') =>
    s.addVideo(admin, trainingId, { title: '追加视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 1 }, key);

test('published training with optional video is immediately readable and attributed in D1 activity', async t => {
    const { s, make, owner, counts } = await fixture(t);
    const response = await api(s, admin, 'trainings/publish', { method: 'POST', body: { ...training, video } });
    assert.equal(response.status, 200);
    const published = response.body.data;
    assert.deepEqual(Object.keys(published).sort(), ['training', 'video']);
    assert.equal(published.training.title, '合成训练');
    assert.equal(published.training.description, '合成记录');
    assert.equal(published.training.status, 'published');
    assert.equal(published.video.url, canonicalUrl);
    assert.equal(published.video.trainingId, published.training.id);
    assert.equal(published.video.publisherId, owner.user.id);
    assert.equal(published.video.publisherName, '合成管理员');
    const fresh = make();
    const detail = await fresh.getTraining(member, published.training.id);
    assert.deepEqual(detail.videos, [published.video]);
    assert.equal((await fresh.getVideo(member, published.video.id)).publisherId, owner.user.id);
    const [item] = (await fresh.listActivity(member)).items;
    assert.equal(item.id, 'video:' + published.video.id);
    assert.equal(item.publisherId, owner.user.id);
    assert.equal(item.publisherName, '合成管理员');
    const without = await s.publishTraining(admin, training, 'no-video');
    assert.equal(without.video, null);
    assert.equal(without.training.status, 'published');
    assert.deepEqual((await fresh.getTraining(member, without.training.id)).videos, []);
    assert.deepEqual(await counts(), [2, 1, 1, 2]);
});

test('invalid link, forged publisher, member, changed actor and cross-origin publish write nothing', async t => {
    const { s, counts } = await fixture(t);
    const post = (principal, body, headers = {}) => api(s, principal, 'trainings/publish', { method: 'POST', body, headers });
    for (const bad of [
        { ...training, video: { ...video, url: 'https://evil.test/video/BV1xx411c7mD' } },
        { ...training, video: { ...video, publisherId: 'forged' } },
        { ...training, publisherId: 'forged' },
    ]) {
        const result = await post(admin, bad);
        assert.equal(result.status, 400);
        assert.equal(result.body.error.code, 'INVALID_INPUT');
    }
    assert.equal((await post(member, training)).status, 403);
    assert.equal((await post(admin, training, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await post(admin, training, { 'X-Kapok-Actor': await actorKey(member) })).body.error.code, 'ACCOUNT_CHANGED');
    assert.deepEqual(await counts(), [0, 0, 0, 0]);
});

test('a failed video event rolls back the preceding writes and the same key can be retried', async t => {
    const { s, db, counts } = await fixture(t);
    await db.prepare(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON video_events
        BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: synthetic event failure'); END`).run();
    const input = { ...training, video };
    await denied(s.publishTraining(admin, input, 'retry'), 'VERSION_CONFLICT');
    assert.deepEqual(await counts(), [0, 0, 0, 0]);
    await db.prepare('DROP TRIGGER synthetic_failure').run();
    assert.ok((await s.publishTraining(admin, input, 'retry')).video.id);
    assert.deepEqual(await counts(), [1, 1, 1, 1]);
});

test('publish reconciles lost D1 receipt and concurrent retries, with normalized input and current admin access', async t => {
    const { s, db, make, owner, counts } = await fixture(t);
    let lost = false;
    const interrupted = make(interceptBatch(db, async statements => {
        const result = await db.batch(statements);
        if (!lost) {
            lost = true;
            throw new Error('synthetic transport disconnected after commit');
        }
        return result;
    }));
    const input = { ...training, video };
    const first = await interrupted.publishTraining(admin, input, 'lost');
    assert.equal(lost, true);
    const normalized = { ...training, title: training.title.trim(), video: { ...video, url: canonicalUrl } };
    assert.deepEqual(await s.publishTraining(admin, normalized, 'lost'), first);
    const [a, b] = await Promise.all([s.publishTraining(admin, input, 'concurrent'), make().publishTraining(admin, normalized, 'concurrent')]);
    assert.deepEqual(a, b);
    assert.deepEqual(await counts(), [2, 2, 2, 2]);
    await denied(s.publishTraining(admin, training, 'lost'), 'IDEMPOTENCY_CONFLICT');
    await db.prepare("UPDATE memberships SET role='member' WHERE id=?").bind(owner.membership.id).run();
    await denied(s.publishTraining(admin, input, 'lost'), 'FORBIDDEN');
});

test('exact short-link retry replays the receipt even after Bilibili stops resolving', async t => {
    const { s, counts } = await fixture(t);
    const short = 'https://b23.tv/Synthetic';
    const originalFetch = fetch;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', (request, options) => {
        if (request !== short) return originalFetch(request, options);
        calls++;
        return Promise.resolve(calls === 1
            ? new Response(null, { status: 302, headers: { Location: canonicalUrl } })
            : new Response(null, { status: 503 }));
    });
    const input = { ...training, video: { ...video, url: short } };
    const saved = await s.publishTraining(admin, input, 'short');
    assert.deepEqual(await s.publishTraining(admin, input, 'short'), saved);
    assert.equal(calls, 1);
    assert.deepEqual(await s.publishTraining(admin, { ...input, video: { ...video, url: canonicalUrl } }, 'short'), saved);
    await denied(s.publishTraining(admin, { ...input, video: { ...video, url: 'BV1xx411c7mD' } }, 'short'), 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(await counts(), [1, 1, 1, 1]);
});

test('admin member preview uses member visibility and leaves the normal training view intact', async t => {
    const { s } = await fixture(t);
    const draft = await s.saveTraining(admin, null, { ...training, status: 'draft' }, 'draft');
    const published = await s.publishTraining(admin, { ...training, video }, 'publish');
    const hidden = await add(s, published.training.id);
    await s.updateVideo(admin, hidden.id, { title: hidden.title, position: hidden.position, status: 'hidden', expectedVersion: hidden.version }, 'hide');
    const path = 'trainings/' + published.training.id;
    const preview = await api(s, admin, path + '?view=member');
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.data, (await api(s, member, path)).body.data);
    assert.deepEqual(preview.body.data.videos.map(v => v.id), [published.video.id]);
    assert.equal((await api(s, admin, path)).body.data.videos.length, 2);
    assert.equal((await api(s, member, path + '?view=member')).status, 403);
    assert.equal((await api(s, admin, 'trainings/' + draft.id + '?view=member')).status, 404);
    assert.equal((await api(s, admin, 'trainings/' + draft.id)).status, 200);
});

test('direct replies keep one root group, allow self-replies and redact inactive targets', async t => {
    const { s, db } = await fixture(t);
    const { training: published, video: v } = await s.publishTraining(admin, { ...training, video }, 'publish');
    const other = await add(s, published.id);
    const root = await s.saveComment(member, v.id, null, { text: '根讨论' }, 'root');
    const target = await s.saveComment(admin, v.id, null, { text: '不可泄漏正文', rootId: root.id }, 'legacy-client');
    const self = await s.saveComment(admin, v.id, null, { text: '自回', replyToId: target.id }, 'self');
    const otherRoot = await s.saveComment(member, v.id, null, { text: '另一串' }, 'other-root');
    await denied(s.saveComment(member, v.id, null, { text: '错误串', rootId: otherRoot.id, replyToId: target.id }, 'bad-root'), 'INVALID_INPUT');
    await denied(s.saveComment(member, other.id, null, { text: '错误视频', replyToId: target.id }, 'cross'), 'INVALID_INPUT');
    await denied(s.saveComment(admin, v.id, self.id, { text: '改关系', replyToId: root.id, expectedVersion: 1 }, 'bad-edit'), 'INVALID_INPUT');
    await s.saveComment(admin, v.id, self.id, { text: '自回改字', expectedVersion: 1 }, 'edit');
    let rows = await s.listComments(member, v.id);
    const reply = rows.find(c => c.id === self.id);
    assert.equal(rows.find(c => c.id === root.id).replyToId, null);
    assert.equal(reply.rootId, root.id);
    assert.equal(reply.replyToId, target.id);
    assert.equal(reply.replyTargetName, '合成管理员');
    assert.equal(reply.text, '自回改字');
    for (const status of ['hidden', 'deleted']) {
        await db.prepare('UPDATE video_comments SET status=? WHERE id=?').bind(status, target.id).run();
        rows = await s.listComments(member, v.id);
        assert.equal(rows.find(c => c.id === self.id).replyTargetName, null);
        assert.ok(!JSON.stringify(rows).includes('不可泄漏正文'));
        await denied(s.saveComment(member, v.id, null, { text: '无效目标', replyToId: target.id }, status), 'INVALID_INPUT');
    }
});

test('target invalidation between precheck and D1 batch leaves no reply or receipt', async t => {
    const { s, db, make, count } = await fixture(t);
    const { video: v } = await s.publishTraining(admin, { ...training, video }, 'publish');
    const root = await s.saveComment(member, v.id, null, { text: '根讨论' }, 'root');
    const target = await s.saveComment(admin, v.id, null, { text: '将被隐藏', rootId: root.id }, 'target');
    const racing = make(interceptBatch(db, async statements => {
        await db.prepare("UPDATE video_comments SET status='hidden' WHERE id=?").bind(target.id).run();
        return db.batch(statements);
    }));
    await denied(racing.saveComment(member, v.id, null, { text: '竞态回复', replyToId: target.id }, 'race'), 'VERSION_CONFLICT');
    assert.equal(await count('video_comments'), 2);
    assert.equal(await count('operations', "key='race'"), 0);
});

test('additive migration leaves old videos unattributed and old root-only replies readable', async t => {
    const { s, db, owner, player } = await fixture(t, true);
    const t0 = '2026-11-07T00:00:00Z';
    const teamId = owner.membership.teamId;
    await db.prepare("INSERT INTO trainings(id,team_id,title,date,description,status,created_at,updated_at) VALUES('historic-training',?,'旧训练','2026-11-07','','published',?,?)").bind(teamId, t0, t0).run();
    await db.prepare("INSERT INTO videos(id,training_id,team_id,title,source,url,position,created_at,updated_at) VALUES('historic-video','historic-training',?,'旧视频','bilibili',?,0,?,?)").bind(teamId, canonicalUrl, t0, t0).run();
    await db.prepare("INSERT INTO video_comments(id,video_id,team_id,author_id,text,created_at,updated_at) VALUES('old-root','historic-video',?,?,'旧根',?,?)").bind(teamId, player.user.id, t0, t0).run();
    await db.prepare("INSERT INTO video_comments(id,video_id,team_id,author_id,root_id,text,created_at,updated_at) VALUES('old-reply','historic-video',?,?,'old-root','旧回复',?,?)").bind(teamId, owner.user.id, t0, t0).run();
    await migrate(db, '0010_training_publication.sql');
    const historic = await s.getVideo(member, 'historic-video');
    assert.equal(historic.publisherId, null);
    assert.equal(historic.publisherName, null);
    await migrate(db, '0013_learning_posts.sql');
    await migrate(db, '0017_learning_activity.sql');
    const oldActivity = (await s.listActivity(member)).items.find(row => row.id === 'video:historic-video');
    assert.equal(oldActivity.publisherId, null);
    assert.equal(oldActivity.publisherName, null);
    const legacy = (await s.listComments(member, historic.id)).find(c => c.id === 'old-reply');
    assert.equal(legacy.replyToId, null);
    assert.equal(legacy.rootId, 'old-root');
    assert.equal(legacy.replyTargetName, '合成队员');
    const added = await add(s, historic.trainingId);
    assert.equal(added.publisherId, owner.user.id);
    await db.prepare("UPDATE video_comments SET status='deleted' WHERE id='old-root'").run();
    assert.equal((await s.listComments(member, historic.id)).find(c => c.id === 'old-reply').replyTargetName, null);
});
