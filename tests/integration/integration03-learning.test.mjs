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

async function fixture(t, { before0013 = false, before0018 = false, learningPolicy } = {}) {
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
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && (!before0013 || file < '0013') && (!before0018 || file < '0018')).sort()) await migrate(file);
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

test('reader comments enter the team feed only with the current public source, and export only to their own author', async t => {
    const {s}=await fixture(t);
    const state = n => ({expectedVersion:n.version, expectedSharingVersion:n.sharingVersion, expectedGeneration:n.generation});
    async function add(path, text) {
        const response = await api(s,reader,'GET',path);
        assert.equal(response.status,200);
        const {discussionEpoch,membershipEpoch} = (await response.json()).data;
        const write = await api(s,reader,'POST',path,{key:crypto.randomUUID(),payload:{text,
            expectedDiscussionEpoch:discussionEpoch,expectedMembershipEpoch:membershipEpoch}});
        assert.equal(write.status,200,await write.clone().text());
        return (await write.json()).data.id;
    }
    const feed = async () => (await s.workspaceDispatch(author,null)).items.filter(item=>item.comment);
    let n=await s.saveReflection(author,null,{title:'Review',text:'Passing practice',date:'2026-11-24'},'new');
    n=await s.shareReflection(author,n.id,{...state(n),scope:'team'},'share');
    const comment=await add('reflections/'+n.id+'/discussion','Review discussion');
    assert.deepEqual(await feed(),[]);
    n=await s.publishReflection(author,n.id,{...state(n),published:true},'distribute');
    const a=await s.saveAnnouncement(admin,null,{title:'Notice',text:'Practice',status:'published'},'notice');
    const noticeComment=await add('announcements/'+a.id+'/discussion','Notice discussion');
    assert.deepEqual((await feed()).map(row=>[row.kind,row.source,row.comment]).sort(),[
        ['announcement_discussion',a.id,noticeComment],['reflection_discussion',n.id,comment],
    ]);
    const mine=(await s.exportOwnData(reader)).readerDiscussions;
    assert.deepEqual(mine.map(row=>row.id).sort(),[comment,noticeComment].sort());
    assert.deepEqual((await s.exportOwnData(author)).readerDiscussions,[]);
    n=await s.shareReflection(author,n.id,{...state(n),scope:'private'},'revoke');
    await s.saveAnnouncement(admin,a.id,{title:'Notice',text:'Practice',status:'draft',expectedVersion:a.version},'withdraw');
    assert.deepEqual(await feed(),[]);
    n=await s.shareReflection(author,n.id,{...state(n),scope:'team'},'share-again');
    await s.publishReflection(author,n.id,{...state(n),published:true},'distribute-again');
    assert.deepEqual(await feed(),[]);
});

test('daily text articles publish and share atomically while archive posts retain explicit sharing', async t => {
    const { s, rows } = await fixture(t);
    await s.createLearningCategory(author, { name: '随谈' }, 'daily-category');
    const create = category => s.saveLearningPost(author, null, { ...input, category }, crypto.randomUUID());
    const archive = await create('基本功');
    const publish = (post, key, share) => s.publishLearningPost(author, post.id,
        { ...publicationVersion(post), ...(share && { shareToActivity: true }) }, key);
    await denied(publish(archive, 'wrong-placement', true), 'INVALID_INPUT');
    assert.equal((await draft(s, archive.id)).status, 'draft');
    await publish(archive, 'archive', false);
    assert.equal((await rows('learning_activity_events')).length, 0);
    const daily = await create('随谈');
    const published = await publish(daily, 'daily', true);
    assert.deepEqual(await publish(daily, 'daily', true), published);
    const event = (await s.getLearningActivity(author, daily.id)).event;
    assert.ok(event);
    assert.equal((await s.listActivity(reader)).items[0].id, 'learning:' + event.id);
    const revised = await publish(published, 'daily-update', true);
    assert.equal((await rows('learning_activity_events')).length, 1);
    await s.changeLearningActivity(author, daily.id, { expectedPublishedVersion: revised.publishedVersion,
        expectedMembershipEpoch: revised.membershipEpoch, expectedEventId: event.id }, 'withdraw-event', false);
    await publish(revised, 'edit-without-resharing', true);
    assert.equal((await s.getLearningActivity(author, daily.id)).event, null);

    // Simulate closing the editor after the draft write and reopening it before publication.
    const previous = await draft(s, archive.id);
    await s.saveLearningPost(author, archive.id, { ...input, category: '随谈', collectionTargetId: 'previous-topic',
        expectedVersion: previous.version }, 'stage-conversion');
    const converted = await publish(await draft(s, archive.id), 'publish-reopened', true);
    assert.ok((await s.getLearningActivity(author, archive.id)).event);
    assert.equal(converted.collectionTargetId, null);
    assert.deepEqual(await rows('topic_learning_associations'), []);

});

