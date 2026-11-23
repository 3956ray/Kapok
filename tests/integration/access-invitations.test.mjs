// Fixed-team onboarding supersedes the former Access invitation lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { actorKey, identityFor } from '../../lib/server/identity.ts';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
import { sitesPrincipal } from '../helpers/identity-fixture.mjs';

const principal = (subject, verifiedEmail = subject + '@example.test', issuer = 'https://synthetic.cloudflareaccess.test') =>
  ({ provider: 'access', issuer, subject, verifiedEmail });
const admin = principal('owner');
const member = principal('player');
const fields = { discName: '队友', jerseyNumber: '07' };
const profile = { ...fields, intent: 'register', confirmed: true };
const target = '/videos/sample?t=14#comment-note';
const expected = membership => ({ expectedVersion: membership.version, expectedEpoch: membership.epoch });

async function fixture(t, stopAt) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-05-22', d1Databases: ['DB'] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const dir = new URL('../../drizzle/', import.meta.url);
  const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort();
  const migrate = async file => {
    const sql = await readFile(new URL(file, dir), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').flatMap(part => part.includes('CREATE TRIGGER') ? [part] : part.split(';')).map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
  };
  for (const file of files) {
    if (stopAt && file >= stopAt) break;
    await migrate(file);
  }
  const make = (binding = db, config = ' OWNER@example.test ') => createService({ db: binding, accessInitialAdminEmail: config });
  const service = make();
  const count = async table => (await db.prepare('SELECT count(*) AS n FROM ' + table).first()).n;
  async function request(p, route, body, key = 'key', method = body === undefined ? 'GET' : 'POST', selected = service, actor = p) {
    const url = 'https://kapok.test';
    const init = body === undefined ? undefined : { method, headers: { Origin: url, 'X-Kapok-Actor': await actorKey(actor), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) };
    const response = await dispatchApi(new Request(url + '/api/v1/' + route, init), route.split('/'), p, selected);
    return { status: response.status, headers: response.headers, ...(await response.json()) };
  }
  return { db, make, service, count, request, migrate, files };
}

