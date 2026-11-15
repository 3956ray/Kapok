import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const admin = principal('collection-admin');
const author = principal('collection-author');
const reader = principal('collection-reader');
const directory = new URL('../../drizzle/', import.meta.url);
const version = draft => ({ expectedVersion: draft.version });
const publication = draft => ({ ...version(draft), expectedMembershipEpoch: draft.membershipEpoch });
const ref = id => ({ kind: 'post', id });
const input = { kind: 'article', category: '战术', title: 'Synthetic post', body: 'Synthetic body' };
const topic = { title: 'Synthetic topic', summary: 'Synthetic summary' };
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
async function fixture(t, before0014 = false) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const migrate = async file => {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    };
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && (!before0014 || file < '0014')).sort()) await migrate(file);
    const make = (overrides = {}) => createService({ db, accessInitialAdminEmail: admin.verifiedEmail, ...overrides });
    const s = make();
    async function join(p) {
        await s.join(p, { intent: 'register', confirmed: true, discName: p.subject, jerseyNumber: '01' }, 'join');
    }
    for (const p of [admin, author, reader]) await join(p);
    return { s, db, make, migrate, join };
}
async function api(s, actor, method, path, input, key) {
    const origin = 'https://kapok.test';
    return dispatchApi(new Request(origin + '/api/v1/' + path, {
        method, headers: { Origin: origin, 'X-Kapok-Actor': await actorKey(actor), 'Idempotency-Key': key ?? '', 'Content-Type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input),
    }), path.split('?')[0].split('/'), actor, s);
}
async function post(s, who, key, extra = {}) {
    const d = await s.saveLearningPost(who, null, { ...input, ...extra }, key + '-draft');
    return s.publishLearningPost(who, d.id, publication(d), key + '-publish');
}

test('topic snapshots and per-item receipt isolate owner drafts and live-filter typed sources', async t => {
    const { s, db, join } = await fixture(t);
    const created = await api(s, author, 'POST', 'learning/collections', topic, 'create');
    assert.equal(created.status, 200);
    const { data: d } = await created.json();
    await denied(s.getTopicCollection(admin, d.id, 'draft'), 'NOT_FOUND');
    await denied(s.getTopicCollection(reader, d.id), 'NOT_FOUND');
    assert.deepEqual(await s.listEditableTopicCollections(admin), []);
    const p = await post(s, reader, 'p');
    const training = await s.saveTraining(admin, null, { title: '旧训练', date: '2026-11-01', description: '', status: 'draft' }, 'training');
    const video = await s.addVideo(admin, training.id, { title: 'Training video secret', source: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', position: 0 }, 'video');
    const vr = { kind: 'video', id: video.id };
    assert.equal((await s.listTopicSources(admin)).some(item => item.id === video.id), false);
    await denied(s.addTopicItems(author, d.id, { ...version(d), items: Array(11).fill(vr) }, 'too-many'), 'INVALID_INPUT');
    const unavailable = await s.addTopicItems(author, d.id, { ...version(d), items: [ref('missing'), vr] }, 'unavailable');
    assert.deepEqual(unavailable.outcomes.map(o => o.status), ['unavailable', 'unavailable']);
    await db.prepare("UPDATE trainings SET status='archived' WHERE id=?").bind(training.id).run();
    const added = await s.addTopicItems(author, d.id, { ...version(unavailable.collection), items: [ref(p.id), vr, ref(p.id)] }, 'add');
    assert.deepEqual(added.outcomes.map(o => o.status), ['added', 'added', 'duplicate']);
    assert.deepEqual(await s.addTopicItems(author, d.id, { ...version(unavailable.collection), items: [ref(p.id), vr, ref(p.id)] }, 'add'), added);
    assert.equal(added.collection.items[0].author.discName, reader.subject);
    assert.equal(added.collection.items[1].author.discName, admin.subject);
    const ordered = await s.orderTopicItems(author, d.id, { ...version(added.collection), items: [vr, ref(p.id)] }, 'order');
    await denied(s.orderTopicItems(author, d.id, { ...version(added.collection), items: [ref(p.id), vr] }, 'stale'), 'VERSION_CONFLICT');
    const published = await s.publishTopicCollection(author, d.id, publication(ordered), 'publish');
    const later = principal('collection-later');
    await join(later);
    const visible = await s.getTopicCollection(later, d.id);
    assert.deepEqual(visible.items.map(({ kind, id }) => ({ kind, id })), [vr, ref(p.id)]);
    const removed = await s.removeTopicItem(author, d.id, { ...version(published), item: ref(p.id) }, 'remove');
    assert.equal(removed.items.length, 1);
    assert.equal((await s.getTopicCollection(later, d.id)).items.length, 2);
    assert.equal((await s.getLearningPost(later, p.id)).body, input.body);
    await s.hideLearningPost(admin, p.id, { expectedVersion: p.publishedVersion }, 'hide');
    await db.prepare("UPDATE trainings SET status='hidden' WHERE id=?").bind(training.id).run();
    for (const result of [await s.getTopicCollection(later, d.id), await s.getTopicCollection(author, d.id, 'draft'),
        (await s.listTopicCollections(later))[0]]) {
        assert.equal(result.items.length, 0);
        assert.doesNotMatch(JSON.stringify(result), /Synthetic post|Training video secret/);
    }
    assert.deepEqual(await s.listTopicSources(later), []);
    await s.withdrawTopicCollection(author, d.id, publication(removed), 'withdraw');
    await denied(s.getTopicCollection(later, d.id), 'NOT_FOUND');
});

test('post publishes once while a collection association is pending, then author retries only inclusion', async t => {
    const { s, db } = await fixture(t);
    const d = await s.saveTopicCollection(author, null, topic, 'topic');
    const draft = await s.saveLearningPost(author, null, { ...input, collectionTargetId: d.id }, 'post');
    await db.prepare(`CREATE TRIGGER interrupt_inclusion AFTER INSERT ON topic_collection_items BEGIN
        UPDATE learning_posts SET status='withdrawn' WHERE id=NEW.source_id;
        END`).run();
    const p = await s.publishLearningPost(author, draft.id, publication(draft), 'publish');
    assert.equal(p.association.status, 'pending');
    assert.equal((await s.getLearningPost(reader, p.id)).body, input.body);
    assert.deepEqual((await s.getLearningPost(author, p.id, 'draft')).association, p.association);
    assert.deepEqual((await s.getTopicCollection(author, d.id, 'draft')).items, []);
    await db.prepare('DROP TRIGGER interrupt_inclusion').run();
    assert.deepEqual(await s.publishLearningPost(author, draft.id, publication(draft), 'publish'), p);
    const alternate = await s.saveTopicCollection(author, null, { title: 'Alternate' }, 'alternate');
    const nextDraft = await s.saveLearningPost(author, p.id, { ...input, ...version(p), collectionTargetId: alternate.id }, 'change-target');
    const retry = { expectedPublishedVersion: p.publishedVersion };
    await denied(s.retryLearningInclusion(admin, p.id, retry, 'retry'), 'NOT_FOUND');
    const done = await s.retryLearningInclusion(author, p.id, retry, 'retry');
    assert.equal(done.status, 'added-draft');
    assert.deepEqual(await s.retryLearningInclusion(author, p.id, retry, 'retry'), done);
    assert.equal((await s.getTopicCollection(author, d.id, 'draft')).items.length, 1);
    assert.equal((await s.getLearningPost(author, p.id, 'draft')).version, nextDraft.version);
    assert.deepEqual((await s.getTopicCollection(author, alternate.id, 'draft')).items, []);
    const other = await s.saveTopicCollection(reader, null, topic, 'foreign');
    const partial = await post(s, author, 'other', { collectionTargetId: other.id });
    assert.equal(partial.association.status, 'pending');
    assert.equal((await s.getLearningPost(reader, partial.id)).publishedVersion, partial.publishedVersion);
    assert.equal((await s.getTopicCollection(reader, other.id, 'draft')).items.length, 0);
});

test('featured authorizes direct management, persists order and omits invalidated collections and items', async t => {
    const { s } = await fixture(t);
    const draft = await s.saveTopicCollection(author, null, topic, 'first');
    const source = await post(s, reader, 'featured-source');
    const { collection: first } = await s.addTopicItems(author, draft.id, { ...version(draft), items: [ref(source.id)] }, 'source');
    const second = await s.saveTopicCollection(reader, null, { ...topic, title: 'Second' }, 'second');
    const a = await s.publishTopicCollection(author, first.id, publication(first), 'first-publish');
    const b = await s.publishTopicCollection(reader, second.id, publication(second), 'second-publish');
    const current = await s.getFeaturedTopics(admin, true);
    const input = { expectedVersion: current.version, collectionIds: [b.id, a.id] };
    assert.equal((await api(s, reader, 'PATCH', 'learning/featured', input, 'denied')).status, 403);
    await denied(s.updateFeaturedTopics(admin, { expectedVersion: 0, collectionIds: [a.id, b.id, 'third', 'fourth'] }, 'too-many'), 'INVALID_INPUT');
    await denied(s.updateFeaturedTopics(admin, { expectedVersion: 0, collectionIds: [a.id, a.id] }, 'duplicate'), 'INVALID_INPUT');
    await denied(s.updateFeaturedTopics(admin, { expectedVersion: 0, collectionIds: ['missing'] }, 'missing'), 'NOT_FOUND');
    assert.equal((await api(s, reader, 'GET', 'learning/featured?view=admin')).status, 403);
    const saved = await s.updateFeaturedTopics(admin, input, 'update');
    assert.deepEqual(saved.collections.map(c => c.id), [b.id, a.id]);
    assert.deepEqual(await s.updateFeaturedTopics(admin, input, 'update'), saved);
    await denied(s.updateFeaturedTopics(admin, input, 'old-version'), 'VERSION_CONFLICT');
    await s.withdrawLearningPost(reader, source.id, publication(source), 'withdraw-source');
    const visible = (await s.getFeaturedTopics(reader)).collections.find(c => c.id === a.id);
    assert.deepEqual(visible.items, []);
    assert.doesNotMatch(JSON.stringify(visible), /Synthetic post/);
    const removed = await s.updateFeaturedTopics(admin, { expectedVersion: saved.version, collectionIds: [a.id] }, 'remove');
    assert.equal(removed.collections.length, 1);
    assert.equal((await s.getTopicCollection(author, b.id)).id, b.id);
    const withdrawn = await s.withdrawTopicCollection(author, a.id, publication(a), 'withdraw');
    assert.deepEqual((await s.getFeaturedTopics(reader)).collections, []);
    await s.publishTopicCollection(author, a.id, publication(withdrawn), 'republish');
    assert.deepEqual((await s.getFeaturedTopics(reader)).collections, []);
});

test('explicit inclusion into a published collection appends only that reference and replays the publication receipt', async t => {
    const { s, db, make } = await fixture(t);
    const d = await s.saveTopicCollection(author, null, topic, 'topic');
    const published = await s.publishTopicCollection(author, d.id, publication(d), 'topic-pub');
    const privateTopic = await s.saveTopicCollection(author, d.id, { title: 'Private title', ...version(published) }, 'edit-private');
    const privateRef = await post(s, reader, 'private-draft-item');
    const { collection: edited } = await s.addTopicItems(author, d.id, { ...version(privateTopic), items: [ref(privateRef.id)] }, 'draft-only');
    const draft = await s.saveLearningPost(author, null, { ...input, collectionTargetId: d.id }, 'draft');
    // Drop the inclusion response by intercepting the second write batch.
    let batches = 0;
    const interrupted = make({ db: {
        prepare: db.prepare.bind(db),
        async batch(statements) {
            const result = await db.batch(statements);
            if (++batches === 2) throw new Error('synthetic lost inclusion response');
            return result;
        },
    } });
    const result = await interrupted.publishLearningPost(author, draft.id, publication(draft), 'pub');
    assert.equal(batches, 2);
    assert.equal(result.association.status, 'added-published');
    assert.deepEqual(await s.publishLearningPost(author, draft.id, publication(draft), 'pub'), result);
    const live = await s.getTopicCollection(reader, d.id);
    assert.equal(live.title, topic.title);
    assert.deepEqual(live.items.map(item => item.id), [draft.id]);
    const current = await s.getTopicCollection(author, d.id, 'draft');
    assert.equal(current.title, 'Private title');
    assert.equal(current.version, edited.version + 1);
    assert.equal(live.publishedVersion, current.version);
    assert.deepEqual(current.items.map(item => item.id), [privateRef.id, draft.id]);
    await denied(s.publishTopicCollection(author, d.id, publication(edited), 'stale'), 'VERSION_CONFLICT');
});

test('D1 rolls back topic item, target ownership and membership transitions inside writes', async t => {
    const { s, db } = await fixture(t);
    const src = await post(s, reader, 'source');
    const d = await s.saveTopicCollection(author, null, topic, 'topic');
    const input = { ...version(d), items: [ref(src.id)] };
    await db.prepare(`CREATE TRIGGER late_source AFTER INSERT ON topic_collection_items
        BEGIN UPDATE learning_posts SET status='withdrawn' WHERE id=NEW.source_id; END`).run();
    await denied(s.addTopicItems(author, d.id, input, 'add'), 'VERSION_CONFLICT');
    assert.equal((await s.getLearningPost(author, src.id)).body, 'Synthetic body');
    assert.deepEqual(await s.getTopicCollection(author, d.id, 'draft'), d);
    await db.prepare('DROP TRIGGER late_source').run();
    const { collection: withItem } = await s.addTopicItems(author, d.id, input, 'add');

    await db.prepare(`CREATE TRIGGER late_reader AFTER UPDATE ON topic_collections
        BEGIN UPDATE memberships SET status='paused' WHERE user_id=NEW.owner_id; END`).run();
    await denied(s.publishTopicCollection(author, d.id, publication(withItem), 'topic-pub'), 'VERSION_CONFLICT');
    assert.deepEqual(await s.getTopicCollection(author, d.id, 'draft'), withItem);
    await db.prepare('DROP TRIGGER late_reader').run();
    await s.publishTopicCollection(author, d.id, publication(withItem), 'topic-pub');

    await db.prepare(`CREATE TRIGGER late_target AFTER INSERT ON topic_collection_items
        BEGIN UPDATE topic_collections SET owner_id=(SELECT owner_id FROM learning_posts WHERE id='${src.id}')
            WHERE id=NEW.collection_id; END`).run();
    const pending = await post(s, author, 'target', { collectionTargetId: d.id });
    assert.equal(pending.association.status, 'pending');
    assert.deepEqual((await s.getTopicCollection(author, d.id, 'draft')).items.map(item => item.id), [src.id]);
    assert.equal((await s.getLearningPost(reader, pending.id)).publishedVersion, pending.publishedVersion);
    await db.prepare('DROP TRIGGER late_target').run();
    const retried = await api(s, author, 'POST', 'learning/posts/' + pending.id + '/inclusion-retry',
        { expectedPublishedVersion: pending.publishedVersion }, 'retry');
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).data.status, 'added-published');
});

test('0014 preserves populated learning, training and old private collection rows', async t => {
    const { s, db, migrate } = await fixture(t, true);
    const authorAccount = await s.me(author);
    await db.prepare(`INSERT INTO learning_posts(id,team_id,owner_id,kind,category,title,summary,body,status,version,created_at,updated_at)
        VALUES('existing-post',?,?,'article','战术','Existing','Summary','Body','published',2,'2026-11-15','2026-11-15')`)
        .bind(authorAccount.membership.teamId, authorAccount.user.id).run();
    await db.prepare(`INSERT INTO learning_post_publications(post_id,kind,category,title,summary,body,version,author_epoch,published_at)
        VALUES('existing-post','article','战术','Existing','Summary','Body',2,?,'2026-11-15')`).bind(authorAccount.membership.epoch).run();
    const training = await s.publishTraining(admin, { title: '旧训练', date: '2026-11-15', description: '',
        video: { title: '旧视频', url: 'https://youtu.be/dQw4w9WgXcQ' } }, 'legacy');
    await s.saveCollection(author, null, { sourceKind: 'video', sourceId: training.video.id, privateNote: '原备注' }, 'legacy');
    const tables = ['learning_posts', 'learning_post_publications', 'trainings', 'videos', 'collections', 'operations'];
    const snapshot = async () => (await db.batch(tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1')))).map(r => r.results);
    const before = await snapshot();
    await migrate('0014_topic_collections.sql');
    assert.deepEqual(await snapshot(), before);
    assert.equal((await s.getLearningPost(reader, 'existing-post')).body, 'Body');
    assert.equal((await s.getLearningPost(author, 'existing-post', 'draft')).association, null);
    assert.equal((await s.listCollections(author))[0].privateNote, '原备注');
    assert.deepEqual(await s.listTopicCollections(author), []);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
});

test('a failed first inclusion read returns the committed post and its persisted retry target', async t => {
    const { s, db, make } = await fixture(t);
    const d = await s.saveTopicCollection(author, null, topic, 'topic');
    const draft = await s.saveLearningPost(author, null, { ...input, collectionTargetId: d.id }, 'draft');
    const interrupted = make({ db: {
        prepare(sql) {
            if (sql.startsWith('SELECT lpub.collection_target_id AS targetId')) throw new Error('synthetic D1 read timeout');
            return db.prepare(sql);
        },
        batch: db.batch.bind(db),
    } });
    const result = await interrupted.publishLearningPost(author, draft.id, publication(draft), 'publish');
    assert.deepEqual(result.association, { status: 'pending', targetId: d.id, publishedVersion: result.publishedVersion });
    assert.equal((await s.getLearningPost(reader, result.id)).body, input.body);
    assert.equal((await s.retryLearningInclusion(author, result.id, { expectedPublishedVersion: result.publishedVersion }, 'retry')).status, 'added-draft');
});

test('topic writes retain the principal binding in the shared learning fence', async t => {
    const { s, db } = await fixture(t);
    const d = await s.saveTopicCollection(author, null, topic, 'topic');
    const values = await Promise.all([s.me(author), s.me(reader)]);
    const ids = values.map(value => value.user.id);
    await db.prepare(`CREATE TRIGGER late_identity AFTER UPDATE ON topic_collections BEGIN
        UPDATE auth_identities SET subject='retired-topic-author' WHERE user_id='${ids[0]}' AND provider='access';
        UPDATE auth_identities SET subject='${author.subject}' WHERE user_id='${ids[1]}' AND provider='access';
    END`).run();

    await denied(s.publishTopicCollection(author, d.id, publication(d), 'raced-identity'), 'VERSION_CONFLICT');
    assert.deepEqual(await s.getTopicCollection(author, d.id, 'draft'), d);
    assert.equal((await s.me(author)).user.id, ids[0]);
    assert.equal((await s.me(reader)).user.id, ids[1]);
    assert.equal(await db.prepare("SELECT id FROM operations WHERE key='raced-identity'").first(), null);
});