test('learning endpoints separate author draft and public snapshot, use versions, and permanently fence administrator hide', async t => {
    const { s, make } = await fixture(t);
    const created = await api(s, author, 'POST', 'learning/posts', { payload: { ...input, collectionTargetId: 'future-topic' }, key: 'create' });
    assert.equal(created.status, 200);
    assert.match(created.headers.get('Cache-Control'), /private, no-store/);
    const { data: post } = await created.json();
    assert.equal(post.status, 'draft');
    assert.deepEqual((await s.listMyLearningPosts(author, 'unpublished-drafts')).map(row => row.id), [post.id]);
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
    assert.deepEqual(await s.listMyLearningPosts(author, 'unpublished-drafts'), []);
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
    const actor = await s.me(author);
    const team = actor.membership.teamId, owner = actor.user.id;
    await db.batch([
        db.prepare("INSERT INTO trainings(id,team_id,title,date,description,status,created_at,updated_at) VALUES('t',?,'旧训练','2026-11-15','','published','2026-11-15','2026-11-15')").bind(team),
        db.prepare("INSERT INTO videos(id,training_id,team_id,title,source,url,position,created_at,updated_at) VALUES('v','t',?,'旧视频','youtube','https://youtu.be/dQw4w9WgXcQ',0,'2026-11-15','2026-11-15')").bind(team),
        db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,private_note,created_at,updated_at) VALUES('c',?,'video','v','原备注','2026-11-15','2026-11-15')").bind(owner),
        db.prepare("INSERT INTO reflections(id,owner_id,team_id,text,date,training_id,video_id,created_at,updated_at) VALUES('r',?,?,'原复盘','2026-11-15','t','v','2026-11-15','2026-11-15')").bind(owner,team),
        db.prepare("INSERT INTO operations(id,actor_id,kind,target_id,key,input_hash,status,result_json,created_at) VALUES('create',?,'training-publish',?,'legacy','hash','done',json_object('id','t'),'2026-11-15')").bind(owner,team),
    ]);
    const tables = ['trainings', 'videos', 'collections', 'reflections', 'operations'];
    const snapshot = await Promise.all(tables.map(table => rows(table)));
    await migrate('0013_learning_posts.sql');
    assert.deepEqual(await Promise.all(tables.map(table => rows(table))), snapshot);
    for (const file of (await readdir(directory)).filter(name=>name.endsWith('.sql') && name>'0013_learning_posts.sql').sort()) await migrate(file);
    assert.equal((await s.getTraining(author, 't')).publisherId, owner);
    assert.equal((await s.listCollections(author))[0].privateNote, '原备注');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
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


test('shared categories trim, preserve case, enforce length and membership, and deduplicate concurrent D1 writes', async t => {
    const { db, s, make, rows } = await fixture(t);
    const path = 'learning/categories';
    const defaults = ['战术', '基本功', '基本概念'];
    assert.equal((await api(s, null, 'GET', path)).status, 401);
    assert.equal((await api(s, outsider, 'POST', path, { payload: { name: '体能' }, key: 'outsider' })).status, 403);
    assert.deepEqual(await s.listLearningCategories(reader), defaults);
    for (const name of ['', '　 ', '🏐'.repeat(33)]) {
        await denied(s.createLearningCategory(author, { name }, 'invalid'), 'INVALID_INPUT');
    }
    await denied(s.saveLearningPost(author, null, { ...input, category: '未登记' }, 'unknown-category'), 'INVALID_INPUT');
    const name = '🏐'.repeat(32);
    const responses = await Promise.all([
        api(s, author, 'POST', path, { payload: { name: '　' + name + ' ' }, key: 'create-category' }),
        api(s, reader, 'POST', path, { payload: { name }, key: 'create-category' }),
    ]);
    for (const response of responses) {
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Cache-Control'), /private, no-store/);
        assert.equal((await response.json()).data, name);
    }
    assert.equal(await s.createLearningCategory(author, { name }, 'create-category'), name);
    await denied(s.createLearningCategory(author, { name: 'X' }, 'create-category'), 'IDEMPOTENCY_CONFLICT');
    for (const name of ['Path', 'path', defaults[0]]) {
        assert.equal(await s.createLearningCategory(reader, { name }, 'category-' + name.replace(defaults[0], 'default')), name);
    }
    assert.deepEqual((await rows('learning_categories')).map(row => row.name).sort(), ['Path', 'path', name].sort());
    assert.deepEqual((await (await api(make(), reader, 'GET', path)).json()).data, [...defaults, 'Path', 'path', name]);
    const saved = await s.saveLearningPost(author, null, { ...input, category: name }, 'with-category');
    await s.publishLearningPost(author, saved.id, publicationVersion(saved), 'publish-category');
    assert.equal((await make().getLearningPost(reader, saved.id)).category, name);

    const { membership } = await s.me(reader);
    const racingDb = {
        prepare: db.prepare.bind(db),
        async batch(statements) {
            await db.prepare("UPDATE memberships SET status='paused', epoch=epoch+1 WHERE id=?").bind(membership.id).run();
            return db.batch(statements);
        },
    };
    await denied(make({ db: racingDb }).createLearningCategory(reader, { name: '撤权竞态' }, 'revoked'), 'VERSION_CONFLICT');
    assert.ok(!(await rows('learning_categories')).some(row => row.name === '撤权竞态'));
    await denied(s.listLearningCategories(reader), 'FORBIDDEN');
});

test('0018 preserves legacy drafts, publications, images, comment replies and referenced data in a D1 batch', async t => {
    const { db, s, migrate, rows } = await fixture(t, { before0018: true });
    const saved = { id: 'old-post' }, published = { version: 2 };
    const { user, membership } = await s.me(author);
    const at = '2026-11-16T00:00:00.000Z';
    const sql = (query, ...bindings) => db.prepare(query).bind(...bindings);
    await db.batch([
        sql("INSERT INTO learning_posts(id,team_id,owner_id,kind,category,title,summary,body,status,version,created_at,updated_at) VALUES(?,?,?,'article','战术',?,?,'私人新版','published',3,?,?)", saved.id,membership.teamId,user.id,input.title,input.summary,at,at),
        sql("INSERT INTO learning_post_publications(post_id,kind,category,title,summary,body,version,author_epoch,published_at) VALUES(?,'article','战术',?,?,?,?,?,?)", saved.id,input.title,input.summary,input.body,published.version,membership.epoch,at),
        sql("INSERT INTO operations(id,actor_id,kind,target_id,key,input_hash,status,result_json,created_at) VALUES('publish-op',?,'learning-publish',?,'old-publish','hash','done',json_object('id',?),?)",user.id,saved.id,saved.id,at),
        sql("INSERT INTO learning_images(id,post_id,object_key,status,digest,mime_type,bytes,width,height,created_at) VALUES('image',?,'key','ready','digest','image/png',4,2,2,?)", saved.id, at),
        sql("INSERT INTO learning_draft_images(post_id,image_id,position,alt) VALUES(?,'image',0,'草稿图片')", saved.id),
        sql("INSERT INTO learning_publication_images(post_id,image_id,position,alt) VALUES(?,'image',0,'发布图片')", saved.id),
        sql("INSERT INTO learning_comments(id,post_id,team_id,author_id,text,created_at,updated_at) VALUES('root',?,?,?,'根评论',?,?)", saved.id, membership.teamId, user.id, at, at),
        sql("INSERT INTO learning_comments(id,post_id,team_id,author_id,root_id,reply_to_id,text,created_at,updated_at) VALUES('reply',?,?,?,'root','root','回复',?,?)", saved.id, membership.teamId, user.id, at, at),
        sql("INSERT INTO learning_comment_moderation (id,comment_id,actor_id,action,reason,created_at) SELECT id,'root',?,'report','合成',? FROM operations WHERE key='old-publish'", user.id, at),
        sql("INSERT INTO topic_learning_associations (post_id,published_version,status) VALUES(?,?,'pending')", saved.id, published.version),
        sql("INSERT INTO learning_activity_events (sequence,id,post_id,author_epoch,shared_at,revoked_at) VALUES(101,'old-event',?,?,?,?)", saved.id, membership.epoch, at, at),
        sql("INSERT INTO learning_activity_events (sequence,id,post_id,author_epoch,shared_at) VALUES(102,'removed-event',?,?,?)", saved.id, membership.epoch, at),
        sql("DELETE FROM learning_activity_events WHERE sequence=102"),
    ]);
    const tables = ['learning_posts', 'learning_post_publications', 'learning_images', 'learning_draft_images', 'learning_publication_images',
        'learning_comments', 'learning_comment_moderation', 'topic_learning_associations', 'learning_activity_events'];
    const before = await Promise.all(tables.map(table => rows(table)));
    before.forEach(result => assert.ok(result.length > 0));
    await migrate('0018_learning_categories.sql');
    assert.deepEqual(await Promise.all(tables.map(table => rows(table))), before);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    await sql("INSERT INTO learning_activity_events (id,post_id,author_epoch,shared_at) VALUES('next-event',?,?,?)", saved.id, membership.epoch, at).run();
    assert.equal((await rows('learning_activity_events')).at(-1).sequence, 103);
    for (const file of (await readdir(directory)).filter(name=>name.endsWith('.sql') && name>'0018_learning_categories.sql').sort()) await migrate(file);
    assert.equal((await draft(s, saved.id)).body, '私人新版');
    assert.equal((await s.getLearningPost(reader, saved.id)).body, input.body);
});

test('workspace material files bind to the edited item, survive publication and respect withdrawal', async t => {
    const {s,db}=await fixture(t);
    const photo=photos[0], clip=await readFile(new URL('../fixtures/synthetic-pass.mp4',import.meta.url));
    const digest=async(bytes)=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    async function attach(who,kind,parentId,mime,bytes,key) {
        const meta={kind,parentId,mime,bytes:bytes.length,digest:await digest(bytes)};
        const {id}=await s.reserveMaterialAsset(who,meta,key);
        const request=()=>new Request('https://kapok.test/file',{method:'PUT',body:bytes,headers:{'content-type':mime,'content-length':String(bytes.length)}});
        assert.deepEqual(await s.putMaterialAsset(who,id,request(),key),{id});
        assert.deepEqual(await s.putMaterialAsset(who,id,request(),key),{id});
        return id;
    }
    const draft=await s.saveLearningPost(author,null,input,'compose');
    const clipId=await attach(author,'post',draft.id,'video/mp4',clip,'clip');
    const photoId=await attach(author,'post',draft.id,photo.type,photo.bytes,'photo');
    const url='/api/v1/material-assets/'+clipId;
    const fields={...input,kind:'video',video:{source:'upload',url},workspaceDetails:{
        date:'2026-11-23',photos:[{id:photoId,alt:'合成图片'}],chapters:{[url]:[{at:0,title:'开场'}]},
    }};
    const edit=await s.saveLearningPost(author,draft.id,{...fields,...version(draft)},'save');
    await denied(s.getMaterialAsset(reader,clipId,null),'NOT_FOUND');
    const preview=await s.getMaterialAsset(author,photoId,null);
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),photo.bytes);
    const published=await s.publishLearningPost(author,draft.id,publicationVersion(edit),'pub');
    const playback=await s.getMaterialAsset(reader,clipId,'bytes=2-7');
    assert.equal(playback.status,206);
    assert.deepEqual(Buffer.from(await playback.arrayBuffer()),clip.subarray(2,8));
    const post=await s.getLearningPost(reader,draft.id);
    assert.deepEqual(post.video,fields.video);
    assert.deepEqual(JSON.parse(post.workspaceDetails),fields.workspaceDetails);
    const other=await s.saveLearningPost(reader,null,input,'different');
    await denied(s.saveLearningPost(reader,other.id,{...fields,...version(other)},'copy'),'VERSION_CONFLICT');
    await s.withdrawLearningPost(author,draft.id,publicationVersion(published),'withdraw');
    await denied(s.getMaterialAsset(reader,photoId,null),'NOT_FOUND');
    const training=(await s.publishTraining(admin,{title:'训练',description:'训练简介',date:'2026-11-23'},'new')).training;
    const trainingPhoto=await attach(admin,'training',training.id,photo.type,photo.bytes,'training-photo');
    const workspaceDetails={category:'防守',body:'要点',photos:[{id:trainingPhoto,alt:'练习示意'}],chapters:{}};
    const newTraining=await s.saveTraining(admin,training.id,{workspaceDetails,title:training.title,date:training.date,description:training.description,status:'published',expectedVersion:training.version},'training-edit');
    assert.equal(JSON.parse(newTraining.workspaceDetails).body,'要点');
    assert.equal(newTraining.publisherId,(await s.me(admin)).user.id);
    assert.deepEqual(new Uint8Array(await (await s.getMaterialAsset(reader,trainingPhoto,null)).arrayBuffer()),photo.bytes);
    await denied(s.reserveMaterialAsset(reader,{kind:'training',parentId:training.id,mime:photo.type,bytes:photo.bytes.length,digest:await digest(photo.bytes)},'deny'),'NOT_FOUND');
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

test('workspace editor publishes a local video and photos, rereads chapters and preserves other training videos', async t => {
    const {s}=await fixture(t);
    const {saveMaterial,loadMaterial,selectVideo}=await import('../../app/workspace-ui/materials.js');
    const {parseVideo}=await import('../../app/workspace-ui/video-source.js');
    const origin='https://kapok.test';
    const session=async who=>{
        const actorId=await actorKey(who), account=await s.me(who), controller=new AbortController();
        async function handle(path,method='GET',body,key=crypto.randomUUID()) {
            const response=await api(s,who,method,path,{payload:body,key});
            const envelope=await response.json();
            assert.equal(response.status,200,envelope.error?.message);
            return envelope.data;
        }
        return {actorId,account,signal:controller.signal,read:path=>handle(path),write:handle};
    };
    const authorContext=await session(author), adminContext=await session(admin);
    const actors=new Map([[authorContext.actorId,author],[adminContext.actorId,admin]]);
    const originalFetch=globalThis.fetch;
    t.after(()=>{globalThis.fetch=originalFetch;});
    globalThis.fetch=async(url,options)=>{
        if (typeof url!=='string' || !url.startsWith('/api/v1/')) return originalFetch(url,options);
        const headers=new Headers(options.headers);
        headers.set('Origin',origin);headers.set('Content-Length',String(options.body.size));
        return dispatchApi(new Request(origin+url,{...options,headers}),url.slice(8).split('/'),actors.get(headers.get('X-Kapok-Actor')),s);
    };
    // A one-frame WebM containing the real 2x2 VP8 keyframe of the image fixture.
    const element=(hex,...parts)=>{
        const content=Buffer.concat(parts.map(part=>Buffer.from(part)));
        const len=content.length<127 ? [128+content.length] : [64+(content.length>>8),content.length&255];
        return Buffer.concat([Buffer.from(hex,'hex'),Buffer.from(len),content]);
    };
    const dur=Buffer.alloc(8);dur.writeDoubleBE(1000);
    const header=element('1a45dfa3',element('4282',Buffer.from('webm')));
    const frame=photos[2].bytes.slice(20);
    const webm=Buffer.concat([header,element('18538067',
        element('1549a966',element('4489',dur)),
        element('1654ae6b',element('ae',element('d7',[1]),element('83',[1]),element('86',Buffer.from('V_VP8')),element('e0',element('b0',[2]),element('ba',[2])))),
        element('1f43b675',element('e7',[0]),element('a3',[0x81,0,0,0x80],frame)))]);
    const form={kind:'video',title:'视频与照片',date:'2026-11-23',category:'场上复盘',summary:'学习',body:'练习要点',photos:[{
        file:new File([photos[0].bytes],'test.png',{type:'image/png'}),alt:'图片',
    }],clipFile:new File([webm],'clip.webm',{type:'video/webm'}),source:null,timepoints:[{at:0,title:'开始'}]};
    const postId=await saveMaterial(authorContext,null,form,authorContext.signal,{key:'workspace-compose'});
    const reading=selectVideo(await loadMaterial(adminContext,{id:postId,kind:'video'},adminContext.signal));
    assert.equal(reading.title,form.title);
    assert.equal(reading.photos[0].alt,'图片');
    assert.deepEqual(reading.timepoints,form.timepoints);
    assert.equal(reading.video.source,'upload');
    const media=await s.getMaterialAsset(admin,reading.video.url.split('/').at(-1),'bytes=0-3');
    assert.equal(media.headers.get('Content-Type'),'video/webm');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()),webm.subarray(0,4));
    const existing=selectVideo(await loadMaterial(authorContext,{id:postId,kind:'video'},authorContext.signal,true));
    await saveMaterial(authorContext,existing,{...existing,title:'已编辑本地视频',clipFile:null,timepoints:[{at:0,title:'新章节'}]},authorContext.signal,{key:'edit-native'});
    const refreshed=selectVideo(await loadMaterial(adminContext,{id:postId,kind:'video'},adminContext.signal));
    assert.equal(refreshed.title,'已编辑本地视频');
    assert.equal(refreshed.videoAsset,reading.videoAsset);
    assert.deepEqual(refreshed.photos,reading.photos);
    assert.deepEqual(refreshed.timepoints,[{at:0,title:'新章节'}]);
    const overview=JSON.parse((await s.listLearningPosts(admin)).find(row=>row.id===postId).workspaceDetails);
    assert.equal(overview.photos[0].id,refreshed.photos[0].id);
    assert.equal(overview.chapters,undefined);
    const trainingInput={...form,kind:'training',clipFile:null,photos:[],source:parseVideo('BV1xx411c7mD')};
    const id=await saveMaterial(adminContext,null,trainingInput,adminContext.signal,{key:'new-training'});
    const old=selectVideo(await loadMaterial(adminContext,{id,kind:'training'},adminContext.signal));
    const response=await s.saveComment(reader,old.selectedVideo.id,null,{text:'视频评论',timestampSec:2,referenceTimes:[2,5]},'comment');
    const item={...trainingInput,clipFile:form.clipFile,source:null,photos:form.photos};
    await saveMaterial(adminContext,old,item,adminContext.signal,{key:'append-webm'});
    const both=await loadMaterial(authorContext,{id,kind:'training'},authorContext.signal);
    assert.equal(both.videos.length,2);
    const latest=selectVideo(both,both.videos[1].id);
    assert.deepEqual(latest.timepoints,item.timepoints);
    assert.deepEqual(selectVideo(both,old.selectedVideo.id).timepoints,trainingInput.timepoints);
    assert.equal(latest.photos.length,1);
    const trainingOverview=JSON.parse((await s.listTrainings(reader)).find(row=>row.id===id).workspaceDetails);
    assert.equal(trainingOverview.photos[0].id,latest.photos[0].id);
    assert.equal(trainingOverview.body,undefined);
    assert.equal(trainingOverview.chapters,undefined);
    const stored=(await s.listComments(reader,old.selectedVideo.id))[0];
    assert.equal(stored.id,response.id);
    assert.deepEqual(JSON.parse(stored.referenceTimes),[2,5]);
    const team=await s.writeTrainingDiscussion(author,id,null,{text:'整场训练'},'thread');
    await s.writeTrainingDiscussion(reader,id,null,{text:'回应',rootId:team.id,replyToId:team.id},'reply');
    assert.equal((await s.readTrainingDiscussion(reader,id)).length,2);
    await s.writeTrainingDiscussion(author,id,team.id,{action:'delete',expectedVersion:1},'remove');
    const after=await s.readTrainingDiscussion(reader,id);
    assert.equal(after.find(c=>c.id===team.id).text,null);
    assert.equal(after.find(c=>c.rootId===team.id).text,'回应');
    const exported=await s.exportOwnData(author), readerExport=await s.exportOwnData(reader);
    assert.equal(exported.materialAssets.length,2);
    assert.equal(exported.materialAssets.every(a=>a.parentId===postId),true);
    assert.deepEqual(exported.learningPosts[0].publication.workspaceDetails.chapters[reading.videoAsset],refreshed.timepoints);
    assert.deepEqual(exported.trainingDiscussions.map(row=>row.id),[team.id]);
    assert.deepEqual(readerExport.materialAssets,[]);
    assert.deepEqual(readerExport.trainingDiscussions.map(row=>row.text),['回应']);
    assert.deepEqual(readerExport.comments.find(c=>c.id===response.id).referenceTimes,[2,5]);
    const quietAccount=await s.exportOwnData(admin);
    assert.deepEqual(quietAccount.trainingDiscussions,[]);
    assert.deepEqual(quietAccount.learningPosts,[]);
});

