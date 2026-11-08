import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImportApi, prepareBatch, runImport } from '../../scripts/ops/initial-videos.mjs';
import { dispatchApi } from '../../lib/server/http.ts';
import { createSharingFixture } from '../helpers/sharing-browser-fixture.mjs';

const origin = 'https://kapok.party';
const session = 'synthetic.access.cookie';
const admin = { provider: 'access', issuer: 'https://import-test.cloudflareaccess.com', subject: 'import-admin', verifiedEmail: 'admin@example.test' };
const member = { ...admin, subject: 'import-member', verifiedEmail: 'member@example.test' };
const otherAdmin = { ...admin, subject: 'other-admin', verifiedEmail: 'other@example.test' };

const url = bvid => 'https://www.bilibili.com/video/' + bvid + '/';
const item = (bvid, change = {}) => ({
    bvid, url: url(bvid), display_title: '合成视频 ' + bvid, title_source: 'user', user_date_label: null, event_date: null, ...change,
});
const training = { title: '合成导入训练', date: '2026-10-03', description: '', status: 'published' };

async function fixture(t) {
    const f = await createSharingFixture();
    t.after(() => f.dispose());
    for (const [principal, role] of [[admin, 'admin'], [member, 'member'], [otherAdmin, 'author']]) {
        await f.db.prepare('INSERT INTO auth_identities VALUES (?, ?, ?, ?, ?)')
            .bind(principal.subject, principal.provider, principal.issuer, principal.subject, f.ids[role]).run();
    }
    await f.db.prepare("UPDATE memberships SET role='admin' WHERE user_id=?").bind(f.ids.author).run();
    const log = [];
    function api(principal = admin, intercept) {
        return createImportApi(session, async (address, init) => {
            assert.equal(new URL(address).origin, origin);
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers.Cookie, 'CF_Authorization=' + session);
            assert.equal(init.headers['Cf-Access-Jwt-Assertion'], undefined);
            const path = new URL(address).pathname.slice('/api/v1/'.length);
            const write = init.method === 'POST';
            if (write) {
                assert.equal(init.headers.Origin, origin);
                assert.match(init.headers['Idempotency-Key'], /^kapok_initial_v1_[a-f0-9]{64}$/);
                log.push({ path, key: init.headers['Idempotency-Key'], payload: JSON.parse(init.body) });
            }
            const dispatch = () => dispatchApi(new Request(address, init), path.split('/'), principal, f.service);
            return intercept ? intercept(path, write, dispatch) : dispatch();
        });
    }
    return { ...f, api, log };
}

function operator(plan) {
    let ledger;
    const save = async state => { ledger = structuredClone(state); };
    const run = (mode, api, overrides = {}) => runImport({ mode, plan, api, ledger, save, approval: ledger?.approval, ...overrides });
    return { run, ledger: () => ledger };
}

