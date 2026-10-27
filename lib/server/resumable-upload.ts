import { DomainError, assertGuard } from './domain.ts';
import type { Me, Principal } from '../contracts/index';
import type { StoredResult } from './domain';
import { HOSTED_MEDIA_POLICY, MEDIA_ENGINEERING_MAX_BYTES, MEDIA_LEASE_MS, MEDIA_LONG_MAX_SECONDS, MEDIA_PART_BYTES, manifestRoot } from '../contracts/media.ts';
import type { MediaPolicy, UploadManifest, UploadProgress } from '../contracts/media';
import { inspectMP4Stage } from './media-stages.ts';

type Context = Me & { user: NonNullable<Me['user']>; membership: NonNullable<Me['membership']> };
type Op = { opId: string; replay: { result: StoredResult } | null; commit: (s: D1PreparedStatement[], r: StoredResult) => Promise<{ result: StoredResult }> };
type Dependencies = { db: D1Database; bucket?: R2Bucket; clock: () => Date; activeMember: (p: Principal | null, admin?: boolean) => Promise<Context>; operation: (actor: string, kind: string, target: string, key: string, input: unknown) => Promise<Op>; mediaPolicy?: MediaPolicy };
type Row = { id: string; owner_id: string; team_id: string; bytes: number; status: string; protocol_version: number; manifest_json: string | null; received_parts: number; generation: number; lease_token: string | null; lease_until: string | null; reserved_bytes: number; assembly_id: string | null; validation_state: string | null; cleanup_state: string; cleanup_target: string | null; cleanup_error: string | null; object_key: string | null; mime: string | null; duration_sec: number | null; transfer_active: number; version: number };
type Attempt = { id: string; upload_id: string; kind: string; part_number: number; object_key: string; bytes: number; state: string; active: number; multipart_id: string | null; completed_parts: number; generation: number };
const busy = () => new DomainError('UPLOAD_BUSY', '上传正在处理，请稍后确认状态再继续。', 409, true);
const unknown = () => new DomainError('RESULT_UNKNOWN', '暂时无法确认上传结果，空间仍保留。请确认状态后继续。', 503, true);
const conflict = () => new DomainError('VERSION_CONFLICT', '上传状态或当前权限已变化，请重新确认。', 409);
const digest = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

