import type { Me, Principal } from '../contracts/index';
import type { ManagedMember, PersonalExport } from '../contracts/data-rights';
import { assertGuard, DomainError } from './domain.ts';
import type { StoredResult } from './domain';
import { reflectionShared } from './reflections.ts';

type Context = Me & {
    user: NonNullable<Me['user']>;
    membership: NonNullable<Me['membership']>;
};
type Dependencies = {
    db: D1Database;
    clock: () => Date;
    me: (p: Principal | null) => Promise<Me>;
    activeMember: (p: Principal | null, admin?: boolean) => Promise<Context>;
    operation: (actor: string, kind: string, target: string, key: string, input: unknown) => Promise<{
        opId: string;
        replay: { result: StoredResult } | null;
        commit: (body: D1PreparedStatement[], result: StoredResult) => Promise<unknown>;
    }>;
};
function inputObject(input: unknown, fields: string[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) {
        throw new DomainError('INVALID_INPUT', '请检查成员设置。');
    }
    return input as Record<string, unknown>;
}
function expected(raw: Record<string, unknown>) {
    if (![raw.expectedVersion, raw.expectedEpoch].every(v => Number.isSafeInteger(v) && Number(v) > 0)) {
        throw new DomainError('INVALID_INPUT', '请重新加载成员状态后操作。');
    }
    return { version: Number(raw.expectedVersion), epoch: Number(raw.expectedEpoch) };
}
const missing = () => new DomainError('NOT_FOUND', '成员不可用或当前无权查看。', 404);

