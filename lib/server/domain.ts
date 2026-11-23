import { validateAvatar, avatarBytes } from './profile-avatar.ts';
import { videoCover } from './video-covers.ts';
import type { LearningAssociation, TopicAddOutcome, TopicPolicy } from '../contracts/topic-collections';
import type { LearningPolicy } from '../contracts/learning';
import type { MediaPolicy } from '../contracts/media';
import type { BootstrapResult, BootstrapStatus, InviteResult, JoinResult, Me, Principal, WriteResult } from '../contracts/index';
import { safeReturnTo } from './return-to.ts';
export { safeReturnTo } from './return-to.ts';
import { createDataRightsService } from './data-rights.ts';
import { createReflectionService } from './reflections.ts';
import { createTrainingService } from './training.ts';
import { createTopicCollections } from './topic-collections.ts';
import { createLearningActivity } from './learning-activity.ts';
import { createLearningDiscussion } from './learning-discussion.ts';
import { createTrainingDiscussions } from './training-discussions.ts';
import { createWorkspaceAssets } from './workspace-assets.ts';
import { createLearningService } from './learning.ts';
import { LEGACY_SITES_ISSUER } from '../contracts/index.ts';
import { accessMembershipFence, actorKey, identityFor, identityTuple, sha256 } from './identity.ts';

export class DomainError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) { super(message); this.code = code; this.status = status; this.retryable = retryable; }
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
function normalizedEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}
function authenticated(principal: Principal | null): Principal {
  if (!principal?.issuer || !principal.subject || !['site', 'access'].includes(principal.provider)) throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
  return principal;
}
export function assertGuard(db: D1Database, opId: string, phase: string, predicate: string, values: unknown[] = []) {
  // Always inserts. A missing/false scalar becomes 0, making D1 roll back the entire batch.
  return db.prepare(`INSERT INTO write_guards (op_id, phase, pass) VALUES (?, ?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END)`).bind(opId, phase, ...values);
}
type OperationRow = { id: string; input_hash: string; status: string; result_json: string | null };
export type StoredResult = { partNumber?: number; etag?: string; digest?: string; id?: string; videoId?: string; requestHash?: string; sourceKind?: string; sourceId?: string; timestampSec?: number | null; userId?: string; membershipId?: string; returnTo?: string; inviteId?: string; expiresAt?: string; membershipEpoch?: number; topicOutcomes?: TopicAddOutcome[]; learningAssociation?: LearningAssociation };
export type ServiceOptions = { db: D1Database; bucket?: R2Bucket; clock?: () => Date; bootstrapSiteUserId?: string; accessInitialAdminEmail?: string; mediaPolicy?: MediaPolicy; learningPolicy?: LearningPolicy; topicPolicy?: TopicPolicy };

const systemClock = () => new Date();

