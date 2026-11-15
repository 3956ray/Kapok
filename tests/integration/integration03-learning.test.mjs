import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey, sitesPrincipal } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const admin = principal('cp03-admin');
const author = principal('cp03-author');
const reader = principal('cp03-reader');
const outsider = principal('cp03-outsider');
const directory = new URL('../../drizzle/', import.meta.url);
const input = { kind: 'article', category: '战术', title: '合成标题', summary: '合成摘要', body: '合成正文' };
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
const version = ({ version }) => ({ expectedVersion: version });
const publicationVersion = ({ version, membershipEpoch }) => ({ expectedVersion: version, expectedMembershipEpoch: membershipEpoch });
const draft = (service, id, actor = author) => service.getLearningPost(actor, id, 'draft');

async function fixture(t, { before0013 = false, learningPolicy } = {}) {
    const mf = new Miniflare({
        modules: true, script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22', d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('BUCKET');
    const migrate = async file => {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    };
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && (!before0013 || file < '0013')).sort()) await migrate(file);
    const make = (overrides = {}) => createService({ db, bucket, accessInitialAdminEmail: admin.verifiedEmail, learningPolicy, ...overrides });
    const s = make();
    for (const [p, discName, jerseyNumber] of [[admin, '管理员', '01'], [author, '作者', '02'], [reader, '读者', '03']]) {
        await s.join(p, { intent: 'register', confirmed: true, discName, jerseyNumber }, 'join');
    }
    const rows = async (table, where = '1') => (await db.prepare('SELECT * FROM ' + table + ' WHERE ' + where + ' ORDER BY 1').all()).results;
    return { db, bucket, s, make, rows, migrate };
}

async function api(s, actor, method, path, { payload, key = '', type = 'application/json' } = {}) {
    const origin = 'https://kapok.test';
    const headers = actor ? { Origin: origin, 'X-Kapok-Actor': await actorKey(actor), 'Idempotency-Key': key, 'Content-Type': type } : {};
    const body = payload === undefined || payload instanceof Uint8Array ? payload : JSON.stringify(payload);
    return dispatchApi(new Request(origin + '/api/v1/' + path, { method, headers, body }), path.split('?')[0].split('/'), actor, s);
}

