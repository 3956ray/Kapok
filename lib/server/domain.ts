import type { MediaPolicy } from '../contracts/media';
import type { BootstrapResult, BootstrapStatus, InviteResult, JoinResult, Me, Principal, WriteResult } from '../contracts/index';
import { createDataRightsService } from './data-rights.ts';
import { createReflectionService } from './reflections.ts';
import { createTrainingService } from './training.ts';
import { identityFor, sha256 } from './identity.ts';

export class DomainError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) { super(message); this.code = code; this.status = status; this.retryable = retryable; }
}
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || /[\\\u0000-\u001f]/.test(value) || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://kapok.local');
    if (/%(?:2f|5c)/i.test(url.pathname) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return '/';
    const path = decodeURIComponent(url.pathname);
    const allowed = /^\/(?:$|trainings(?:\/[a-zA-Z0-9_-]+)?|videos\/[a-zA-Z0-9_-]+|growth|me(?:\/(?:data|recycle|edit))?|members(?:\/[a-zA-Z0-9_-]+)?|reflections\/(?:new|[a-zA-Z0-9_-]+(?:\/(?:edit|sharing))?)|announcements\/[a-zA-Z0-9_-]+|activity|admin\/(?:invites|announcements|members)|internal\/bootstrap)$/;
    if (url.origin !== 'https://kapok.local' || !allowed.test(path)) return '/';
    const params = url.searchParams;
    const id = /^[a-zA-Z0-9_-]{1,80}$/;
    const queryKeys = path.startsWith('/videos/') ? ['t'] : path === '/reflections/new' ? ['collection', 'training', 'video'] : path === '/activity' ? ['cursor'] : [];
    if ([...params.keys()].some(key => !queryKeys.includes(key) || params.getAll(key).length !== 1)) return '/';
    if (path === '/reflections/new' && params.has('collection') && (params.has('training') || params.has('video'))) return '/';
    for (const [key, value] of params) {
      if (key === 't' ? !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) : key === 'cursor' ? !/^[a-zA-Z0-9_+=/-]{1,512}$/.test(value) : !id.test(value)) return '/';
    }
    if (url.hash && !(path.startsWith('/videos/') && /^#comment-[a-zA-Z0-9_-]{1,80}$/.test(url.hash)) && !(path.startsWith('/announcements/') && url.hash === '#body')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/'; }
}
function object(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new DomainError('INVALID_INPUT', '请检查填写的内容。');
  return input as Record<string, unknown>;
}
function profile(input: Record<string, unknown>) {
  const { discName, jerseyNumber } = input;
  if (typeof discName !== 'string' || discName.trim().length < 1 || discName.trim().length > 20 || typeof jerseyNumber !== 'string' || jerseyNumber.trim().length < 1 || jerseyNumber.trim().length > 4) throw new DomainError('INVALID_INPUT', '盘名需为1–20字，背号需为1–4字的文字。');
  return { discName: discName.trim(), jerseyNumber: jerseyNumber.trim() };
}
function authenticated(principal: Principal | null): Principal {
  if (!principal?.subject) throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
  return principal;
}
export function assertGuard(db: D1Database, opId: string, phase: string, predicate: string, values: unknown[] = []) {
  // Always inserts. A missing/false scalar becomes 0, making D1 roll back the entire batch.
  return db.prepare(`INSERT INTO write_guards (op_id, phase, pass) VALUES (?, ?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END)`).bind(opId, phase, ...values);
}
type OperationRow = { id: string; input_hash: string; status: string; result_json: string | null };
export type StoredResult = { partNumber?: number; etag?: string; digest?: string; id?: string; sourceKind?: string; sourceId?: string; timestampSec?: number | null; userId?: string; membershipId?: string; returnTo?: string; inviteId?: string; expiresAt?: string };
export type ServiceOptions = { db: D1Database; bucket?: R2Bucket; clock?: () => Date; bootstrapSiteUserId?: string; mediaPolicy?: MediaPolicy };

export function createService({ db, bucket, clock = () => new Date(), bootstrapSiteUserId, mediaPolicy }: ServiceOptions) {
  const statement = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  async function me(principal: Principal | null): Promise<Me> {
    const current = authenticated(principal);
    const userId = await identityFor(db, current);
    const row = await statement(`SELECT u.id, u.status, p.disc_name, p.jersey_number, p.version AS profile_version,
      m.id AS member_id, m.team_id, m.role, m.status AS member_status, m.epoch, m.version AS member_version,
      t.name AS team_name, t.description AS team_description
      FROM users u JOIN auth_identities a ON a.user_id = u.id AND a.provider = 'site' AND a.subject = ?
      LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN memberships m ON m.user_id = u.id
      LEFT JOIN teams t ON t.id = m.team_id WHERE u.id = ?`, current.subject, userId).first<Record<string, string | number | null>>();
    if (!row) return { user: null, profile: null, membership: null, team: null };
    if (row.status !== 'active') return { user: { id: String(row.id), status: 'deleted' }, profile: null, membership: null, team: null };
    return {
      user: { id: String(row.id), status: row.status as 'active' | 'deleted' },
      profile: row.disc_name === null ? null : { discName: String(row.disc_name), jerseyNumber: String(row.jersey_number), version: Number(row.profile_version) },
      membership: row.member_id === null ? null : { id: String(row.member_id), teamId: String(row.team_id), role: row.role as 'admin' | 'coach' | 'member', status: row.member_status as 'active' | 'paused' | 'left', epoch: Number(row.epoch), version: Number(row.member_version) },
      team: row.member_status === 'active' ? { id: String(row.team_id), name: String(row.team_name), description: String(row.team_description) } : null,
    };
  }
  async function activeMember(principal: Principal | null, admin = false) {
    const current = await me(principal);
    if (current.user?.status !== 'active' || current.membership?.status !== 'active' || (admin && current.membership.role !== 'admin')) throw new DomainError('FORBIDDEN', '当前账号没有此操作权限。', 403);
    return current as Me & { user: NonNullable<Me['user']>; membership: NonNullable<Me['membership']> };
  }
  async function operation(actor: string, kind: string, target: string, key: string, input: unknown) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError('INVALID_INPUT', '需要有效的请求标识。');
    const inputHash = await sha256(JSON.stringify(input));
    async function lookup() {
      const row = await statement('SELECT id, input_hash, status, result_json FROM operations WHERE actor_id = ? AND kind = ? AND target_id = ? AND key = ?', actor, kind, target, key).first<OperationRow>();
      if (!row) return null;
      if (row.input_hash !== inputHash) throw new DomainError('IDEMPOTENCY_CONFLICT', '此请求标识已用于不同内容，请确认后重新提交。', 409);
      if (row.status !== 'done' || !row.result_json) throw new DomainError('RESULT_UNKNOWN', '尚未确认操作结果，请保留内容并使用同一请求重试。', 503, true);
      return { operationId: row.id, result: JSON.parse(row.result_json) as StoredResult };
    }
    const replay = await lookup();
    const opId = replay?.operationId ?? crypto.randomUUID();
    return {
      opId, replay,
      async commit(body: D1PreparedStatement[], result: StoredResult) {
        try {
          await db.batch([
            statement("INSERT INTO operations (id, actor_id, kind, target_id, key, input_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)", opId, actor, kind, target, key, inputHash, clock().toISOString()),
            ...body,
            statement("UPDATE operations SET status = 'done', result_json = ? WHERE id = ? AND status = 'pending'", JSON.stringify(result), opId),
            assertGuard(db, opId, 'done', "EXISTS(SELECT 1 FROM operations WHERE id = ? AND status = 'done')", [opId]),
          ]);
          return { operationId: opId, result, fresh: true };
        } catch (error) {
          // Includes UNIQUE races and a response lost after D1 committed. Never consume again on replay.
          const committed = await lookup();
          if (committed) return { ...committed, fresh: false };
          if (/CHECK constraint failed|UNIQUE constraint failed/i.test(String(error))) throw error;
          throw new DomainError('RESULT_UNKNOWN', '尚未确认操作结果，请保留内容并使用同一请求重试。', 503, true);
        }
      },
    };
  }
  function ensureIdentity(userId: string, principal: Principal, details: { discName: string; jerseyNumber: string }) {
    return [
      statement("INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", userId, clock().toISOString()),
      statement("INSERT INTO auth_identities (id, provider, subject, user_id) VALUES (?, 'site', ?, ?) ON CONFLICT(provider, subject) DO NOTHING", crypto.randomUUID(), principal.subject, userId),
      statement('INSERT INTO profiles (user_id, disc_name, jersey_number) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING', userId, details.discName, details.jerseyNumber),
    ];
  }
  const identityGuard = (opId: string, userId: string, subject: string) => assertGuard(db, opId, 'identity', "EXISTS(SELECT 1 FROM users u JOIN auth_identities a ON a.user_id=u.id WHERE u.id=? AND u.status='active' AND a.provider='site' AND a.subject=?)", [userId, subject]);
  const adminGuard = (opId: string, userId: string, teamId: string) => assertGuard(db, opId, 'admin', "EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.team_id=? AND m.status='active' AND m.role='admin' AND u.status='active')", [userId, teamId]);
  async function getBootstrap(principal: Principal | null): Promise<BootstrapStatus> {
    const current = authenticated(principal);
    const initialized = !!await statement("SELECT id FROM bootstraps WHERE id = 'site'").first();
    return { siteUserId: current.subject, initialized, canBootstrap: !initialized && !!bootstrapSiteUserId && current.subject === bootstrapSiteUserId, me: await me(current) };
  }
  async function bootstrap(principal: Principal | null, input: unknown, key: string): Promise<BootstrapResult> {
    const current = authenticated(principal);
    if (!bootstrapSiteUserId || current.subject !== bootstrapSiteUserId) throw new DomainError('FORBIDDEN', '仅已配置的站点所有者可以初始化。', 403);
    const details = profile(object(input, ['discName', 'jerseyNumber']));
    const userId = await identityFor(db, current);
    const op = await operation(userId, 'bootstrap', 'site', key, details);
    if (op.replay) return { operationId: op.opId, inviteId: op.replay.result.inviteId!, expiresAt: op.replay.result.expiresAt!, me: await me(current) };
    if (await statement("SELECT id FROM bootstraps WHERE id='site'").first()) throw new DomainError('ALREADY_INITIALIZED', '队伍已完成初始化。', 409);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const expiresAt = new Date(clock().getTime() + 7 * 86400000).toISOString();
    try {
      const committed = await op.commit([
        assertGuard(db, op.opId, 'uninitialized', "NOT EXISTS(SELECT 1 FROM bootstraps WHERE id='site')"),
        ...ensureIdentity(userId, current, details), identityGuard(op.opId, userId, current.subject),
        statement("INSERT INTO teams (id,singleton,name,description,created_at) VALUES ('kapok',1,'木棉合成队','记录一次训练，留下可以回看的思考。',?)", clock().toISOString()),
        statement("INSERT INTO memberships (id,team_id,user_id,role,status,epoch,joined_at) VALUES (?,'kapok',?,'admin','active',1,?)", membershipId, userId, clock().toISOString()),
        statement("INSERT INTO invites (id,team_id,token_hash,max_uses,expires_at,created_by) VALUES (?,'kapok',?,1,?,?)", inviteId, await sha256(token), expiresAt, userId),
        statement("INSERT INTO bootstraps (id,team_id,owner_user_id,op_id,initialized_at) VALUES ('site','kapok',?,?,?)", userId, op.opId, clock().toISOString()),
        adminGuard(op.opId, userId, 'kapok'),
      ], { userId, membershipId, inviteId, expiresAt });
      return { operationId: committed.operationId, inviteId: committed.result.inviteId!, expiresAt: committed.result.expiresAt!, ...(committed.fresh ? { inviteToken: token } : {}), me: await me(current) };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('ALREADY_INITIALIZED', '队伍已完成初始化。', 409);
    }
  }
  async function join(principal: Principal | null, input: unknown, key: string): Promise<JoinResult> {
    const current = authenticated(principal);
    const raw = object(input, ['discName', 'jerseyNumber', 'token', 'returnTo']);
    const details = profile(raw);
    if (typeof raw.token !== 'string' || raw.token.length < 16 || raw.token.length > 200) throw new DomainError('INVALID_INPUT', '请提供有效的邀请令牌。');
    const tokenHash = await sha256(raw.token);
    const returnTo = safeReturnTo(raw.returnTo);
    const userId = await identityFor(db, current);
    const op = await operation(userId, 'join', 'kapok', key, { ...details, tokenHash, returnTo });
    if (op.replay) return { operationId: op.opId, me: await me(current), returnTo: op.replay.result.returnTo! };
    const existing = await me(current);
    if (existing.user?.status === 'deleted') throw new DomainError('FORBIDDEN', '当前账号不可加入队伍。', 403);
    const membershipId = existing.membership?.id ?? crypto.randomUUID();
    const alreadyActive = existing.membership?.status === 'active';
    const now = clock().toISOString();
    const result = { userId, membershipId, returnTo };
    try {
      const statements = [ ...ensureIdentity(userId, current, details), identityGuard(op.opId, userId, current.subject) ];
      if (!alreadyActive) statements.push(
        statement("UPDATE invites SET used_count=used_count+1,last_op_id=? WHERE token_hash=? AND team_id='kapok' AND revoked=0 AND expires_at>? AND used_count<max_uses AND (recipient_subject IS NULL OR recipient_subject=?)", op.opId, tokenHash, now, current.subject),
        assertGuard(db, op.opId, 'invite', "EXISTS(SELECT 1 FROM invites WHERE token_hash=? AND team_id='kapok' AND last_op_id=? AND revoked=0 AND expires_at>? AND used_count<=max_uses AND (recipient_subject IS NULL OR recipient_subject=?))", [tokenHash, op.opId, now, current.subject]),
        statement("INSERT INTO memberships (id,team_id,user_id,role,status,epoch,joined_at) VALUES (?,'kapok',?,'member','active',1,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role='member',status='active',epoch=epoch+1,version=version+1,joined_at=excluded.joined_at WHERE memberships.status!='active'", membershipId, userId, now),
        statement("INSERT INTO join_receipts (id,op_id,invite_id,membership_id,epoch) SELECT ?,?,i.id,m.id,m.epoch FROM invites i JOIN memberships m ON m.team_id=i.team_id AND m.user_id=? WHERE i.token_hash=? AND i.last_op_id=?", crypto.randomUUID(), op.opId, userId, tokenHash, op.opId),
        assertGuard(db, op.opId, 'receipt', "EXISTS(SELECT 1 FROM join_receipts r JOIN memberships m ON m.id=r.membership_id WHERE r.op_id=? AND m.user_id=? AND m.status='active' AND m.epoch=r.epoch)", [op.opId, userId]),
      );
      statements.push(assertGuard(db, op.opId, 'membership', "(SELECT count(*) FROM memberships WHERE user_id=? AND team_id='kapok' AND status='active')=1", [userId]));
      const committed = await op.commit(statements, result);
      return { operationId: committed.operationId, me: await me(current), returnTo: committed.result.returnTo! };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // Another key for this actor may have joined first. It must not consume a second invitation.
      if (!alreadyActive && (await me(current)).membership?.status === 'active') return join(current, input, key);
      throw new DomainError('INVITE_UNAVAILABLE', '邀请已失效、过期或名额已用完，请重新确认邀请。', 409);
    }
  }
  async function updateProfile(principal: Principal | null, input: unknown, key: string): Promise<WriteResult> {
    const current = authenticated(principal);
    const raw = object(input, ['discName', 'jerseyNumber', 'expectedVersion']);
    const details = profile(raw);
    if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1) throw new DomainError('INVALID_INPUT', '请重新加载资料后再保存。');
    const context = await me(current);
    if (context.user?.status !== 'active' || !context.profile) throw new DomainError('FORBIDDEN', '请先完成建档。', 403);
    const op = await operation(context.user.id, 'profile', context.user.id, key, { ...details, expectedVersion: raw.expectedVersion });
    if (op.replay) return { operationId: op.opId, me: await me(current) };
    try {
      const committed = await op.commit([
        identityGuard(op.opId, context.user.id, current.subject),
        assertGuard(db, op.opId, 'version', 'EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND version=?)', [context.user.id, raw.expectedVersion]),
        statement('UPDATE profiles SET disc_name=?,jersey_number=?,version=version+1 WHERE user_id=? AND version=?', details.discName, details.jerseyNumber, context.user.id, raw.expectedVersion),
        assertGuard(db, op.opId, 'updated', 'EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND version=?)', [context.user.id, Number(raw.expectedVersion) + 1]),
      ], { userId: context.user.id });
      return { operationId: committed.operationId, me: await me(current) };
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('VERSION_CONFLICT', '资料已发生变化，请重新加载后保存。', 409); }
  }
  async function createInvite(principal: Principal | null, input: unknown, key: string): Promise<InviteResult> {
    const raw = object(input, ['revokeInviteId']);
    if (raw.revokeInviteId !== undefined && (typeof raw.revokeInviteId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.revokeInviteId))) throw new DomainError('INVALID_INPUT', '请确认要撤销的邀请。');
    const normalized = raw.revokeInviteId ? { revokeInviteId: raw.revokeInviteId } : {};
    const context = await activeMember(principal, true);
    const op = await operation(context.user.id, 'invite', context.membership.teamId, key, normalized);
    if (op.replay) return { operationId: op.opId, inviteId: op.replay.result.inviteId!, expiresAt: op.replay.result.expiresAt! };
    const token = crypto.randomUUID() + crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const expiresAt = new Date(clock().getTime() + 7 * 86400000).toISOString();
    try {
      const committed = await op.commit([
        adminGuard(op.opId, context.user.id, context.membership.teamId),
        ...(raw.revokeInviteId ? [
          statement('UPDATE invites SET revoked=1 WHERE id=? AND team_id=?', raw.revokeInviteId, context.membership.teamId),
          assertGuard(db, op.opId, 'revoked', 'EXISTS(SELECT 1 FROM invites WHERE id=? AND team_id=? AND revoked=1)', [raw.revokeInviteId, context.membership.teamId]),
        ] : []),
        statement('INSERT INTO invites (id,team_id,token_hash,max_uses,expires_at,created_by) VALUES (?,?,?,1,?,?)', inviteId, context.membership.teamId, await sha256(token), expiresAt, context.user.id),
      ], { inviteId, expiresAt });
      return { operationId: committed.operationId, inviteId: committed.result.inviteId!, expiresAt: committed.result.expiresAt!, ...(committed.fresh ? { inviteToken: token } : {}) };
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('FORBIDDEN', '管理员权限已发生变化，请重新加载。', 403); }
  }
  const reflections = createReflectionService({ db, clock, activeMember, me, operation });
  return { me, getBootstrap, bootstrap, join, updateProfile, createInvite, activeMember, ...reflections,
    ...createDataRightsService({ db, clock, activeMember, me, operation }),
    ...createTrainingService({ db, bucket, clock, mediaPolicy, activeMember, me, operation, getReflection: reflections.getReflection }) };
}
export type Service = ReturnType<typeof createService>;
