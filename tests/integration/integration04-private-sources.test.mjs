import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const [admin, author, reader] = ['private-admin', 'private-author', 'private-reader'].map(principal);
const directory = new URL('../../drizzle/', import.meta.url);
const publication = item => ({ expectedVersion: item.version, expectedMembershipEpoch: item.membershipEpoch });
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);

test('learning bookmarks and private reflection references survive upgrade, refresh and source withdrawal', { timeout: 30000 }, async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {}', compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    async function migrate(file) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    for (const file of (await readdir(directory)).filter(name => /^00(?:0\d|1[0-5])_.*\.sql$/.test(name)).sort()) await migrate(file);
    const make = (database = db) => createService({ db: database, accessInitialAdminEmail: admin.verifiedEmail });
    const s = make();
    for (const [p, discName] of [[admin, '管理员'], [author, '作者'], [reader, '读者']]) {
        await s.join(p, { intent: 'register', confirmed: true, discName, jerseyNumber: '01' }, 'join');
    }
    const readerId = (await s.me(reader)).user.id;
    const date = '2026-11-15';
    await db.prepare("INSERT INTO collections VALUES('old',?,'video','old-video',15,'旧收藏',7,?,?)").bind(readerId, date, date).run();
    const old = await db.prepare("SELECT * FROM collections WHERE id='old'").first();
    await migrate('0016_learning_private_sources.sql');
    await migrate('0017_learning_activity.sql');
    assert.deepEqual(await db.prepare("SELECT * FROM collections WHERE id='old'").first(), old);

    const postFields = { kind: 'article', category: '战术', title: '公开资料标题', summary: '合成摘要', body: '第三方正文' };
    const postDraft = await s.saveLearningPost(author, null, postFields, 'post');
    const post = await s.publishLearningPost(author, postDraft.id, publication(postDraft), 'publish-post');
    const topicDraft = await s.saveTopicCollection(author, null, { title: '公开专题标题' }, 'topic');
    const { collection: topicWithItem } = await s.addTopicItems(author, topicDraft.id,
        { expectedVersion: topicDraft.version, items: [{ kind: 'post', id: post.id }] }, 'topic-item');
    const topic = await s.publishTopicCollection(author, topicDraft.id, publication(topicWithItem), 'publish-topic');
    const sources = [
        { kind: 'learning_post', group: 'posts', id: post.id, title: post.title },
        { kind: 'topic_collection', group: 'collections', id: topic.id, title: topic.title },
    ];
    await s.saveLearningPost(author, post.id, { ...postFields, title: '编辑中的私人标题', expectedVersion: post.version }, 'new-draft');
    const saved = [];
    const ownerHeader = await actorKey(reader);
    const origin = 'https://kapok.test';
    const api = (path, method = 'GET', payload, key, database = db) => dispatchApi(new Request(origin + '/api/v1/' + path, {
        method, headers: { Origin: origin, 'X-Kapok-Actor': ownerHeader, 'Idempotency-Key': key ?? '', 'Content-Type': 'application/json' },
        body: payload && JSON.stringify(payload),
    }), path.split('/'), reader, make(database));
    function loseCommitConfirmation() {
        let committed = false;
        return {
            prepare(sql) {
                if (committed && sql.startsWith('SELECT id, input_hash, status, result_json FROM operations'))
                    throw new Error('Synthetic D1 receipt lookup failure after commit');
                return db.prepare(sql);
            },
            async batch(statements) {
                await db.batch(statements);
                committed = true;
                throw new Error('Synthetic D1 response loss after commit');
            },
        };
    }
    for (const { kind, group, id, title } of sources) {
        const sourceRef = { kind, id };
        const endpoint = 'learning/' + group + '/' + id + '/reflection-seed';
        const seedResponse = await api(endpoint);
        assert.equal(seedResponse.status, 200);
        assert.match(seedResponse.headers.get('Cache-Control'), /private, no-store/);
        assert.deepEqual((await seedResponse.json()).data, { text: '', trainingId: null, videoId: null, sourceRef });
        assert.equal((await s.listMyReflections(reader)).length, saved.length, 'opening editor never creates a reflection');

        const body = { sourceKind: kind, sourceId: id, privateNote: '本人收藏备注' };
        const unknown = await api('collections', 'POST', body, kind, loseCommitConfirmation());
        assert.equal(unknown.status, 503);
        assert.equal((await unknown.json()).error.code, 'RESULT_UNKNOWN');
        const response = await api('collections', 'POST', body, kind);
        assert.equal(response.status, 200);
        const { data: bookmark } = await response.json();
        assert.deepEqual(await s.saveCollection(reader, null, { ...body, privateNote: '重复收藏不能覆盖' }, 'dedup-' + kind), bookmark);
        assert.deepEqual((await s.listCollections(reader)).find(x => x.id === bookmark.id).source, { title, href: '/learn/' + group + '/' + id });
        await s.saveCollection(reader, bookmark.id, { privateNote: '本人已编辑备注', expectedVersion: 1 }, 'edit-' + kind);
        const seed = await make().getCollectionReflectionSeed(reader, bookmark.id);
        assert.deepEqual(seed, { text: '本人已编辑备注', trainingId: null, videoId: null, sourceRef });

        const reflectionBody = { title: '', ...seed, date };
        const lostReflection = await api('reflections', 'POST', reflectionBody, kind, loseCommitConfirmation());
        assert.equal(lostReflection.status, 503);
        assert.equal((await lostReflection.json()).error.code, 'RESULT_UNKNOWN');
        const responseReflection = await api('reflections', 'POST', reflectionBody, kind);
        assert.equal(responseReflection.status, 200);
        const { data: reflection } = await responseReflection.json();
        assert.equal(reflection.title, '');
        assert.equal(reflection.text, seed.text);
        assert.equal(reflection.scope, 'private');
        assert.equal(reflection.published, false);
        assert.deepEqual(reflection.sourceRef, sourceRef);
        assert.deepEqual((await make().getReflection(reader, reflection.id)).link, { title, href: '/learn/' + group + '/' + id });
        saved.push({ collectionId: bookmark.id, reflectionId: reflection.id, sourceRef, key: kind, body: reflectionBody });

        for (const outsider of [admin, author]) {
            await denied(s.getCollectionReflectionSeed(outsider, bookmark.id), 'NOT_FOUND');
            await denied(s.saveCollection(outsider, bookmark.id, { privateNote: '不能覆盖', expectedVersion: 2 }, 'foreign-' + kind), 'NOT_FOUND');
            await denied(s.getReflection(outsider, reflection.id), 'NOT_FOUND');
            const bundle = await s.exportOwnData(outsider);
            assert.equal(bundle.collections.some(item => item.id === bookmark.id), false);
            assert.equal(bundle.reflections.some(item => item.id === reflection.id), false);
        }
    }
    await denied(s.saveReflection(reader, null, { text: 'Input', date, sourceRef: { kind: 'video', id: post.id } }, 'bad-kind'), 'INVALID_INPUT');
    await denied(s.saveCollection(reader, null, { sourceKind: 'learning_post', sourceId: post.id, timestampSec: 0 }, 'bad-time'), 'INVALID_INPUT');
    const own = await s.exportOwnData(reader);
    assert.equal(own.collections.filter(c => c.sourceAvailable).length, 2);
    assert.equal(own.reflections.length, 2);
    assert.equal(own.reflections.every(r => r.sourceAvailable), true);
    assert.doesNotMatch(JSON.stringify(own), /第三方正文|公开资料标题|编辑中的私人标题|公开专题标题/);

    const directSeed = await s.getLearningReflectionSeed(author, 'topic_collection', topic.id);
    const direct = await s.saveReflection(author, null, { ...directSeed, text: '直接入口的本人正文', date }, 'direct');
    assert.equal(direct.scope, 'private');
    assert.equal(direct.title, '');
    await denied(s.getReflection(reader, direct.id), 'NOT_FOUND');
    const state = r => ({ expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation });
    const shared = await s.shareReflection(author, direct.id, { ...state(direct), scope: 'team' }, 'share-direct');
    const readerDto = await s.getReflection(reader, shared.id);
    assert.equal(readerDto.link.title, topic.title);
    assert.equal(Object.hasOwn(readerDto, 'sourceRef'), false);
    assert.equal(Object.hasOwn(readerDto, 'privateNote'), false);
    assert.equal(Object.hasOwn(readerDto, 'bookmarkId'), false);
    const reverted = await s.saveReflection(author, shared.id, { ...directSeed, text: '编辑保存恢复私人', date, ...state(shared) }, 'edit-direct');
    assert.equal(reverted.scope, 'private');
    await denied(s.getReflection(reader, direct.id), 'NOT_FOUND');

    const nextDraft = await s.getLearningPost(author, post.id, 'draft');
    await s.withdrawLearningPost(author, post.id, publication(nextDraft), 'withdraw-post');
    const currentTopic = await s.getTopicCollection(author, topic.id, 'draft');
    await s.withdrawTopicCollection(author, topic.id, publication(currentTopic), 'withdraw-topic');
    for (const { collectionId, reflectionId, sourceRef, key, body } of saved) {
        const bookmark = (await s.listCollections(reader)).find(x => x.id === collectionId);
        assert.equal(bookmark.source, null);
        assert.equal(bookmark.privateNote, '本人已编辑备注');
        assert.deepEqual(await s.getCollectionReflectionSeed(reader, collectionId), {
            text: bookmark.privateNote, sourceRef: null, trainingId: null, videoId: null,
        });
        await denied(s.getLearningReflectionSeed(reader, sourceRef.kind, sourceRef.id), 'NOT_FOUND');
        assert.equal((await s.saveReflection(reader, null, body, key)).id, reflectionId, 'the original receipt stays valid after source withdrawal');
        const reflection = await s.getOwnReflection(reader, reflectionId);
        assert.equal(reflection.link, null);
        assert.deepEqual(reflection.sourceRef, sourceRef);
        const edited = await s.saveReflection(reader, reflection.id, { ...body, text: '来源撤回后自己的新正文',
            expectedVersion: reflection.version, expectedGeneration: reflection.generation, expectedSharingVersion: reflection.sharingVersion }, 'edit-' + key);
        assert.deepEqual(edited.sourceRef, sourceRef);
        assert.equal(edited.link, null);
    }
    const final = await s.exportOwnData(reader);
    assert.equal(final.collections.length, 3, 'both original bookmarks and the old row survive conversion');
    assert.equal(final.reflections.length, 2, 'each unknown-result retry has one reflection');
    assert.ok(final.reflections.every(r => !r.sourceAvailable && r.sourceKind && r.sourceId && r.text === '来源撤回后自己的新正文'));

    const otherId = (await s.me(author)).user.id;
    const rebound = {
        prepare(sql) { return db.prepare(sql); },
        async batch(statements) {
            const result = await db.batch(statements);
            await db.batch([
                db.prepare('DELETE FROM auth_identities WHERE user_id=? AND provider=? AND issuer=?').bind(otherId, reader.provider, reader.issuer),
                db.prepare('UPDATE auth_identities SET user_id=? WHERE provider=? AND issuer=? AND subject=?')
                    .bind(otherId, reader.provider, reader.issuer, reader.subject),
            ]);
            return result;
        },
    };
    await denied(make(rebound).saveReflection(reader, null, { text: '原本人', date }, 'late-actor'), 'NOT_FOUND');
});
