import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { MEDIA_MAX_BYTES, MEDIA_PART_BYTES, MEDIA_TEAM_BYTES } from '../../lib/contracts/media.ts';
import { sizedMP4 } from '../fixtures/mp4-sized.mjs';
const owner = { subject: 'owner' };
const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
const stream = bytes => new Request('https://kapok.test', { method: 'PUT', body: bytes }).body;
async function fixture(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-05-22', d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('BUCKET');
    for (const file of ['0000_identity.sql', '0001_training.sql', '0002_upload_cleanup.sql', '0004_resumable_uploads.sql']) {
        const migration = await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8');
        for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
    }
    const s = createService({ db, bucket, bootstrapSiteUserId: owner.subject });
    await s.bootstrap(owner, { discName: '合成管理员', jerseyNumber: '01' }, 'boot');
    return { s, db, bucket };
}
const proxy = (target, overrides) => new Proxy(target, { get(object, key) { const value = overrides[key] ?? object[key]; return typeof value === 'function' ? value.bind(object) : value; } });
async function upload(s, file, key = 'create') {
    const u = await s.createUpload(owner, { bytes: file.size }, key);
    for (let offset = 0, part = 1; offset < file.size; offset += MEDIA_PART_BYTES, part++) await s.putUploadPart(owner, u.id, stream(file.read(offset, Math.min(MEDIA_PART_BYTES, file.size - offset))), 'content', part);
    return u;
}
test('actual R2 100MiB via twenty bounded requests, 600 seconds, range-only completion and private Range', async t => {
    const { s, db, bucket } = await fixture(t);
    const file = sizedMP4(original, MEDIA_MAX_BYTES, 600);
    const u = await upload(s, file);
    assert.equal((await db.prepare("SELECT count(*) n FROM operations WHERE target_id=? AND kind LIKE 'upload-part-%'").bind(u.id).first()).n, 20);
    const reads = [];
    const bounded = proxy(bucket, { async get(key, options) {
        assert.ok(options?.range, 'completion must not read the full object');
        reads.push(options.range);
        assert.ok(options.range.length <= 2 * 1024 * 1024);
        return bucket.get(key, options);
    }});
    const service = createService({ db, bucket: bounded });
    const result = await service.completeUpload(owner, u.id, 'complete');
    assert.equal(result.durationSec, 600);
    assert.ok(reads.length <= 25);
    assert.ok(reads.reduce((sum, range) => sum + range.length, 0) <= 2 * 1024 * 1024 + 24 * 16);
    assert.equal((await s.completeUpload(owner, u.id, 'complete')).durationSec, 600);
    const tr = await s.saveTraining(owner, null, { title: '合成训练', date: '2026-10-17', status: 'published', description: '' }, 'training');
    const video = await s.addVideo(owner, tr.id, { title: '合成视频', source: 'upload', uploadId: u.id, position: 0 }, 'video');
    const range = await s.getMedia(owner, video.id, 'bytes=-16');
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 16);
    await reject(s.createUpload(owner, { bytes: MEDIA_MAX_BYTES + 1 }, 'oversized'), 'UPLOAD_LIMIT');
    await db.prepare('UPDATE uploads SET bytes=? WHERE id=?').bind(MEDIA_TEAM_BYTES, u.id).run();
    await reject(s.createUpload(owner, { bytes: 1 }, 'quota'), 'UPLOAD_LIMIT');
});
test('part order, immutable payload replay, exact length, unknown completion and unready attachment', async t => {
    const { s, db, bucket } = await fixture(t);
    const file = sizedMP4(original, MEDIA_PART_BYTES + 16);
    const u = await s.createUpload(owner, { bytes: file.size }, 'create');
    await reject(s.putUploadPart(owner, u.id, stream(file.read(MEDIA_PART_BYTES, 16)), 'content', 2), 'UPLOAD_INCOMPLETE');
    await s.putUploadPart(owner, u.id, stream(file.read(0, MEDIA_PART_BYTES)), 'content', 1);
    await s.putUploadPart(owner, u.id, stream(file.read(0, MEDIA_PART_BYTES)), 'content', 1);
    const changed = file.read(0, MEDIA_PART_BYTES); changed[100] ^= 1;
    await reject(s.putUploadPart(owner, u.id, stream(changed), 'content', 1), 'IDEMPOTENCY_CONFLICT');
    await reject(s.putUploadPart(owner, u.id, stream(file.read(0, MEDIA_PART_BYTES)), 'other-key', 1), 'IDEMPOTENCY_CONFLICT');
    await reject(s.completeUpload(owner, u.id, 'complete'), 'UPLOAD_INCOMPLETE');
    const tr = await s.saveTraining(owner, null, { title: '合成训练', date: '2026-10-17', status: 'published', description: '' }, 'training');
    await reject(s.addVideo(owner, tr.id, { title: '合成视频', source: 'upload', uploadId: u.id, position: 0 }, 'video'), 'VERSION_CONFLICT');
    await reject(s.putUploadPart(owner, u.id, stream(new Uint8Array(17)), 'content', 2), 'UPLOAD_LIMIT');
    await s.putUploadPart(owner, u.id, stream(file.read(MEDIA_PART_BYTES, 16)), 'content', 2);
    let lose = true;
    const lost = proxy(bucket, { resumeMultipartUpload(...args) {
        const multipart = bucket.resumeMultipartUpload(...args);
        return { ...multipart, async complete(parts) { const result = await multipart.complete(parts); if (lose) { lose = false; throw new Error('synthetic response lost'); } return result; }, abort: () => multipart.abort() };
    }});
    const service = createService({ db, bucket: lost });
    await reject(service.completeUpload(owner, u.id, 'complete'), 'RESULT_UNKNOWN');
    assert.equal((await db.prepare('SELECT transfer_active FROM uploads WHERE id=?').bind(u.id).first()).transfer_active, 0);
    assert.equal((await service.completeUpload(owner, u.id, 'complete')).durationSec, 3);
});
test('HTTP part upload preserves Origin actor owner checks and accepts only bounded part indexes', async t => {
    const { s } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'create');
    const request = (actor, origin, part) => new Request('https://kapok.test/api/v1/uploads/' + u.id + '/content', { method: 'PUT', headers: { Origin: origin, 'X-Kapok-Actor': actor, 'X-Kapok-Part': part, 'Idempotency-Key': 'content' }, body: original });
    const path = ['uploads', u.id, 'content'];
    assert.equal((await dispatchApi(request('other', 'https://kapok.test', '1'), path, owner, s)).status, 409);
    assert.equal((await dispatchApi(request('owner', 'https://other.test', '1'), path, owner, s)).status, 403);
    assert.equal((await dispatchApi(request('owner', 'https://kapok.test', '1.5'), path, owner, s)).status, 400);
    assert.equal((await dispatchApi(request('owner', 'https://kapok.test', '1'), path, owner, s)).status, 200);
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('held part and held multipart completion cannot publish after cancel; quota waits for cleanup', async t => {
    for (const phase of ['part', 'complete']) {
        const { s, db, bucket } = await fixture(t);
        const u = await s.createUpload(owner, { bytes: original.length }, 'held-' + phase);
        const started = deferred(), release = deferred();
        const hold = multipart => ({
            uploadId: multipart.uploadId,
            async uploadPart(...args) { if (phase === 'part') { started.resolve(); await release.promise; } return multipart.uploadPart(...args); },
            async complete(...args) { if (phase === 'complete') { started.resolve(); await release.promise; } return multipart.complete(...args); },
            abort: () => multipart.abort(),
        });
        const held = proxy(bucket, {
            async createMultipartUpload(...args) { return hold(await bucket.createMultipartUpload(...args)); },
            resumeMultipartUpload(...args) { return hold(bucket.resumeMultipartUpload(...args)); },
        });
        const service = createService({ db, bucket: held });
        if (phase === 'complete') await s.putUploadPart(owner, u.id, stream(original), 'content', 1);
        const running = phase === 'part' ? service.putUploadPart(owner, u.id, stream(original), 'content', 1) : service.completeUpload(owner, u.id, 'complete');
        const settled = running.then(() => null, error => error);
        await started.promise;
        await reject(s.cancelUpload(owner, u.id, 'cancel'), 'CLEANUP_PENDING');
        assert.equal((await db.prepare('SELECT transfer_active FROM uploads WHERE id=?').bind(u.id).first()).transfer_active, 1);
        await db.prepare('UPDATE uploads SET bytes=? WHERE id=?').bind(MEDIA_TEAM_BYTES, u.id).run();
        await reject(s.createUpload(owner, { bytes: 1 }, 'held-quota'), 'UPLOAD_LIMIT');
        await db.prepare('UPDATE uploads SET bytes=? WHERE id=?').bind(original.length, u.id).run();
        release.resolve();
        assert.equal((await settled).code, 'VERSION_CONFLICT');
        await s.cancelUpload(owner, u.id, 'cancel');
        assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first()).status, 'cancelled');
        assert.equal((await bucket.list()).objects.length, 0);
        assert.equal((await db.prepare("SELECT count(*) n FROM operations WHERE target_id=? AND kind='upload-complete' AND status='done'").bind(u.id).first()).n, 0);
    }
});
test('held part loses permission and never commits journal or ready status; owner can clean after restoration', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'revoke');
    const started = deferred(), release = deferred();
    const held = proxy(bucket, { async createMultipartUpload(...args) {
        const multipart = await bucket.createMultipartUpload(...args);
        return { uploadId: multipart.uploadId, async uploadPart(...parts) { started.resolve(); await release.promise; return multipart.uploadPart(...parts); } };
    }});
    const service = createService({ db, bucket: held });
    const settled = service.putUploadPart(owner, u.id, stream(original), 'content', 1).then(() => null, error => error);
    await started.promise;
    await db.prepare("UPDATE memberships SET role='member',epoch=epoch+1 WHERE user_id=?").bind((await s.me(owner)).user.id).run();
    release.resolve();
    assert.equal((await settled).code, 'VERSION_CONFLICT');
    await reject(s.completeUpload(owner, u.id, 'complete'), 'FORBIDDEN');
    assert.equal((await db.prepare("SELECT count(*) n FROM operations WHERE target_id=? AND kind LIKE 'upload-part-%'").bind(u.id).first()).n, 0);
    await db.exec("UPDATE memberships SET role='admin',epoch=epoch+1");
    await s.cancelUpload(owner, u.id, 'cancel');
    assert.equal((await bucket.list()).objects.length, 0);
});
test('part zero-effect guard, missing ETag and lost real D1 commit preserve safe retry', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'guards');
    let omit = true;
    const faulty = proxy(bucket, { async createMultipartUpload(...args) {
        const multipart = await bucket.createMultipartUpload(...args);
        return { uploadId: multipart.uploadId, async uploadPart(...parts) { const receipt = await multipart.uploadPart(...parts); return omit ? { partNumber: receipt.partNumber } : receipt; } };
    }});
    await reject(createService({ db, bucket: faulty }).putUploadPart(owner, u.id, stream(original), 'content', 1), 'UPLOAD_FAILED');
    assert.equal((await db.prepare('SELECT transfer_active FROM uploads WHERE id=?').bind(u.id).first()).transfer_active, 0);
    omit = false;
    await db.exec("CREATE TRIGGER suppress_part BEFORE UPDATE OF transfer_active ON uploads WHEN OLD.transfer_active=1 AND NEW.transfer_active=0 BEGIN SELECT RAISE(IGNORE); END");
    await reject(s.putUploadPart(owner, u.id, stream(original), 'content', 1), 'VERSION_CONFLICT');
    await db.exec('DROP TRIGGER suppress_part');
    // Synthetic trigger also suppressed failure lease release; release it explicitly to model recovery.
    await db.prepare('UPDATE uploads SET transfer_active=0 WHERE id=?').bind(u.id).run();
    let lose = true;
    const lostDb = proxy(db, { async batch(statements) { const result = await db.batch(statements); if (lose) { lose = false; throw new Error('synthetic committed response lost'); } return result; } });
    const service = createService({ db: lostDb, bucket });
    await service.putUploadPart(owner, u.id, stream(original), 'content', 1);
    await service.putUploadPart(owner, u.id, stream(original), 'content', 1);
    assert.equal((await db.prepare("SELECT count(*) n FROM operations WHERE target_id=? AND kind LIKE 'upload-part-%'").bind(u.id).first()).n, 1);
    assert.equal((await service.completeUpload(owner, u.id, 'complete')).mime, 'video/mp4');
});
test('maximum 24-box completion and rejection cleanup stay below 50 storage calls', async t => {
    for (const invalid of [false, true]) {
        const { s, db, bucket } = await fixture(t);
        const moov = original.indexOf('moov') - 4;
        const free = Buffer.alloc(8); free.writeUInt32BE(8); free.write('free', 4);
        const bytes = Buffer.concat([original.subarray(0, moov), ...Array.from({ length: 21 }, () => free), original.subarray(moov)]);
        if (invalid) bytes.write('hvc1', bytes.indexOf('avc1'));
        const u = await s.createUpload(owner, { bytes: bytes.length }, 'budget-' + invalid);
        await s.putUploadPart(owner, u.id, stream(bytes), 'content', 1);
        let calls = 0, statementsExecuted = 0;
        const originals = new WeakMap();
        function statement(target) {
            const wrapped = new Proxy(target, { get(object, key) {
                if (key === 'bind') return (...args) => statement(object.bind(...args));
                if (['first', 'all', 'run', 'raw'].includes(key)) return (...args) => { calls++; statementsExecuted++; return object[key](...args); };
                const value = object[key]; return typeof value === 'function' ? value.bind(object) : value;
            }});
            originals.set(wrapped, target); return wrapped;
        }
        const countedDb = proxy(db, { prepare(sql) { return statement(db.prepare(sql)); }, batch(statements) { calls++; statementsExecuted += statements.length; return db.batch(statements.map(s => originals.get(s) ?? s)); } });
        const countedBucket = proxy(bucket, {
            get(...args) { calls++; return bucket.get(...args); }, head(...args) { calls++; return bucket.head(...args); }, delete(...args) { calls++; return bucket.delete(...args); },
            resumeMultipartUpload(...args) { const multipart = bucket.resumeMultipartUpload(...args); return { uploadId: multipart.uploadId, complete(parts) { calls++; return multipart.complete(parts); }, abort() { calls++; return multipart.abort(); } }; },
        });
        const service = createService({ db: countedDb, bucket: countedBucket });
        const response = await dispatchApi(new Request('https://kapok.test/api/v1/uploads/' + u.id + '/complete', { method: 'POST', headers: { Origin: 'https://kapok.test', 'X-Kapok-Actor': owner.subject, 'Idempotency-Key': 'complete', 'Content-Type': 'application/json' }, body: '{}' }), ['uploads', u.id, 'complete'], owner, service);
        const body = await response.json();
        if (invalid) assert.equal(body.error.code, 'UNSUPPORTED_CODEC');
        else assert.equal(body.data.mime, 'video/mp4');
        assert.ok(calls < 50, `${invalid ? 'reject' : 'ready'} completion made ${calls} storage calls`);
        assert.ok(statementsExecuted < 50, `${statementsExecuted} D1 statements`);
        t.diagnostic(`${invalid ? 'reject with cleanup' : 'ready'}: ${calls} D1 calls/batches + R2 operations; ${statementsExecuted} D1 statements including every batch member`);
    }
});
test('failed multipart-ID persistence aborts before any part can become an untracked orphan', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'record-id');
    await db.exec("CREATE TRIGGER suppress_multipart BEFORE UPDATE OF multipart_id ON uploads BEGIN SELECT RAISE(IGNORE); END");
    let aborted = 0, partCalls = 0;
    const tracked = proxy(bucket, { async createMultipartUpload(...args) {
        const multipart = await bucket.createMultipartUpload(...args);
        return { uploadId: multipart.uploadId, uploadPart(...parts) { partCalls++; return multipart.uploadPart(...parts); }, async abort() { aborted++; return multipart.abort(); } };
    }});
    await reject(createService({ db, bucket: tracked }).putUploadPart(owner, u.id, stream(original), 'content', 1), 'CLEANUP_PENDING');
    assert.equal(aborted, 1); assert.equal(partCalls, 0);
    assert.equal((await db.prepare('SELECT transfer_active FROM uploads WHERE id=?').bind(u.id).first()).transfer_active, 0);
    await db.exec('DROP TRIGGER suppress_multipart');
    await s.cancelUpload(owner, u.id, 'cancel');
    assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first()).status, 'cancelled');
});
test('transient R2 metadata read failure remains unknown and retryable rather than rejecting valid media', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'metadata-network');
    await s.putUploadPart(owner, u.id, stream(original), 'content', 1);
    let fail = true;
    const flaky = proxy(bucket, { get(...args) { if (fail) { fail = false; throw new Error('synthetic unavailable range read'); } return bucket.get(...args); } });
    const service = createService({ db, bucket: flaky });
    await reject(service.completeUpload(owner, u.id, 'complete'), 'RESULT_UNKNOWN');
    const row = await db.prepare('SELECT status,cleanup_state FROM uploads WHERE id=?').bind(u.id).first();
    assert.equal(row.status, 'received'); assert.equal(row.cleanup_state, 'none');
    assert.equal((await service.completeUpload(owner, u.id, 'complete')).mime, 'video/mp4');
});
test('unrecordable multipart ID plus failed abort cannot claim cleanup or release reserved quota', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'untracked');
    await db.exec("CREATE TRIGGER suppress_id BEFORE UPDATE OF multipart_id ON uploads BEGIN SELECT RAISE(IGNORE); END");
    let multipart;
    const faulty = proxy(bucket, { async createMultipartUpload(...args) {
        multipart = await bucket.createMultipartUpload(...args);
        return { uploadId: multipart.uploadId, async abort() { throw new Error('synthetic abort unavailable'); } };
    }});
    await reject(createService({ db, bucket: faulty }).putUploadPart(owner, u.id, stream(original), 'content', 1), 'CLEANUP_PENDING');
    await reject(s.cancelUpload(owner, u.id, 'cancel'), 'CLEANUP_PENDING');
    const row = await db.prepare('SELECT status,cleanup_state,cleanup_error,transfer_active FROM uploads WHERE id=?').bind(u.id).first();
    assert.equal(row.status, 'receiving'); assert.equal(row.cleanup_state, 'pending'); assert.equal(row.cleanup_error, 'MULTIPART_UNCONFIRMED'); assert.equal(row.transfer_active, 0);
    await multipart.abort(); // isolated test fixture disposal; product deliberately retains unknown quota.
});
test('interrupted request does not commit a partial part; same reservation retries safely', async t => {
    const { s, db } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'interrupted');
    let sent = false;
    const interrupted = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(original.subarray(0, 100)); } else controller.error(new Error('synthetic transport interrupted')); } });
    await assert.rejects(s.putUploadPart(owner, u.id, interrupted, 'content', 1), /synthetic transport/);
    assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first()).status, 'pending');
    await s.putUploadPart(owner, u.id, stream(original), 'content', 1);
    assert.equal((await s.completeUpload(owner, u.id, 'complete')).mime, 'video/mp4');
});
test('held completion rechecks membership epoch and guarded received transition before ready', async t => {
    const { s, db, bucket } = await fixture(t);
    const u = await s.createUpload(owner, { bytes: original.length }, 'late-complete-permission');
    await s.putUploadPart(owner, u.id, stream(original), 'content', 1);
    const started = deferred(), release = deferred();
    const held = proxy(bucket, { resumeMultipartUpload(...args) {
        const multipart = bucket.resumeMultipartUpload(...args);
        return { async complete(parts) { started.resolve(); await release.promise; return multipart.complete(parts); } };
    }});
    const settled = createService({ db, bucket: held }).completeUpload(owner, u.id, 'complete').then(() => null, error => error);
    await started.promise;
    await db.exec('UPDATE memberships SET epoch=epoch+1');
    release.resolve(); assert.equal((await settled).code, 'VERSION_CONFLICT');
    assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first()).status, 'receiving');
    await db.exec("CREATE TRIGGER suppress_received BEFORE UPDATE OF status ON uploads WHEN NEW.status='received' BEGIN SELECT RAISE(IGNORE); END");
    await reject(s.completeUpload(owner, u.id, 'complete'), 'VERSION_CONFLICT');
    assert.equal((await db.prepare("SELECT count(*) n FROM operations WHERE target_id=? AND kind IN ('upload-received','upload-complete')").bind(u.id).first()).n, 0);
    await db.exec('DROP TRIGGER suppress_received');
    assert.equal((await s.completeUpload(owner, u.id, 'complete')).mime, 'video/mp4');
});
