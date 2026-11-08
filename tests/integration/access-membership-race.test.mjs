import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createService } from '../../lib/server/domain.ts';
import { createSharingFixture, principals, syntheticContent, versions } from '../helpers/sharing-browser-fixture.mjs';

const access = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'access-author', verifiedEmail: 'author@example.test' };

async function fixture(t) {
    const f = await createSharingFixture();
    t.after(() => f.dispose());
    await f.db.prepare("INSERT INTO auth_identities VALUES ('access-author','access',?,?,?)")
        .bind(access.issuer, access.subject, f.ids.author).run();
    return f;
}

function raceAtBatch(f, event, snapshot = async () => {}) {
    let intercepted = false;
    let before;
    const db = {
        prepare: f.db.prepare.bind(f.db),
        async batch(statements) {
            assert.equal(intercepted, false);
            intercepted = true;
            const author = f.ids.author;
            if (event === 'rebind') {
                await f.db.prepare("UPDATE auth_identities SET user_id=? WHERE id='access-author'").bind(f.ids.member).run();
            } else if (event === 'rejoin') {
                await f.db.batch([
                    f.db.prepare("UPDATE memberships SET status='left' WHERE user_id=?").bind(author),
                    f.db.prepare("UPDATE memberships SET status='active',epoch=epoch+1 WHERE user_id=?").bind(author),
                ]);
            } else {
                await f.db.prepare("UPDATE memberships SET status=? WHERE user_id=?").bind(event, author).run();
            }
            before = await snapshot();
            return f.db.batch(statements);
        },
    };
    return { service: createService({ db }), intercepted: () => intercepted, before: () => before };
}

const pausedOrConflict = e => ['FORBIDDEN', 'VERSION_CONFLICT'].includes(e.code);
const rows = (f, table) => f.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all().then(r => r.results);
async function assertRolledBack(f, race, table) {
    assert.equal(race.intercepted(), true);
    assert.deepEqual(await rows(f, table), race.before());
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM operations WHERE key='raced'").first()).n, 0);
}

for (const [action, event] of [
    ['create', 'paused'], ['update', 'left'], ['delete', 'rejoin'], ['restore', 'paused'],
    ['update', 'rebind'], ['delete', 'rebind'], ['restore', 'rebind'],
    ['share-private', 'rebind'], ['publish', 'rebind'],
]) {
    test(`Access reflection ${action} rolls back when ${event} occurs before commit`, async t => {
        const f = await fixture(t);
        let original;
        if (action !== 'create') original = await f.service.saveReflection(access, null, syntheticContent, 'original');
        if (action === 'restore') {
            await f.service.deleteReflection(access, original.id, versions(original), 'original-delete');
            [original] = await f.service.listDeletedReflections(access);
        }
        if (action === 'publish') original = await f.service.shareReflection(access, original.id, { ...versions(original), scope: 'team' }, 'original-share');
        const race = raceAtBatch(f, event, () => rows(f, 'reflections'));
        const s = race.service;
        const write = action === 'create' ? s.saveReflection(access, null, syntheticContent, 'raced')
            : action === 'update' ? s.saveReflection(access, original.id, { ...syntheticContent, text: 'changed', ...versions(original) }, 'raced')
            : action === 'delete' ? s.deleteReflection(access, original.id, versions(original), 'raced')
            : action === 'restore' ? s.restoreReflection(access, original.id, versions(original), 'raced')
            : action === 'share-private' ? s.shareReflection(access, original.id, { ...versions(original), scope: 'private' }, 'raced')
            : s.publishReflection(access, original.id, { ...versions(original), published: true }, 'raced');
        const outcome = await write.then(() => null, error => error);
        await assertRolledBack(f, race, 'reflections');
        assert.ok(pausedOrConflict(outcome ?? {}), String(outcome));
    });
}

for (const [action, event] of [['create', 'rebind'], ['update', 'paused'], ['delete', 'rejoin']]) {
    test(`Access collection ${action} rolls back when ${event} occurs before commit`, async t => {
        const f = await fixture(t);
        const training = await f.service.saveTraining(principals.admin, null, { title: '合成训练', description: '', date: '2026-10-19', status: 'published' }, 'training');
        const video = await f.service.addVideo(principals.admin, training.id, { title: '合成视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
        const original = { sourceKind: 'video', sourceId: video.id, privateNote: 'synthetic note' };
        const collection = action === 'create' ? null : await f.service.saveCollection(access, null, original, 'original-note');
        const race = raceAtBatch(f, event, () => rows(f, 'collections'));
        const outcome = await race.service.saveCollection(access, collection?.id ?? null,
            collection ? { action: action === 'delete' ? 'delete' : 'save', privateNote: 'changed', expectedVersion: 1 } : original,
            'raced').then(() => null, error => error);
        await assertRolledBack(f, race, 'collections');
        assert.ok(pausedOrConflict(outcome ?? {}), String(outcome));
    });
}

for (const event of ['paused', 'rejoin', 'rebind']) {
    test(`Access export denies its snapshot when ${event} precedes the batch`, async t => {
        const f = await fixture(t);
        await f.service.saveReflection(access, null, syntheticContent, 'export-reflection');
        assert.equal((await f.service.exportOwnData(access)).reflections.length, 1);
        const race = raceAtBatch(f, event);
        await assert.rejects(race.service.exportOwnData(access), e => e.code === 'FORBIDDEN');
        assert.equal(race.intercepted(), true);
    });
}

test('Sites retains private write and export access while membership is paused', async t => {
    const f = await fixture(t);
    const race = raceAtBatch(f, 'paused');
    await race.service.saveReflection(principals.author, null, syntheticContent, 'sites-private');
    assert.equal(race.intercepted(), true);
    assert.equal((await f.service.exportOwnData(principals.author)).reflections.length, 1);
});

function revokeAtRead(f, startsWith) {
    let intercepted = false;
    const db = {
        prepare(sql) {
            const statement = f.db.prepare(sql);
            if (!sql.startsWith(startsWith)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    const run = async method => {
                        intercepted = true;
                        await f.db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(f.ids.author).run();
                        return bound[method]();
                    };
                    return { first: () => run('first'), all: () => run('all') };
                },
            };
        },
    };
    return { service: createService({ db }), intercepted: () => intercepted };
}

test('Access reflection owner query reads no private body if revoked after precheck', async t => {
    const f = await fixture(t);
    const original = await f.service.saveReflection(access, null, syntheticContent, 'original');
    const race = revokeAtRead(f, 'SELECT r.*,p.disc_name,p.jersey_number FROM reflections');
    await assert.rejects(race.service.getOwnReflection(access, original.id), e => e.code === 'NOT_FOUND');
    assert.equal(race.intercepted(), true);
});

test('Access collections query reads no private notes if revoked after precheck', async t => {
    const f = await fixture(t);
    const training = await f.service.saveTraining(principals.admin, null, { title: '合成训练', description: '', date: '2026-10-19', status: 'published' }, 'training');
    const video = await f.service.addVideo(principals.admin, training.id, { title: '合成视频', source: 'bilibili', url: 'BV1xx411c7mD', position: 0 }, 'video');
    await f.service.saveCollection(access, null, { sourceKind: 'video', sourceId: video.id, privateNote: 'synthetic note' }, 'original-note');
    const race = revokeAtRead(f, 'SELECT id,source_kind AS sourceKind,source_id AS sourceId');
    assert.deepEqual(await race.service.listCollections(access), []);
    assert.equal(race.intercepted(), true);
});
