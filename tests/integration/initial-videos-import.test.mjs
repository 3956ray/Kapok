import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createImportApi, prepareImport, runImport, withLedger } from '../../scripts/ops/initial-videos.mjs';
import { dispatchApi } from '../../lib/server/http.ts';
import { createSharingFixture } from '../helpers/sharing-browser-fixture.mjs';

const origin = 'https://kapok.party';
const first = 'BV1xx411c7mD';
const second = 'BV1xx411c7mE';
const session = 'synthetic.access.cookie';
const admin = { provider: 'access', issuer: 'https://import-test.cloudflareaccess.com', subject: 'import-admin', verifiedEmail: 'admin@example.test' };
const member = { ...admin, subject: 'import-member', verifiedEmail: 'member@example.test' };
const otherAdmin = { ...admin, subject: 'other-admin', verifiedEmail: 'other@example.test' };

const url = bvid => 'https://www.bilibili.com/video/' + bvid + '/';
const item = (bvid, change = {}) => ({
    bvid, url: url(bvid), display_title: '合成视频 ' + bvid, title_source: 'user', user_date_label: null, event_date: null, ...change,
});
const manifest = (...items) => ({ items });
const training = { title: '合成导入训练', date: '2026-10-03', description: '', status: 'published' };
const video = (bvid, change = {}) => ({ title: '合成视频', source: 'bilibili', url: url(bvid), position: 2, ...change });
const newTraining = { group: 'synthetic-event', date: training.date, title: training.title, confirmed: true };

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

function toExisting(trainingId, ...bvids) {
    return prepareImport(manifest(...bvids.map(bvid => item(bvid))), Object.fromEntries(bvids.map((bvid, position) => [bvid, { trainingId, position }])));
}

test('offline CLI prints blockers for eight synthetic rows without network, mapping inference or writes', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'kapok-initial-preview-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'manifest.json');
    await writeFile(path, JSON.stringify(manifest(...Array.from({ length: 8 }, (_, index) => item('BV1xx411c7m' + index, {
        title_source: 'temporary_label', user_date_label: '1107',
    })))));
    const script = fileURLToPath(new URL('../../scripts/ops/initial-videos.mjs', import.meta.url));
    const args = ['--import', 'data:text/javascript,globalThis.fetch=()=>{process.exit(88)}', script, '--manifest', path];
    const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: { KAPOK_ACCESS_SESSION: session } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'NOT_IMPORTED');
    assert.equal(report.rows.length, 8);
    assert.ok(report.rows.every(row => row.dateLabel === '1107' && row.eventDate === null && row.association === null
        && row.titleSource === 'temporary_label' && row.blockers.includes('CONFIRM_VIDEO_TITLE')));
    assert.ok(!result.stdout.includes(session));
    const bad = spawnSync(process.execPath, [...args, '--reconcile', '--mapping', path, '--ledger', join(dir, 'ledger.json')], { cwd: dir, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.deepEqual(await readdir(dir), ['manifest.json']);
});

test('explicit full date/title and temporary title confirmation; malformed, foreign and repeated sources fail closed', () => {
    const pending = item(first, { title_source: 'temporary_label', user_date_label: '1107' });
    for (const [date, confirmed] of [[null, true], ['1107', true], ['2026-02-30', true], [training.date, false]]) {
        const preview = prepareImport(manifest(pending), { [first]: { newTraining: { ...newTraining, date, confirmed }, position: 0 } });
        assert.deepEqual(preview.rows[0].blockers, ['CONFIRM_NEW_TRAINING_DATE_AND_TITLE', 'CONFIRM_VIDEO_TITLE']);
    }
    const valid = prepareImport(manifest({ ...pending, url: url(first) + '?spm_id_from=synthetic&p=2#ignored' }), {
        [first]: { newTraining, position: 0, videoTitle: pending.display_title },
    });
    assert.deepEqual(valid.rows[0].blockers, []);
    assert.equal(valid.rows[0].video.url, url(first) + '?p=2');
    assert.equal(valid.newTrainings[0].payload.date, training.date);
    const missingTitle = prepareImport(manifest(item(first)), { [first]: { newTraining: { ...newTraining, title: null }, position: 0 } });
    assert.deepEqual(missingTitle.rows[0].blockers, ['CONFIRM_NEW_TRAINING_DATE_AND_TITLE']);
    for (const bad of [
        'https://b23.tv/example', 'https://www.bilibili.com.evil.test/video/' + first, 'http://www.bilibili.com/video/' + first,
        'https://name@www.bilibili.com/video/' + first, 'https://www.bilibili.com/video/x/../' + first,
        url(first) + '?p=0', url(first) + '?p=2&p=3', url(second),
    ]) assert.throws(() => prepareImport(manifest(item(first, { url: bad }))), /Bilibili|differ/);
    assert.throws(() => prepareImport(manifest(item(first), item(first))), /repeated/);
    assert.throws(() => prepareImport(manifest(item(first)), { [first]: { trainingId: 'x', newTraining } }), /one valid/);
});

