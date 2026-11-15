import type { Principal } from '../contracts';
import type { LearningActivityInput, LearningActivityStatus } from '../contracts/learning-social';
import type { ActivityItem } from '../contracts/reflections';
import { assertGuard, DomainError } from './domain.ts';
import {
    bindLearningMember, learningConflict, learningMemberFence, learningMemberGuard, learningMissing, learningObject,
    learningPostVisible, type LearningContext, type LearningDependencies,
} from './learning.ts';

const currentCycle = 'la.revoked_at IS NULL AND la.author_epoch=lpub.author_epoch';
export const learningActivityVisible = `${currentCycle} AND ${learningPostVisible}`;
export const learningActivitySelect = `SELECT 'learning:'||la.id AS id,'learning' AS kind,lpub.title AS title,
    '/learn/posts/'||lp.id AS href,la.shared_at AS publishedAt,lpub.published_at AS updatedAt,
    NULL AS publisherId,NULL AS publisherName
    FROM learning_activity_events la JOIN learning_posts lp ON lp.id=la.post_id
    JOIN learning_post_publications lpub ON lpub.post_id=lp.id
    WHERE lp.team_id=? AND ${learningActivityVisible}`;
const ownerSource = `FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
    LEFT JOIN learning_activity_events la ON la.post_id=lp.id AND ${currentCycle}
    WHERE lp.id=? AND lp.team_id=? AND lp.owner_id=? AND ${learningPostVisible}`;
const lastCycle = `(SELECT latest.id FROM learning_activity_events latest WHERE latest.post_id=lp.id
    AND latest.author_epoch=lpub.author_epoch ORDER BY latest.sequence DESC LIMIT 1)`;
const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = () => new DomainError('RESULT_UNKNOWN', '尚未确认动态操作结果，请使用同一请求重试。', 503, true);

export function createLearningActivity({ db, clock, activeMember, operation }: Pick<LearningDependencies, 'db' | 'clock' | 'activeMember' | 'operation'>) {
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);

    async function ownStatus(c: LearningContext, postId: string): Promise<LearningActivityStatus> {
        const member = learningMemberFence(c);
        const row = await q(`SELECT lpub.version,la.id,la.shared_at,${lastCycle} AS last_id ${ownerSource} AND ${member.sql}`,
            postId, c.membership.teamId, c.user.id, ...member.values)
            .first<{ version: number; id: string | null; shared_at: string; last_id: string | null }>();
        if (!row) throw learningMissing();
        return { publishedVersion: row.version, lastEventId: row.last_id,
            event: row.id ? { id: row.id, sharedAt: row.shared_at } : null };
    }

    async function getLearningActivity(p: Principal | null, postId: string) {
        return ownStatus(await bindLearningMember(activeMember, p), postId);
    }

    async function changeLearningActivity(p: Principal | null, postId: string, input: unknown, key: string, share: boolean) {
        try {
            const c = await bindLearningMember(activeMember, p);
            const { expectedPublishedVersion, expectedMembershipEpoch, expectedEventId } =
                learningObject(input, ['expectedPublishedVersion', 'expectedMembershipEpoch', 'expectedEventId']) as LearningActivityInput;
            if (!Number.isSafeInteger(expectedPublishedVersion) || expectedPublishedVersion < 1 ||
                !Number.isSafeInteger(expectedMembershipEpoch) || expectedMembershipEpoch < 1 ||
                (expectedEventId === null ? !share : typeof expectedEventId !== 'string' || !eventId.test(expectedEventId))) {
                throw new DomainError('INVALID_INPUT', '请重新加载资料和动态状态再操作。');
            }
            if (expectedMembershipEpoch !== c.membership.epoch) throw learningConflict();
            const current = await ownStatus(c, postId);
            const op = await operation(c.user.id, share ? 'learning-activity-share' : 'learning-activity-withdraw', postId, key,
                { expectedPublishedVersion, expectedMembershipEpoch, expectedEventId });
            let result = op.replay?.result;
            if (!result) {
                if (current.publishedVersion !== expectedPublishedVersion || current.lastEventId !== expectedEventId ||
                    (share ? current.event !== null : current.event?.id !== expectedEventId)) {
                    throw learningConflict();
                }
                const id = share ? crypto.randomUUID() : expectedEventId!;
                const time = clock().toISOString();
                const sourceGuard = (phase: string, event: string | null, last: string | null) => assertGuard(db, op.opId, phase,
                    `EXISTS(SELECT 1 ${ownerSource} AND lpub.version=? AND la.id IS ? AND ${lastCycle} IS ?)`,
                    [postId, c.membership.teamId, c.user.id, expectedPublishedVersion, event, last]);
                result = (await op.commit([
                    learningMemberGuard(db, op, c, 'before'), sourceGuard('before-cycle', share ? null : expectedEventId, expectedEventId),
                    share ? q('INSERT INTO learning_activity_events(id,post_id,author_epoch,shared_at) VALUES(?,?,?,?)',
                        id, postId, c.membership.epoch, time) :
                        q('UPDATE learning_activity_events SET revoked_at=? WHERE id=?', time, id),
                    learningMemberGuard(db, op, c, 'after'), sourceGuard('after-cycle', share ? id : null, id),
                ], { id, membershipId: c.membership.id, membershipEpoch: c.membership.epoch })).result;
            }
            const after = await ownStatus(c, postId);
            if (result.membershipId !== c.membership.id || result.membershipEpoch !== c.membership.epoch ||
                after.lastEventId !== result.id || (share ? after.event?.id !== result.id : after.event !== null)) throw learningConflict();
            return after;
        } catch (error) {
            if (error instanceof DomainError) throw error;
            if (/CHECK constraint failed:\s*write_guard_pass\b/i.test(String(error))) throw learningConflict();
            throw unavailable();
        }
    }

    async function listCurrentLearningActivity(p: Principal | null, ids: string[]) {
        if (!ids.length || ids.length > 220 || ids.some(id => !eventId.test(id))) {
            throw new DomainError('INVALID_INPUT', '动态条目不可用，请重新加载。');
        }
        const c = await bindLearningMember(activeMember, p);
        const member = learningMemberFence(c);
        const { results } = await q(`${learningActivitySelect} AND ${member.sql}
            AND la.id IN (SELECT value FROM json_each(?))`, c.membership.teamId, ...member.values, JSON.stringify(ids))
            .all<Extract<ActivityItem, { kind: 'learning' }> & { publisherId: null; publisherName: null }>();
        return results.map(({ id, kind, title, href, publishedAt, updatedAt }) => ({ id, kind, title, href, publishedAt, updatedAt }));
    }

    return { getLearningActivity, changeLearningActivity, listCurrentLearningActivity };
}
