import type { Me, Principal } from '../contracts/index';
import type { ManagedMember, PersonalExport } from '../contracts/data-rights';
import { assertGuard, DomainError } from './domain.ts';
import type { StoredResult } from './domain';
import { identityTuple } from './identity.ts';
import { reflectionShared } from './reflections.ts';
import { privateOwnerFence, publishedLearningLink, requirePrivateOwner } from './learning-sources.ts';
import { learningActivityVisible } from './learning-activity.ts';
import { learningPostVisible } from './learning.ts';
import { topicCoverVersion } from './topic-cover.ts';
import { topicVideoVisible, topicVisible } from './topic-collections.ts';

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
        const access = privateOwnerFence(p, c);
        const owned = (sql: string) => q(`WITH owner AS (SELECT ? AS id WHERE ${access.predicate}) ` + sql,
            c.user.id, ...access.values);
        const teamSource = (team: string) => `EXISTS(SELECT 1 FROM memberships rm WHERE rm.user_id=o.id
            AND rm.team_id=${team} AND rm.status='active')`;
        const videoSource = (video: string) => `EXISTS(SELECT 1 FROM videos v JOIN trainings t ON t.id=v.training_id
            WHERE v.id=${video} AND v.status='active' AND t.status IN ('published','archived') AND ${teamSource('t.team_id')})`;
        const bool = (predicate: string) => `json(CASE WHEN ${predicate} THEN 'true' ELSE 'false' END)`;
        const imageRefs = (table: 'learning_draft_images' | 'learning_publication_images') =>
            `(SELECT json_group_array(json(entry)) FROM (
                SELECT json_object('id',li.id,'position',ir.position,'alt',ir.alt,'decorative',${bool('ir.decorative=1')}) AS entry
                FROM ${table} ir JOIN learning_images li ON li.id=ir.image_id AND li.post_id=ir.post_id
                WHERE ir.post_id=lp.id AND li.status='ready' ORDER BY ir.position))`;
        const learningContent = (alias: 'lp' | 'lpub', publication: boolean) =>
            `'kind',${alias}.kind,'category',${alias}.category,'title',${alias}.title,'summary',${alias}.summary,'body',${alias}.body,
            'workspaceDetails',json(${alias}.workspace_details),'version',${alias}.version,'collectionTargetId',${alias}.collection_target_id,
            'video',CASE WHEN ${alias}.video_source IS NOT NULL THEN json_object('source',${alias}.video_source,'url',${alias}.video_url) END,
            'images',json(${imageRefs(publication ? 'learning_publication_images' : 'learning_draft_images')})`;
        const topicItems = (snapshot: 0 | 1) => `(SELECT json_group_array(json(entry)) FROM (
            SELECT json_object('kind',ti.kind,'id',ti.source_id,'position',ti.position,'sourceAvailable',${bool(`${teamSource('tc.team_id')} AND (
                (ti.kind='post' AND EXISTS(SELECT 1 FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
                    WHERE lp.id=ti.source_id AND lp.team_id=tc.team_id AND ${learningPostVisible}))
                OR (ti.kind='training' AND EXISTS(SELECT 1 FROM trainings t WHERE t.id=ti.source_id AND t.team_id=tc.team_id AND t.status IN ('published','archived')))
                OR (ti.kind='video' AND EXISTS(SELECT 1 FROM videos v JOIN trainings t ON t.id=v.training_id
                    WHERE v.id=ti.source_id AND v.team_id=tc.team_id AND ${topicVideoVisible})))`)}) AS entry
            FROM topic_collection_items ti WHERE ti.collection_id=tc.id AND ti.snapshot=${snapshot} ORDER BY ti.position))`;
        const result = await db.batch([
            owned('SELECT p.disc_name AS discName,p.jersey_number AS jerseyNumber,p.bio,a.image AS avatar FROM profiles p JOIN owner o ON o.id=p.user_id LEFT JOIN profile_avatars a ON a.user_id=p.user_id'),
            owned(`SELECT r.id,r.title,r.text,r.category,r.date,r.training_id AS trainingId,r.video_id AS videoId,
                r.source_kind AS sourceKind,r.source_id AS sourceId,r.deleted_at AS deletedAt,r.created_at AS createdAt,r.updated_at AS updatedAt,
                CASE WHEN ${publishedLearningLink('r.source_kind', 'r.source_id', 'o.id')} IS NOT NULL
                    OR (r.training_id IS NOT NULL AND EXISTS(SELECT 1 FROM trainings t WHERE t.id=r.training_id
                    AND t.status IN ('published','archived') AND ${teamSource('t.team_id')})
                    AND (r.video_id IS NULL OR ${videoSource('r.video_id')})) THEN 1 ELSE 0 END AS sourceAvailable
                FROM reflections r JOIN owner o ON o.id=r.owner_id ORDER BY r.date DESC,r.id DESC`),
            owned(`SELECT c.id,c.source_kind AS sourceKind,c.source_id AS sourceId,c.timestamp_sec AS timestampSec,
                c.private_note AS privateNote,c.created_at AS createdAt,c.updated_at AS updatedAt,
                CASE WHEN (c.source_kind='training' AND EXISTS(SELECT 1 FROM trainings t WHERE t.id=c.source_id
                    AND t.status IN ('published','archived') AND ${teamSource('t.team_id')}))
                    OR (c.source_kind='video' AND ${videoSource('c.source_id')})
                    OR (c.source_kind='comment' AND EXISTS(SELECT 1 FROM video_comments vc WHERE vc.id=c.source_id
                        AND vc.status='active' AND ${videoSource('vc.video_id')}))
                    OR (c.source_kind='reflection' AND EXISTS(SELECT 1 FROM reflections r WHERE r.id=c.source_id
                        AND r.deleted_at IS NULL AND (r.owner_id=o.id OR (${reflectionShared.replaceAll('?', 'o.id')}))))
                    OR ${publishedLearningLink('c.source_kind', 'c.source_id', 'o.id')} IS NOT NULL
                    THEN 1 ELSE 0 END AS sourceAvailable
                FROM collections c JOIN owner o ON o.id=c.owner_id ORDER BY c.created_at DESC,c.id DESC`),
            owned(`SELECT c.id,c.video_id AS videoId,c.root_id AS rootId,CASE WHEN c.status='active' THEN c.text ELSE NULL END AS text,
                CASE WHEN c.status='active' THEN c.timestamp_sec END AS timestampSec,CASE WHEN c.status='active' THEN c.reference_times END AS refTimes,c.status,c.created_at AS createdAt,c.updated_at AS updatedAt,
                CASE WHEN c.status='active' AND ${videoSource('c.video_id')} THEN 1 ELSE 0 END AS sourceAvailable
                FROM video_comments c JOIN owner o ON o.id=c.author_id ORDER BY c.created_at,c.id`),
            owned(`SELECT lp.id,lp.status,lp.created_at AS createdAt,lp.updated_at AS updatedAt,
                json_object(${learningContent('lp', false)}) AS draft,
                CASE WHEN lpub.post_id IS NOT NULL THEN json_object(${learningContent('lpub', true)},
                    'publishedAt',lpub.published_at,'available',${bool(`${teamSource('lp.team_id')} AND ${learningPostVisible}`)}) END AS publication
                FROM learning_posts lp JOIN owner o ON o.id=lp.owner_id
                LEFT JOIN learning_post_publications lpub ON lpub.post_id=lp.id ORDER BY lp.created_at,lp.id`),
            owned(`SELECT tc.id,tc.status,tc.created_at AS createdAt,tc.updated_at AS updatedAt,
                json_patch(json_object('title',tc.title,'summary',tc.summary,'category',tc.category,'version',tc.version,'items',json(${topicItems(0)})),
                    json_object('coverVersion',${topicCoverVersion('tc.version')})) AS draft,
                CASE WHEN tcp.collection_id IS NOT NULL THEN json_patch(json_object('title',tcp.title,'summary',tcp.summary,'category',tcp.category,'version',tcp.version,
                    'publishedAt',tcp.published_at,'available',${bool(`${teamSource('tc.team_id')} AND ${topicVisible}`)},'items',json(${topicItems(1)})),
                    json_object('coverVersion',${topicCoverVersion('tcp.version')})) END AS publication
                FROM topic_collections tc JOIN owner o ON o.id=tc.owner_id
                LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id ORDER BY tc.created_at,tc.id`),
            owned(`SELECT li.id,li.post_id AS postId,li.mime_type AS mimeType,li.bytes,li.width,li.height,li.created_at AS createdAt
                FROM learning_images li JOIN learning_posts lp ON lp.id=li.post_id JOIN owner o ON o.id=lp.owner_id
                WHERE li.status='ready' ORDER BY li.created_at,li.id`),
            owned(`SELECT c.id,c.post_id AS postId,c.root_id AS rootId,c.reply_to_id AS replyToId,
                CASE WHEN c.status='active' THEN c.text END AS text,
                CASE WHEN c.status='active' THEN c.timestamp_sec END AS timestampSec,CASE WHEN c.status='active' THEN c.reference_times END AS refTimes,
                c.status,c.created_at AS createdAt,c.updated_at AS updatedAt,
                CASE WHEN c.status='active' AND ${teamSource('lp.team_id')} AND ${learningPostVisible} THEN 1 ELSE 0 END AS sourceAvailable
                FROM learning_comments c JOIN owner o ON o.id=c.author_id
                JOIN learning_posts lp ON lp.id=c.post_id AND lp.team_id=c.team_id
                LEFT JOIN learning_post_publications lpub ON lpub.post_id=lp.id ORDER BY c.created_at,c.id`),
            owned(`SELECT la.id,la.post_id AS postId,la.shared_at AS sharedAt,la.revoked_at AS revokedAt,
                CASE WHEN ${learningActivityVisible} THEN 1 ELSE 0 END AS active
                FROM learning_activity_events la JOIN learning_posts lp ON lp.id=la.post_id JOIN owner o ON o.id=lp.owner_id
                LEFT JOIN learning_post_publications lpub ON lpub.post_id=lp.id ORDER BY la.shared_at,la.id`),
            owned(`SELECT a.id AS id,a.parent_kind AS parentKind,a.parent_id AS parentId,a.mime AS mimeType,a.bytes,a.created_at AS createdAt
                FROM material_assets a JOIN owner o ON o.id=a.owner_id WHERE a.ready=1
                UNION ALL SELECT u.id,'training',v.training_id,u.mime,u.bytes,u.created_at
                FROM uploads u JOIN owner o ON o.id=u.owner_id JOIN videos v ON v.upload_id=u.id
                WHERE u.status='ready' AND v.status!='deleted' AND NOT EXISTS(SELECT 1 FROM material_assets a WHERE a.id=u.id)
                ORDER BY 6,1`),
            owned(`SELECT d.id,d.training_id AS trainingId,d.root_id AS rootId,d.reply_to_id AS replyToId,
                CASE WHEN d.status='active' THEN d.body END AS text,d.status,d.created_at AS createdAt
                FROM training_discussions d JOIN owner o ON o.id=d.author_id ORDER BY d.created_at,d.id`),
            owned(`SELECT t.id,t.title,t.date,t.description,t.status FROM trainings t JOIN owner o ON o.id=t.publisher_id ORDER BY t.date DESC,t.id`),
        ]);
        const profile = result[0].results[0] as PersonalExport['profile'] | undefined;
        if (!profile) throw new DomainError('FORBIDDEN', '账号状态已变化，请重新确认。', 403);
        const availability = <T>(rows: unknown[]) => rows.map(row => {
            const item = row as T & { sourceAvailable: number };
            const {refTimes,...rest}=item as T & {refTimes?:string;sourceAvailable:number};
            return {...rest,sourceAvailable:!!item.sourceAvailable,...(refTimes && {referenceTimes:JSON.parse(refTimes)})} as T;
        });
        const revisions = <T>(rows: unknown[]) => rows.map(row => {
            const { draft, publication, ...fields } = row as { draft: string; publication: string | null };
            return { ...fields, draft: JSON.parse(draft), publication: publication ? JSON.parse(publication) : null } as T;
        });
        await requirePrivateOwner(db, access);
        return {
            format: 'kapok-personal-v1',
            trainings:result[11].results as PersonalExport['trainings'],
            materialAssets:result[9].results as PersonalExport['materialAssets'],
            trainingDiscussions:result[10].results as PersonalExport['trainingDiscussions'],
            generatedAt: clock().toISOString(),
            profile: profile.avatar ? profile : {discName:profile.discName,jerseyNumber:profile.jerseyNumber,bio:profile.bio},
            reflections: availability<PersonalExport['reflections'][number]>(result[1].results),
            collections: availability<PersonalExport['collections'][number]>(result[2].results),
            comments: availability<PersonalExport['comments'][number]>(result[3].results),
            learningPosts: revisions<PersonalExport['learningPosts'][number]>(result[4].results),
            topicCollections: revisions<PersonalExport['topicCollections'][number]>(result[5].results),
            learningImages: result[6].results as PersonalExport['learningImages'],
            learningComments: availability<PersonalExport['learningComments'][number]>(result[7].results),
            learningActivity: (result[8].results as (Omit<PersonalExport['learningActivity'][number], 'active'> & { active: number })[])
                .map(event => ({ ...event, active: !!event.active })),
        };
    }
    const loginIdentity = 'EXISTS(SELECT 1 FROM auth_identities login WHERE login.user_id=m.user_id AND login.provider=? AND login.issuer=?)';
    const selectMember = (login = false) => `SELECT m.id,m.team_id AS teamId,m.role,m.status,m.epoch,m.version,
        m.user_id AS userId,p.disc_name AS discName,p.jersey_number AS jerseyNumber${login ? ', '+loginIdentity+' AS canSignIn' : ''}
        FROM memberships m JOIN users u ON u.id=m.user_id JOIN profiles p ON p.user_id=m.user_id`;
    async function confirmMemberManager(p: Principal | null, c: Context, expectedVersion = c.membership.version, admin = true) {
        const latest = await activeMember(p, admin);
        if (latest.user.id !== c.user.id || latest.membership.id !== c.membership.id ||
            latest.membership.epoch !== c.membership.epoch || latest.membership.version !== expectedVersion) {
            throw new DomainError('FORBIDDEN', '成员权限已发生变化，请重新加载。', 403);
        }
    }
    async function listManagedMembers(p: Principal | null): Promise<ManagedMember[]> {
        const c = await activeMember(p, true);
        const members = (await q(`${selectMember(true)} WHERE m.team_id=? AND u.status='active'
            AND EXISTS(SELECT 1 FROM memberships am JOIN users au ON au.id=am.user_id
                JOIN auth_identities a ON a.user_id=au.id WHERE am.id=? AND am.user_id=?
                AND am.team_id=m.team_id AND am.role='admin' AND am.status='active' AND am.epoch=? AND am.version=?
                AND au.status='active' AND a.provider=? AND a.issuer=? AND a.subject=?)
            ORDER BY p.disc_name,m.id`, p!.provider,p!.issuer,c.membership.teamId, c.membership.id, c.user.id,
            c.membership.epoch, c.membership.version, ...identityTuple(p!)).all<ManagedMember>()).results;
        await confirmMemberManager(p, c);
        return members.map(m=>({...m,canSignIn:!!m.canSignIn}));
    }
    async function managedMember(id: string, teamId: string) {
        const row = await q(`${selectMember()} WHERE m.user_id=? AND m.team_id=? AND u.status='active'`, id, teamId).first<ManagedMember>();
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
        if (op.replay) return false;
        const old = await managedMember(target, c.membership.teamId);
        const epoch = e.epoch + (old.status !== 'active' && status === 'active' ? 1 : 0);
        try {
            await op.commit([
                assertGuard(db, op.opId, 'actor', `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
                    JOIN auth_identities a ON a.user_id=u.id WHERE m.user_id=? AND m.team_id=?
                    AND ${selfLeave ? "m.status IN ('active','paused')" : "m.status='active'"}
                    AND m.epoch=? AND m.version=? AND u.status='active' AND a.provider=? AND a.issuer=? AND a.subject=?
                    ${selfLeave ? '' : "AND m.role='admin'"})`,
                [c.user.id, c.membership.teamId, c.membership.epoch, c.membership.version, ...identityTuple(p)]),
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
                    WHERE m.team_id=? AND m.role='admin' AND m.status='active' AND u.status='active' AND ${loginIdentity})`, [c.membership.teamId,p.provider,p.issuer]),
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
            return true;
        } catch (error) {
            if (error instanceof DomainError) throw error;
            throw new DomainError('MEMBERSHIP_CONFLICT', '成员状态已变化，或此操作会移除最后一位有效管理员。请重新加载后确认；须先保留另一位有效管理员。', 409);
        }
    }
    async function updateMembership(p: Principal | null, target: string, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const raw = inputObject(input, ['role', 'status', 'expectedVersion', 'expectedEpoch']);
        const changed = await mutateMembership(p!, c, target, raw, key, false);
        // A completed key reads current state, never reapplies its historical role/status.
        const member = await managedMember(target, c.membership.teamId);
        if (changed && target === c.user.id) {
            const identity = await q(`SELECT 1 FROM auth_identities a JOIN users u ON u.id=a.user_id
                JOIN memberships m ON m.user_id=u.id WHERE a.provider=? AND a.issuer=? AND a.subject=?
                AND u.id=? AND u.status='active' AND m.id=? AND m.version=? AND m.epoch=?`,
            ...identityTuple(p!), c.user.id, c.membership.id, member.version, member.epoch).first();
            if (!identity || member.version !== c.membership.version + 1 || member.epoch !== c.membership.epoch ||
                member.role !== raw.role || member.status !== raw.status) {
                throw new DomainError('FORBIDDEN', '成员权限已发生变化，请重新加载。', 403);
            }
        } else await confirmMemberManager(p, c);
        return member;
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