const batchManifest = { items: Array.from({ length: 8 }, (_, i) => item('BV1xx411c7m' + i, { event_date: i < 4 ? '2026-11-0' + (i + 1) : null })), initial_batch: Array.from({ length: 4 }, (_, i) => 'BV1xx411c7m' + i) };
const batchPlan = () => prepareBatch(batchManifest, 'initial_batch');
test('explicit batch excludes pending dates and freezes the confirmed mapping', () => {
    const plan = batchPlan();
    assert.equal(plan.rows.length, 4);
    assert.ok(plan.rows.every(row => row.eventDate && !row.blockers.length));
    assert.throws(() => prepareBatch(batchManifest, 'all'));
    assert.throws(() => prepareBatch({ ...batchManifest, initial_batch: [...batchManifest.initial_batch.slice(0, 3), batchManifest.items[4].bvid] }, 'initial_batch'));
});
test('actual service atomic batch lost response, stable rerun, manual edits and immutable identity', async t => {
    const f = await fixture(t); const op = operator(batchPlan());
    await op.run('reconcile', f.api());
    let lost = false;
    await assert.rejects(op.run('apply', f.api(admin, async (path, write, dispatch) => {
        const result = await dispatch();
        if (write && !lost) { lost = true; throw new Error('lost response'); }
        return result;
    })), /unknown/);
    assert.equal(Object.values(op.ledger().trainings).filter(r => r.state === 'pending').length, 1);
    assert.equal((await op.run('apply', f.api())).blockers.length, 0);
    const writes = f.log.length;
    await f.db.prepare("UPDATE videos SET title='manual title',position=77 WHERE url=?").bind(url(batchManifest.items[0].bvid)).run();
    assert.equal((await op.run('apply', f.api())).blockers.length, 0);
    assert.equal(f.log.length, writes);
    const fresh = operator(batchPlan()); await fresh.run('reconcile', f.api()); await fresh.run('apply', f.api());
    assert.equal(f.log.length, writes);
    assert.equal((await f.db.prepare('SELECT title,position FROM videos WHERE url=?').bind(url(batchManifest.items[0].bvid)).first()).position, 77);
    await assert.rejects(op.run('reconcile', f.api(otherAdmin)), /different Kapok/);
    const changed = structuredClone(batchPlan()); changed.rows[0].video.title = 'changed';
    await assert.rejects(op.run('apply', f.api(), { plan: changed }), /plan changed/);
    assert.ok(f.log.every(row => row.path === 'trainings/publish'));
});
test('unique date reuse, deleted inventory, null publisher and multiple dates block without overwrite', async t => {
    const f = await fixture(t); const api = f.api();
    const { actor } = await api('bootstrap');
    const saved = (await api('trainings', { actor, key: 'kapok_initial_v1_' + 'a'.repeat(64), payload: { ...training, date: '2026-11-01' } })).data;
    const op = operator(batchPlan());
    assert.equal((await op.run('reconcile', api)).decisions[0].trainingId, saved.id);
    await op.run('apply', api);
    const bvid = batchManifest.items[0].bvid;
    await f.db.prepare('UPDATE videos SET publisher_id=NULL WHERE url=?').bind(url(bvid)).run();
    assert.ok((await op.run('reconcile', api)).blockers.some(b => b.reason === 'PUBLISHER_CONFLICT'));
    await f.db.prepare("UPDATE videos SET status='deleted' WHERE url=?").bind(url(bvid)).run();
    assert.ok((await op.run('reconcile', api)).blockers.some(b => b.reason === 'BVID_HIDDEN_OR_DELETED'));
    await api('trainings', { actor, key: 'kapok_initial_v1_' + 'b'.repeat(64), payload: { ...training, date: '2026-11-01' } });
    assert.ok((await op.run('reconcile', api)).blockers.some(b => b.reason === 'MULTIPLE_DATE_MATCHES'));
    await assert.rejects(f.api(member)('trainings/import-inventory'), /403/);
});
test('pending save failure sends no POST and account switch before write sends no POST', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    await assert.rejects(op.run('apply', f.api(), { save: async state => { if (Object.values(state.trainings).some(r => r.state === 'pending')) throw new Error('storage failed'); } }), /storage failed/);
    assert.equal(f.log.length, 0);
    await f.db.prepare('UPDATE memberships SET epoch=epoch+1 WHERE user_id=?').bind(f.ids.admin).run();
    await assert.rejects(op.run('apply', f.api()), /different Kapok/);
    assert.equal(f.log.length, 0);
});
test('concurrent same-admin fresh ledgers share keys and create only four atomic publications', async t => {
    const f = await fixture(t); const a = operator(batchPlan()); const b = operator(batchPlan());
    await Promise.all([a.run('reconcile', f.api()), b.run('reconcile', f.api())]);
    await Promise.all([a.run('apply', f.api()), b.run('apply', f.api())]);
    for (const item of batchManifest.items.slice(0, 4)) {
        assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(item.bvid)).first()).n, 1);
    }
    assert.equal(new Set(f.log.map(row => row.key)).size, 4);
});