test('learning endpoints separate author draft and public snapshot, use versions, and permanently fence administrator hide', async t => {
    const { s, make } = await fixture(t);
    const created = await api(s, author, 'POST', 'learning/posts', { payload: { ...input, collectionTargetId: 'future-topic' }, key: 'create' });
    assert.equal(created.status, 200);
    assert.match(created.headers.get('Cache-Control'), /private, no-store/);
    const { data: post } = await created.json();
    assert.equal(post.status, 'draft');
    assert.equal(post.collectionTargetId, 'future-topic');
    for (const who of [admin, reader]) {
        await denied(draft(s, post.id, who), 'NOT_FOUND');
        await denied(s.getLearningPost(who, post.id), 'NOT_FOUND');
        assert.deepEqual(await s.listLearningPosts(who), []);
        assert.deepEqual(await s.listMyLearningPosts(who), []);
    }
    const explicitDraft = await api(s, author, 'GET', 'learning/posts/' + post.id + '?view=draft');
    assert.equal((await explicitDraft.json()).data.body, input.body);
    assert.equal((await api(s, outsider, 'GET', 'learning/posts')).status, 403);
    assert.equal((await api(s, null, 'GET', 'learning/posts')).status, 401);
    await denied(s.hideLearningPost(admin, post.id, version(post), 'hide-draft'), 'NOT_FOUND');

    const published = await s.publishLearningPost(author, post.id, publicationVersion(post), 'publish');
    const old = await s.getLearningPost(reader, post.id);
    assert.equal(old.body, input.body);
    assert.equal(old.publishedVersion, published.version);
    assert.deepEqual(old.author, { id: (await s.me(author)).user.id, discName: '作者', jerseyNumber: '02' });
    for (const key of ['version', 'status', 'collectionTargetId', 'ownerId']) assert.ok(!(key in old));
    const saved = await s.saveLearningPost(author, post.id, { ...input, title: '更新', body: '私人新稿', ...version(published) }, 'save');
    assert.deepEqual(await make().getLearningPost(reader, post.id), old);
    assert.deepEqual(await s.getLearningPost(admin, post.id), old);
    assert.equal((await s.listLearningPosts(reader))[0].title, input.title);
    assert.equal((await s.listMyLearningPosts(author))[0].title, '更新');
    await denied(s.publishLearningPost(author, post.id, publicationVersion(published), 'old-version'), 'VERSION_CONFLICT');
    const withdrawn = await s.withdrawLearningPost(author, post.id, publicationVersion(saved), 'withdraw');
    assert.equal(withdrawn.status, 'withdrawn');
    await denied(s.getLearningPost(reader, post.id), 'NOT_FOUND');
    await denied(s.publishLearningPost(author, post.id, publicationVersion(post), 'publish'), 'VERSION_CONFLICT');
    const again = await s.publishLearningPost(author, post.id, publicationVersion(withdrawn), 'republish');
    assert.equal((await s.getLearningPost(reader, post.id)).body, '私人新稿');
    const beforeMemberHide = await s.getLearningPost(reader, post.id);
    await denied(s.hideLearningPost(reader, post.id, { expectedVersion: again.version }, 'member-hide'), 'FORBIDDEN');
    assert.deepEqual(await s.getLearningPost(reader, post.id), beforeMemberHide);
    const hidden = await s.hideLearningPost(admin, post.id, { expectedVersion: again.version }, 'hide');
    assert.deepEqual(Object.keys(hidden).sort(), ['id', 'status']);
    assert.deepEqual(hidden, { id: post.id, status: 'hidden' });
    await denied(s.getLearningPost(author, post.id), 'NOT_FOUND');
    await denied(s.getLearningPost(admin, post.id), 'NOT_FOUND');
    const concealed = await draft(s, post.id);
    const editHidden = await s.saveLearningPost(author, post.id, { ...input, ...version(concealed) }, 'edit-hidden');
    assert.equal(editHidden.status, 'hidden');
    await denied(s.publishLearningPost(author, post.id, publicationVersion(editHidden), 'publish-hidden'), 'READ_ONLY');
    await denied(s.withdrawLearningPost(author, post.id, publicationVersion(editHidden), 'withdraw-hidden'), 'READ_ONLY');
    assert.deepEqual(await s.listLearningPosts(reader), []);
});

test('learning operations survive lost responses and roll back an after-write membership change', async t => {
    const { db, s, make, rows } = await fixture(t);
    const draftPost = await s.saveLearningPost(author, null, input, 'post');
    await db.prepare(`CREATE TRIGGER late_publish AFTER INSERT ON learning_post_publications
        BEGIN UPDATE memberships SET epoch=epoch+1 WHERE user_id=(SELECT owner_id FROM learning_posts WHERE id=NEW.post_id); END`).run();
    const before = await s.me(author);
    const guards = await rows('write_guards');
    await denied(s.publishLearningPost(author, draftPost.id, publicationVersion(draftPost), 'pub'), 'VERSION_CONFLICT');
    assert.deepEqual(await rows('write_guards'), guards);
    assert.deepEqual(await rows('learning_post_publications'), []);
    assert.deepEqual(await s.me(author), before);
    assert.equal((await draft(s, draftPost.id)).status, 'draft');
    await db.prepare('DROP TRIGGER late_publish').run();
    let lose = true;
    const wrapped = { prepare: db.prepare.bind(db), batch: async statements => {
        const result = await db.batch(statements);
        if (lose) { lose = false; throw new Error('synthetic lost D1 result'); }
        return result;
    } };
    const first = await make({ db: wrapped }).publishLearningPost(author, draftPost.id, publicationVersion(draftPost), 'pub');
    assert.deepEqual(first, await make().publishLearningPost(author, draftPost.id, publicationVersion(draftPost), 'pub'));
    await denied(s.publishLearningPost(author, draftPost.id, publicationVersion(first), 'pub'), 'IDEMPOTENCY_CONFLICT');
    assert.equal((await rows('learning_post_publications')).length, 1);
    await db.prepare("UPDATE memberships SET epoch=epoch+1,status='paused' WHERE user_id=?").bind(before.user.id).run();
    await denied(draft(s, draftPost.id), 'FORBIDDEN');
    await denied(s.getLearningPost(reader, draftPost.id), 'NOT_FOUND');
    await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(before.user.id).run();
    await denied(s.getLearningPost(reader, draftPost.id), 'NOT_FOUND');
    await denied(s.publishLearningPost(author, draftPost.id, publicationVersion(draftPost), 'pub'), 'VERSION_CONFLICT');
    await denied(s.publishLearningPost(author, draftPost.id, publicationVersion(first), 'late-new-transport'), 'VERSION_CONFLICT');
    const rejoined = await draft(s, draftPost.id);
    assert.equal(rejoined.status, 'withdrawn');
    assert.notEqual(rejoined.membershipEpoch, first.membershipEpoch);
    await s.publishLearningPost(author, rejoined.id, publicationVersion(rejoined), 'explicit-after-rejoin');
    assert.equal((await s.getLearningPost(reader, draftPost.id)).body, input.body);
});