function interrupt(db, onBatch, after = false) {
  let once = true;
  return new Proxy(db, { get(target, property) {
    if (property === 'batch') return async statements => {
      const run = once;
      once = false;
      if (run && !after) await onBatch();
      const result = await target.batch(statements);
      if (run && after) await onBatch();
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('verified Access member registers with two fields, keeps safe deep link and leaves old API closed', async t => {
  const f = await fixture(t);
  const before = await f.request(member, 'me');
  assert.equal(before.data.user, null);
  assert.equal(await f.count('teams'), 1);
  assert.equal((await f.request(member, 'trainings')).status, 403);
  for (const body of [fields, { ...fields, intent: 'login', confirmed: true }, { ...fields, intent: 'register', confirmed: false }]) {
    const refused = await f.request(member, 'join', body, 'without-confirmation');
    assert.equal(refused.error.code, 'INVALID_INPUT');
  }
  for (const table of ['users', 'auth_identities', 'profiles', 'memberships', 'operations']) assert.equal(await f.count(table), 0);
  const invalid = await f.request(member, 'join', { ...profile, role: 'admin' }, 'bad-role');
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  const joined = await f.request(member, 'join', { ...profile, returnTo: target });
  assert.equal(joined.status, 200, JSON.stringify(joined.error));
  assert.equal(joined.data.me.team.name, 'Kapok');
  assert.equal(joined.data.me.membership.role, 'member');
  assert.equal(joined.data.me.profile.jerseyNumber, '07');
  assert.equal(joined.data.returnTo, target);
  assert.match(joined.headers.get('Cache-Control'), /no-store/);
  assert.equal((await f.request(member, 'trainings')).status, 200);
  assert.equal((await f.request(admin, 'internal/bootstrap', profile)).status, 404);
  assert.equal((await f.request(admin, 'admin/invites', {})).status, 404);
  assert.equal((await f.request(member, 'admin/invites')).status, 404);
  assert.equal((await f.request(sitesPrincipal('new-site'), 'join', profile)).status, 403);
  assert.equal(await f.count('invites'), 0);
  assert.equal(await f.count('bootstraps'), 0);
  assert.equal(await f.count('join_receipts'), 0);
});

test('concurrent subjects and retries grant only the configured first administrator without email identity linking', async t => {
  const f = await fixture(t);
  const sameEmail = principal('other-owner-subject', admin.verifiedEmail);
  const sameSubject = principal(admin.subject, admin.verifiedEmail, 'https://different.cloudflareaccess.test');
  const accounts = [member, admin, sameEmail, sameSubject];
  const results = await Promise.all([
    ...accounts.map(p => f.request(p, 'join', { ...profile, returnTo: '//outside.test' })),
    f.request(member, 'join', { ...profile, returnTo: '//outside.test' }),
    f.request(member, 'join', { ...profile, discName: '另一个名字', returnTo: '/growth' }, 'different-key'),
  ]);
  for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.error));
  assert.equal(results.filter((r, i) => i < 4 && r.data.me.membership.role === 'admin').length, 1);
  assert.equal(results[0].data.me.membership.role, 'member');
  assert.equal(results[0].data.returnTo, '/');
  assert.equal(results[0].data.operationId, results[4].data.operationId);
  assert.equal(results[0].data.me.membership.id, results[5].data.me.membership.id);
  assert.equal(results[5].data.returnTo, '/growth');
  assert.equal(results[0].data.me.profile.discName, results[5].data.me.profile.discName);
  assert.equal(await f.count('profiles'), 4);
  assert.equal(new Set(results.slice(0, 4).map(r => r.data.me.user.id)).size, 4);
  assert.equal(await f.count('memberships'), 4);
  assert.equal(await f.count('teams'), 1);
  assert.equal(await f.count('initial_admin_grants'), 1);
});

test('role mutation is admin-only, audited, last-admin safe and persists after demotion and re-login', async t => {
  const f = await fixture(t);
  const a = (await f.request(admin, 'join', profile)).data.me;
  const b = (await f.request(member, 'join', profile)).data.me;
  const update = (actor, target, role, key) => f.request(actor, 'admin/members/' + target.user.id,
    { ...expected(target.membership), role, status: 'active' }, key, 'PATCH');
  assert.equal((await update(member, b, 'admin', 'self-promote')).status, 403);
  assert.equal((await update(admin, a, 'member', 'last')).error.code, 'MEMBERSHIP_CONFLICT');
  assert.equal((await update(admin, b, 'admin', 'promote')).data.role, 'admin');
  assert.equal((await update(member, a, 'member', 'demote')).data.role, 'member');
  assert.equal((await f.request(admin, 'admin/members')).status, 403);
  assert.equal((await f.request(admin, 'me')).data.membership.role, 'member');
  assert.equal((await f.request(admin, 'join', profile)).data.me.membership.role, 'member');
  const other = principal('new-owner-subject', admin.verifiedEmail);
  assert.equal((await f.request(other, 'join', profile)).data.me.membership.role, 'member');
  const audit = (await f.db.prepare('SELECT action,reason FROM moderation_audit ORDER BY rowid').all()).results;
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(row => [row.action, JSON.parse(row.reason).to.role]), [['member-update', 'admin'], ['member-update', 'member']]);
});

test('paused, left and deleted Access accounts cannot re-register or replay, even with old requests', async t => {
  const f = await fixture(t);
  await f.request(admin, 'join', profile);
  for (const status of ['paused', 'left', 'deleted']) {
    const p = principal(status);
    const first = await f.request(p, 'join', profile);
    assert.equal(first.status, 200, JSON.stringify(first.error));
    const account = first.data.me;
    if (status === 'deleted') await f.db.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(account.user.id).run();
    else await f.db.prepare('UPDATE memberships SET status=?,version=version+1 WHERE id=?').bind(status, account.membership.id).run();
    for (const key of ['key', 'fresh']) assert.equal((await f.request(p, 'join', profile, key)).status, 403);
  }
  assert.equal(await f.count('memberships'), 4);
});

test('unknown, committed-lost and late-revoked outcomes reconcile without duplicate writes or false success', async t => {
  const f = await fixture(t);
  const noCommit = f.make(interrupt(f.db, () => { throw new Error('unknown transport outcome'); }));
  const unknown = await f.request(member, 'join', profile, 'uncertain', 'POST', noCommit);
  assert.equal(unknown.error.code, 'RESULT_UNKNOWN');
  assert.equal(await f.count('memberships'), 0);
  const lost = f.make(interrupt(f.db, () => { throw new Error('lost D1 response'); }, true));
  const recovered = await f.request(member, 'join', profile, 'uncertain', 'POST', lost);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.error));
  assert.equal((await f.request(member, 'join', profile, 'uncertain')).data.operationId, recovered.data.operationId);
  assert.equal((await f.request(member, 'join', { ...profile, jerseyNumber: '08' }, 'uncertain')).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.request(member, 'join', profile, 'actor-changed', 'POST', f.service, admin)).error.code, 'ACCOUNT_CHANGED');
  const revoke = f.make(interrupt(f.db, async () => {
    await f.db.prepare("UPDATE memberships SET status='paused',version=version+1 WHERE role='admin'").run();
  }, true));
  assert.equal((await f.request(admin, 'join', profile, 'late', 'POST', revoke)).status, 403);
  assert.equal((await f.request(admin, 'join', profile, 'late')).status, 403);
  assert.equal(await f.count('memberships'), 2);
});