test('changed date mapping after preview requires a new approval before any import POST', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); const api = f.api();
    await op.run('reconcile', api); const originalApproval = op.ledger().approval;
    const { actor } = await api('bootstrap');
    await api('trainings', { actor, key: 'kapok_initial_v1_' + 'd'.repeat(64), payload: { ...training, date: '2026-11-01' } });
    const before = f.log.length;
    const stopped = await op.run('apply', api);
    assert.ok(stopped.blockers.some(b => b.reason === 'APPROVED_MAPPING_CHANGED_REVIEW_AGAIN'));
    assert.equal(f.log.length, before);
    const preview = await op.run('reconcile', api);
    assert.notEqual(preview.approval, originalApproval);
    assert.equal(preview.mapping[0].action, 'append');
    await assert.rejects(op.run('apply', api, { approval: originalApproval }), /approval hash/);
    assert.equal((await op.run('apply', api)).blockers.length, 0);
});

test('same admin epoch rotation between last preflight and POST rejects at authenticated service boundary', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    let rotated = false;
    const api = f.api(admin, async (path, write, dispatch) => {
        if (write && !rotated) {
            rotated = true;
            await f.db.prepare('UPDATE memberships SET epoch=epoch+1 WHERE user_id=?').bind(f.ids.admin).run();
        }
        return dispatch();
    });
    await assert.rejects(op.run('apply', api), /409/);
    assert.ok(op.ledger().trainings[batchManifest.items[0].bvid].key);
    assert.equal(op.ledger().trainings[batchManifest.items[0].bvid].rejected, undefined);
    for (const item of batchManifest.items.slice(0, 4)) {
        assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(item.bvid)).first()).n, 0);
        assert.equal((await f.db.prepare('SELECT count(*) AS n FROM trainings WHERE date=?').bind(item.event_date).first()).n, 0);
    }
});

test('date mapping drift after final inventory is transactionally rejected', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    let inserted = false;
    const api = f.api(admin, async (path, write, dispatch) => {
        if (write && !inserted) {
            inserted = true;
            const regular = f.api(); const { actor } = await regular('bootstrap');
            await regular('trainings', { actor, key: 'kapok_initial_v1_' + 'e'.repeat(64), payload: { ...training, date: '2026-11-01' } });
        }
        return dispatch();
    });
    await assert.rejects(op.run('apply', api), /409/);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(batchManifest.items[0].bvid)).first()).n, 0);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM trainings WHERE date=?').bind('2026-11-01').first()).n, 1);
    const oldApproval = op.ledger().approval;
    const rejectedKey = op.ledger().trainings[batchManifest.items[0].bvid].rejected[0].key;
    assert.equal((await f.db.prepare('SELECT status FROM operations WHERE key=?').bind(rejectedKey).first()).status, 'superseded');
    const preview = await op.run('reconcile', f.api());
    assert.notEqual(preview.approval, oldApproval);
    assert.equal(preview.mapping[0].action, 'append');
    await assert.rejects(op.run('apply', f.api(), { approval: oldApproval }), /approval hash/);
    assert.equal((await op.run('apply', f.api())).blockers.length, 0);
    const count = f.log.length;
    await op.run('apply', f.api());
    assert.equal(f.log.length, count);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(batchManifest.items[0].bvid)).first()).n, 1);
    const rejectedRequest = f.log.find(row => row.key === rejectedKey);
    const { actor } = await f.api()('bootstrap');
    // The durable tombstone forbids an old tab from committing this key even without a precondition.
    await assert.rejects(f.api()('trainings/publish', { actor, key: rejectedKey, payload: rejectedRequest.payload }), /without commit/);
});

test('pinned membership is also fenced inside atomic transaction with zero residual records', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    await f.db.prepare(`CREATE TRIGGER synthetic_import_epoch BEFORE INSERT ON trainings BEGIN UPDATE memberships SET epoch=epoch+1 WHERE user_id='${f.ids.admin}'; END`).run();
    await assert.rejects(op.run('apply', f.api()), /409/);
    for (const item of batchManifest.items.slice(0, 4)) {
        assert.equal((await f.db.prepare('SELECT count(*) AS n FROM trainings WHERE date=?').bind(item.event_date).first()).n, 0);
        assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(item.bvid)).first()).n, 0);
    }
});