const photos = [
    ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNY6W680t2YAUIBACG6BI0c0mdzAAAAAElFTkSuQmCC'],
    ['image/jpeg', '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAALp/9k='],
    ['image/webp', 'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/u7T3/wF090Yt/+hJ/8En/wSfuAAAA=='],
    ['image/webp', 'UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAfQo6Z2pv+BiOh/AAA='],
].map(([type, base64]) => ({ type, bytes: Uint8Array.from(Buffer.from(base64, 'base64')) }));
const stream = bytes => new Response(bytes).body;
const put = (s, postId, image, photo, key, who = author) => s.uploadLearningImage(who, postId, image.id, stream(photo.bytes), photo.type, key);
const reserve = (s, postId, key) => s.reserveLearningImage(author, postId, {}, key);
const complete = (s, postId, image, key) => s.completeLearningImage(author, postId, image.id, {}, key);

test('D1 and private bucket validate real images, preserve independent published references and fence cleanup', async t => {
    const { db, bucket, s, make, rows } = await fixture(t, { learningPolicy: { maxImages: 4, maxImageBytes: 512 } });
    let post = await s.saveLearningPost(author, null, input, 'post');
    const reserved = await reserve(s, post.id, 'reserve0');
    const [png] = photos;
    await denied(put(s, post.id, reserved, png, 'other-upload', admin), 'NOT_FOUND');
    await denied(put(s, post.id, reserved, { ...png, type: 'image/gif' }, 'unsupported'), 'INVALID_IMAGE');
    await denied(put(s, post.id, reserved, { ...png, type: 'image/jpeg' }, 'wrong-type'), 'INVALID_IMAGE');
    const corruptPng = png.bytes.slice(); corruptPng[50] ^= 1;
    await denied(put(s, post.id, reserved, { ...png, bytes: corruptPng }, 'crc'), 'INVALID_IMAGE');
    for (const [i, photo] of photos.entries()) {
        await denied(put(s, post.id, reserved, { ...photo, bytes: photo.bytes.slice(0, -3) }, 'truncated' + i), 'INVALID_IMAGE');
    }
    await denied(put(s, post.id, reserved, { ...png, bytes: new Uint8Array(513) }, 'oversize'), 'IMAGE_TOO_LARGE');
    await denied(complete(s, post.id, reserved, 'missing-bytes'), 'IMAGE_NOT_UPLOADED');
    assert.equal((await bucket.list()).objects.length, 0);

    const images = [];
    for (const [i, photo] of photos.entries()) {
        const image = i ? await reserve(s, post.id, 'reserve' + i) : reserved;
        const uploaded = await api(s, author, 'PUT', `learning/posts/${post.id}/images/${image.id}/content`, { payload: photo.bytes, key: 'upload' + i, type: photo.type });
        assert.equal(uploaded.status, 200, await uploaded.text());
        const ready = await complete(s, post.id, image, 'complete' + i);
        assert.deepEqual(ready, await complete(make(), post.id, image, 'complete' + i));
        assert.deepEqual([ready.mimeType, ready.width, ready.height, ready.bytes], [photo.type, 2, 2, photo.bytes.length]);
        assert.equal(await s.getLearningImage(author, post.id, image.id, 'draft').then(r => r.headers.get('Cache-Control')), 'private, no-store, max-age=0');
        images.push(ready);
    }
    await denied(reserve(s, post.id, 'over-limit'), 'IMAGE_LIMIT');
    const first = images[0];
    const entries = await rows('learning_images');
    const objectKey = entries.find(row => row.id === first.id).object_key;
    assert.equal(JSON.stringify(images).includes(objectKey), false);
    const imagePath = `learning/posts/${post.id}/images/${first.id}`;
    for (const who of [admin, reader, null]) assert.ok([401, 404].includes((await api(s, who, 'GET', imagePath + '?view=draft')).status));
    assert.equal((await api(s, author, 'GET', imagePath)).status, 404);
    await denied(s.getLearningImage(author, post.id, objectKey, 'draft'), 'NOT_FOUND');
    await denied(s.removeLearningImage(author, post.id, first.id, {}, 'still-draft'), 'IMAGE_REFERENCED');
    const otherPost = await s.saveLearningPost(author, null, input, 'other-post');
    await denied(s.saveLearningPost(author, otherPost.id, {
        ...input, ...version(otherPost), images: [{ id: first.id, alt: '跨资料图片', decorative: false }],
    }, 'cross-post-image'), 'INVALID_IMAGE');
    assert.deepEqual((await draft(s, otherPost.id)).images, []);

    post = await draft(s, post.id);
    await denied(s.publishLearningPost(author, post.id, publicationVersion(post), 'no-alt'), 'INVALID_INPUT');
    const described = await s.saveLearningPost(author, post.id, {
        ...input, ...version(post), images: images.map((image, index) => ({
            id: image.id, alt: index === 0 ? '两格合成战术图' : '', decorative: index > 0,
        })).reverse(),
    }, 'describe-images');
    const published = await s.publishLearningPost(author, post.id, publicationVersion(described), 'publish');
    const publicPost = await s.getLearningPost(reader, post.id);
    assert.deepEqual(publicPost.images.map(({ id, alt, decorative }) => ({ id, alt, decorative })),
        described.images.map(({ id, alt, decorative }) => ({ id, alt, decorative })));
    const asset = await api(s, reader, 'GET', imagePath);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('Content-Type'), png.type);
    assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), png.bytes);
    const readerId = (await s.me(reader)).user.id;
    const switched = make({ bucket: {
        async get(key) {
            const object = await bucket.get(key);
            await db.prepare("UPDATE memberships SET epoch=epoch+1,status='paused' WHERE user_id=?").bind(readerId).run();
            return object;
        },
    } });
    await denied(switched.getLearningImage(reader, post.id, first.id), 'NOT_FOUND');
    await denied(s.getLearningImage(reader, post.id, first.id), 'FORBIDDEN');
    await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(readerId).run();
    const edited = await s.saveLearningPost(author, post.id, { ...input, images: [], ...version(published) }, 'detach-images');
    await denied(s.getLearningImage(author, post.id, first.id, 'draft'), 'NOT_FOUND');
    await denied(s.removeLearningImage(author, post.id, first.id, {}, 'still-published'), 'IMAGE_REFERENCED');
    assert.equal((await api(s, reader, 'GET', imagePath)).status, 200);
    const withdrawn = await s.withdrawLearningPost(author, post.id, publicationVersion(edited), 'withdraw');
    assert.equal((await api(s, reader, 'GET', imagePath)).status, 404);
    await denied(s.removeLearningImage(author, post.id, first.id, {}, 'still-historical'), 'IMAGE_REFERENCED');
    await s.publishLearningPost(author, post.id, publicationVersion(withdrawn), 'replace-snapshot');
    const interrupted = make({ bucket: {
        async put(...args) {
            await bucket.put(...args);
            throw new Error('synthetic lost erase response');
        },
    } });
    await denied(interrupted.removeLearningImage(author, post.id, first.id, {}, 'remove'), 'RESULT_UNKNOWN');
    assert.equal((await rows('learning_images')).find(row => row.id === first.id).status, 'cleanup');
    assert.equal((await bucket.head(objectKey)).size, 0);
    const removed = await s.removeLearningImage(author, post.id, first.id, {}, 'remove');
    assert.deepEqual(removed, { id: first.id, status: 'removed' });
    assert.deepEqual(await make().removeLearningImage(author, post.id, first.id, {}, 'remove'), removed);
    assert.equal((await bucket.head(objectKey))?.size ?? 0, 0);
    await denied(s.saveLearningPost(author, post.id, { ...input, images: [{ id: first.id, alt: '旧图', decorative: false }], ...version(await draft(s, post.id)) }, 'bad-ref'), 'INVALID_IMAGE');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
});

