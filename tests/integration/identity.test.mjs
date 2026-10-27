import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';

const owner = { subject: 'synthetic-owner' };
const alice = { subject: 'synthetic-alice' };
const bob = { subject: 'synthetic-bob' };
const bootstrapInput = { discName: '合成领队', jerseyNumber: '01' };
const profile = { discName: '木棉', jerseyNumber: '07', returnTo: '/videos/synthetic?t=32' };
const now = () => new Date('2026-10-16T00:00:00Z');
async function fixture(t, persistent = false) {
  const directory = await mkdtemp(pathJoin(tmpdir(), 'kapok-d1-'));
  const make = () => new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } }', compatibilityDate: '2026-05-22', d1Databases: ['DB'], ...(persistent ? { d1Persist: directory } : {}) });
  let mf = make();
  let db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('../../drizzle/0000_identity.sql', import.meta.url), 'utf8');
  for (const sql of migration.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  let service = createService({ db, clock: now, bootstrapSiteUserId: owner.subject });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get service() { return service; }, async restart() { await mf.dispose(); mf = make(); db = await mf.getD1Database('DB'); service = createService({ db, clock: now, bootstrapSiteUserId: owner.subject }); } };
}
async function seeded(t, persistent) {
  const f = await fixture(t, persistent);
  const initialized = await f.service.bootstrap(owner, bootstrapInput, 'bootstrap-key');
  assert.ok(initialized.inviteToken);
  return { f, token: initialized.inviteToken };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('unseeded identity joins once, preserves string 07, maps stable ID after D1 restart', async t => {
  const { f, token } = await seeded(t, true);
  assert.equal((await f.service.me(alice)).user, null);
  const result = await f.service.join(alice, { ...profile, token }, 'join-alice');
  assert.equal(result.me.profile.jerseyNumber, '07');
  assert.equal(result.returnTo, '/videos/synthetic?t=32');
  const userId = result.me.user.id;
  await f.restart();
  assert.equal((await f.service.me(alice)).user.id, userId);
  assert.equal((await f.service.me(alice)).membership.role, 'member');
});

test('one-use invite concurrency commits one member and rolls losing user/profile/operation back', async t => {
  const { f, token } = await seeded(t);
  const results = await Promise.allSettled([f.service.join(alice, { ...profile, token }, 'a'), f.service.join(bob, { ...profile, token }, 'b')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM users').first()).n, 2);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM profiles').first()).n, 2);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM operations').first()).n, 2);
  assert.equal((await f.db.prepare('SELECT used_count AS n FROM invites').first()).n, 1);
});