test('workspace dispatch archives training videos on the selected day across pages and leaves discussion and publication times intact', async t => {
    const { s, db } = await fixture(t);
    const publish = date => s.publishTraining(admin, {title:'大学城训练', date, description:'',
        video:{title:'训练片段',url:'https://www.bilibili.com/video/BV1xx411c7mD/'}}, crypto.randomUUID());
    const recent = await publish('2020-10-19');
    const older = await publish('2020-09-25');
    const auditTime = () => db.prepare('SELECT published_at FROM video_events WHERE video_id=?').bind(older.video.id).first('published_at');
    const publishedAt = await auditTime();
    const comment = await s.saveComment(reader, older.video.id, null, {text:'今天的观察'}, 'comment');

    // Historical bulk imports can span a page within a single activity day.
    await db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100)
        INSERT INTO videos(id,training_id,team_id,title,source,url,position,status,created_at,updated_at,publisher_id)
        SELECT 'archive-'||n,training_id,team_id,title,source,url,n+1,status,created_at,updated_at,publisher_id
        FROM videos,seq WHERE videos.id=?`).bind(older.video.id).run();
    const first = await s.workspaceDispatch(reader,null);
    const second = await s.workspaceDispatch(reader,first.next);
    assert.equal(first.items.length,100);
    assert.equal(second.next,null);
    const items = [...first.items,...second.items];
    assert.equal(items.length,103);
    assert.equal(new Set(items.map(row=>row.key)).size,103);
    assert.equal(items[0].comment,comment.id);
    assert.equal(items[0].date,await db.prepare('SELECT created_at FROM video_comments WHERE id=?').bind(comment.id).first('created_at'));
    assert.equal(items[1].video,recent.video.id);
    assert.equal(items[1].date,'2020-10-19');
    assert.ok(items.slice(2).every(row=>row.source===older.training.id && row.date==='2020-09-25'));
    await s.saveTraining(admin,older.training.id,{date:'2020-10-20',title:'更正日期',description:'',
        status:'published',expectedVersion:older.training.version},'correct');
    const corrected = await s.workspaceDispatch(reader,null);
    assert.equal(corrected.items[1].date,'2020-10-20');
    assert.equal(corrected.items[1].source,older.training.id);
    assert.equal(await auditTime(),publishedAt);
});

test('shared videos use the published record date while articles and undated videos keep the original share time', async t => {
    const { s } = await fixture(t);
    await s.createLearningCategory(author,{name:'随谈'},'daily-category');
    for (const data of [{kind:'video',video:{source:'bilibili',url:'https://www.bilibili.com/video/BV1xx411c7mD/'}}, {workspaceDetails:{date:'2020-09-25'}}, {kind:'video',video:{source:'bilibili',url:'https://www.bilibili.com/video/BV1xx411c7mD/'},workspaceDetails:{date:'2020-10-19'}}]) {
        const post = await s.saveLearningPost(author,null,{...input,...data,category:'随谈'},crypto.randomUUID());
        const published = await s.publishLearningPost(author,post.id,publicationVersion(post),crypto.randomUUID());
        await s.changeLearningActivity(author,post.id,{expectedPublishedVersion:published.publishedVersion,
            expectedMembershipEpoch:published.membershipEpoch,expectedEventId:null},crypto.randomUUID(),true);
        const {event} = await s.getLearningActivity(author,post.id);
        const expected = data.kind === 'video' && data.workspaceDetails?.date ? data.workspaceDetails.date : event.sharedAt;
        const get = async () => (await s.workspaceDispatch(reader,null)).items.find(row=>row.source===post.id);
        assert.equal((await get()).date,expected);
        const current = await draft(s,post.id);
        await s.saveLearningPost(author,post.id,{...input,...data,category:'随谈',workspaceDetails:{date:'2020-12-01'},
            expectedVersion:current.version},crypto.randomUUID());
        assert.equal((await get()).date,expected);
    }
});

test('team bulletin selects live member-visible sources, fences writes and falls back after withdrawal', async t => {
    const {s} = await fixture(t);
    const empty = {version:0,item:null,fallback:null,unavailable:false};
    assert.deepEqual(await s.readBulletin(reader),empty);
    await denied(s.bulletinOptions(reader,'',null),'FORBIDDEN');
    await denied(s.setBulletin(reader,{key:null,expectedVersion:0},'no'),'FORBIDDEN');
    const published=await s.saveAnnouncement(admin,null,{title:'精选通知',text:'需要集合',status:'published'},'notice');
    await s.saveAnnouncement(admin,null,{title:'精选草稿',text:'不可展示',status:'draft'},'draft');
    const opts=await s.bulletinOptions(admin,'精选',null);
    assert.equal(opts.items.length,1);
    const key=opts.items[0].key;
    const choice={key,expectedVersion:0};
    const selected=await s.setBulletin(admin,choice,'pin');
    assert.equal(selected.version,1);
    assert.equal(selected.item.href,'/announcements/'+published.id);
    assert.deepEqual(await s.readBulletin(reader),selected);
    assert.deepEqual(await s.setBulletin(admin,choice,'pin'),selected);
    await assert.rejects(s.setBulletin(admin,{key:null,expectedVersion:0},'old'));
    const draft=await s.saveAnnouncement(admin,published.id,{title:'精选通知',text:'草稿改动',status:'draft',expectedVersion:published.version},'revoke');
    assert.deepEqual(await s.readBulletin(reader),{version:1,item:null,fallback:null,unavailable:false});
    assert.deepEqual(await s.readBulletin(admin),{version:1,item:null,fallback:null,unavailable:true});
    await s.saveAnnouncement(admin,published.id,{title:'第二版',text:'新的正文',status:'published',expectedVersion:draft.version},'again');
    assert.equal((await s.readBulletin(reader)).item,null);
    await assert.rejects(s.setBulletin(admin,{key,expectedVersion:1},'stale-choice'));
    assert.deepEqual(await s.setBulletin(admin,{key:null,expectedVersion:1},'reset'),{version:2,item:null,fallback:null,unavailable:false});
});

test('team bulletin options paginate same-day content and a private reflection stays absent for its author', async t=>{
    const {s,db}=await fixture(t);
    const {membership}=await s.me(admin);
    const inserts=Array.from({length:35},(_,i)=>db.prepare(
        "INSERT INTO trainings(id,team_id,title,date,description,status,version,updated_at,created_at) VALUES(?,?,?,'2026-09-25','','published',1,'2026','2026')"
    ).bind('page-'+i,membership.teamId,'合成训练'+i));
    await db.batch(inserts);
    const first=await s.bulletinOptions(admin,'训练',null);
    const second=await s.bulletinOptions(admin,'训练',first.next);
    assert.equal(first.items.length,30);
    assert.equal(second.next,null);
    assert.equal(new Set([...first.items,...second.items].map(o=>o.key)).size,35);
    await denied(s.bulletinOptions(admin,'其他',first.next),'INVALID_INPUT');
    const privateNote=await s.saveReflection(admin,null,{title:'私人想法',text:'私人正文',date:'2026-11-24'},'private');
    assert.equal((await s.bulletinOptions(admin,'私人',null)).items.length,0);
    await assert.rejects(s.setBulletin(admin,{key:'n:'+privateNote.id+':1',expectedVersion:0},'forge'));
    const picked=first.items[0];
    await s.setBulletin(admin,{key:picked.key,expectedVersion:0},'pin');
    const id=picked.href.split('/').at(-1);
    await db.prepare("UPDATE trainings SET title='更名' WHERE id=?").bind(id).run();
    assert.equal((await s.readBulletin(reader)).item.title,'更名');
    await db.prepare("UPDATE trainings SET status='hidden' WHERE id=?").bind(id).run();
    const fallback=(await s.readBulletin(reader)).fallback;
    assert.equal(fallback.type,'训练');
    assert.notEqual(fallback.href,picked.href);
    assert.equal(fallback.cover,'/workspace-assets/media/sideline-team.webp');
    await db.batch(['hidden','published'].map(status=>db.prepare('UPDATE trainings SET status=? WHERE id=?').bind(status,id)));
    assert.equal((await s.readBulletin(reader)).item,null);
});

test('team bulletin keeps edited comments and invalidates the selection across moderation cycles', async t => {
    const {s}=await fixture(t);
    const {video}=await s.publishTraining(admin,{title:'训练',date:'2026-10-19',description:'',
        video:{title:'视频',url:'https://www.bilibili.com/video/BV1xx411c7mD/'}},'publish-video');
    const post=await s.saveLearningPost(author,null,input,'new-post');
    await s.publishLearningPost(author,post.id,publicationVersion(post),'publish-post');
    const vc=await s.saveComment(reader,video.id,null,{text:'视频留言'},'add-video-comment');
    const pc=await s.saveLearningComment(reader,post.id,null,{text:'图文留言'},'add-post-comment');
    const timed=await s.saveComment(reader,video.id,null,{text:'',timestampSec:10,referenceTimes:[10,30]},'timed-only');
    const timedOption=(await s.bulletinOptions(admin,'00:30',null)).items.find(x=>x.href.includes(timed.id));
    assert.equal(timedOption.summary,'视频时刻 · 00:10、00:30');
    const cases=[
        {id:vc.id,edit:()=>s.saveComment(reader,video.id,vc.id,{text:'修改后的留言',expectedVersion:1},'edit-vc'),
            moderate:(action)=>s.moderateComment(admin,vc.id,{action,reason:'治理'},action+'-vc')},
        {id:pc.id,edit:()=>s.saveLearningComment(reader,post.id,pc.id,{text:'修改后的留言',expectedVersion:1},'edit-pc'),
            moderate:(action)=>s.moderateLearningComment(admin,post.id,pc.id,{action,reason:'治理',expectedVersion:action==='hide'?2:3},action+'-pc')},
    ];
    let version=0;
    for(const example of cases){
        const option=(await s.bulletinOptions(admin,'留言',null)).items.find(x=>x.href.includes(example.id));
        const set=await s.setBulletin(admin,{key:option.key,expectedVersion:version},'pin-'+example.id);
        version=set.version;
        await example.edit();
        assert.equal((await s.readBulletin(reader)).item.summary,'修改后的留言');
        await example.moderate('hide');
        assert.equal((await s.readBulletin(reader)).item,null);
        await example.moderate('restore');
        assert.equal((await s.readBulletin(reader)).item,null);
        const available=(await s.bulletinOptions(admin,'修改后的留言',null)).items.find(x=>x.href.includes(example.id));
        assert.notEqual(available.key,option.key);
    }
});

test('bulletin prefers the published custom cover for both video entry points', async t=>{
    const {s,db}=await fixture(t);
    const url='https://www.bilibili.com/video/BV1xx411c7mD/';
    const {training,video}=await s.publishTraining(admin,{title:'封面训练',date:'2026-09-25',description:'',video:{title:'封面片段',url}},'train-cover');
    const p=await s.saveLearningPost(author,null,{...input,kind:'video',title:'封面视频',video:{source:'bilibili',url}},'post-cover');
    await s.publishLearningPost(author,p.id,publicationVersion(p),'publish-cover');
    const options=async()=> (await s.bulletinOptions(admin,'封面',null)).items;
    const published=(await options()).find(item=>item.href==='/trainings/'+p.id);
    assert.equal(published.cover,'/api/v1/video-covers/post/'+p.id);
    const details=JSON.stringify({photos:[{id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',alt:'',coverOnly:true}]});
    await db.batch([
      db.prepare('UPDATE trainings SET workspace_details=? WHERE id=?').bind(details,training.id),
      db.prepare('UPDATE learning_post_publications SET workspace_details=? WHERE post_id=?').bind(details,p.id),
    ]);
    const expected='/api/v1/material-assets/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    assert.equal((await options()).find(item=>item.href.endsWith('?video='+video.id)).cover,expected);
    await s.setBulletin(admin,{key:published.key,expectedVersion:0},'pin-cover');
    assert.equal((await s.readBulletin(reader)).item.cover,expected);
});