test('fixed origin never follows redirects or echoes response bodies and rejects wrong response origins', async () => {
    const calls = [];
    const api = createImportApi(session, async (address, init) => {
        calls.push([address, init.redirect]);
        return new Response(session, { status: 302, headers: { Location: 'https://evil.test' } });
    });
    await assert.rejects(api('bootstrap'), error => /HTTP 302/.test(error.message) && !error.message.includes(session));
    await assert.rejects(api('trainings/../me'), /Invalid import API route/);
    assert.deepEqual(calls, [[origin + '/api/v1/bootstrap', 'error']]);
    const wrongOrigin = createImportApi(session, async () => {
        const response = Response.json({ data: {}, requestId: 'ignored' });
        Object.defineProperty(response, 'url', { value: 'https://evil.test/api/v1/bootstrap' });
        return response;
    });
    await assert.rejects(wrongOrigin('bootstrap'), /response rejected/);
});

test('lost training/video responses and partial retry retain D1 operation keys and immutable payloads', async t => {
    const f = await fixture(t);
    const plan = prepareImport(manifest(item(first), item(second)), {
        [first]: { newTraining, position: 1 }, [second]: { newTraining, position: 2 },
    });
    const op = operator(plan);
    const preview = await op.run('reconcile', f.api());
    assert.equal(preview.blockers.length, 0);
    assert.deepEqual(f.log, []);
    await assert.rejects(op.run('apply', f.api(), { approval: 'bad' }), /approval hash/);
    const lost = (route, predicate = () => true) => f.api(admin, async (path, write, dispatch) => {
        const response = await dispatch();
        if (write && route.test(path) && predicate()) {
            assert.equal(response.status, 200);
            throw Error('synthetic lost response');
        }
        return response;
    });
    await assert.rejects(op.run('apply', lost(/^trainings$/)), /result unknown/);
    assert.equal(op.ledger().trainings[newTraining.group].state, 'pending');
    assert.equal((await op.run('reconcile', f.api())).blockers.length, 0);
    assert.equal(f.log.length, 1);

    await assert.rejects(op.run('apply', lost(/\/videos$/)), /result unknown/);
    assert.deepEqual(f.log[0], f.log[1]);
    assert.equal(op.ledger().trainings[newTraining.group].state, 'confirmed');
    assert.equal(op.ledger().videos[first].state, 'pending');

    const failBeforeCommit = f.api(admin, async (path, write, dispatch) => {
        if (write && path.endsWith('/videos')) throw Error('synthetic transport failure before dispatch');
        return dispatch();
    });
    await assert.rejects(op.run('apply', failBeforeCommit), /result unknown/);
    assert.equal(op.ledger().videos[first].state, 'matched');
    assert.equal(op.ledger().videos[second].state, 'pending');

    const changed = prepareImport(manifest(item(first), item(second)), {
        [first]: { newTraining, position: 1 }, [second]: { newTraining, position: 3 },
    });
    const writes = f.log.length;
    await assert.rejects(op.run('apply', f.api(), { plan: changed }), /immutable inputs/);
    assert.equal(f.log.length, writes);
    assert.equal((await op.run('apply', f.api())).blockers.length, 0);
    assert.deepEqual(f.log[3], f.log[4]);
    assert.equal(op.ledger().videos[second].state, 'confirmed');
    await op.run('apply', f.api());
    assert.equal(f.log.length, 5);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM trainings').first()).n, 1);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM videos').first()).n, 2);
    const keys = (await f.db.prepare("SELECT key FROM operations WHERE kind IN ('training','video-add')").all()).results.map(row => row.key);
    assert.deepEqual(new Set(keys), new Set(f.log.map(entry => entry.key)));
});

test('current matching BVID preserves manual title/order and hidden or deleted known targets never get recreated', async t => {
    const f = await fixture(t);
    const tr = await f.service.saveTraining(admin, null, training, 'manual-training');
    const original = await f.service.addVideo(admin, tr.id, video(first, { url: url(first) + '?p=2', position: 77, title: '人工标题' }), 'manual-video');
    const op = operator(toExisting(tr.id, first));
    const preview = await op.run('reconcile', f.api());
    assert.equal(preview.decisions[0].currentTitle, '人工标题');
    assert.equal(preview.decisions[0].currentPosition, 77);
    assert.equal(preview.decisions[0].videoId, original.id);
    assert.equal((await op.run('apply', f.api())).decisions[0].state, 'matched');
    assert.equal((await f.service.getVideo(admin, original.id)).title, '人工标题');
    await f.service.updateVideo(admin, original.id, { title: '人工标题', position: 77, status: 'hidden', expectedVersion: 1 }, 'hide');
    const hiddenOp = operator(toExisting(tr.id, first));
    assert.equal((await hiddenOp.run('reconcile', f.api())).blockers[0].reason, 'BVID_HIDDEN');
    await f.service.updateVideo(admin, original.id, { title: '人工标题', position: 77, status: 'deleted', expectedVersion: 2 }, 'delete');
    for (const run of [op.run, hiddenOp.run]) assert.equal((await run('apply', f.api())).blockers[0].reason, 'KNOWN_VIDEO_UNAVAILABLE');
    assert.deepEqual(f.log, []);
});