export function createService({ db, bucket, clock = systemClock, bootstrapSiteUserId, accessInitialAdminEmail, mediaPolicy, learningPolicy, topicPolicy }: ServiceOptions) {
  const statement = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  type AccountRow = Record<string, string | number | null>;
  function accountStatement(current: Principal) {
    // The unique identity tuple already selects the user; a separate identityFor
    // lookup adds a remote D1 round trip without strengthening this join.
    return statement(`SELECT u.id, u.status, p.*, p.version AS profile_version,
      m.id AS member_id, m.team_id, m.role, m.status AS member_status, m.epoch, m.version AS member_version,
      t.name AS team_name, t.description AS team_description
      FROM users u JOIN auth_identities a ON a.user_id = u.id AND a.provider=? AND a.issuer=? AND a.subject=?
      LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN memberships m ON m.user_id = u.id
      LEFT JOIN teams t ON t.id = m.team_id`, ...identityTuple(current));
  }
  function accountFromRow(row: AccountRow | null | undefined): Me {
    if (!row) return { user: null, profile: null, membership: null, team: null };
    if (row.status !== 'active') return { user: { id: String(row.id), status: 'deleted' }, profile: null, membership: null, team: null };
    return {
      user: { id: String(row.id), status: row.status as 'active' | 'deleted' },
      profile: row.disc_name === null ? null : { discName: String(row.disc_name), jerseyNumber: String(row.jersey_number), bio: String(row.bio ?? ''), ...(row.position ? { position: String(row.position) } : {}), version: Number(row.profile_version) },
      membership: row.member_id === null ? null : { id: String(row.member_id), teamId: String(row.team_id), role: row.role as 'admin' | 'coach' | 'member', status: row.member_status as 'active' | 'paused' | 'left', epoch: Number(row.epoch), version: Number(row.member_version) },
      team: row.member_status === 'active' ? { id: String(row.team_id), name: String(row.team_name), description: String(row.team_description) } : null,
    };
  }
  async function me(principal: Principal | null): Promise<Me> {
    return accountFromRow(await accountStatement(authenticated(principal)).first<AccountRow>());
  }
  async function getAccount(principal: Principal | null): Promise<Me> {
    const current = authenticated(principal);
    const account = await me(current);
    if (current.provider === 'access' && account.membership?.status !== 'active') {
      return { ...account, profile: null, team: null };
    }
    return account;
  }
  async function activeMember(principal: Principal | null, admin = false) {
    const current = await me(principal);
    if (current.user?.status !== 'active' || current.membership?.status !== 'active' || (admin && current.membership.role !== 'admin')) throw new DomainError('FORBIDDEN', '当前账号没有此操作权限。', 403);
    return current as Me & { user: NonNullable<Me['user']>; membership: NonNullable<Me['membership']> };
  }
  async function operation(actor: string, kind: string, target: string, key: string, input: unknown, prepareInput?: () => Promise<unknown>) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DomainError('INVALID_INPUT', '需要有效的请求标识。');
    // A confirmed identical request can replay without repeating external input resolution.
    const requestHash = prepareInput && await sha256(JSON.stringify(input));
    let inputHash: Promise<string> | undefined;
    const canonicalHash = () => inputHash ??= (async () => sha256(JSON.stringify(prepareInput ? await prepareInput() : input)))();
    if (!prepareInput) await canonicalHash();
    async function lookup() {
      const row = await statement('SELECT id, input_hash, status, result_json FROM operations WHERE actor_id = ? AND kind = ? AND target_id = ? AND key = ?', actor, kind, target, key).first<OperationRow>();
      if (!row) return null;
      const result = requestHash && row.status === 'done' && row.result_json ? JSON.parse(row.result_json) as StoredResult : null;
      const exactReplay = requestHash !== undefined && result?.requestHash === requestHash;
      if (!exactReplay && row.input_hash !== await canonicalHash()) throw new DomainError('IDEMPOTENCY_CONFLICT', '此请求标识已用于不同内容，请确认后重新提交。', 409);
      if (row.status === 'superseded' && row.result_json && JSON.parse(row.result_json).importMappingRejected === true) throw new DomainError('IMPORT_MAPPING_REJECTED_NO_COMMIT', '该请求未提交：训练归属已变化，请重新核对并批准新映射。', 409);
      if (row.status !== 'done' || !row.result_json) throw new DomainError('RESULT_UNKNOWN', '尚未确认操作结果，请保留内容并使用同一请求重试。', 503, true);
      return { operationId: row.id, result: result ?? JSON.parse(row.result_json) as StoredResult };
    }
    const replay = await lookup();
    if (!replay) await canonicalHash();
    const opId = replay?.operationId ?? crypto.randomUUID();
    return {
      opId, replay,
      async rejectImportMapping(predicate: string, values: unknown[]) {
        // An atomic tombstone permanently prevents this exact key from later committing.
        // ON CONFLICT preserves any concurrent committed receipt, which lookup returns first.
        await statement(`INSERT INTO operations (id,actor_id,kind,target_id,key,input_hash,status,result_json,created_at)
          SELECT ?,?,?,?,?,?,'superseded',?,? WHERE (${predicate}) ON CONFLICT DO NOTHING`,
          opId, actor, kind, target, key, await canonicalHash(), JSON.stringify({ importMappingRejected: true }), clock().toISOString(), ...values).run();
        return lookup();
      },
      async commit(body: D1PreparedStatement[], result: StoredResult) {
        try {
          await db.batch([
            statement("INSERT INTO operations (id, actor_id, kind, target_id, key, input_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)", opId, actor, kind, target, key, await canonicalHash(), clock().toISOString()),
            ...body,
            statement("UPDATE operations SET status = 'done', result_json = ? WHERE id = ? AND status = 'pending'", JSON.stringify(requestHash ? { ...result, requestHash } : result), opId),
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
      statement("INSERT INTO auth_identities (id, provider, issuer, subject, user_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, issuer, subject) DO NOTHING", crypto.randomUUID(), ...identityTuple(principal), userId),
      statement('INSERT INTO profiles (user_id, disc_name, jersey_number) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING', userId, details.discName, details.jerseyNumber),
    ];
  }
  const identityGuard = (opId: string, userId: string, principal: Principal) => assertGuard(db, opId, 'identity', "EXISTS(SELECT 1 FROM users u JOIN auth_identities a ON a.user_id=u.id WHERE u.id=? AND u.status='active' AND a.provider=? AND a.issuer=? AND a.subject=?)", [userId, ...identityTuple(principal)]);
  const adminGuard = (opId: string, userId: string, teamId: string) => assertGuard(db, opId, 'admin', "EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.team_id=? AND m.status='active' AND m.role='admin' AND u.status='active')", [userId, teamId]);
  const configuredSitesOwner = (p: Principal) => p.provider === 'site' && p.issuer === LEGACY_SITES_ISSUER && !!bootstrapSiteUserId && p.subject === bootstrapSiteUserId;
  const configuredAccessEmail = normalizedEmail(accessInitialAdminEmail);
  async function currentAccessMembership(p: Principal, userId: string, membershipId: string, epoch: number) {
    const account = await activeMember(p);
    if (account.user.id !== userId || account.membership.id !== membershipId || account.membership.epoch !== epoch) {
      throw new DomainError('FORBIDDEN', '成员权限已发生变化，请重新加载。', 403);
    }
    return account;
  }
  async function getBootstrap(principal: Principal | null): Promise<BootstrapStatus> {
    const current = authenticated(principal);
    // A read-only batch keeps initialization and account reads in one D1 request.
    const [initialization, accountRows] = await db.batch<AccountRow>([
      statement("SELECT id FROM bootstraps WHERE id = 'site'"),
      accountStatement(current),
    ]);
    const initialized = initialization.results.length > 0;
    const account = accountFromRow(accountRows.results[0]);
    const sites = current.provider === 'site';
    return {
      actorId: await actorKey(current),
      ...(sites ? { siteUserId: current.subject } : {}),
      initialized, canBootstrap: !initialized && configuredSitesOwner(current),
      me: sites ? account : { ...account, profile: null, team: null },
    };
  }
  async function join(principal: Principal | null, input: unknown, key: string): Promise<JoinResult> {
    const current = authenticated(principal);
    if (current.provider === 'site' && current.issuer === LEGACY_SITES_ISSUER && bootstrapSiteUserId) {
      return joinSyntheticFixture(current, input, key);
    }
    const email = current.provider === 'access' ? normalizedEmail(current.verifiedEmail) : null;
    if (!email) throw new DomainError('FORBIDDEN', '请使用已验证的邮箱账号完善资料。', 403);
    const raw = object(input, ['discName', 'jerseyNumber', 'returnTo', 'intent', 'confirmed']);
    if (raw.intent !== 'register' || raw.confirmed !== true) throw new DomainError('INVALID_INPUT', '请先确认注册资料，再提交加入队伍。');
    const details = profile(raw);
    const returnTo = safeReturnTo(raw.returnTo);
    const existing = await me(current);
    const unavailable = () => new DomainError('FORBIDDEN', '当前账号不能自行恢复成员资格，请联系管理员。', 403);
    if (existing.user?.status === 'deleted' || (existing.membership && existing.membership.status !== 'active')) throw unavailable();

    const team = await statement('SELECT id FROM teams WHERE singleton=1').first<{ id: string }>();
    if (!team) throw new DomainError('SERVICE_UNAVAILABLE', '暂时未能准备队伍，请稍后重试。', 503, true);
    const userId = existing.user?.id ?? await identityFor(db, current);
    const op = await operation(userId, 'fixed-team-join', team.id, key, { ...details, returnTo });
    async function receipt(operationId: string, result: StoredResult): Promise<JoinResult> {
      const account = await currentAccessMembership(current, userId, result.membershipId!, result.membershipEpoch!);
      const destination = account.membership.role !== 'admin' && returnTo.startsWith('/admin/') ? '/' : returnTo;
      return { operationId, me: account, returnTo: destination };
    }
    if (op.replay) return receipt(op.opId, op.replay.result);

    const membershipId = existing.membership?.id ?? 'fixed_' + userId;
    const membershipEpoch = existing.membership?.epoch ?? 1;
    const now = clock().toISOString();
    const commands: D1PreparedStatement[] = [];
    if (!existing.membership) {
      commands.push(...ensureIdentity(userId, current, details));
      if (email === configuredAccessEmail) {
        commands.push(statement(`INSERT INTO initial_admin_grants (team_id, op_id)
          SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE team_id=? AND user_id=?)
          ON CONFLICT(team_id) DO NOTHING`, team.id, op.opId, team.id, userId));
      }
      commands.push(statement(`INSERT INTO memberships (id,team_id,user_id,role,status,epoch,joined_at)
        VALUES (?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM initial_admin_grants WHERE team_id=? AND op_id=?)
          THEN 'admin' ELSE 'member' END, 'active', 1, ?)
        ON CONFLICT(team_id,user_id) DO NOTHING`, membershipId, team.id, userId, team.id, op.opId, now));
    }
    commands.push(
      identityGuard(op.opId, userId, current),
      assertGuard(db, op.opId, 'membership', "EXISTS(SELECT 1 FROM memberships WHERE id=? AND team_id=? AND user_id=? AND status='active' AND epoch=?)",
        [membershipId, team.id, userId, membershipEpoch]),
      assertGuard(db, op.opId, 'profile', 'EXISTS(SELECT 1 FROM profiles WHERE user_id=?)', [userId]),
    );
    try {
      const committed = await op.commit(commands, { membershipId, membershipEpoch });
      return await receipt(committed.operationId, committed.result);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const latest = await me(current);
      if (latest.user?.status === 'deleted' || (latest.membership && (latest.membership.status !== 'active' || latest.membership.epoch !== membershipEpoch))) throw unavailable();
      throw new DomainError('RESULT_UNKNOWN', '尚未确认操作结果，请保留内容并使用同一请求重试。', 503, true);
    }
  }

  // Explicit local seed and historical fixture only. HTTP dispatch never exposes these mutations.
  async function bootstrap(principal: Principal | null, input: unknown, key: string): Promise<BootstrapResult> {
    const current = authenticated(principal);
    if (!configuredSitesOwner(current)) throw new DomainError('FORBIDDEN', '仅已配置的账号可以初始化。', 403);
    const details = profile(object(input, ['discName', 'jerseyNumber']));
    const userId = await identityFor(db, current);
    const op = await operation(userId, 'bootstrap', 'site', key, details);
    async function receipt(operationId: string, result: StoredResult, inviteToken?: string): Promise<BootstrapResult> {
      return { operationId, me: await me(current), inviteId: result.inviteId!, expiresAt: result.expiresAt!, ...(inviteToken ? { inviteToken } : {}) };
    }
    if (op.replay) return receipt(op.opId, op.replay.result);
    if (await statement("SELECT id FROM bootstraps WHERE id='site'").first()) throw new DomainError('ALREADY_INITIALIZED', '队伍已完成初始化。', 409);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const now = clock();
    const expiresAt = new Date(now.getTime() + 7 * 86400000).toISOString();
    try {
      const committed = await op.commit([
        assertGuard(db, op.opId, 'uninitialized', "NOT EXISTS(SELECT 1 FROM bootstraps WHERE id='site')"),
        ...ensureIdentity(userId, current, details), identityGuard(op.opId, userId, current),
        statement("INSERT INTO teams (id,singleton,name,description,created_at) VALUES ('kapok',1,'KPark','记录一次训练，留下可以回看的思考。',?) ON CONFLICT(id) DO NOTHING", now.toISOString()),
        statement("INSERT INTO memberships (id,team_id,user_id,role,status,epoch,joined_at) VALUES (?,'kapok',?,'admin','active',1,?)", membershipId, userId, now.toISOString()),
        statement("INSERT INTO invites (id,team_id,token_hash,max_uses,expires_at,created_by) VALUES (?,'kapok',?,1,?,?)", inviteId, await sha256(token), expiresAt, userId),
        statement("INSERT INTO bootstraps (id,team_id,owner_user_id,op_id,initialized_at) VALUES ('site','kapok',?,?,?)", userId, op.opId, now.toISOString()),
        assertGuard(db, op.opId, 'initialized', "EXISTS(SELECT 1 FROM bootstraps WHERE id='site' AND owner_user_id=? AND op_id=?)", [userId, op.opId]),
        adminGuard(op.opId, userId, 'kapok'),
      ], { userId, membershipId, inviteId, expiresAt });
      return await receipt(committed.operationId, committed.result, committed.fresh ? token : undefined);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('ALREADY_INITIALIZED', '队伍已完成初始化。', 409);
    }
  }
  async function joinSyntheticFixture(current: Principal, input: unknown, key: string): Promise<JoinResult> {
    const raw = object(input, ['discName', 'jerseyNumber', 'token', 'returnTo']);
    const details = profile(raw);
    if (typeof raw.token !== 'string' || raw.token.length < 16 || raw.token.length > 200) throw new DomainError('INVALID_INPUT', '请提供有效的邀请令牌。');
    const tokenHash = await sha256(raw.token);
    const returnTo = safeReturnTo(raw.returnTo);
    const userId = await identityFor(db, current);
    const unavailable = () => new DomainError('INVITE_UNAVAILABLE', '邀请已失效、过期或不适用于当前账号，请重新确认邀请。', 409);
    const op = await operation(userId, 'join', 'kapok', key, { ...details, tokenHash, returnTo });
    if (op.replay) return { operationId: op.opId, me: await me(current), returnTo: op.replay.result.returnTo! };
    const existing = await me(current);
    if (existing.user?.status === 'deleted') throw new DomainError('FORBIDDEN', '当前账号不可加入队伍。', 403);
    const membershipId = existing.membership?.id ?? crypto.randomUUID();
    const alreadyActive = existing.membership?.status === 'active';
    const now = clock().toISOString();
    const invitation = "token_hash=? AND team_id='kapok' AND revoked=0 AND expires_at>? AND recipient_email IS NULL AND (recipient_subject IS NULL OR recipient_subject=?)";
    try {
      const commands = [...ensureIdentity(userId, current, details), identityGuard(op.opId, userId, current)];
      if (!alreadyActive) commands.push(
        statement(`UPDATE invites SET used_count=used_count+1,last_op_id=? WHERE ${invitation} AND used_count<max_uses`, op.opId, tokenHash, now, current.subject),
        assertGuard(db, op.opId, 'invite', `EXISTS(SELECT 1 FROM invites WHERE ${invitation} AND last_op_id=? AND used_count<=max_uses)`, [tokenHash, now, current.subject, op.opId]),
        statement("INSERT INTO memberships (id,team_id,user_id,role,status,epoch,joined_at) VALUES (?,'kapok',?,'member','active',1,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role='member',status='active',epoch=epoch+1,version=version+1,joined_at=excluded.joined_at WHERE memberships.status!='active'", membershipId, userId, now),
        statement("INSERT INTO join_receipts (id,op_id,invite_id,membership_id,epoch) SELECT ?,?,i.id,m.id,m.epoch FROM invites i JOIN memberships m ON m.team_id=i.team_id AND m.user_id=? WHERE i.token_hash=? AND i.last_op_id=?", crypto.randomUUID(), op.opId, userId, tokenHash, op.opId),
        assertGuard(db, op.opId, 'receipt', "EXISTS(SELECT 1 FROM join_receipts r JOIN memberships m ON m.id=r.membership_id WHERE r.op_id=? AND m.user_id=? AND m.status='active' AND m.epoch=r.epoch)", [op.opId, userId]),
      );
      commands.push(assertGuard(db, op.opId, 'membership', "(SELECT count(*) FROM memberships WHERE user_id=? AND team_id='kapok' AND status='active')=1", [userId]));
      const committed = await op.commit(commands, { userId, membershipId, returnTo });
      return { operationId: committed.operationId, me: await me(current), returnTo: committed.result.returnTo! };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (!alreadyActive && (await me(current)).membership?.status === 'active') return joinSyntheticFixture(current, input, key);
      throw unavailable();
    }
  }
  async function getProfileAvatar(principal: Principal | null, id: string, digest: string) {
    const viewer = await activeMember(principal);
    const access = accessMembershipFence(principal,viewer);
    const row = await statement(`SELECT a.image FROM profile_avatars a
      JOIN memberships subject ON subject.user_id=a.user_id JOIN users u ON u.id=subject.user_id
      WHERE a.user_id=? AND a.digest=? AND subject.team_id=? AND subject.status='active' AND u.status='active'
      AND EXISTS(SELECT 1 FROM memberships m JOIN users v ON v.id=m.user_id WHERE m.id=? AND m.team_id=subject.team_id
        AND m.user_id=? AND m.status='active' AND m.epoch=? AND v.status='active') AND ${access.predicate}`,
      id,digest,viewer.membership.teamId,viewer.membership.id,viewer.user.id,viewer.membership.epoch,...access.values).first<{image:string}>();
    if (!row) throw new DomainError('NOT_FOUND','头像暂不可见。',404);
    return { bytes:avatarBytes(row.image.slice(row.image.indexOf(',')+1)), type:row.image.slice(5,row.image.indexOf(';')) };
  }
  async function updateProfile(principal: Principal | null, input: unknown, key: string): Promise<WriteResult> {
    const current = authenticated(principal);
    const raw = object(input, ['discName', 'jerseyNumber', 'bio', 'position', 'expectedVersion', 'avatar']);
    if (raw.position !== undefined && !['', '接盘手', '持盘手', '防守组'].includes(String(raw.position))) throw new DomainError('INVALID_INPUT', '请选择有效的场上位置。');
    const details = { ...profile(raw), ...(raw.position === undefined ? {} : { position: raw.position }), bio: raw.bio === undefined ? undefined : raw.bio };
    if (details.bio !== undefined && (typeof details.bio !== 'string' || details.bio.trim().length > 160)) throw new DomainError('INVALID_INPUT', '简介最多160字。');
    if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1) throw new DomainError('INVALID_INPUT', '请重新加载资料后再保存。');
    const context = await businessAccount(current);
    if (context.user?.status !== 'active' || !context.profile) throw new DomainError('FORBIDDEN', '请先完成建档。', 403);
    if (raw.avatar !== undefined && context.membership?.status !== 'active')
      throw new DomainError('FORBIDDEN','仅有效队员可更新头像。',403);
    const avatar = await validateAvatar(raw.avatar);
    const op = await operation(context.user.id, 'profile', context.user.id, key, {
      ...details, expectedVersion: raw.expectedVersion, ...(avatar !== undefined && {avatar:avatar?.digest ?? null})
    });
    if (op.replay) return { operationId: op.opId, me: await me(current) };
    try {
      const access = accessMembershipFence(current, context);
      const committed = await op.commit([
        current.provider === 'access'
          ? assertGuard(db, op.opId, 'identity', access.predicate, access.values)
          : identityGuard(op.opId, context.user.id, current),
        assertGuard(db, op.opId, 'version', 'EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND version=?)', [context.user.id, raw.expectedVersion]),
        statement('UPDATE profiles SET disc_name=?,jersey_number=?,bio=COALESCE(?,bio),version=version+1 WHERE user_id=? AND version=?', details.discName, details.jerseyNumber, typeof details.bio === 'string' ? details.bio.trim() : null, context.user.id, raw.expectedVersion),
        ...(typeof raw.position === 'string' ? [statement('UPDATE profiles SET position=? WHERE user_id=?', raw.position, context.user.id)] : []),
        ...(avatar === undefined ? [] : [
          assertGuard(db,op.opId,'avatar-member',`EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
            WHERE m.user_id=? AND m.id=? AND m.epoch=? AND u.status='active' AND m.status='active')`,
            [context.user.id,context.membership!.id,context.membership!.epoch]),
          avatar === null ? statement('DELETE FROM profile_avatars WHERE user_id=?',context.user.id)
            : statement(`INSERT INTO profile_avatars(user_id,digest,image) VALUES(?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest,image=excluded.image`,context.user.id,avatar.digest,avatar.url)
        ]),
        assertGuard(db, op.opId, 'updated', 'EXISTS(SELECT 1 FROM profiles WHERE user_id=? AND version=?)', [context.user.id, Number(raw.expectedVersion) + 1]),
      ], { userId: context.user.id });
      return { operationId: committed.operationId, me: await me(current) };
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('VERSION_CONFLICT', '资料已发生变化，请重新加载后保存。', 409); }
  }
  async function createInvite(principal: Principal | null, input: unknown, key: string): Promise<InviteResult> {
    const current = authenticated(principal);
    if (current.provider !== 'site' || current.issuer !== LEGACY_SITES_ISSUER || !bootstrapSiteUserId) throw new DomainError('NOT_FOUND', '此功能暂不可用。', 404);
    const raw = object(input, ['revokeInviteId']);
    if (raw.revokeInviteId !== undefined && (typeof raw.revokeInviteId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.revokeInviteId))) throw new DomainError('INVALID_INPUT', '请确认要撤销的邀请。');
    const normalized = raw.revokeInviteId ? { revokeInviteId: raw.revokeInviteId } : {};
    const context = await activeMember(current, true);
    const op = await operation(context.user.id, 'invite', context.membership.teamId, key, normalized);
    if (op.replay) return { operationId: op.opId, inviteId: op.replay.result.inviteId!, expiresAt: op.replay.result.expiresAt! };
    const token = crypto.randomUUID() + crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const expiresAt = new Date(clock().getTime() + 7 * 86400000).toISOString();
    try {
      const committed = await op.commit([
        adminGuard(op.opId, context.user.id, context.membership.teamId),
        ...(raw.revokeInviteId ? [
          statement('UPDATE invites SET revoked=1 WHERE id=? AND team_id=? AND recipient_email IS NULL', raw.revokeInviteId, context.membership.teamId),
          assertGuard(db, op.opId, 'revoked', 'EXISTS(SELECT 1 FROM invites WHERE id=? AND team_id=? AND revoked=1 AND recipient_email IS NULL)', [raw.revokeInviteId, context.membership.teamId]),
        ] : []),
        statement('INSERT INTO invites (id,team_id,token_hash,max_uses,expires_at,created_by) VALUES (?,?,?,1,?,?)', inviteId, context.membership.teamId, await sha256(token), expiresAt, context.user.id),
      ], { inviteId, expiresAt });
      return { operationId: committed.operationId, inviteId: committed.result.inviteId!, expiresAt: committed.result.expiresAt!, ...(committed.fresh ? { inviteToken: token } : {}) };
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError('FORBIDDEN', '管理员权限已发生变化，请重新加载。', 403); }
  }
  const businessAccount = (p: Principal | null) => p?.provider === 'access' ? activeMember(p) : me(p);
  const reflections = createReflectionService({ db, clock, activeMember, me: businessAccount, operation });
  const { attemptLearningInclusion, ...topics } = createTopicCollections({ db, clock, activeMember, operation, topicPolicy });
  return { readVideoCover: (source: string | null) => videoCover(bucket, source), me, getAccount, getBootstrap, bootstrap, join, updateProfile, getProfileAvatar, createInvite, activeMember, ...reflections,
    ...createDataRightsService({ db, clock, activeMember, me: businessAccount, operation }),
    ...topics,
    ...createLearningActivity({ db, clock, activeMember, operation }),
    ...createLearningDiscussion({ db, clock, activeMember, operation }),
    ...createTrainingDiscussions({ db,clock,activeMember,operation }),
    ...createWorkspaceAssets({ db,bucket,clock,activeMember,operation,mediaPolicy }),
    ...createLearningService({ db, bucket, clock, learningPolicy, activeMember, operation, attemptLearningInclusion }),
    ...createTrainingService({ db, bucket, clock, mediaPolicy, activeMember, me: businessAccount, operation, getReflection: reflections.getReflection }) };
}
export type Service = ReturnType<typeof createService>;
