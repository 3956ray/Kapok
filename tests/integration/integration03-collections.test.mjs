import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
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
async function fixture(t, cutoff) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}',
        compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const migrate = async file => {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    };
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql') && (!cutoff || file < cutoff)).sort()) await migrate(file);
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
    const { s, db, migrate } = await fixture(t, '0014');
    const authorAccount = await s.me(author);
    await db.prepare(`INSERT INTO learning_posts(id,team_id,owner_id,kind,category,title,summary,body,status,version,created_at,updated_at)
        VALUES('existing-post',?,?,'article','战术','Existing','Summary','Body','published',2,'2026-11-15','2026-11-15')`)
        .bind(authorAccount.membership.teamId, authorAccount.user.id).run();
    await db.prepare(`INSERT INTO learning_post_publications(post_id,kind,category,title,summary,body,version,author_epoch,published_at)
        VALUES('existing-post','article','战术','Existing','Summary','Body',2,?,'2026-11-15')`).bind(authorAccount.membership.epoch).run();
    // Seed the historical row format before later migrations introduce new write fields.
    await db.batch([
        db.prepare("INSERT INTO trainings(id,team_id,title,date,description,status,created_at,updated_at) VALUES('old-training',?,'旧训练','2026-11-15','','published','2026-11-15','2026-11-15')").bind(authorAccount.membership.teamId),
        db.prepare("INSERT INTO videos(id,training_id,team_id,title,source,url,position,created_at,updated_at) VALUES('old-video','old-training',?,'旧视频','youtube','https://youtu.be/dQw4w9WgXcQ',0,'2026-11-15','2026-11-15')").bind(authorAccount.membership.teamId),
        db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,private_note,created_at,updated_at) VALUES('old-bookmark',?,'video','old-video','原备注','2026-11-15','2026-11-15')").bind(authorAccount.user.id),
    ]);
    const tables = ['learning_posts', 'learning_post_publications', 'trainings', 'videos', 'collections', 'operations'];
    const snapshot = async () => (await db.batch(tables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1')))).map(r => r.results);
    const before = await snapshot();
    await migrate('0014_topic_collections.sql');
    assert.deepEqual(await snapshot(), before);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql') && name > '0014_topic_collections.sql').sort()) await migrate(file);
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

test('workspace collections project old D1 records and atomically publish ordered live sources', async t => {
    const { s, db } = await fixture(t);
    const legacy = await s.saveTopicCollection(author, null, topic, 'old');
    const legacyPublication = await s.publishTopicCollection(author, legacy.id, publication(legacy), 'make-public');
    const readerRows = await s.workspaceTopics(reader);
    assert.deepEqual(readerRows.map(row => [row.id, row.category, row.published]), [[legacy.id, '', 1]]);
    const training = await s.saveTraining(admin, null, { title: 'Footwork', date: '2026-11-11', description: '', status: 'published' }, 'session');
    const article = await post(s, reader, 'study');
    const newItems = [{ kind: 'training', id: training.id }, ref(article.id)];
    const payload = { title: 'New group', summary: 'Read in order', category: '防守', items: newItems, ...publication(legacyPublication) };
    assert.equal((await api(s, reader, 'PATCH', 'workspace/topics/' + legacy.id, payload, 'not-mine')).status, 404);
    const saved = await api(s, author, 'PATCH', 'workspace/topics/' + legacy.id, payload, 'revise');
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).data.id, legacy.id);
    assert.equal((await api(s, author, 'PATCH', 'workspace/topics/' + legacy.id, payload, 'revise')).status, 200);
    const [fresh] = await s.workspaceTopics(reader);
    assert.deepEqual(fresh.items.map(({kind,id}) => ({kind,id})), newItems);
    assert.equal(fresh.category, '防守');
    await db.prepare("UPDATE trainings SET status='hidden' WHERE id=?").bind(training.id).run();
    assert.deepEqual((await s.workspaceTopics(reader))[0].items.map(x => x.id), [article.id]);
    const create = {...payload, expectedVersion: 0};
    assert.equal((await api(s, author, 'POST', 'workspace/topics', create, 'hidden-content')).status, 409);
    assert.equal((await s.workspaceTopics(reader)).length, 1);
    assert.equal((await api(s, author, 'DELETE', 'workspace/topics/' + legacy.id, publication(legacyPublication), 'stale')).status, 409);
    const current = await s.getTopicCollection(author, legacy.id, 'draft');
    const del = () => api(s, author, 'DELETE', 'workspace/topics/' + legacy.id, publication(current), 'delete');
    assert.equal((await del()).status, 200);
    assert.equal((await del()).status, 200);
    assert.deepEqual(await s.workspaceTopics(reader), []);
    assert.equal((await s.getLearningPost(reader,article.id)).id,article.id);
});