test('duplicates and different training associations block with no POST; existing same-date title needs explicit ID', async t => {
    const f = await fixture(t);
    const tr = await f.service.saveTraining(admin, null, training, 'manual-training');
    const other = await f.service.saveTraining(admin, null, { ...training, title: '其他训练' }, 'other-training');
    await f.service.addVideo(admin, other.id, video(first), 'manual-video');
    const op = operator(toExisting(tr.id, first));
    assert.equal((await op.run('reconcile', f.api())).blockers[0].reason, 'BVID_ON_DIFFERENT_TRAINING');
    await f.service.addVideo(admin, tr.id, video(first), 'second-manual-video');
    assert.equal((await op.run('apply', f.api())).blockers[0].reason, 'MULTIPLE_BVID_MATCHES');
    const newOp = operator(prepareImport(manifest(item(second)), { [second]: { newTraining, position: 0 } }));
    assert.equal((await newOp.run('reconcile', f.api())).blockers[0].reason, 'MATCHING_TRAINING_REQUIRES_EXPLICIT_ID');
    assert.deepEqual(f.log, []);
});

test('concurrent identical operations use the same keys and one D1 training and video each', async t => {
    const f = await fixture(t);
    const plan = prepareImport(manifest(item(first)), { [first]: { newTraining, position: 0 } });
    const a = operator(plan);
    const b = operator(plan);
    await a.run('reconcile', f.api());
    await b.run('reconcile', f.api());
    const gates = new Map();
    const api = f.api(admin, async (path, write, dispatch) => {
        if (write) {
            if (gates.has(path)) gates.get(path).resolve();
            else gates.set(path, Promise.withResolvers());
            await gates.get(path).promise;
        }
        return dispatch();
    });
    const results = await Promise.all([a.run('apply', api), b.run('apply', api)]);
    assert.equal(f.log.length, 4);
    assert.deepEqual(f.log[0], f.log[1]);
    assert.deepEqual(f.log[2], f.log[3]);
    assert.equal(results[0].decisions[0].videoId, results[1].decisions[0].videoId);
    assert.equal((await f.service.listTrainings(admin)).length, 1);
    assert.equal((await f.service.getTraining(admin, results[0].decisions[0].trainingId)).videos.length, 1);
});

test('a committed video deleted before a lost response is reconciled cannot be recreated on same-key retry', async t => {
    const f = await fixture(t);
    const tr = await f.service.saveTraining(admin, null, training, 'manual-training');
    const op = operator(toExisting(tr.id, first));
    await op.run('reconcile', f.api());
    const lost = f.api(admin, async (path, write, dispatch) => {
        const response = await dispatch();
        if (write) {
            const { data } = await response.json();
            await f.service.updateVideo(admin, data.id, { title: data.title, position: data.position, status: 'deleted', expectedVersion: data.version }, 'delete-before-reply');
            throw Error('synthetic lost response');
        }
        return response;
    });
    await assert.rejects(op.run('apply', lost), /result unknown/);
    assert.equal((await op.run('reconcile', f.api())).decisions[0].state, 'pending');
    await assert.rejects(op.run('apply', f.api()), /HTTP 404/);
    assert.equal(op.ledger().videos[first].state, 'pending');
    assert.deepEqual(f.log[0], f.log[1]);
    assert.deepEqual((await f.db.prepare('SELECT status FROM videos').all()).results, [{ status: 'deleted' }]);
});

test('different active administrator, nonadmin, and a mid-run actor swap cannot use the ledger', async t => {
    const f = await fixture(t);
    const tr = await f.service.saveTraining(admin, null, training, 'manual-training');
    const op = operator(toExisting(tr.id, first));
    await op.run('reconcile', f.api());
    await assert.rejects(op.run('apply', f.api(otherAdmin)), /different Kapok administrator/);
    await assert.rejects(op.run('apply', f.api(member)), /not an active administrator/);
    const swap = f.api(admin, async (path, write, dispatch) => {
        if (path === 'me') return f.api(otherAdmin)('me').then(({ actor, data }) => Response.json({ data, requestId: 'swapped' }, { headers: { 'X-Kapok-Actor': actor } }));
        return dispatch();
    });
    await assert.rejects(op.run('apply', swap), /actor changed/);
    assert.deepEqual(f.log, []);
});

test('private on-disk ledger persists pending receipts and serializes a second process using the same path', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'kapok-initial-ledger-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'ledger.json');
    const written = Promise.withResolvers();
    const release = Promise.withResolvers();
    const stopped = withLedger(path, async (ledger, save) => {
        assert.equal(ledger, undefined);
        await save({ state: 'pending', id: null });
        written.resolve();
        await release.promise;
        throw Error('synthetic interrupted operation');
    });
    await written.promise;
    await assert.rejects(withLedger(path, () => assert.fail('concurrent ledger entry')), /acquire the ledger lock/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    release.resolve();
    await assert.rejects(stopped, /interrupted/);
    await withLedger(path, ledger => assert.deepEqual(ledger, { state: 'pending', id: null }));
    assert.deepEqual(await readdir(directory), ['ledger.json']);
    assert.ok(!(await readFile(path, 'utf8')).includes(session));
});