test('bucket failures before and after put, concurrent completion and cleanup prevent stale writes becoming accessible', async t => {
    const { db, bucket, s, make, rows } = await fixture(t);
    const post = await s.saveLearningPost(author, null, input, 'post');
    const [png, jpeg] = photos;
    const image = await reserve(s, post.id, 'reserve');
    const objectKey = (await rows('learning_images'))[0].object_key;
    const breakPut = after => make({ bucket: {
        head: bucket.head.bind(bucket), get: bucket.get.bind(bucket),
        async put(...args) { if (after) await bucket.put(...args); throw new Error('synthetic bucket timeout'); },
    } });
    await denied(put(breakPut(false), post.id, image, png, 'upload'), 'RESULT_UNKNOWN');
    assert.equal(await bucket.head(objectKey), null);
    await denied(put(breakPut(true), post.id, image, png, 'upload'), 'RESULT_UNKNOWN');
    assert.equal((await bucket.head(objectKey)).size, png.bytes.length);
    await denied(s.getLearningImage(author, post.id, image.id, 'draft'), 'NOT_FOUND');
    await denied(put(s, post.id, image, jpeg, 'upload'), 'IDEMPOTENCY_CONFLICT');
    await denied(put(s, post.id, image, jpeg, 'changed-key'), 'IMAGE_CONFLICT');
    assert.equal((await put(make(), post.id, image, png, 'upload')).status, 'uploaded');
    const before = (await draft(s, post.id)).version;
    const [a, b] = await Promise.all([complete(s, post.id, image, 'complete'), complete(make(), post.id, image, 'complete')]);
    assert.deepEqual(a, b);
    assert.equal((await draft(s, post.id)).version, before + 1);
    assert.equal((await draft(s, post.id)).images.length, 1);
    assert.equal((await rows('learning_draft_images')).length, 1);

    const stale = await reserve(s, post.id, 'stale');
    let releasePut, startedPut;
    const mayContinue = new Promise(resolve => { releasePut = resolve; });
    const hasStarted = new Promise(resolve => { startedPut = resolve; });
    const delayed = make({ bucket: {
        head: bucket.head.bind(bucket), get: bucket.get.bind(bucket),
        async put(...args) { startedPut(); await mayContinue; return bucket.put(...args); },
    } });
    const attempt = put(delayed, post.id, stale, png, 'stale-upload');
    const failure = denied(attempt, 'NOT_FOUND');
    await Promise.race([hasStarted, attempt]);
    try { await s.removeLearningImage(author, post.id, stale.id, {}, 'remove-stale'); }
    finally { releasePut(); }
    await failure;
    const staleRow = (await rows('learning_images')).find(row => row.id === stale.id);
    assert.equal((await bucket.head(staleRow.object_key))?.size ?? 0, 0);
    await denied(complete(s, post.id, stale, 'stale-complete'), 'NOT_FOUND');
    await db.prepare("UPDATE memberships SET epoch=epoch+1,status='left' WHERE user_id=?").bind((await s.me(author)).user.id).run();
    await denied(s.getLearningImage(author, post.id, image.id, 'draft'), 'FORBIDDEN');
});