export function createResumableUploads({ db, bucket, clock, activeMember, operation, mediaPolicy = HOSTED_MEDIA_POLICY }: Dependencies) {
    const policy = { ...mediaPolicy };
    if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > MEDIA_ENGINEERING_MAX_BYTES || !Number.isSafeInteger(policy.teamBytes) || policy.teamBytes < policy.maxBytes || !Number.isSafeInteger(policy.maxSeconds) || policy.maxSeconds < 1 || policy.maxSeconds > MEDIA_LONG_MAX_SECONDS) throw new Error('Invalid trusted media policy');
    const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
    const now = () => clock().toISOString();
    async function own(p: Principal | null, id: string) {
        const c = await activeMember(p, true);
        const u = await q('SELECT * FROM uploads WHERE id=? AND owner_id=? AND team_id=?', id, c.user.id, c.membership.teamId).first<Row>();
        if (!u) throw new DomainError('NOT_FOUND', '内容不可用或当前无权查看。', 404);
        if (!bucket) throw new DomainError('SERVICE_UNAVAILABLE', '私有媒体存储暂不可用。', 503);
        return { c, u };
    }
    function member(c: Context, op: Op) {
        return assertGuard(db, op.opId, 'resumable-member', "EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.user_id=? AND m.team_id=? AND m.epoch=? AND m.role='admin' AND m.status='active' AND u.status='active')", [c.membership.id, c.user.id, c.membership.teamId, c.membership.epoch]);
    }
    function fence() { return "id=? AND generation=? AND lease_token=? AND cleanup_state='none'"; }
    function values(u: Row, token: string) { return [u.id, u.generation, token]; }
    async function commit(c: Context, op: Op, statements: D1PreparedStatement[], result: StoredResult = {}) {
        try { return await op.commit([member(c, op), ...statements], result); }
        catch (error) { if (error instanceof DomainError) throw error; throw conflict(); }
    }
    async function reserve(c: Context, op: Op, bytes: number, statements: D1PreparedStatement[], result: StoredResult = {}) {
        const used = await q("SELECT coalesce(sum(max(bytes,reserved_bytes)),0) AS n FROM uploads WHERE team_id=? AND status NOT IN ('cancelled','rejected')", c.membership.teamId).first<{ n: number }>();
        if ((used?.n ?? 0) + bytes > policy.teamBytes) throw new DomainError('UPLOAD_LIMIT', '队伍可用容量不足。上传还需要临时空间保存和组装，请先检查未完成上传的清理状态。', 413);
        return commit(c, op, [assertGuard(db, op.opId, 'physical-quota', "(SELECT coalesce(sum(max(bytes,reserved_bytes)),0) FROM uploads WHERE team_id=? AND status NOT IN ('cancelled','rejected'))+?<=?", [c.membership.teamId, bytes, policy.teamBytes]), ...statements], result);
    }
    const slotSQL = "(SELECT count(*) FROM (SELECT 1 FROM upload_attempts a JOIN uploads u ON u.id=a.upload_id WHERE u.team_id=? AND a.active=1 AND a.state!='deleted' LIMIT 2))<2";
    function slot(c: Context, op: Op) { return assertGuard(db, op.opId, 'active-attempt-slot', slotSQL, [c.membership.teamId]); }
    async function available(c: Context) {
        const row = await q(`SELECT CASE WHEN ${slotSQL} THEN 1 ELSE 0 END AS available`, c.membership.teamId).first<{ available: number }>();
        if (!row?.available) throw new DomainError('CLEANUP_PENDING', '暂有其他上传或待确认写入正在处理，请稍后重新确认。空间仍保留。', 503, true);
    }
    async function activate(c: Context, u: Row, token: string, id: string) {
        const result = await q(`UPDATE upload_attempts SET active=1 WHERE id=? AND active=0 AND state='pending' AND (${slotSQL}) AND EXISTS(SELECT 1 FROM uploads WHERE ${fence()}) AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.epoch=? AND m.role='admin' AND m.status='active' AND u.status='active')`, id, c.membership.teamId, ...values(u, token), c.membership.id, c.membership.epoch).run();
        if (!result.meta.changes) throw busy();
    }
    function rejected(code: string | null) {
        return new DomainError(code === 'UPLOAD_LIMIT' ? 'UPLOAD_LIMIT' : code === 'UNSUPPORTED_CODEC' ? 'UNSUPPORTED_CODEC' : 'UNSUPPORTED_MEDIA', `${code === 'UPLOAD_LIMIT' ? `视频时长超出当前${policy.maxSeconds / 60}分钟上限。` : code === 'UNSUPPORTED_CODEC' ? '已识别视频，但当前暂不支持它的编码。' : '文件未通过视频格式检查。'}请先取消并清理这次上传，再选择新文件。`, code === 'UPLOAD_LIMIT' ? 413 : 415);
    }
    async function create(p: Principal | null, input: unknown, key: string) {
        const c = await activeMember(p, true);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['bytes', 'manifest'].includes(k))) throw new DomainError('INVALID_INPUT', '请检查上传申请。');
        const r = input as { bytes: number; manifest: UploadManifest };
        if (!Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > policy.maxBytes) throw new DomainError('UPLOAD_LIMIT', `当前单文件最多${policy.maxBytes / 1024 / 1024}MiB；较大视频的托管容量尚未开放。`, 413);
        const m = r.manifest;
        if (!m || Object.keys(m).some(k => !['root', 'digests'].includes(k)) || !Array.isArray(m.digests) || m.digests.length !== Math.ceil(r.bytes / MEDIA_PART_BYTES) || m.digests.some(d => typeof d !== 'string' || !/^[a-f0-9]{64}$/.test(d)) || m.root !== await manifestRoot(r.bytes, m.digests)) throw new DomainError('INVALID_INPUT', '文件内容校验信息无效，请重新选择文件。');
        if (!bucket) throw new DomainError('SERVICE_UNAVAILABLE', '私有媒体存储暂不可用。', 503);
        const op = await operation(c.user.id, 'upload-create-v2', c.membership.teamId, key, r);
        const id = op.replay?.result.id ?? crypto.randomUUID();
        if (!op.replay) {
            await reserve(c, op, r.bytes * 2, [q("INSERT INTO uploads(id,team_id,owner_id,bytes,reserved_bytes,status,created_at,protocol_version,manifest_json,content_key) VALUES(?,?,?,?,?,'pending',?,2,?,?)", id, c.membership.teamId, c.user.id, r.bytes, r.bytes * 2, now(), JSON.stringify({ root: m.root }), m.root), q('INSERT INTO upload_parts(upload_id,part_number,digest,bytes) SELECT ?,CAST(key AS INTEGER)+1,value,min(?,?-CAST(key AS INTEGER)*?) FROM json_each(?)', id, MEDIA_PART_BYTES, r.bytes, MEDIA_PART_BYTES, JSON.stringify(m.digests)), assertGuard(db, op.opId, 'created', 'EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND protocol_version=2) AND (SELECT count(*) FROM upload_parts WHERE upload_id=?)=?', [id, c.user.id, id, m.digests.length])], { id });
        }
        return { id };
    }
    async function get(p: Principal | null, id: string): Promise<UploadProgress> {
        const { u } = await own(p, id);
        const a = u.assembly_id ? await q('SELECT completed_parts FROM upload_attempts WHERE id=?', u.assembly_id).first<{ completed_parts: number }>() : null;
        return { id, bytes: u.bytes, status: u.status, cleanupState: u.cleanup_state, protocol: u.protocol_version, nextPart: u.received_parts + 1, receivedParts: u.received_parts, assembledParts: a?.completed_parts ?? 0, manifest: u.manifest_json ? JSON.parse(u.manifest_json) : null, policy, leaseUntil: u.lease_until, reservedBytes: u.reserved_bytes, rejection: u.cleanup_target === 'rejected' ? { code: rejected(u.cleanup_error).code, message: rejected(u.cleanup_error).message } : null };
    }
    async function lease(c: Context, original: Row) {
        if (original.cleanup_state !== 'none' || ['cancelled', 'rejected'].includes(original.status)) throw new DomainError('CLEANUP_PENDING', '此上传等待清理，空间仍保留。', 503, true);
        if (original.lease_token && original.lease_until && original.lease_until > now()) throw busy();
        const token = crypto.randomUUID(), generation = original.generation + 1;
        const result = await q(`UPDATE uploads SET lease_token=?,lease_until=?,generation=?,transfer_active=1,version=version+1 WHERE id=? AND generation=? AND cleanup_state='none' AND (lease_token IS NULL OR lease_until<=?) AND (SELECT count(*) FROM (SELECT 1 FROM uploads WHERE team_id=? AND lease_token IS NOT NULL AND lease_until>? AND id!=? LIMIT 2))<2 AND EXISTS(SELECT 1 FROM memberships WHERE id=? AND epoch=? AND status='active' AND role='admin')`, token, new Date(clock().getTime() + MEDIA_LEASE_MS).toISOString(), generation, original.id, original.generation, now(), c.membership.teamId, now(), original.id, c.membership.id, c.membership.epoch).run();
        if (!result.meta.changes) throw busy();
        return { u: { ...original, generation, lease_token: token }, token, expired: !!original.lease_token };
    }
    async function release(u: Row, token: string) { await q('UPDATE uploads SET lease_token=NULL,lease_until=NULL,transfer_active=0 WHERE id=? AND generation=? AND lease_token=?', ...values(u, token)).run(); }
    async function readPart(stream: ReadableStream<Uint8Array> | null, expected: number) {
        if (!stream) throw new DomainError('INVALID_INPUT', '需要文件分块。');
        const out = new Uint8Array(expected), reader = stream.getReader(); let count = 0;
        try { while (true) { const r = await reader.read(); if (r.done) break; if (r.value.length > expected - count) throw new DomainError('UPLOAD_LIMIT', '分块大小与申请不符。', 413); out.set(r.value, count); count += r.value.length; } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (count !== expected) throw new DomainError('UPLOAD_LIMIT', '分块大小与申请不符。', 413);
        return out;
    }
    async function part(p: Principal | null, id: string, stream: ReadableStream<Uint8Array> | null, key: string, number: number) {
        const initial = await own(p, id), m = JSON.parse(initial.u.manifest_json!) as Pick<UploadManifest, 'root'>;
        if (key !== m.root || !Number.isSafeInteger(number) || number < 1 || number > Math.ceil(initial.u.bytes / MEDIA_PART_BYTES)) throw new DomainError('IDEMPOTENCY_CONFLICT', '续传文件与原文件不一致，请重新选择原文件。', 409);
        if (initial.u.cleanup_state !== 'none') throw new DomainError('CLEANUP_PENDING', '此上传等待清理，空间仍保留。', 503, true);
        // A confirmed receipt acknowledges earlier content only. Do not accept a
        // second body or allocate a buffer for it; clients must query progress.
        if (number <= initial.u.received_parts) throw new DomainError('IDEMPOTENCY_CONFLICT', '此分块已确认接收，请确认上传进度后继续缺失部分。', 409);
        if (number !== initial.u.received_parts + 1 || !['pending', 'receiving'].includes(initial.u.status)) throw new DomainError('UPLOAD_INCOMPLETE', '请从尚未收到的分块继续。', 409);
        const commitment = await q('SELECT digest,bytes FROM upload_parts WHERE upload_id=? AND part_number=?', id, number).first<{ digest: string; bytes: number }>();
        if (!commitment) throw unknown();
        const expected = commitment.bytes;
        const { u, token } = await lease(initial.c, initial.u), c = initial.c;
        const attemptId = crypto.randomUUID(), objectKey = `staging/${id}/${attemptId}`;
        let allocated = false, issued = false;
        try {
            await available(c);
            const n = await q("SELECT count(*) AS n FROM upload_attempts WHERE upload_id=? AND kind='part' AND part_number=?", id, number).first<{ n: number }>();
            if ((n?.n ?? 0) >= 3) throw new DomainError('UPLOAD_RETRY_LIMIT', '此分块重试已达上限，请确认并清理后重新上传。', 409);
            const allocation = await operation(c.user.id, 'upload-stage-allocate', id, attemptId, { number });
            const extra = (n?.n ?? 0) ? expected : 0;
            await reserve(c, allocation, extra, [slot(c, allocation), assertGuard(db, allocation.opId, 'stage-lease', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()} AND received_parts=?)`, [...values(u, token), number - 1]), q("INSERT INTO upload_attempts(id,upload_id,kind,part_number,object_key,bytes,state,active,generation) VALUES(?,?,'part',?,?,?,'pending',1,?)", attemptId, id, number, objectKey, expected, u.generation), q('UPDATE uploads SET reserved_bytes=reserved_bytes+? WHERE id=?', extra, id)]);
            allocated = true;
            const bytes = await readPart(stream, expected);
            if (await digest(bytes) !== commitment.digest) throw new DomainError('IDEMPOTENCY_CONFLICT', '续传文件内容与原文件不一致。', 409);
            issued = true;
            await bucket!.put(objectKey, bytes, { sha256: commitment.digest });
            await q('UPDATE upload_attempts SET active=0 WHERE id=?', attemptId).run();
            const op = await operation(c.user.id, 'upload-stage-commit', id, attemptId, {});
            await commit(c, op, [assertGuard(db, op.opId, 'stage-before', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()} AND received_parts=?)`, [...values(u, token), number - 1]), q('UPDATE upload_parts SET attempt_id=? WHERE upload_id=? AND part_number=? AND attempt_id IS NULL', attemptId, id, number), q("UPDATE upload_attempts SET state='committed' WHERE id=? AND active=0", attemptId), q("UPDATE uploads SET status='receiving',received_parts=received_parts+1 WHERE id=? AND generation=? AND lease_token=?", ...values(u, token)), assertGuard(db, op.opId, 'stage-after', 'EXISTS(SELECT 1 FROM uploads WHERE id=? AND received_parts=?) AND EXISTS(SELECT 1 FROM upload_parts WHERE upload_id=? AND part_number=? AND attempt_id=?)', [id, number, id, number, attemptId])], { id, partNumber: number });
            return { id, partNumber: number };
        } catch (error) {
            if (allocated && !issued) await q('UPDATE upload_attempts SET active=0 WHERE id=?', attemptId).run();
            if (allocated) await q("UPDATE upload_attempts SET state='garbage' WHERE id=? AND state='pending'", attemptId).run();
            if (error instanceof DomainError) throw error;
            throw unknown();
        } finally { await release(u, token); }
    }
    async function cleanupAttempt(a: Attempt, u: Row) {
        // HEAD absence cannot settle a one-shot PUT/complete whose outcome is unknown.
        if (a.active) {
            const object = await bucket!.head(a.object_key);
            if (!object || object.key !== a.object_key || object.size !== a.bytes) return false;
            if (a.kind === 'part') {
                const commitment = await q('SELECT digest FROM upload_parts WHERE upload_id=? AND part_number=?', u.id, a.part_number).first<{ digest: string }>();
                const checksum = object.checksums.sha256;
                if (!commitment || !checksum || Array.from(new Uint8Array(checksum), b => b.toString(16).padStart(2, '0')).join('') !== commitment.digest) return false;
            }
            await q('UPDATE upload_attempts SET active=0 WHERE id=?', a.id).run();
        }
        if (a.multipart_id) {
            try { await bucket!.resumeMultipartUpload(a.object_key, a.multipart_id).abort(); }
            catch (error) { if (!/NoSuchUpload|does not exist|not found|10024/i.test(String(error))) return false; }
        }
        await bucket!.delete(a.object_key);
        if (await bucket!.head(a.object_key)) return false;
        // Same-row update prevents repeated cleanup from releasing physical reservation twice.
        await db.batch([q("UPDATE uploads SET reserved_bytes=reserved_bytes-? WHERE id=? AND EXISTS(SELECT 1 FROM upload_attempts WHERE id=? AND state!='deleted' AND active=0)", a.kind === 'part' || a.id !== u.assembly_id ? a.bytes : 0, u.id, a.id), q("UPDATE upload_attempts SET state='deleted' WHERE id=? AND active=0", a.id)]);
        return true;
    }
    async function ready(p: Principal | null, c: Context, u: Row) {
        if (u.transfer_active || u.lease_token || u.lease_until) {
            // Repair only an expired terminal lease from the earlier protocol.
            // A current lease/new generation or closed state must keep its fence.
            if (u.lease_token && (!u.lease_until || u.lease_until > now())) throw busy();
            const op = await operation(c.user.id, 'upload-ready-recover', u.id, `${u.generation}_${u.version}`, {});
            await commit(c, op, [
                assertGuard(db, op.opId, 'ready-recover-before', `EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND version=? AND generation=? AND object_key IS ? AND status='ready' AND cleanup_state='none' AND lease_token IS ? AND lease_until IS ? AND (lease_token IS NULL OR lease_until<=?)) AND NOT EXISTS(SELECT 1 FROM upload_attempts WHERE upload_id=? AND active=1)`, [u.id, c.user.id, u.version, u.generation, u.object_key, u.lease_token, u.lease_until, now(), u.id]),
                q("UPDATE uploads SET lease_token=NULL,lease_until=NULL,transfer_active=0,generation=generation+1,version=version+1 WHERE id=? AND version=? AND generation=? AND status='ready' AND cleanup_state='none'", u.id, u.version, u.generation),
                assertGuard(db, op.opId, 'ready-recover-after', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND version=? AND generation=? AND object_key IS ? AND status='ready' AND cleanup_state='none' AND transfer_active=0 AND lease_token IS NULL AND lease_until IS NULL)", [u.id, c.user.id, u.version + 1, u.generation + 1, u.object_key]),
            ], { id: u.id });
        }
        const current = await own(p, u.id);
        if (current.u.status !== 'ready' || current.u.cleanup_state !== 'none' || current.u.transfer_active || current.u.lease_token || current.u.lease_until) throw conflict();
        return { id: u.id, status: 'ready', mime: current.u.mime, durationSec: current.u.duration_sec };
    }
    async function complete(p: Principal | null, id: string, key: string) {
        const initial = await own(p, id), c = initial.c;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError('INVALID_INPUT', '需要有效请求标识。');
        if (initial.u.cleanup_target === 'rejected') throw rejected(initial.u.cleanup_error);
        if (initial.u.cleanup_state !== 'none') throw new DomainError('CLEANUP_PENDING', '上传正在清理，空间仍保留。', 503, true);
        if (initial.u.status === 'ready') return ready(p, c, initial.u);
        const expected = Math.ceil(initial.u.bytes / MEDIA_PART_BYTES);
        if (initial.u.received_parts !== expected) throw new DomainError('UPLOAD_INCOMPLETE', '请先续传缺失的分块。', 409);
        const { u, token, expired } = await lease(c, initial.u);
        let currentAttempt: Attempt | null = null;
        let assemblySlot = false, assemblyWriting = false, inspectingMedia = false, retiredReady = false;
        try {
            if (u.status !== 'received') {
                currentAttempt = u.assembly_id ? await q('SELECT * FROM upload_attempts WHERE id=?', u.assembly_id).first<Attempt>() : null;
                if (currentAttempt && (expired || currentAttempt.active || currentAttempt.state === 'garbage')) {
                    // A predecessor may still complete. Its key and full physical reservation
                    // remain quarantined; the successor gets a fresh multipart and object key.
                    await q("UPDATE upload_attempts SET state='garbage' WHERE id=? AND state!='deleted'", currentAttempt.id).run();
                    currentAttempt = null;
                }
                if (!currentAttempt) {
                    const count = await q("SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND kind='assembly'", id).first<{ n: number }>();
                    if ((count?.n ?? 0) >= 3) throw new DomainError('UPLOAD_RETRY_LIMIT', '合并重试已达上限，请清理后重新上传。', 409);
                    const aid = crypto.randomUUID(), objectKey = `quarantine/${id}/${aid}`;
                    const extra = u.assembly_id ? u.bytes : 0;
                    const allocation = await operation(c.user.id, 'upload-assembly-allocate', id, aid, {});
                    await available(c);
                    await reserve(c, allocation, extra, [slot(c, allocation), assertGuard(db, allocation.opId, 'assembly-lease', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()})`, values(u, token)), q("INSERT INTO upload_attempts(id,upload_id,kind,part_number,object_key,bytes,state,active,generation) VALUES(?,?,'assembly',0,?,?,'pending',1,?)", aid, id, objectKey, u.bytes, u.generation), q('UPDATE uploads SET assembly_id=?,reserved_bytes=reserved_bytes+? WHERE id=?', aid, extra, id)]);
                    const multipart = await bucket!.createMultipartUpload(objectKey);
                    const written = await q(`UPDATE upload_attempts SET multipart_id=?,active=0 WHERE id=? AND EXISTS(SELECT 1 FROM uploads WHERE ${fence()})`, multipart.uploadId, aid, ...values(u, token)).run();
                    if (!written.meta.changes) {
                        // Persist settlement/ID even after cancellation, solely for cleanup.
                        await q("UPDATE upload_attempts SET multipart_id=?,active=0,state='garbage' WHERE id=? AND state!='deleted'", multipart.uploadId, aid).run();
                        await multipart.abort().catch(() => {}); throw conflict();
                    }
                    currentAttempt = await q('SELECT * FROM upload_attempts WHERE id=?', aid).first<Attempt>();
                }
                const a = currentAttempt!;
                if (!a.multipart_id) throw new DomainError('CLEANUP_PENDING', '合并初始化结果未知，空间仍保留。请清理此上传。', 503, true);
                if (a.completed_parts < expected) {
                    const number = a.completed_parts + 1;
                    const receipt = await q('SELECT a.object_key,p.bytes,p.digest FROM upload_parts p JOIN upload_attempts a ON a.id=p.attempt_id WHERE p.upload_id=? AND p.part_number=?', id, number).first<{ object_key: string; bytes: number; digest: string }>();
                    if (!receipt) throw unknown();
                    await activate(c, u, token, a.id); assemblySlot = true;
                    const object = await bucket!.get(receipt.object_key);
                    if (!object || object.size !== receipt.bytes) throw unknown();
                    const bytes = new Uint8Array(await object.arrayBuffer());
                    if (await digest(bytes) !== receipt.digest) throw unknown();
                    assemblyWriting = true;
                    const part = await bucket!.resumeMultipartUpload(a.object_key, a.multipart_id).uploadPart(number, bytes);
                    await q('UPDATE upload_attempts SET active=0 WHERE id=?', a.id).run(); assemblySlot = false;
                    if (part.partNumber !== number || !part.etag || part.etag.length > 1024) throw unknown();
                    const op = await operation(c.user.id, 'upload-assemble-part', id, `${a.id}_${number}`, {});
                    await commit(c, op, [assertGuard(db, op.opId, 'assembly-before', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()} AND assembly_id=?)`, [...values(u, token), a.id]), q('INSERT INTO upload_assembly_parts(attempt_id,part_number,etag) VALUES(?,?,?)', a.id, number, part.etag), q('UPDATE upload_attempts SET completed_parts=? WHERE id=? AND completed_parts=?', number, a.id, number - 1), assertGuard(db, op.opId, 'assembly-after', 'EXISTS(SELECT 1 FROM upload_attempts WHERE id=? AND completed_parts=?)', [a.id, number])], { id });
                    return { id, status: 'assembling', assembledParts: number, totalParts: expected };
                }
                const receipts = (await q('SELECT part_number AS partNumber,etag FROM upload_assembly_parts WHERE attempt_id=? ORDER BY part_number LIMIT 1024', a.id).all<R2UploadedPart>()).results;
                if (receipts.length !== expected || receipts.some((part, i) => part.partNumber !== i + 1 || !part.etag || part.etag.length > 1024)) throw unknown();
                await activate(c, u, token, a.id); assemblySlot = true; assemblyWriting = true;
                let stored = await bucket!.head(a.object_key);
                if (!stored) stored = await bucket!.resumeMultipartUpload(a.object_key, a.multipart_id).complete(receipts);
                await q('UPDATE upload_attempts SET active=0 WHERE id=?', a.id).run(); assemblySlot = false;
                if (stored.size !== u.bytes) throw unknown();
                const op = await operation(c.user.id, 'upload-received-v2', id, a.id, {});
                await commit(c, op, [assertGuard(db, op.opId, 'received-before', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()} AND assembly_id=?)`, [...values(u, token), a.id]), q("UPDATE uploads SET status='received',object_key=?,multipart_id=? WHERE id=?", a.object_key, a.multipart_id, id), q("UPDATE upload_attempts SET state='committed' WHERE id=?", a.id)], { id });
                return { id, status: 'validating' };
            }
            // Remove one staging/abandoned object per call. Bounded cleanup also creates
            // enough headroom before metadata validation; unknown attempts never vanish.
            const obsolete = await q("SELECT * FROM upload_attempts WHERE upload_id=? AND id!=? AND state IN ('pending','committed','garbage') ORDER BY state,id LIMIT 1", id, u.assembly_id).first<Attempt>();
            if (obsolete) {
                if (!await cleanupAttempt(obsolete, u)) throw new DomainError('CLEANUP_PENDING', '临时文件结果尚未确认，空间仍保留。请稍后重试。', 503, true);
                return { id, status: 'validating' };
            }
            inspectingMedia = true;
            const step = await inspectMP4Stage(u.bytes, async (offset, length) => {
                const range = await bucket!.get(u.object_key!, { range: { offset, length } });
                if (!range) throw unknown(); return range.arrayBuffer();
            }, u.validation_state ? JSON.parse(u.validation_state) : null, policy);
            inspectingMedia = false;
            const terminal = step.media ? ',lease_token=NULL,lease_until=NULL,transfer_active=0,version=version+1' : '';
            const op = await operation(c.user.id, 'upload-validation-step', id, token, {});
            await commit(c, op, [assertGuard(db, op.opId, 'validation-before', `EXISTS(SELECT 1 FROM uploads WHERE ${fence()} AND status='received' AND object_key=?)`, [...values(u, token), u.object_key]), q(`UPDATE uploads SET validation_state=?,status=?,mime=?,duration_sec=?${terminal} WHERE id=? AND generation=? AND lease_token=?`, JSON.stringify(step.state), step.media ? 'ready' : 'received', step.media?.mime ?? null, step.media?.durationSec ?? null, ...values(u, token)), assertGuard(db, op.opId, 'validation-after', `EXISTS(SELECT 1 FROM uploads WHERE id=? AND generation=? AND version=? AND status=? AND cleanup_state='none'${step.media ? ' AND transfer_active=0 AND lease_token IS NULL AND lease_until IS NULL' : ' AND lease_token=?'})`, step.media ? [id, u.generation, u.version + 2, 'ready'] : [id, u.generation, u.version + 1, 'received', token])], { id });
            retiredReady = !!step.media;
            return { id, status: step.media ? 'ready' : 'validating', ...step.media, metrics: step.metrics };
        } catch (error) {
            if (currentAttempt && assemblySlot && !assemblyWriting) await q('UPDATE upload_attempts SET active=0 WHERE id=?', currentAttempt.id).run();
            if (currentAttempt && assemblyWriting && u.status !== 'received') await q("UPDATE upload_attempts SET state='garbage' WHERE id=? AND state!='deleted'", currentAttempt.id).run();
            if (inspectingMedia && error instanceof DomainError && ['UNSUPPORTED_MEDIA', 'UNSUPPORTED_CODEC', 'UPLOAD_LIMIT'].includes(error.code)) {
                const rejectedState = await q(`UPDATE uploads SET cleanup_state='pending',cleanup_target='rejected',cleanup_error=?,generation=generation+1,lease_token=NULL,lease_until=NULL,transfer_active=0 WHERE ${fence()}`, error.code, ...values(u, token)).run();
                if (!rejectedState.meta.changes) throw conflict();
                throw rejected(error.code);
            }
            if (error instanceof DomainError) throw error;
            throw unknown();
        } finally { if (!retiredReady) await release(u, token); }
    }
    async function cancel(p: Principal | null, id: string, key: string) {
        const { c, u } = await own(p, id);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError('INVALID_INPUT', '需要有效请求标识。');
        if (u.status === 'cancelled' || u.status === 'rejected') return { id, status: u.status };
        if (await q('SELECT id FROM videos WHERE upload_id=?', id).first()) throw new DomainError('UPLOAD_IN_USE', '已挂载视频不能从上传列表清理。', 409);
        const op = await operation(c.user.id, 'upload-close-v2', id, key, {});
        if (!op.replay) await commit(c, op, [assertGuard(db, op.opId, 'unattached', 'NOT EXISTS(SELECT 1 FROM videos WHERE upload_id=?)', [id]), q("UPDATE uploads SET cleanup_state='pending',cleanup_target=coalesce(cleanup_target,'cancelled'),generation=generation+1,lease_token=NULL,lease_until=NULL,transfer_active=0 WHERE id=?", id)], { id });
        const attempt = await q("SELECT * FROM upload_attempts WHERE upload_id=? AND state IN ('pending','committed','garbage') ORDER BY state,id LIMIT 1", id).first<Attempt>();
        if (attempt) {
            try { if (!await cleanupAttempt(attempt, u)) throw unknown(); }
            catch { throw new DomainError('CLEANUP_PENDING', '临时写入或清理结果尚未确认，空间仍保留。请稍后重试。', 503, true); }
            return { id, status: 'cleaning' };
        }
        const final = await operation(c.user.id, 'upload-cancel-finish-v2', id, 'finish', {});
        await commit(c, final, [assertGuard(db, final.opId, 'all-clean', "NOT EXISTS(SELECT 1 FROM upload_attempts WHERE upload_id=? AND state IN ('pending','committed','garbage')) AND NOT EXISTS(SELECT 1 FROM videos WHERE upload_id=?)", [id, id]), q("UPDATE uploads SET status=coalesce(cleanup_target,'cancelled'),cleanup_state='deleted',reserved_bytes=0,object_key=NULL,version=version+1 WHERE id=? AND cleanup_state='pending'", id), assertGuard(db, final.opId, 'cancelled', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND status IN ('cancelled','rejected') AND cleanup_state='deleted')", [id])], { id });
        return { id, status: u.cleanup_target ?? 'cancelled' };
    }
    return { create, get, part, complete, cancel, policy };
}