test('0020 upgrades populated directories without changing old chapter order or publication revisions', async t => {
    const { s, db, migrate } = await fixture(t, '0020');
    const account = await s.me(author);
    await db.batch([
        db.prepare("INSERT INTO topic_collections(id,team_id,owner_id,title,summary,status,version,created_at,updated_at) VALUES('old',?,?,'Draft','intro','published',7,'2026-11-15','2026-11-15')").bind(account.membership.teamId,account.user.id),
        db.prepare("INSERT INTO topic_collection_publications(collection_id,title,summary,version,author_epoch,visibility_id,published_at) VALUES('old','Publication','intro',6,?,'visible','2026-11-15')").bind(account.membership.epoch),
        db.prepare("INSERT INTO topic_collection_items(collection_id,snapshot,kind,source_id,position) VALUES ('old',1,'post','old-post',0),('old',1,'video','old-video',1),('old',0,'video','old-video',0),('old',0,'post','old-post',1)"),
    ]);
    const read = async () => (await db.prepare('SELECT * FROM topic_collection_items ORDER BY snapshot,position').all()).results;
    const before = await read();
    await migrate('0020_workspace_topics.sql');
    await migrate('0025_workspace_topic_covers.sql');
    assert.deepEqual(await read(),before);
    assert.deepEqual((await s.workspaceTopics(author)).map(row => [row.title,row.version,row.category,row.coverVersion]).sort(),
        [['Draft',7,'',null],['Publication',6,'',null]]);
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
});

test('team share freezes directory order, excludes hidden sources, and expires on withdrawal or deletion', async t => {
    const { s, db } = await fixture(t);
    const a = await post(s, author, 'one');
    const b = await post(s, author, 'two');
    const epoch = (await s.me(author)).membership.epoch;
    const input = { title: '训练路线', category: '进攻', summary:'学习顺序', items:[ref(a.id),ref(b.id)], expectedVersion:0, expectedMembershipEpoch:epoch };
    const {id} = await s.publishWorkspaceTopic(author,null,input,'create');
    const edition = await s.shareWorkspaceTopic(reader,id,{expectedPublishedVersion:1},'copy');
    assert.deepEqual(await s.shareWorkspaceTopic(author,id,{expectedPublishedVersion:1},'another-copy'),edition);
    await s.publishWorkspaceTopic(author,id,{...input,title:'新标题',items:[ref(b.id)],expectedVersion:1},'edit');
    const before = await s.readWorkspaceShare(reader,edition.id);
    assert.equal(before.title,input.title);
    assert.deepEqual(before.items.map(row=>row.id),[a.id,b.id]);
    await s.hideLearningPost(admin,a.id,{expectedVersion:a.publishedVersion},'hide');
    assert.deepEqual((await s.readWorkspaceShare(reader,edition.id)).items.map(row=>row.id),[b.id]);
    const draft = await s.getTopicCollection(author,id,'draft');
    const withdrawn = await s.withdrawTopicCollection(author,id,publication(draft),'withdraw');
    await denied(s.readWorkspaceShare(reader,edition.id),'NOT_FOUND');
    await s.publishWorkspaceTopic(author,id,{...input,items:[ref(b.id)],expectedVersion:withdrawn.version},'restore');
    await denied(s.readWorkspaceShare(reader,edition.id),'NOT_FOUND');
    const current = await s.getTopicCollection(author,id,'draft');
    const live = await s.shareWorkspaceTopic(reader,id,{expectedPublishedVersion:current.publishedVersion},'second');
    await s.deleteWorkspaceTopic(author,id,publication(current),'delete');
    await denied(s.readWorkspaceShare(reader,live.id),'NOT_FOUND');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspace_topic_shares').first()).n,0);
});

