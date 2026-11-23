import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { actorKey } from '../helpers/identity-fixture.mjs';

const principal = subject => ({ provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject, verifiedEmail: subject + '@example.test' });
const [admin, author, reader] = ['activity-admin', 'activity-author', 'activity-reader'].map(principal);
const directory = new URL('../../drizzle/', import.meta.url);
const publication = item => ({ expectedVersion: item.version, expectedMembershipEpoch: item.membershipEpoch });
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);

test('learning activity cycles use current published content and never revive after withdrawal, hiding or leave', { timeout: 30000 }, async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {}', compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    async function migrate(file) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    for (const file of migrations.filter(name => name < '0017')) await migrate(file);
    let time = Date.parse('2026-11-15T05:00:00Z');
    const make = (database = db) => createService({ db: database, accessInitialAdminEmail: admin.verifiedEmail, clock: () => new Date(time) });
    const advance = () => { time += 60_000; };
    const s = make();
    const profile = { intent: 'register', confirmed: true, discName: '合成成员', jerseyNumber: '01' };
    for (const p of [admin, author, reader]) await s.join(p, profile, 'join');
    const fields = { kind: 'article', category: '战术', title: '首次发布', body: '首版公开正文' };
    const owner = await s.me(author);
    const postId = crypto.randomUUID();
    const createdAt = new Date(time).toISOString();
    await db.batch([
        db.prepare(`INSERT INTO learning_posts(id,team_id,owner_id,kind,category,title,summary,body,status,version,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'',?,'published',2,?,?)`)
            .bind(postId, owner.membership.teamId, owner.user.id, fields.kind, fields.category, fields.title, fields.body, createdAt, createdAt),
        db.prepare(`INSERT INTO learning_post_publications(post_id,kind,category,title,summary,body,version,author_epoch,published_at)
            VALUES(?,?,?,?,'',?,2,?,?)`)
            .bind(postId, fields.kind, fields.category, fields.title, fields.body, owner.membership.epoch, createdAt),
    ]);
    const origin = 'https://kapok.test';
    async function api(path, p = author, method = 'GET', input, key, service = s) {
        const url = new URL('/api/v1/' + path, origin);
        return dispatchApi(new Request(url, { method, headers: { Origin: origin, 'X-Kapok-Actor': await actorKey(p),
            'Idempotency-Key': key ?? '', 'Content-Type': 'application/json' }, body: input && JSON.stringify(input) }),
        url.pathname.slice('/api/v1/'.length).split('/'), p, service);
    }
    for (const file of migrations.filter(name => name >= '0017')) await migrate(file);
    let post = await s.getLearningPost(author, postId, 'draft');
    const path = 'learning/posts/' + post.id + '/activity';
    const request = (id = null) => ({
        expectedPublishedVersion: post.publishedVersion, expectedMembershipEpoch: post.membershipEpoch, expectedEventId: id,
    });
    const feed = async (cursor = null) => (await make().listActivity(reader, cursor)).items.filter(item => item.kind === 'learning');
    const lookup = async id => {
        const response = await api('activity/learning?ids=' + id, reader);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Cache-Control'), /private, no-store/);
        return (await response.json()).data;
    };
    assert.deepEqual(await feed(), []);
    assert.deepEqual((await (await api(path)).json()).data, { publishedVersion: post.publishedVersion, lastEventId: null, event: null });
    for (const p of [reader, admin]) {
        assert.equal((await api(path, p)).status, 404);
        assert.equal((await api(path, p, 'POST', request(), 'foreign-share')).status, 404);
    }

    advance();
    const firstInput = request();
    let committed = false;
    const lost = make({
        prepare(sql) {
            if (committed && sql.startsWith('SELECT id, input_hash, status, result_json FROM operations')) throw new Error('Lost receipt lookup');
            return db.prepare(sql);
        },
        async batch(statements) {
            await db.batch(statements);
            committed = true;
            throw new Error('Lost commit response');
        },
    });
    const unknown = await api(path, author, 'POST', firstInput, 'share-1', lost);
    assert.equal(unknown.status, 503);
    assert.equal((await unknown.json()).error.code, 'RESULT_UNKNOWN');
    const firstResponse = await api(path, author, 'POST', firstInput, 'share-1');
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()).data.event;
    assert.deepEqual((await s.getLearningActivity(author, post.id)).event, first);
    const firstFeed = {
        id: 'learning:' + first.id, href: '/learn/posts/' + post.id, title: fields.title, kind: 'learning',
        publishedAt: first.sharedAt, updatedAt: post.updatedAt,
    };
    assert.deepEqual(await feed(), [firstFeed]);

    advance();
    const announcement = await s.saveAnnouncement(admin, null, { title: '时间排序检查', text: '公告正文', status: 'published' }, 'announcement');
    const newerPage = await s.listActivity(reader, null, 1);
    assert.equal(newerPage.items[0].id, 'announcement:' + announcement.id);
    assert.ok(newerPage.nextCursor);
    advance();
    const edited = await s.saveLearningPost(author, post.id, { ...fields, title: '第二版发布', body: '编辑草稿正文', expectedVersion: post.version }, 'edit');
    assert.deepEqual(await feed(newerPage.nextCursor), [firstFeed]);
    assert.deepEqual(await lookup(first.id), [firstFeed]);
    advance();
    post = await s.publishLearningPost(author, post.id, publication(edited), 'publish-update');
    const updatedFeed = { ...firstFeed, title: '第二版发布', updatedAt: post.updatedAt };
    assert.deepEqual(await feed(), [updatedFeed]);
    assert.deepEqual(await feed(newerPage.nextCursor), [updatedFeed]);
    assert.deepEqual(await lookup(first.id), [updatedFeed]);
    assert.deepEqual((await s.changeLearningActivity(author, post.id, firstInput, 'share-1', true)).event, first);

    const withdrawInput = request(first.id);
    const withdrawn = await api(path, author, 'DELETE', withdrawInput, 'withdraw-activity');
    assert.equal(withdrawn.status, 200);
    assert.equal((await withdrawn.json()).data.event, null);
    assert.equal((await s.getLearningPost(reader, post.id)).title, '第二版发布');
    assert.deepEqual(await lookup(first.id), []);
    assert.deepEqual(await feed(newerPage.nextCursor), []);
    await denied(s.changeLearningActivity(author, post.id, firstInput, 'share-1', true), 'VERSION_CONFLICT');
    await denied(s.changeLearningActivity(author, post.id, request(), 'late-stale-share', true), 'VERSION_CONFLICT');

    const share = async key => {
        advance();
        const { lastEventId } = await s.getLearningActivity(author, post.id);
        const { event } = await s.changeLearningActivity(author, post.id, request(lastEventId), key, true);
        return event;
    };
    const second = await share('share-2');
    assert.notEqual(second.id, first.id);
    assert.deepEqual((await feed()).map(item => item.id), ['learning:' + second.id]);
    assert.deepEqual(await feed(newerPage.nextCursor), []);
    assert.deepEqual(await lookup(first.id), []);
    await denied(s.changeLearningActivity(author, post.id, withdrawInput, 'withdraw-activity', false), 'VERSION_CONFLICT');
    assert.equal((await s.getLearningActivity(author, post.id)).event.id, second.id);

    post = await s.withdrawLearningPost(author, post.id, publication(post), 'withdraw-post');
    await denied(s.getLearningPost(reader, post.id), 'NOT_FOUND');
    assert.deepEqual(await lookup(second.id), []);
    post = await s.publishLearningPost(author, post.id, publication(post), 'republish-post');
    assert.deepEqual(await feed(), []);
    assert.deepEqual(await lookup(second.id), []);
    const third = await share('share-3');
    assert.equal((await api(path, admin, 'DELETE', request(third.id), 'foreign-withdraw')).status, 404);
    await s.hideLearningPost(admin, post.id, { expectedVersion: post.publishedVersion }, 'hide');
    await denied(s.getLearningPost(reader, post.id), 'NOT_FOUND');
    assert.deepEqual(await lookup(third.id), []);
    // Simulate source recovery without adding any administrator recovery route.
    await db.prepare("UPDATE learning_posts SET status='withdrawn' WHERE id=?").bind(post.id).run();
    post = await s.publishLearningPost(author, post.id, publication(await s.getLearningPost(author, post.id, 'draft')), 'publish-after-recovery');
    assert.deepEqual(await lookup(third.id), []);
    assert.deepEqual(await feed(), []);

    const fourth = await share('share-4');
    const staleEpoch = request();
    const { membership, user } = await s.me(author);
    await s.updateMembership(admin, user.id, {
        expectedVersion: membership.version, expectedEpoch: membership.epoch, role: 'member', status: 'left',
    }, 'leave');
    assert.deepEqual(await lookup(fourth.id), []);
    await denied(s.getLearningPost(reader, post.id), 'NOT_FOUND');
    const left = (await s.listManagedMembers(admin)).find(person => person.id === membership.id);
    await s.updateMembership(admin, left.userId, {
        expectedVersion: left.version, expectedEpoch: left.epoch, role: 'member', status: 'active',
    }, 'reactivate');
    post = await s.publishLearningPost(author, post.id, publication(await s.getLearningPost(author, post.id, 'draft')), 'publish-after-rejoin');
    await denied(s.changeLearningActivity(author, post.id, staleEpoch, 'share-4', true), 'VERSION_CONFLICT');
    assert.deepEqual(await feed(), []);
    assert.deepEqual(await lookup(fourth.id), []);
    const authorId = (await s.me(author)).user.id;
    const readerId = (await s.me(reader)).user.id;
    // The subject that authorized the write has disappeared by the time D1 executes the batch.
    const race = make({
        prepare: sql => db.prepare(sql),
        async batch(statements) {
            const identity = db.prepare("UPDATE auth_identities SET subject=? WHERE user_id=? AND provider='access'");
            await identity.bind('rebound-author', authorId).run();
            try { return await db.batch(statements); }
            finally { await identity.bind(author.subject, authorId).run(); }
        },
    });
    await denied(race.changeLearningActivity(author, post.id, request(), 'identity-race', true), 'VERSION_CONFLICT');
    assert.deepEqual(await feed(), []);
    assert.equal(await db.prepare("SELECT count(*) AS count FROM operations WHERE key='identity-race'").first('count'), 0);
    const fifth = await share('share-5');
    assert.notEqual(fifth.id, fourth.id);
    assert.deepEqual((await feed()).map(item => item.id), ['learning:' + fifth.id]);
    const readerRace = make({
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!sql.includes('UNION ALL') || !sql.includes('learning_activity_events')) return statement;
            return { bind: (...values) => ({ async all() {
                const identity = db.prepare("UPDATE auth_identities SET subject=? WHERE user_id=? AND provider='access'");
                await identity.bind('rebound-reader', readerId).run();
                try { return await statement.bind(...values).all(); }
                finally { await identity.bind(reader.subject, readerId).run(); }
            } }) };
        },
    });
    assert.deepEqual((await readerRace.listActivity(reader)).items, []);

    const exported = (await s.exportOwnData(author)).learningActivity;
    assert.deepEqual(exported.map(event => [event.id, event.active]), [
        [first.id, false], [second.id, false], [third.id, false], [fourth.id, false], [fifth.id, true],
    ]);
    assert.deepEqual(Object.keys(exported[0]).sort(), ['active', 'id', 'postId', 'revokedAt', 'sharedAt']);
    assert.ok(exported[0].revokedAt && exported[1].revokedAt && exported[2].revokedAt);
    for (const p of [reader, admin]) assert.deepEqual((await s.exportOwnData(p)).learningActivity, []);
});