test('generic conflict retains original pending key and approval until safe same-key retry', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    const approval = op.ledger().approval;
    await f.db.prepare("CREATE TRIGGER synthetic_import_generic BEFORE INSERT ON video_events BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: synthetic generic conflict'); END").run();
    await assert.rejects(op.run('apply', f.api()), /409/);
    const pending = structuredClone(op.ledger().trainings[batchManifest.items[0].bvid]);
    assert.equal(pending.state, 'pending'); assert.ok(pending.key); assert.equal(pending.rejected, undefined);
    assert.equal((await op.run('reconcile', f.api())).approval, approval);
    assert.equal(op.ledger().trainings[batchManifest.items[0].bvid].key, pending.key);
    await f.db.prepare('DROP TRIGGER synthetic_import_generic').run();
    await op.run('apply', f.api());
    assert.equal(f.log[0].key, f.log[1].key);
});

test('a later mapping rejection preserves earlier successful receipt and lost rejection preserves pending key', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api());
    let publications = 0;
    const api = f.api(admin, async (path, write, dispatch) => {
        if (write && ++publications === 2) {
            const regular = f.api(); const { actor } = await regular('bootstrap');
            await regular('trainings', { actor, key: 'kapok_initial_v1_' + 'f'.repeat(64), payload: { ...training, date: '2026-11-02' } });
            const rejected = await dispatch(); assert.equal(rejected.status, 409);
            throw new Error('lost rejection response');
        }
        return dispatch();
    });
    await assert.rejects(op.run('apply', api), /unknown/);
    const firstReceipt = structuredClone(op.ledger().videos[batchManifest.items[0].bvid]);
    const pendingKey = op.ledger().trainings[batchManifest.items[1].bvid].key;
    assert.ok(pendingKey); assert.equal(op.ledger().trainings[batchManifest.items[1].bvid].state, 'pending');
    const oldApproval = op.ledger().approval;
    await op.run('reconcile', f.api());
    assert.equal(op.ledger().approval, oldApproval);
    await assert.rejects(op.run('apply', f.api()), /without commit/);
    assert.equal(op.ledger().trainings[batchManifest.items[1].bvid].key, null);
    const preview = await op.run('reconcile', f.api());
    assert.notEqual(preview.approval, oldApproval);
    assert.deepEqual(op.ledger().videos[batchManifest.items[0].bvid], firstReceipt);
    await op.run('apply', f.api());
    const writes = f.log.length; await op.run('apply', f.api()); assert.equal(f.log.length, writes);
    for (const item of batchManifest.items.slice(0, 4)) assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(item.bvid)).first()).n, 1);
});

test('committed same-key receipt wins over a later invalid mapping and is never superseded', async t => {
    const f = await fixture(t); const op = operator(batchPlan()); await op.run('reconcile', f.api()); await op.run('apply', f.api());
    const original = f.log[0];
    const api = f.api(); const { actor } = await api('bootstrap');
    await api('trainings', { actor, key: 'kapok_initial_v1_' + '9'.repeat(64), payload: { ...training, date: batchManifest.items[0].event_date } });
    const replay = await api(original.path, { actor, key: original.key, payload: original.payload, precondition: { ...op.ledger().frozen.binding, trainingDate: batchManifest.items[0].event_date, trainingId: null } });
    assert.equal(replay.data.video.id, op.ledger().videos[batchManifest.items[0].bvid].id);
    assert.equal((await f.db.prepare('SELECT status FROM operations WHERE key=?').bind(original.key).first()).status, 'done');
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos WHERE url=?').bind(url(batchManifest.items[0].bvid)).first()).n, 1);
});

