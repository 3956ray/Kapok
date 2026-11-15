import type { Me, Principal } from '../contracts/index';
import type { ReflectionLink } from '../contracts/reflections';
import { assertGuard, DomainError } from './domain.ts';
import { accessMembershipFence, identityTuple } from './identity.ts';
import { learningPostVisible } from './learning.ts';
import { topicVisible } from './topic-collections.ts';

// Arguments are internal SQL expressions, never request values.
export function publishedLearningLink(kind: string, id: string, reader: string) {
    const member = (team: string) => `EXISTS(SELECT 1 FROM memberships lsm JOIN users lsu ON lsu.id=lsm.user_id
        WHERE lsm.user_id=${reader} AND lsm.team_id=${team} AND lsm.status='active' AND lsu.status='active')`;
    return `CASE ${kind}
        WHEN 'learning_post' THEN (SELECT json_object('title',lpub.title,'href','/learn/posts/'||lp.id)
            FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
            WHERE lp.id=${id} AND ${learningPostVisible} AND ${member('lp.team_id')})
        WHEN 'topic_collection' THEN (SELECT json_object('title',tcp.title,'href','/learn/collections/'||tc.id)
            FROM topic_collections tc JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
            WHERE tc.id=${id} AND ${topicVisible} AND ${member('tc.team_id')}) END`;
}

export function parseLearningLink(value: string | null): ReflectionLink {
    return value ? JSON.parse(value) as ReflectionLink : null;
}

// Also capture Site identity and membership. Site personal records remain readable
// after a fresh session binds to the current state of that same owner.
export function privateOwnerFence(p: Principal | null, c: Me) {
    if (p?.provider === 'access') return accessMembershipFence(p, c);
    if (!p || !c.user) return { predicate: '0', values: [] };
    return {
        predicate: `EXISTS(SELECT 1 FROM auth_identities pi JOIN users pu ON pu.id=pi.user_id
            LEFT JOIN memberships pm ON pm.user_id=pu.id WHERE pu.id=? AND pu.status='active'
            AND pi.provider=? AND pi.issuer=? AND pi.subject=?
            AND pm.id IS ? AND pm.team_id IS ? AND pm.status IS ? AND pm.epoch IS ?)`,
        values: [c.user.id, ...identityTuple(p), c.membership?.id ?? null, c.membership?.teamId ?? null,
            c.membership?.status ?? null, c.membership?.epoch ?? null],
    };
}

export async function requirePrivateOwner(db: D1Database, access: ReturnType<typeof privateOwnerFence>) {
    if (!await db.prepare(`SELECT 1 WHERE ${access.predicate}`).bind(...access.values).first()) {
        throw new DomainError('NOT_FOUND', '内容不可用或当前无权查看。', 404);
    }
}

export function learningSourceGuard(db: D1Database, opId: string, kind: string, id: string, owner: string) {
    return assertGuard(db, opId, 'learning-source', `EXISTS(WITH source(kind,id,reader) AS (VALUES (?,?,?)) SELECT 1 FROM source
        WHERE ${publishedLearningLink('source.kind', 'source.id', 'source.reader')} IS NOT NULL)`, [kind, id, owner]);
}

export async function privateSourceWrite<T>(write: () => Promise<T>) {
    try {
        return await write();
    } catch (error) {
        if (error instanceof DomainError) throw error;
        if (/CHECK constraint failed:\s*write_guard_pass\b|UNIQUE constraint failed:\s*collections.owner_id, collections.source_kind, collections.source_id\b/i.test(String(error))) {
            throw new DomainError('VERSION_CONFLICT', '记录或权限已变化，请重新加载后重试。', 409);
        }
        throw new DomainError('RESULT_UNKNOWN', '尚未确认操作结果，请保留内容并使用同一请求重试。', 503, true);
    }
}