test('invalid invite guard rolls back all first-join identity/member/result writes', async t => {
  const { f } = await seeded(t);
  await rejectsCode(f.service.join(alice, { ...profile, token: 'not-a-valid-invitation-token' }, 'invalid'), 'INVITE_UNAVAILABLE');
  for (const table of ['users', 'auth_identities', 'profiles', 'memberships', 'operations']) assert.equal((await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 0);
  // NOT NULL and CHECK failures are real database constraints, not an app-side changes check.
  await assert.rejects(f.db.prepare("INSERT INTO write_guards VALUES ((SELECT id FROM operations LIMIT 1),'null-proof',NULL)").run());
  await assert.rejects(f.db.prepare("INSERT INTO write_guards VALUES ((SELECT id FROM operations LIMIT 1),'zero-proof',0)").run());
});

test('same key is bound to normalized input and concurrent duplicates replay stable result', async t => {
  const { f, token } = await seeded(t);
  const input = { ...profile, token };
  const [first, duplicate] = await Promise.all([f.service.join(alice, input, 'same'), f.service.join(alice, input, 'same')]);
  assert.equal(first.operationId, duplicate.operationId);
  assert.equal((await f.service.join(alice, input, 'same')).operationId, first.operationId); // caller dropped original response
  await rejectsCode(f.service.join(alice, { ...input, jerseyNumber: '08' }, 'same'), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.db.prepare('SELECT used_count AS n FROM invites').first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 1);
});

test('configured bootstrap subject only, service token without identity denied, no first visitor admin', async t => {
  const f = await fixture(t);
  await rejectsCode(f.service.bootstrap(bob, bootstrapInput, 'bad'), 'FORBIDDEN');
  await rejectsCode(f.service.bootstrap(null, bootstrapInput, 'token-only'), 'UNAUTHENTICATED');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM users').first()).n, 0);
  const initialized = await f.service.bootstrap(owner, bootstrapInput, 'correct');
  const replay = await f.service.bootstrap(owner, bootstrapInput, 'correct');
  assert.equal(replay.operationId, initialized.operationId);
  assert.equal(replay.inviteToken, undefined);
  await rejectsCode(f.service.bootstrap(owner, bootstrapInput, 'different'), 'ALREADY_INITIALIZED');
  assert.equal((await f.service.me(bob)).user, null);
});

test('profile updates belong only to authenticated actor; version/role/owner spoofing rejected', async t => {
  const { f, token } = await seeded(t);
  await f.service.join(alice, { ...profile, token }, 'join');
  const before = await f.service.me(owner);
  await rejectsCode(f.service.updateProfile(alice, { discName: '伪造', jerseyNumber: '10', expectedVersion: 1, userId: before.user.id }, 'spoof'), 'INVALID_INPUT');
  await rejectsCode(f.service.join(bob, { ...profile, token, role: 'admin' }, 'role'), 'INVALID_INPUT');
  const changed = await f.service.updateProfile(alice, { discName: '新盘名', jerseyNumber: '07', expectedVersion: 1 }, 'edit');
  assert.equal(changed.me.profile.version, 2);
  await rejectsCode(f.service.updateProfile(alice, { discName: '旧写入', jerseyNumber: '07', expectedVersion: 1 }, 'stale'), 'VERSION_CONFLICT');
  assert.deepEqual(await f.service.me(owner), before);
});

test('expired/revoked invites and malicious return targets fail safely; member does not consume another invite', async t => {
  const { f, token } = await seeded(t);
  await f.db.prepare('UPDATE invites SET revoked = 1').run();
  await rejectsCode(f.service.join(alice, { ...profile, token }, 'revoked'), 'INVITE_UNAVAILABLE');
  await f.db.prepare("UPDATE invites SET revoked = 0, expires_at = '2020-01-01T00:00:00.000Z'").run();
  await rejectsCode(f.service.join(alice, { ...profile, token }, 'expired'), 'INVITE_UNAVAILABLE');
  await f.db.prepare("UPDATE invites SET expires_at = '2030-01-01T00:00:00.000Z'").run();
  const result = await f.service.join(alice, { ...profile, token, returnTo: '//evil.example' }, 'safe');
  assert.equal(result.returnTo, '/');
  const next = await f.service.createInvite(owner, {}, 'invite-2');
  await f.service.join(alice, { ...profile, token: next.inviteToken }, 'already');
  assert.equal((await f.db.prepare('SELECT used_count AS n FROM invites WHERE id = ?').bind(next.inviteId).first()).n, 0);
  await rejectsCode(f.service.createInvite(alice, {}, 'no-admin'), 'FORBIDDEN');
});

test('a real committed D1 batch whose response is lost is recovered with the same operation', async t => {
  const { f, token } = await seeded(t);
  let lost = false;
  const disconnectDb = new Proxy(f.db, { get(target, property) {
    if (property === 'batch') return async statements => { const result = await target.batch(statements); if (!lost) { lost = true; throw new Error('synthetic transport disconnected AFTER commit'); } return result; };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = createService({ db: disconnectDb, clock: now, bootstrapSiteUserId: owner.subject });
  const result = await service.join(alice, { ...profile, token }, 'lost-response');
  assert.equal(lost, true);
  assert.equal((await f.service.join(alice, { ...profile, token }, 'lost-response')).operationId, result.operationId);
  assert.equal((await f.db.prepare('SELECT used_count AS n FROM invites').first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 1);
});

test('concurrent bootstrap keys create one singleton, one admin and one invitation', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.service.bootstrap(owner, bootstrapInput, 'owner-a'), f.service.bootstrap(owner, bootstrapInput, 'owner-b')]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  for (const table of ['users', 'auth_identities', 'profiles', 'memberships', 'operations', 'teams', 'bootstraps', 'invites']) assert.equal((await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 1);
});

test('recipient restrictions and rejoin use a new epoch without a second profile', async t => {
  const { f, token } = await seeded(t);
  await f.db.prepare('UPDATE invites SET recipient_subject = ?').bind(alice.subject).run();
  await rejectsCode(f.service.join(bob, { ...profile, token }, 'recipient'), 'INVITE_UNAVAILABLE');
  const first = await f.service.join(alice, { ...profile, token }, 'first');
  await f.db.prepare("UPDATE memberships SET status='left',version=version+1 WHERE user_id=?").bind(first.me.user.id).run();
  const next = await f.service.createInvite(owner, {}, 'second-invite');
  const rejoined = await f.service.join(alice, { ...profile, token: next.inviteToken }, 'second');
  assert.equal(rejoined.me.user.id, first.me.user.id);
  assert.equal(rejoined.me.membership.epoch, 2);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM profiles WHERE user_id=?').bind(first.me.user.id).first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 2);
});

test('HTTP requires identity and same Origin, keeps responses no-store and never takes role/actor from input', async t => {
  const { dispatchApi } = await import('../../lib/server/http.ts');
  const { f, token } = await seeded(t);
  const request = (path, input, overrides = {}) => new Request(`https://kapok.test/api/v1/${path}`, { method: 'POST', headers: { Origin: 'https://kapok.test', 'Content-Type': 'application/json', 'Idempotency-Key': 'http-test', 'X-Kapok-Actor': alice.subject, ...overrides }, body: JSON.stringify(input) });
  const tokenOnly = await dispatchApi(request('internal/bootstrap', bootstrapInput, { Authorization: 'Bearer synthetic-service-token' }), ['internal', 'bootstrap'], null, f.service);
  assert.equal(tokenOnly.status, 401);
  const crossOrigin = await dispatchApi(request('join', { ...profile, token }, { Origin: 'https://evil.test' }), ['join'], alice, f.service);
  assert.equal(crossOrigin.status, 403);
  const missingOrigin = new Request('https://kapok.test/api/v1/join', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'missing-origin' }, body: JSON.stringify({ ...profile, token }) });
  assert.equal((await dispatchApi(missingOrigin, ['join'], alice, f.service)).status, 403);
  const changedAccount = await dispatchApi(request('join', { ...profile, token }, { 'X-Kapok-Actor': bob.subject }), ['join'], alice, f.service);
  assert.equal(changedAccount.status, 409);
  assert.equal((await changedAccount.json()).error.code, 'ACCOUNT_CHANGED');
  const spoofed = await dispatchApi(request('join', { ...profile, token, subject: owner.subject, role: 'admin' }), ['join'], alice, f.service);
  assert.equal(spoofed.status, 400);
  const success = await dispatchApi(request('join', { ...profile, token }), ['join'], alice, f.service);
  assert.equal(success.status, 200);
  assert.match(success.headers.get('cache-control'), /private, no-store/);
  assert.match(tokenOnly.headers.get('cache-control'), /no-store/);
  const body = await success.json();
  assert.equal(body.data.me.membership.role, 'member');
  assert.ok(body.requestId);
  const own = await dispatchApi(new Request('https://kapok.test/api/v1/me'), ['me'], bob, f.service);
  assert.equal((await own.json()).data.user, null);
});

test('returnTo rejects external, auth, escaped slash and script targets while retaining training timepoints', async () => {
  const { safeReturnTo } = await import('../../lib/server/domain.ts');
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/callback', '/signin-with-chatgpt', '/signout-with-chatgpt', 'javascript:alert(1)', '/videos/x\n']) assert.equal(safeReturnTo(path), '/');
  assert.equal(safeReturnTo('/videos/synthetic?t=32#comment-discussion'), '/videos/synthetic?t=32#comment-discussion');
});

test('lost invitation token is replaced only with explicit atomic revocation; plaintext token is not persisted', async t => {
  const { f, token } = await seeded(t);
  const initialInvite = await f.db.prepare('SELECT id FROM invites').first();
  const replacement = await f.service.createInvite(owner, { revokeInviteId: initialInvite.id }, 'revoke-and-reissue');
  await rejectsCode(f.service.join(alice, { ...profile, token }, 'revoked-old'), 'INVITE_UNAVAILABLE');
  await f.service.join(alice, { ...profile, token: replacement.inviteToken }, 'replacement');
  assert.equal((await f.db.prepare('SELECT revoked FROM invites WHERE id=?').bind(initialInvite.id).first()).revoked, 1);
  const replay = await f.service.createInvite(owner, { revokeInviteId: initialInvite.id }, 'revoke-and-reissue');
  assert.equal(replay.inviteToken, undefined);
  const allOperations = await f.db.prepare('SELECT result_json FROM operations').all();
  assert.equal(JSON.stringify(allOperations).includes(replacement.inviteToken), false);
  assert.equal(JSON.stringify(allOperations).includes(token), false);
});

test('explicit local seed initializes isolated on-disk D1 and is safe to repeat', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = await mkdtemp(pathJoin(tmpdir(), 'kapok-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile);
  const first = await run(process.execPath, ['scripts/seed-local.mjs', '--confirm-local', '--state-dir', directory], { cwd: new URL('../../', import.meta.url) });
  assert.match(first.stdout, /Local synthetic dataset initialized/);
  const second = await run(process.execPath, ['scripts/seed-local.mjs', '--confirm-local', '--state-dir', directory], { cwd: new URL('../../', import.meta.url) });
  assert.match(second.stdout, /already initialized/);
});

test('a zero-row receipt write trips the late guard and rolls back consumed invite, new user and membership', async t => {
  const { f, token } = await seeded(t);
  // Test-only SQLite trigger suppresses the receipt insert, after the service already wrote member and invite.
  await f.db.prepare('CREATE TRIGGER suppress_receipt BEFORE INSERT ON join_receipts BEGIN SELECT RAISE(IGNORE); END').run();
  await rejectsCode(f.service.join(alice, { ...profile, token }, 'late-zero'), 'INVITE_UNAVAILABLE');
  for (const table of ['users', 'auth_identities', 'profiles', 'memberships', 'operations']) assert.equal((await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n, 1);
  assert.equal((await f.db.prepare('SELECT used_count AS n FROM invites').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM join_receipts').first()).n, 0);
  await f.db.prepare('DROP TRIGGER suppress_receipt').run();
  assert.equal((await f.service.join(alice, { ...profile, token }, 'late-zero')).me.membership.role, 'member');
});