export function createDataRightsService({ db, clock, me, activeMember, operation }: Dependencies) {
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
    async function personal(p: Principal | null) {
        const current = await me(p);
        if (!p || current.user?.status !== 'active' || !current.profile) {
            throw new DomainError('FORBIDDEN', '请先登录并确认有效账号。', 403);
        }
        return current as Me & { user: NonNullable<Me['user']> };
    }
    async function exportOwnData(p: Principal | null): Promise<PersonalExport> {
        const c = await personal(p);
        // All sections are generated in ONE current-identity D1 snapshot. No stored file or old job is reused.
        const owner = `WITH owner AS (SELECT u.id FROM users u JOIN auth_identities a ON a.user_id=u.id
            WHERE u.id=? AND u.status='active' AND a.provider='site' AND a.subject=?) `;
        const owned = (sql: string) => q(owner + sql, c.user.id, p!.subject);
        const teamSource = (team: string) => `EXISTS(SELECT 1 FROM memberships rm WHERE rm.user_id=o.id
            AND rm.team_id=${team} AND rm.status='active')`;
        const videoSource = (video: string) => `EXISTS(SELECT 1 FROM videos v JOIN trainings t ON t.id=v.training_id
            WHERE v.id=${video} AND v.status='active' AND t.status IN ('published','archived') AND ${teamSource('t.team_id')})`;
        const result = await db.batch([
            owned('SELECT p.disc_name AS discName,p.jersey_number AS jerseyNumber FROM profiles p JOIN owner o ON o.id=p.user_id'),
            owned(`SELECT r.id,r.title,r.text,r.date,r.training_id AS trainingId,r.video_id AS videoId,
                r.deleted_at AS deletedAt,r.created_at AS createdAt,r.updated_at AS updatedAt,
                CASE WHEN r.training_id IS NOT NULL AND EXISTS(SELECT 1 FROM trainings t WHERE t.id=r.training_id
                    AND t.status IN ('published','archived') AND ${teamSource('t.team_id')})
                    AND (r.video_id IS NULL OR ${videoSource('r.video_id')}) THEN 1 ELSE 0 END AS sourceAvailable
                FROM reflections r JOIN owner o ON o.id=r.owner_id ORDER BY r.date DESC,r.id DESC`),
            owned(`SELECT c.id,c.source_kind AS sourceKind,c.source_id AS sourceId,c.timestamp_sec AS timestampSec,
                c.private_note AS privateNote,c.created_at AS createdAt,c.updated_at AS updatedAt,
                CASE WHEN (c.source_kind='video' AND ${videoSource('c.source_id')})
                    OR (c.source_kind='comment' AND EXISTS(SELECT 1 FROM video_comments vc WHERE vc.id=c.source_id
                        AND vc.status='active' AND ${videoSource('vc.video_id')}))
                    OR (c.source_kind='reflection' AND EXISTS(SELECT 1 FROM reflections r WHERE r.id=c.source_id
                        AND r.deleted_at IS NULL AND (r.owner_id=o.id OR (${reflectionShared.replaceAll('?', 'o.id')}))))
                    THEN 1 ELSE 0 END AS sourceAvailable
                FROM collections c JOIN owner o ON o.id=c.owner_id ORDER BY c.created_at DESC,c.id DESC`),
            owned(`SELECT c.id,c.video_id AS videoId,c.root_id AS rootId,CASE WHEN c.status='active' THEN c.text ELSE NULL END AS text,
                c.timestamp_sec AS timestampSec,c.status,c.created_at AS createdAt,c.updated_at AS updatedAt,
                CASE WHEN c.status='active' AND ${videoSource('c.video_id')} THEN 1 ELSE 0 END AS sourceAvailable
                FROM video_comments c JOIN owner o ON o.id=c.author_id ORDER BY c.created_at,c.id`),
        ]);
        const profile = result[0].results[0] as PersonalExport['profile'] | undefined;
        if (!profile) throw new DomainError('FORBIDDEN', '账号状态已变化，请重新确认。', 403);
        const availability = <T>(rows: unknown[]) => rows.map(row => {
            const item = row as T & { sourceAvailable: number };
            return { ...item, sourceAvailable: !!item.sourceAvailable };
        });
        return {
            format: 'kapok-personal-v1',
            generatedAt: clock().toISOString(),
            profile,
            reflections: availability<PersonalExport['reflections'][number]>(result[1].results),
            collections: availability<PersonalExport['collections'][number]>(result[2].results),
            comments: availability<PersonalExport['comments'][number]>(result[3].results),
        };
    }
    const selectMember = `SELECT m.id,m.team_id AS teamId,m.role,m.status,m.epoch,m.version,
        m.user_id AS userId,p.disc_name AS discName,p.jersey_number AS jerseyNumber
        FROM memberships m JOIN users u ON u.id=m.user_id JOIN profiles p ON p.user_id=m.user_id`;
    async function listManagedMembers(p: Principal | null): Promise<ManagedMember[]> {
        const c = await activeMember(p, true);
        return (await q(`${selectMember} WHERE m.team_id=? AND u.status='active'
            AND EXISTS(SELECT 1 FROM memberships am JOIN users au ON au.id=am.user_id WHERE am.user_id=?
                AND am.team_id=m.team_id AND am.role='admin' AND am.status='active' AND am.epoch=? AND au.status='active')
            ORDER BY p.disc_name,m.id`, c.membership.teamId, c.user.id, c.membership.epoch).all<ManagedMember>()).results;
    }
    async function managedMember(id: string, teamId: string) {
        const row = await q(`${selectMember} WHERE m.user_id=? AND m.team_id=? AND u.status='active'`, id, teamId).first<ManagedMember>();
        if (!row) throw missing();
        return row;
    }
    async function mutateMembership(p: Principal, c: Context, target: string, raw: Record<string, unknown>, key: string, selfLeave: boolean) {
        const e = expected(raw);
        const role = raw.role;
        const status = raw.status;
        if (!['admin', 'coach', 'member'].includes(String(role)) || !['active', 'paused', 'left'].includes(String(status))) {
            throw new DomainError('INVALID_INPUT', '请选择有效角色与成员状态。');
        }
        const op = await operation(c.user.id, selfLeave ? 'member-leave' : 'member-update', target, key, { role, status, expected: e });
        if (op.replay) return;
        const old = await managedMember(target, c.membership.teamId);
        const epoch = e.epoch + (old.status !== 'active' && status === 'active' ? 1 : 0);
        try {
            await op.commit([
                assertGuard(db, op.opId, 'actor', `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
                    JOIN auth_identities a ON a.user_id=u.id WHERE m.user_id=? AND m.team_id=?
                    AND ${selfLeave ? "m.status IN ('active','paused')" : "m.status='active'"}
                    AND m.epoch=? AND m.version=? AND u.status='active' AND a.provider='site' AND a.subject=?
                    ${selfLeave ? '' : "AND m.role='admin'"})`,
                [c.user.id, c.membership.teamId, c.membership.epoch, c.membership.version, p.subject]),
                assertGuard(db, op.opId, 'before', `EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND team_id=?
                    AND version=? AND epoch=? AND status=? AND role=?)`,
                [target, c.membership.teamId, e.version, e.epoch, old.status, old.role]),
                q(`UPDATE memberships SET role=?,status=?,epoch=?,version=version+1
                    WHERE user_id=? AND team_id=? AND version=? AND epoch=?`,
                role, status, epoch, target, c.membership.teamId, e.version, e.epoch),
                assertGuard(db, op.opId, 'updated', `EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND team_id=?
                    AND version=? AND epoch=? AND role=? AND status=?)`,
                [target, c.membership.teamId, e.version + 1, epoch, role, status]),
                // This post-mutation guard executes inside the same serialized D1 batch, including self-leave.
                assertGuard(db, op.opId, 'last-admin', `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
                    WHERE m.team_id=? AND m.role='admin' AND m.status='active' AND u.status='active')`, [c.membership.teamId]),
                q('INSERT INTO moderation_audit(id,actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?,?)',
                    op.opId, c.user.id, old.id, selfLeave ? 'member-leave' : 'member-update',
                    JSON.stringify({
                        code: selfLeave ? 'self-request' : 'role-or-status-change',
                        from: { role: old.role, status: old.status, epoch: old.epoch, version: old.version },
                        to: { role, status, epoch, version: e.version + 1 },
                    }), clock().toISOString()),
                assertGuard(db, op.opId, 'audit', 'EXISTS(SELECT 1 FROM moderation_audit WHERE id=? AND actor_id=? AND target_id=?)',
                    [op.opId, c.user.id, old.id]),
            ], { id: target });
        } catch (error) {
            if (error instanceof DomainError) throw error;
            throw new DomainError('MEMBERSHIP_CONFLICT', '成员状态已变化，或此操作会移除最后一位有效管理员。请重新加载后确认；须先保留另一位有效管理员。', 409);
        }
    }
    async function updateMembership(p: Principal | null, target: string, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const raw = inputObject(input, ['role', 'status', 'expectedVersion', 'expectedEpoch']);
        await mutateMembership(p!, c, target, raw, key, false);
        // A completed key reads current state, never reapplies its historical role/status.
        return managedMember(target, c.membership.teamId);
    }
    async function leaveTeam(p: Principal | null, input: unknown, key: string) {
        const c = await personal(p);
        const raw = inputObject(input, ['expectedVersion', 'expectedEpoch']);
        if (!c.membership) throw missing();
        // Use a stable normalized role for self-leave receipts, so later role changes cannot change the key's input.
        await mutateMembership(p!, c as Context, c.user.id, { ...raw, role: 'member', status: 'left' }, key, true);
        return { membership: (await me(p)).membership };
    }
    return { exportOwnData, listManagedMembers, updateMembership, leaveTeam };
}