test('0013 adds learning without changing populated 0012 training, collection and reflection rows', async t => {
    const { db, s, rows, migrate } = await fixture(t, { before0013: true });
    const training = await s.publishTraining(admin, { title: '旧训练', date: '2026-11-15', description: '', video: { title: '旧视频', url: 'https://youtu.be/dQw4w9WgXcQ' } }, 'legacy');
    await s.saveCollection(author, null, { sourceKind: 'video', sourceId: training.video.id, privateNote: '原备注' }, 'legacy');
    await s.saveReflection(author, null, { text: '原复盘', date: '2026-11-15', videoId: training.video.id, trainingId: training.training.id }, 'legacy');
    const tables = ['trainings', 'videos', 'collections', 'reflections', 'operations'];
    const snapshot = await Promise.all(tables.map(table => rows(table)));
    await migrate('0013_learning_posts.sql');
    assert.deepEqual(await Promise.all(tables.map(table => rows(table))), snapshot);
    assert.equal((await s.listCollections(author))[0].privateNote, '原备注');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    await migrate('0014_topic_collections.sql');
    const incomplete = await s.saveLearningPost(author, null, { ...input, body: '' }, 'incomplete');
    await denied(s.publishLearningPost(author, incomplete.id, publicationVersion(incomplete), 'needs-body'), 'INVALID_INPUT');
    const video = await s.saveLearningPost(author, null, {
        kind: 'video', category: '基本功', title: '合成视频', video: { source: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ?t=1m' },
    }, 'yt');
    assert.deepEqual(video.video, { source: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=60s' });
    await denied(s.saveLearningPost(author, null, { kind: 'video', title: '合成视频', category: '基本功', video: { source: 'vimeo', url: 'https://vimeo.com/1' } }, 'invalid'), 'INVALID_INPUT');
    await denied(s.saveLearningPost(author, null, { ...input, category: '任意' }, 'category'), 'INVALID_INPUT');
    const bili = await s.saveLearningPost(author, null, {
        kind: 'video', category: '基本概念', title: '合成视频', video: { source: 'bilibili', url: '分享 https://bilibili.com/video/BV1xx411c7mD?p=2&tracking=1' },
    }, 'bili');
    assert.deepEqual(bili.video, { source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2' });
});

test('attaching an uploaded image wins over a previously prepared cleanup without erasing bytes', async t => {
    const { db, bucket, s, make, rows } = await fixture(t);
    const post = await s.saveLearningPost(author, null, input, 'post');
    const image = await reserve(s, post.id, 'reserve');
    const [png] = photos;
    await put(s, post.id, image, png, 'upload');
    const key = (await rows('learning_images'))[0].object_key;
    let release, entered;
    const pending = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { entered = resolve; });
    const delayed = make({ db: {
        prepare: db.prepare.bind(db),
        async batch(statements) { entered(); await pending; return db.batch(statements); },
    } });
    const cleanup = delayed.removeLearningImage(author, post.id, image.id, {}, 'stale-cleanup');
    const conflict = denied(cleanup, 'VERSION_CONFLICT');
    await Promise.race([begun, cleanup]);
    try {
        await complete(s, post.id, image, 'attach');
    } finally { release(); }
    await conflict;
    assert.equal((await bucket.head(key)).size, png.bytes.length);
    const response = await s.getLearningImage(author, post.id, image.id, 'draft');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png.bytes);
});

function identityMove(current, replacement) {
    assert.equal(current.provider, replacement.provider);
    assert.equal(current.issuer, replacement.issuer);
    const sqlString = value => "'" + value.replaceAll("'", "''") + "'";
    const scope = 'provider=' + sqlString(current.provider) + ' AND issuer=' + sqlString(current.issuer);
    const rename = (from, to) => `UPDATE auth_identities SET subject=${sqlString(to)} WHERE ${scope} AND subject=${sqlString(from)}`;
    return [rename(current.subject, current.subject + '-former'), rename(replacement.subject, current.subject)];
}

function injectBeforeBatch(db, move) {
    let intercepted = false;
    return {
        prepare: db.prepare.bind(db),
        async batch(statements) {
            if (!intercepted) {
                intercepted = true;
                await db.batch(move.map(sql => db.prepare(sql)));
            }
            return db.batch(statements);
        },
        assertIntercepted: () => assert.equal(intercepted, true),
    };
}

function injectBeforeRead(db, matches, move) {
    let intercepted = false;
    return {
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!matches(sql)) return statement;
            return { bind: (...args) => {
                const bound = statement.bind(...args);
                const read = async (method, ...values) => {
                    assert.equal(intercepted, false);
                    intercepted = true;
                    await db.batch(move.map(sql => db.prepare(sql)));
                    return bound[method](...values);
                };
                return { first: (...values) => read('first', ...values), all: () => read('all') };
            } };
        },
        assertIntercepted: () => assert.equal(intercepted, true),
    };
}

const postState = async rows => Promise.all(['learning_posts', 'learning_post_publications', 'topic_learning_associations', 'operations', 'write_guards'].map(table => rows(table)));
const imageState = async rows => Promise.all(['learning_images', 'learning_draft_images', 'learning_publication_images'].map(table => rows(table)));

for (const [view, actor, method, projection, expected] of [
    ['private detail', author, (s, p, id) => draft(s, id, p), 'lp.body,lp.video_source', 'NOT_FOUND'],
    ['private list', author, (s, p) => s.listMyLearningPosts(p), 'ORDER BY lp.updated_at', null],
    ['published detail', reader, (s, p, id) => s.getLearningPost(p, id), 'lpub.body,', 'NOT_FOUND'],
    ['published list', reader, (s, p) => s.listLearningPosts(p), 'ORDER BY lpub.published_at', null],
]) {
    test(`learning identity rebind before the ${view} SQL read fences the captured member`, async t => {
        const { db, s, make, rows } = await fixture(t);
        let post = await s.saveLearningPost(author, null, input, 'post');
        if (actor === reader) post = await s.publishLearningPost(author, post.id, publicationVersion(post), 'publish');
        const replacement = actor === reader ? author : reader;
        const memberships = await rows('memberships');
        const raced = injectBeforeRead(db, sql => sql.includes(projection), identityMove(actor, replacement));
        const result = method(make({ db: raced }), actor, post.id);
        if (expected) await denied(result, expected);
        else assert.deepEqual(await result, []);
        raced.assertIntercepted();
        assert.deepEqual(await rows('memberships'), memberships);
        assert.equal((await s.me(actor)).membership.status, 'active');
    });
}

for (const [action, triggerEvent] of [
    ['create', 'INSERT ON learning_posts'],
    ['save', 'UPDATE OF body ON learning_posts'],
    ['publish', 'INSERT ON learning_post_publications'],
    ['withdraw', 'UPDATE OF status ON learning_posts'],
    ['hide', 'UPDATE OF status ON learning_posts'],
]) {
    for (const phase of ['before', 'after']) {
        test(`learning identity rebind ${phase} ${action} leaves no unauthorized rows or receipt`, async t => {
            const { db, s, make, rows } = await fixture(t);
            let post = await s.saveLearningPost(author, null, { ...input, collectionTargetId: 'synthetic-topic' }, 'post');
            if (['withdraw', 'hide'].includes(action)) post = await s.publishLearningPost(author, post.id, publicationVersion(post), 'publish');
            const actor = action === 'hide' ? admin : author;
            const move = identityMove(actor, reader);
            const before = await postState(rows);
            const identities = await rows('auth_identities');
            const memberships = await rows('memberships');
            const raced = phase === 'before' ? injectBeforeBatch(db, move) : db;
            if (phase === 'after') {
                await db.prepare(`CREATE TRIGGER rebind AFTER ${triggerEvent} BEGIN ${move.join('; ')}; END`).run();
            }
            const target = make({ db: raced });
            const key = 'raced-' + action;
            const attempt = action === 'create' ? target.saveLearningPost(actor, null, input, key)
                : action === 'save' ? target.saveLearningPost(actor, post.id, { ...input, ...version(post), body: '合成未授权改稿' }, key)
                : action === 'hide' ? target.hideLearningPost(actor, post.id, version(post), key)
                : action === 'publish' ? target.publishLearningPost(actor, post.id, publicationVersion(post), key)
                : target.withdrawLearningPost(actor, post.id, publicationVersion(post), key);
            const code = await attempt.then(() => 'success', error => error.code);
            assert.deepEqual(await postState(rows), before, `committed state changed despite returning ${code}`);
            assert.equal(code, 'VERSION_CONFLICT');
            assert.deepEqual(await rows('memberships'), memberships);
            if (phase === 'before') {
                raced.assertIntercepted();
                assert.equal((await s.me(actor)).user.id, identities.find(row => row.subject === reader.subject).user_id);
            } else {
                assert.deepEqual(await rows('auth_identities'), identities);
            }
        });
    }
}

test('learning identity rebind during the private R2 GET cancels the original body for a Sites member', async t => {
    const { db, bucket, make, rows } = await fixture(t);
    const siteAdmin = sitesPrincipal('cp03-site-admin');
    const owner = sitesPrincipal('cp03-site-image-owner');
    const replacement = sitesPrincipal('cp03-site-image-reader');
    const s = make({ bootstrapSiteUserId: siteAdmin.subject });
    await s.bootstrap(siteAdmin, { discName: '合成管理员', jerseyNumber: '01' }, 'bootstrap');
    for (const actor of [owner, replacement]) {
        const invite = await s.createInvite(siteAdmin, {}, 'invite-' + actor.subject);
        await s.join(actor, { token: invite.inviteToken, discName: '合成队员', jerseyNumber: '11' }, 'join');
    }
    const post = await s.saveLearningPost(owner, null, input, 'post');
    const image = await s.reserveLearningImage(owner, post.id, {}, 'reserve');
    const [png] = photos;
    await put(s, post.id, image, png, 'upload', owner);
    await s.completeLearningImage(owner, post.id, image.id, {}, 'attach');
    const replacementId = (await s.me(replacement)).user.id;
    const memberships = await rows('memberships');
    const move = identityMove(owner, replacement);
    let cancelled = false;
    const delayed = make({ bucket: {
        async get(key) {
            const object = await bucket.get(key);
            const reader = object.body.getReader();
            await db.batch(move.map(sql => db.prepare(sql)));
            return {
                size: object.size, checksums: object.checksums, httpMetadata: object.httpMetadata,
                body: new ReadableStream({
                    async pull(controller) {
                        const { value, done } = await reader.read();
                        if (done) controller.close();
                        else controller.enqueue(value);
                    },
                    async cancel() { cancelled = true; await reader.cancel(); },
                }, { highWaterMark: 0 }),
            };
        },
    } });
    const outcome = await delayed.getLearningImage(owner, post.id, image.id, 'draft').then(
        async response => ({ delivered: [...new Uint8Array(await response.arrayBuffer())] }),
        error => ({ code: error.code }),
    );
    assert.deepEqual(outcome, { code: 'NOT_FOUND' });
    assert.equal(cancelled, true);
    assert.equal((await s.me(owner)).user.id, replacementId);
    assert.deepEqual(await rows('memberships'), memberships);
});

for (const [action, triggerEvent] of [
    ['reserve', 'INSERT ON learning_images'],
    ['upload', 'UPDATE OF status ON learning_images'],
    ['complete', 'UPDATE OF status ON learning_images'],
    ['remove', 'UPDATE OF status ON learning_images'],
]) {
    for (const phase of ['before', 'after']) {
        test(`learning identity rebind ${phase} image ${action} preserves metadata, references and bytes`, async t => {
            const { db, bucket, s, make, rows } = await fixture(t);
            let post = await s.saveLearningPost(author, null, input, 'post');
            const [png] = photos;
            const attached = await reserve(s, post.id, 'original');
            await put(s, post.id, attached, png, 'original-upload');
            await complete(s, post.id, attached, 'original-complete');
            post = await s.saveLearningPost(author, post.id, { ...input, ...version(await draft(s, post.id)), images: [
                { id: attached.id, alt: '合成 PNG', decorative: false },
            ] }, 'describe');
            await s.publishLearningPost(author, post.id, publicationVersion(post), 'publish');
            const target = action === 'reserve' ? null : await reserve(s, post.id, 'target');
            if (action === 'complete' || action === 'remove') await put(s, post.id, target, png, 'target-upload');
            const beforePost = await postState(rows);
            const beforeImages = await imageState(rows);
            const objects = async () => (await bucket.list()).objects.map(({ key, size, etag }) => ({ key, size, etag }));
            const beforeObjects = await objects();
            const identities = await rows('auth_identities');
            const move = identityMove(author, reader);
            const raced = phase === 'before' ? injectBeforeBatch(db, move) : db;
            if (phase === 'after') {
                await db.prepare(`CREATE TRIGGER rebind AFTER ${triggerEvent} BEGIN ${move.join('; ')}; END`).run();
            }
            const guarded = make({ db: raced });
            const attempt = action === 'reserve' ? reserve(guarded, post.id, 'raced-reserve')
                : action === 'upload' ? put(guarded, post.id, target, png, 'raced-upload')
                : action === 'complete' ? complete(guarded, post.id, target, 'raced-complete')
                : guarded.removeLearningImage(author, post.id, target.id, {}, 'raced-remove');
            const code = await attempt.then(() => 'success', error => error.code);
            assert.deepEqual(await imageState(rows), beforeImages, `committed image state changed despite returning ${code}`);
            assert.deepEqual(await postState(rows), beforePost);
            assert.deepEqual(await objects(), beforeObjects);
            assert.equal(code, 'VERSION_CONFLICT');
            if (phase === 'before') raced.assertIntercepted();
            else assert.deepEqual(await rows('auth_identities'), identities);
        });
    }
}