test('workspace cover edits preserve share editions and enforce member, owner, version and deletion rules', async t => {
    const { s, db } = await fixture(t);
    const article = await post(s, reader, 'cover-source');
    const payload = { title:'热身', category:'训练', summary:'', items:[ref(article.id)], expectedVersion:0,
        expectedMembershipEpoch:(await s.me(author)).membership.epoch };
    // A valid PNG above the usual 40 KB JSON limit exercises the route-specific body allowance.
    const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNY6W680t2YAUIBACG6BI0c0mdzAAAAAElFTkSuQmCC', 'base64');
    const chunk = Buffer.from('tEXtComment\0' + 'x'.repeat(32_000));
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length - 4);
    checksum.writeUInt32BE(crc32(chunk));
    const paddedPng = Buffer.concat([imageFixture.subarray(0,-12), length, chunk, checksum, imageFixture.subarray(-12)]);
    const png = 'data:image/png;base64,' + paddedPng.toString('base64');
    const webp = 'data:image/webp;base64,UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/u7T3/wF090Yt/+hJ/8En/wSfuAAAA==';
    const create = cover => api(s,author,'POST','workspace/topics',{...payload,cover},'cover-create');
    assert.equal((await create('data:image/png;base64,QQ==')).status,415);
    assert.equal((await create('data:image/png;base64,' + 'A'.repeat(451_000))).status,413);
    const response = await create(png);
    assert.equal(response.status,200);
    const {data:{id}} = await response.json();
    assert.deepEqual((await (await create(png)).json()).data,{id});
    assert.equal((await create(webp)).status,409);
    const share = await s.shareWorkspaceTopic(reader,id,{expectedPublishedVersion:1},'cover-share');
    const cover = (p,view,target,rev) => api(s,p,'GET',`workspace/topic-covers/${view}/${target}/${rev}`);
    const edit = (fields,expectedVersion,key) => api(s,author,'PATCH','workspace/topics/'+id,{...payload,...fields,expectedVersion},key);
    assert.equal((await s.workspaceTopics(reader))[0].coverVersion,1);
    const image = await cover(reader,'published',id,1);
    assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/png');
    assert.match(image.headers.get('cache-control'),/no-store/);
    assert.equal(Buffer.from(await image.arrayBuffer()).toString('base64'),png.split(',')[1]);
    assert.equal((await cover(author,'draft',id,1)).status,200);
    assert.equal((await cover(reader,'draft',id,1)).status,404);
    assert.equal((await api(s,reader,'PATCH','workspace/topics/'+id,{...payload,cover:webp,expectedVersion:1},'cover-other')).status,404);
    assert.equal((await edit({title:'新版标题'},1,'metadata')).status,200);
    assert.equal((await s.workspaceTopics(reader))[0].coverVersion,1);
    assert.equal((await edit({cover:webp},2,'replace')).status,200);
    assert.equal((await cover(reader,'published',id,1)).status,404);
    assert.equal((await cover(reader,'published',id,3)).headers.get('content-type'),'image/webp');
    assert.equal((await s.readWorkspaceShare(reader,share.id)).coverVersion,1);
    assert.equal((await cover(reader,'share',share.id,1)).headers.get('content-type'),'image/png');
    assert.equal((await cover(reader,'share',share.id,3)).status,404);
    const exported = (await s.exportOwnData(author)).topicCollections.find(row => row.id===id);
    assert.equal(exported.draft.coverVersion,3);
    assert.equal(exported.publication.coverVersion,3);
    assert.equal((await edit({cover:null},3,'remove')).status,200);
    assert.equal((await s.workspaceTopics(reader))[0].coverVersion,null);
    assert.equal((await cover(reader,'published',id,3)).status,404);
    assert.equal((await cover(reader,'share',share.id,1)).status,200);
    const readerUser = (await s.me(reader)).user.id;
    await db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(readerUser).run();
    assert.equal((await cover(reader,'share',share.id,1)).status,403);
    await db.prepare("UPDATE memberships SET status='active' WHERE user_id=?").bind(readerUser).run();
    const draft = await s.getTopicCollection(author,id,'draft');
    const withdrawn = await s.withdrawTopicCollection(author,id,publication(draft),'cover-withdraw');
    assert.equal((await cover(reader,'share',share.id,1)).status,404);
    await s.deleteWorkspaceTopic(author,id,publication(withdrawn),'cover-delete');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM workspace_topic_cover_revisions').first()).n,0);
});