for (const action of ['publish', 'append']) {
    for (const status of ['active', 'hidden', 'deleted']) {
        test(`final inventory → racing ${status} BVID from another admin rejects ${action} with zero importer writes`, async t => {
            const f = await fixture(t);
            if (action === 'append') for (const item of batchManifest.items.slice(0, 4)) await f.service.saveTraining(admin, null, { ...training, date: item.event_date }, 'append-target-' + item.bvid);
            const op = operator(batchPlan()); await op.run('reconcile', f.api());
            let before; let racing;
            const counts = async () => Promise.all(['trainings', 'videos', 'video_events'].map(async table => (await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n));
            const api = f.api(admin, async (_path, write, dispatch) => {
                if (write && !racing) {
                    const target = await f.service.saveTraining(otherAdmin, null, { ...training, date: '2026-12-01' }, 'racing-target');
                    racing = await f.service.addVideo(otherAdmin, target.id, { title: 'racing video', source: 'bilibili', url: url(batchManifest.items[0].bvid) + '?p=2', position: 0 }, 'racing-video');
                    // Historical canonical variants must match the same BVID, regardless of page.
                    const variant = status === 'active' ? url(batchManifest.items[0].bvid) + '?p=2' : 'https://bilibili.com/video/' + batchManifest.items[0].bvid + (status === 'hidden' ? '#part' : '?p=3');
                    await f.db.prepare('UPDATE videos SET status=?,url=? WHERE id=?').bind(status, variant, racing.id).run();
                    if (status !== 'active') await f.db.prepare('UPDATE trainings SET status=? WHERE id=?').bind(status, target.id).run();
                    before = await counts();
                }
                return dispatch();
            });
            await assert.rejects(op.run('apply', api), /409/);
            assert.deepEqual(await counts(), before);
            const request = f.log.at(-1);
            assert.equal(request.path, action === 'publish' ? 'trainings/publish' : `trainings/${op.ledger().mapping[0].trainingId}/videos`);
            assert.equal((await f.db.prepare('SELECT status FROM operations WHERE key=?').bind(request.key).first()).status, 'superseded');
            assert.equal((await op.run('reconcile', f.api())).blockers.length > 0, true);
            assert.deepEqual(await counts(), before);
        });
    }
    test(`BVID conflict created inside ${action} transaction rolls back every business write`, async t => {
        const f = await fixture(t);
        if (action === 'append') for (const item of batchManifest.items.slice(0, 4)) await f.service.saveTraining(admin, null, { ...training, date: item.event_date }, 'append-target-' + item.bvid);
        const target = await f.service.saveTraining(otherAdmin, null, { ...training, date: '2026-12-01' }, 'racing-target');
        const op = operator(batchPlan()); await op.run('reconcile', f.api());
        const counts = async () => Promise.all(['trainings', 'videos', 'video_events'].map(async table => (await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n));
        const before = await counts();
        await f.db.prepare(`CREATE TRIGGER synthetic_bvid_race AFTER INSERT ON operations
            WHEN NEW.kind='${action === 'publish' ? 'training-publish' : 'video-add'}' AND NEW.status='pending'
            BEGIN INSERT INTO videos(id,training_id,team_id,title,source,url,position,created_at,updated_at,publisher_id)
            SELECT 'synthetic-race',id,team_id,'racing video','bilibili','${url(batchManifest.items[0].bvid)}',0,created_at,updated_at,'${f.ids.author}' FROM trainings WHERE id='${target.id}'; END`).run();
        await assert.rejects(op.run('apply', f.api()), /409/);
        assert.deepEqual(await counts(), before);
        const receipt = action === 'publish' ? op.ledger().trainings[batchManifest.items[0].bvid] : op.ledger().videos[batchManifest.items[0].bvid];
        // Rolled-back synthetic conflict cannot prove a durable rejection: keep the key.
        assert.equal(receipt.state, 'pending'); assert.ok(receipt.key); assert.equal(receipt.rejected, undefined);
        await f.db.prepare('DROP TRIGGER synthetic_bvid_race').run();
        assert.equal((await op.run('apply', f.api())).blockers.length, 0);
    });
}