test('existing team, membership and private reflection survive 0008 and 0009 and stay owner-private', async t => {
  const f = await fixture(t, '0008');
  const ownerId = await identityFor(f.db, admin);
  await f.db.batch([
    f.db.prepare("INSERT INTO teams VALUES ('preserved-team',1,'木棉','existing description','time')"),
    f.db.prepare("INSERT INTO users(id,created_at) VALUES (?,'time')").bind(ownerId),
    f.db.prepare("INSERT INTO auth_identities(id,provider,issuer,subject,user_id) VALUES ('existing','access',?,?,?)").bind(admin.issuer, admin.subject, ownerId),
    f.db.prepare("INSERT INTO profiles(user_id,disc_name,jersey_number) VALUES (?,'原资料','09')").bind(ownerId),
    f.db.prepare("INSERT INTO memberships(id,team_id,user_id,role,status,epoch,joined_at) VALUES ('existing-member','preserved-team',?,'admin','active',2,'time')").bind(ownerId),
  ]);
  // Seed the pre-upgrade format without calling today's writer on an older D1 schema.
  const draft = { id: 'original-reflection' };
  await f.db.prepare(`INSERT INTO reflections (id,owner_id,team_id,title,text,date,created_at,updated_at)
    VALUES (?,?,'preserved-team','本人标题','既有私人正文','2026-11-07','time','time')`).bind(draft.id, ownerId).run();
  await f.migrate('0008_fixed_team_onboarding.sql');
  const before = (await f.request(admin, 'me')).data;
  assert.equal(before.team.name, 'KPark');
  const tables = ['users', 'auth_identities', 'profiles', 'memberships', 'reflections', 'operations', 'initial_admin_grants'];
  const snapshot = () => f.db.batch(tables.map(table => f.db.prepare('SELECT * FROM ' + table)));
  const rowsBefore = (await snapshot()).map(result => result.results);
  await f.migrate('0009_kapok_team_name.sql');
  const account = (await f.request(admin, 'me')).data;
  assert.deepEqual(account, { ...before, team: { ...before.team, name: 'Kapok' } });
  assert.deepEqual((await snapshot()).map(result => result.results), rowsBefore);
  assert.equal(await f.count('teams'), 1);
  assert.equal(account.team.id, 'preserved-team');
  assert.equal(account.membership.id, 'existing-member');
  assert.equal(account.membership.epoch, 2);
  assert.equal(account.team.name, 'Kapok');
  assert.equal(account.team.description, 'existing description');
  assert.equal(account.profile.discName, '原资料');
  for (const file of f.files.filter(name => name > '0009_kapok_team_name.sql')) await f.migrate(file);
  const fresh = (await f.request(principal('other-admin-mailbox', admin.verifiedEmail), 'join', profile)).data.me;
  assert.equal(fresh.membership.role, 'member');
  assert.equal((await f.request(member, 'join', profile)).status, 200);
  assert.equal((await f.request(member, 'reflections/' + draft.id)).status, 404);
  const personal = (await f.request(admin, 'reflections/' + draft.id)).data;
  assert.equal(personal.text, '既有私人正文');
  const memberDraft = (await f.request(member, 'reflections', { title: '队员复盘', text: '队员私人正文', date: '2026-11-07' }, 'member-draft')).data;
  assert.equal((await f.request(admin, 'reflections/' + memberDraft.id)).status, 404);
});

test('migration carries forward historical admin grants even after all role values changed', async t => {
  const f = await fixture(t, '0008');
  const ownerId = await identityFor(f.db, admin);
  await f.db.batch([
    f.db.prepare("INSERT INTO teams VALUES ('preserved-team',1,'Former name','original description','time')"),
    f.db.prepare("INSERT INTO users(id,created_at) VALUES (?,'time')").bind(ownerId),
    f.db.prepare("INSERT INTO auth_identities(id,provider,issuer,subject,user_id) VALUES ('existing','access',?,?,?)").bind(admin.issuer, admin.subject, ownerId),
    f.db.prepare("INSERT INTO profiles(user_id,disc_name,jersey_number) VALUES (?,'原资料','09')").bind(ownerId),
    f.db.prepare("INSERT INTO memberships(id,team_id,user_id,role,status,epoch,joined_at) VALUES ('old-admin','preserved-team',?,'member','active',2,'time')").bind(ownerId),
    f.db.prepare("INSERT INTO moderation_audit(id,actor_id,target_id,action,reason,created_at) VALUES ('audit',?,'old-admin','member-update',?,'time')")
      .bind(ownerId, JSON.stringify({ from: { role: 'admin' }, to: { role: 'member' } })),
  ]);
  await f.migrate('0008_fixed_team_onboarding.sql');
  assert.equal(await f.count('teams'), 1);
  assert.equal(await f.count('initial_admin_grants'), 1);
  const sameEmail = principal('new-subject', admin.verifiedEmail);
  const joined = (await f.request(sameEmail, 'join', profile)).data;
  assert.equal(joined.me.team.id, 'preserved-team');
  assert.equal(joined.me.team.name, 'KPark');
  assert.equal(joined.me.membership.role, 'member');
  assert.equal((await f.request(admin, 'me')).data.membership.role, 'member');
});
