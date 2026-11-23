import type { DeletedReflection } from '../contracts/data-rights';
import type { Me, Principal } from '../contracts/index';
import type { Announcement, ActivityItem, ActivityPage, PublicMember, PublicProfile, Reflection, ReflectionAuthor, ReflectionReader } from '../contracts/reflections';
import { assertGuard, DomainError } from './domain.ts';
import type { StoredResult } from './domain';
import { learningActivitySelect, learningActivityVisible } from './learning-activity.ts';
import { bindLearningMember, learningMemberFence, learningPostVisible } from './learning.ts';
import { accessMembershipFence } from './identity.ts';
import { isLearningSourceRef, type LearningSourceKind } from '../contracts/reflections.ts';
import { learningSourceGuard, parseLearningLink, privateOwnerFence, privateSourceWrite, publishedLearningLink } from './learning-sources.ts';
type Context = Me & {
    user: NonNullable<Me['user']>;
    membership: NonNullable<Me['membership']>;
};
type Op = {
    opId: string;
    replay: {
        result: StoredResult;
    } | null;
    commit: (statements: D1PreparedStatement[], result: StoredResult) => Promise<{ result: StoredResult }>;
};
type Dependencies = {
    db: D1Database;
    clock: () => Date;
    me: (p: Principal | null) => Promise<Me>;
    activeMember: (p: Principal | null, admin?: boolean) => Promise<Context>;
    operation: (actor: string, kind: string, target: string, key: string, input: unknown) => Promise<Op>;
};
type Row = {
    id: string;
    owner_id: string;
    category?: string | null;
    team_id: string;
    title: string;
    text: string;
    date: string;
    version: number;
    sharing_version: number;
    generation: number;
    gate: string;
    active_op_id: string | null;
    scope: 'private' | 'team' | 'coach';
    coach_id: string | null;
    coach_epoch: number | null;
    author_epoch: number | null;
    published_at: string | null;
    deleted_at: string | null;
    training_id: string | null;
    video_id: string | null;
    source_kind: LearningSourceKind | null;
    source_id: string | null;
    updated_at: string;
    disc_name: string;
    jersey_number: string;
};
function object(input: unknown, fields: string[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) {
        throw new DomainError('INVALID_INPUT', '请检查填写内容。');
    }
    return input as Record<string, unknown>;
}
function text(input: unknown, max: number, optional = false) {
    if (typeof input !== 'string' || !optional && !input.trim() || input.length > max) {
        throw new DomainError('INVALID_INPUT', `内容需为${optional ? 0 : 1}–${max}字。`);
    }
    return input;
}
function positive(input: unknown) {
    if (!Number.isSafeInteger(input) || Number(input) < 1) throw new DomainError('INVALID_INPUT', '请重新加载记录后再操作。');
    return Number(input);
}
const missing = () => new DomainError('NOT_FOUND', '内容不可用或当前无权查看。', 404);
const conflict = () => new DomainError('VERSION_CONFLICT', '记录或权限已变化，请重新加载后重试。', 409);

// Used by reflection reads, directory, activity and collection guards: one authoritative predicate.
export const reflectionShared = `r.deleted_at IS NULL AND r.gate='open' AND r.active_op_id IS NULL
        AND EXISTS(SELECT 1 FROM users au JOIN memberships am ON am.user_id=au.id
                WHERE au.id=r.owner_id AND au.status='active' AND am.team_id=r.team_id
                AND am.status='active' AND am.epoch=r.author_epoch)
        AND EXISTS(SELECT 1 FROM users ru JOIN memberships rm ON rm.user_id=ru.id
                WHERE ru.id=? AND ru.status='active' AND rm.team_id=r.team_id AND rm.status='active'
                AND r.scope='team')`;
export function createReflectionService({
    db,
    clock,
    me,
    activeMember,
    operation
}: Dependencies) {
    const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
    const now = () => clock().toISOString();
    const select = 'SELECT r.*,p.disc_name,p.jersey_number FROM reflections r JOIN profiles p ON p.user_id=r.owner_id';
    async function personal(p: Principal | null) {
        if (!p) throw new DomainError('FORBIDDEN', '请先登录并建档。', 403);
        const c = await me(p);
        if (c.user?.status !== 'active' || !c.profile) throw new DomainError('FORBIDDEN', '请先登录并建档。', 403);
        return c as Me & {
            user: NonNullable<Me['user']>;
        };
    }
    function ownerGuard(op: Op, p: Principal | null, c: Awaited<ReturnType<typeof personal>>) {
        const access = privateOwnerFence(p, c);
        return assertGuard(db, op.opId, 'owner', `EXISTS(SELECT 1 FROM users WHERE id=? AND status='active') AND ${access.predicate}`,
            [c.user.id, ...access.values]);
    }
    function memberGuard(op: Op, c: Context, admin = false) {
        return assertGuard(
            db,
            op.opId,
            'member',
            `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
                        WHERE m.user_id=? AND m.team_id=? AND m.status='active' AND m.epoch=? AND u.status='active' ${admin ? "AND m.role='admin'" : ''})`,
            [c.user.id, c.membership.teamId, c.membership.epoch]
        );
    }
    async function commit(op: Op, statements: D1PreparedStatement[], id: string) {
        try {
            const committed = await op.commit(statements, {
                id
            });
            return committed.result;
        } catch (error) {
            if (error instanceof DomainError) throw error;
            throw conflict();
        }
    }
    async function link(r: Row, c: Awaited<ReturnType<typeof personal>>) {
        if (!r.training_id) return null;
        if (c.user?.status !== 'active' || c.membership?.status !== 'active' || c.membership.teamId !== r.team_id) return null;
        const source = r.video_id ? await q(
            `SELECT v.title,v.id FROM videos v JOIN trainings t ON t.id=v.training_id
                                WHERE v.id=? AND v.training_id=? AND v.team_id=? AND v.status='active' AND t.status IN ('published','archived')`,
            r.video_id,
            r.training_id,
            r.team_id
        ).first<{
            title: string;
            id: string;
        }>() : await q("SELECT title,id FROM trainings WHERE id=? AND team_id=? AND status IN ('published','archived')", r.training_id, r.team_id).first<{
            title: string;
            id: string;
        }>();
        return source ? {
            title: source.title,
            href: (r.video_id ? '/videos/' : '/trainings/') + source.id
        } : null;
    }
    async function present(r: Row, c: Awaited<ReturnType<typeof personal>>, resolveLink = true): Promise<Reflection> {
        const actor = c.user.id;
        const base: ReflectionReader = {
            id: r.id,
            title: r.title,
            text: r.text,
            ...(r.category ? { category: r.category } : {}),
            date: r.date,
            updatedAt: r.updated_at,
            author: {
                id: r.owner_id,
                discName: r.disc_name,
                jerseyNumber: r.jersey_number
            },
            isAuthor: actor === r.owner_id,
            link: resolveLink ? await link(r, c) : null
        };
        if (actor !== r.owner_id) return base;
        return {
            ...base,
            isAuthor: true,
            version: r.version,
            sharingVersion: r.sharing_version,
            generation: r.generation,
            scope: r.scope === 'team' ? 'team' : 'private',
            published: r.scope === 'team' && r.published_at !== null,
            trainingId: r.training_id,
            videoId: r.video_id,
            ...(r.source_kind && r.source_id ? { sourceRef: { kind: r.source_kind, id: r.source_id } } : {})
        };
    }
    async function getReflection(p: Principal | null, id: string): Promise<Reflection> {
        if (!p) throw missing();
        let c;
        try {
            c = await personal(p);
        } catch {
            throw missing();
        }
        const access = privateOwnerFence(p, c);
        const r = await q(
            `${select} WHERE r.id=? AND r.deleted_at IS NULL AND
                        (r.owner_id=? OR (${reflectionShared})) AND ${access.predicate}`,
            id,
            c.user.id,
            c.user.id,
            ...access.values
        ).first<Row>();
        if (!r) throw missing();
        const dto = await present(r, c);
        const current = await q(`SELECT ${publishedLearningLink('r.source_kind', 'r.source_id', 'viewer.id')} AS link
            FROM reflections r CROSS JOIN (SELECT ? AS id) viewer WHERE r.id=? AND r.version=? AND r.sharing_version=? AND r.deleted_at IS NULL
            AND (r.owner_id=? OR (${reflectionShared})) AND ${access.predicate}`,
            c.user.id, id, r.version, r.sharing_version, c.user.id, c.user.id, ...access.values).first<{ link: string | null }>();
        if (!current) throw missing();
        return { ...dto, link: r.source_kind ? parseLearningLink(current.link) : dto.link };
    }
    async function withCurrentOwnLinks<T extends ReflectionAuthor>(p: Principal | null, c: Awaited<ReturnType<typeof personal>>, items: T[]) {
        const access = privateOwnerFence(p, c);
        const rows = await q(`WITH viewer(id) AS (SELECT ? WHERE ${access.predicate})
            SELECT r.id,r.version,r.sharing_version,
            CASE WHEN r.source_kind IS NOT NULL THEN ${publishedLearningLink('r.source_kind', 'r.source_id', 'viewer.id')}
            WHEN EXISTS(SELECT 1 FROM memberships lm WHERE lm.user_id=viewer.id AND lm.status='active' AND lm.team_id=r.team_id)
            THEN CASE WHEN r.video_id IS NOT NULL THEN
              (SELECT json_object('title',v.title,'href','/videos/'||v.id) FROM videos v JOIN trainings t ON t.id=v.training_id
               WHERE v.id=r.video_id AND v.training_id=r.training_id AND v.team_id=r.team_id AND v.status='active' AND t.status IN ('published','archived'))
              ELSE (SELECT json_object('title',t.title,'href','/trainings/'||t.id) FROM trainings t
               WHERE t.id=r.training_id AND t.team_id=r.team_id AND t.status IN ('published','archived')) END END AS link
            FROM viewer LEFT JOIN reflections r ON r.owner_id=viewer.id`, c.user.id, ...access.values)
            .all<{ id: string | null; version: number; sharing_version: number; link: string | null }>();
        if (!rows.results.length) throw missing();
        const links = new Map(rows.results.map(row => [row.id, row]));
        return items.flatMap(item => {
            const row = links.get(item.id);
            if (!row || row.version !== item.version || row.sharing_version !== item.sharingVersion) return [];
            return [{ ...item, link: parseLearningLink(row.link) }];
        });
    }
    async function getOwnReflection(p: Principal | null, id: string, captured?: Awaited<ReturnType<typeof personal>>): Promise<ReflectionAuthor> {
        const c = captured ?? await personal(p);
        const access = privateOwnerFence(p, c);
        const r = await q(`${select} WHERE r.id=? AND r.owner_id=? AND r.deleted_at IS NULL AND ${access.predicate}`, id, c.user.id, ...access.values).first<Row>();
        if (!r) throw missing();
        const dto = await present(r, c) as ReflectionAuthor;
        const current = await q(`SELECT r.version,r.sharing_version,${publishedLearningLink('r.source_kind', 'r.source_id', 'r.owner_id')} AS link
            FROM reflections r WHERE r.id=? AND r.owner_id=? AND r.deleted_at IS NULL AND ${access.predicate}`,
            id, c.user.id, ...access.values).first<{ version: number; sharing_version: number; link: string | null }>();
        if (!current) throw missing();
        if (current.version !== dto.version || current.sharing_version !== dto.sharingVersion) {
            throw new DomainError('RESULT_UNKNOWN', '记录刚发生变化，请使用原操作重新读取结果。', 503, true);
        }
        return { ...dto, link: r.source_kind ? parseLearningLink(current.link) : dto.link };
    }
    async function homeReflectionSummaries(p: Principal | null) {
        const c = await personal(p);
        const access = privateOwnerFence(p, c);
        return (await q(`SELECT r.id,r.date,r.scope,r.title,substr(trim(r.text),1,81) AS text
            FROM reflections r WHERE r.owner_id=? AND r.deleted_at IS NULL AND r.scope='private'
            AND ${access.predicate} ORDER BY r.date DESC,r.id DESC LIMIT 3`, c.user.id, ...access.values)
            .all<Pick<ReflectionAuthor, 'id' | 'date' | 'scope' | 'title' | 'text'>>()).results;
    }
    async function listMyReflections(p: Principal | null) {
        const c = await personal(p);
        const access = privateOwnerFence(p, c);
        const rows = (await q(`${select} WHERE r.owner_id=? AND r.deleted_at IS NULL AND ${access.predicate} ORDER BY r.date DESC,r.id DESC`, c.user.id, ...access.values).all<Row>()).results;
        const items = await Promise.all(rows.map(r => present(r, c, false) as Promise<ReflectionAuthor>));
        return withCurrentOwnLinks(p, c, items);
    }
    async function association(p: Principal | null, trainingId: unknown, videoId: unknown) {
        const training = trainingId == null || trainingId === '' ? null : text(trainingId, 80);
        const video = videoId == null || videoId === '' ? null : text(videoId, 80);
        if (video && !training) throw new DomainError('INVALID_INPUT', '关联视频需同时选择所属训练。');
        if (!training) return {
            training,
            video,
            context: null
        };
        const c = await activeMember(p);
        const source = await q(
            `SELECT id FROM trainings WHERE id=? AND team_id=? AND status IN ('published','archived')
                        AND (? IS NULL OR EXISTS(SELECT 1 FROM videos WHERE id=? AND training_id=trainings.id AND team_id=? AND status='active'))`,
            training,
            c.membership.teamId,
            video,
            video,
            c.membership.teamId
        ).first();
        if (!source) throw missing();
        return {
            training,
            video,
            context: c
        };
    }
    function associationGuard(op: Op, a: Awaited<ReturnType<typeof association>>) {
        if (!a.context) return [];
        return [
            memberGuard(op, a.context),
            assertGuard(
                db,
                op.opId,
                'association',
                `EXISTS(SELECT 1 FROM trainings
                        WHERE id=? AND team_id=? AND status IN ('published','archived') AND (? IS NULL OR EXISTS(
                        SELECT 1 FROM videos WHERE id=? AND training_id=trainings.id AND status='active' AND team_id=?)))`,
                [a.training, a.context.membership.teamId, a.video, a.video, a.context.membership.teamId]
            )
        ];
    }
    function expected(raw: Record<string, unknown>) {
        return {
            version: positive(raw.expectedVersion),
            sharing: positive(raw.expectedSharingVersion),
            generation: positive(raw.expectedGeneration)
        };
    }
    // Begin and finish share ONE D1 batch, with no externally visible pending phase.
    // An old prepared batch cannot acquire a newer version/generation; final zero effects roll back everything.
    function begin(op: Op, p: Principal | null, c: Awaited<ReturnType<typeof personal>>, id: string, e: ReturnType<typeof expected>) {
        const owner = c.user.id;
        return [
            ownerGuard(op, p, c),
            q(
                `UPDATE reflections SET gate='closed',sharing_version=sharing_version+1,active_op_id=?
                        WHERE id=? AND owner_id=? AND version=? AND sharing_version=? AND generation=? AND active_op_id IS NULL AND deleted_at IS NULL`,
                op.opId,
                id,
                owner,
                e.version,
                e.sharing,
                e.generation
            ),
            assertGuard(
                db,
                op.opId,
                'begin',
                `EXISTS(SELECT 1 FROM reflections WHERE id=? AND owner_id=? AND version=?
                        AND sharing_version=? AND generation=? AND gate='closed' AND active_op_id=?)`,
                [id, owner, e.version, e.sharing + 1, e.generation, op.opId]
            )
        ];
    }
    function finished(op: Op, id: string, e: ReturnType<typeof expected>, version: number, predicate: string, args: unknown[]) {
        return assertGuard(
            db,
            op.opId,
            'finish',
            `EXISTS(SELECT 1 FROM reflections WHERE id=? AND version=?
                        AND sharing_version=? AND generation=? AND active_op_id IS NULL AND last_committed_op_id=? AND (${predicate}))`,
            [id, version, e.sharing + 1, e.generation, op.opId, ...args]
        );
    }
    const finalWhere = 'id=? AND active_op_id=? AND sharing_version=? AND generation=?';
    async function saveReflection(p: Principal | null, id: string | null, input: unknown, key: string) {
        const c = await personal(p);
        const raw = object(
            input,
            [
                'title',
                'text',
                'date',
                'trainingId',
                'videoId',
                'sourceRef',
                'expectedVersion',
                'expectedSharingVersion',
                'expectedGeneration',
                'category'
            ]
        );
        const title = text(raw.title ?? '', 60, true);
        const category = typeof raw.category === 'string' ? raw.category.normalize('NFKC').trim() : undefined;
        if (raw.category !== undefined && (!category || Array.from(category).length > 20)) {
            throw new DomainError('INVALID_INPUT', '复盘类别需为 1–20 个字。');
        }
        const body = text(raw.text, 5000);
        const date = text(raw.date, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
            throw new DomainError('INVALID_INPUT', '请填写有效日期。');
        }
        if (raw.sourceRef !== undefined && raw.sourceRef !== null && !isLearningSourceRef(raw.sourceRef))
            throw new DomainError('INVALID_INPUT', '请选择有效的学习来源。');
        const explicitRef = isLearningSourceRef(raw.sourceRef) ? { kind: raw.sourceRef.kind, id: raw.sourceRef.id } : null;
        if (explicitRef && ((raw.trainingId != null && raw.trainingId !== '') || (raw.videoId != null && raw.videoId !== '')))
            throw new DomainError('INVALID_INPUT', '学习来源和训练请选择其一。');
        const e = id ? expected(raw) : null;
        const normalized = {
            title,
            text: body,
            ...(category ? { category } : {}),
            date,
            trainingId: raw.trainingId ?? null,
            videoId: raw.videoId ?? null,
            expected: e,
            ...(raw.sourceRef !== undefined ? { sourceRef: explicitRef } : {})
        };
        const op = await privateSourceWrite(() => operation(c.user.id, 'reflection-save', id ?? c.user.id, key, normalized));
        const target = op.replay?.result.id ?? id ?? crypto.randomUUID();
        if (op.replay) return privateSourceWrite(() => getOwnReflection(p, target, c));
        const old = id ? await getOwnReflection(p, id, c) : null;
        const a = await association(p, raw.trainingId, raw.videoId);
        const ref = raw.sourceRef === undefined && !a.training ? old?.sourceRef ?? null : explicitRef;
        const sourceGuards = ref && (ref.kind !== old?.sourceRef?.kind || ref.id !== old.sourceRef.id)
            ? [learningSourceGuard(db, op.opId, ref.kind, ref.id, c.user.id)] : [];
        const commitSave = (statements: D1PreparedStatement[], id: string) => {
            if (category) statements.push(q('UPDATE reflections SET category=? WHERE id=? AND owner_id=? AND last_committed_op_id=?',
                category, id, c.user.id, op.opId));
            return privateSourceWrite(() => op.commit(statements, { id }));
        };
        if (!id) {
            if (!c.membership) throw new DomainError('FORBIDDEN', '请先完成队伍建档。', 403);
            const committed = await commitSave(
                [
                    ownerGuard(op, p, c),
                    ...associationGuard(op, a),
                    ...sourceGuards,
                    q(
                        `INSERT INTO reflections(id,owner_id,team_id,title,text,date,training_id,video_id,source_kind,source_id,last_committed_op_id,created_at,updated_at)
                                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        target,
                        c.user.id,
                        c.membership.teamId,
                        title,
                        body,
                        date,
                        a.training,
                        a.video,
                        ref?.kind ?? null,
                        ref?.id ?? null,
                        op.opId,
                        now(),
                        now()
                    ),
                    assertGuard(
                        db,
                        op.opId,
                        'created',
                        "EXISTS(SELECT 1 FROM reflections WHERE id=? AND owner_id=? AND scope='private' AND last_committed_op_id=?)",
                        [target, c.user.id, op.opId]
                    )
                ],
                target
            );
            return privateSourceWrite(() => getOwnReflection(p, committed.result.id!, c));
        } else {
            await commitSave(
                [
                    ...begin(op, p, c, id, e!),
                    ...associationGuard(op, a),
                    ...sourceGuards,
                    q(
                        `UPDATE reflections SET title=?,text=?,date=?,training_id=?,video_id=?,source_kind=?,source_id=?,version=version+1,
                                        scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,published_at=NULL,
                                        active_op_id=NULL,last_committed_op_id=?,updated_at=? WHERE ${finalWhere}`,
                        title,
                        body,
                        date,
                        a.training,
                        a.video,
                        ref?.kind ?? null,
                        ref?.id ?? null,
                        op.opId,
                        now(),
                        id,
                        op.opId,
                        e!.sharing + 1,
                        e!.generation
                    ),
                    finished(
                        op,
                        id,
                        e!,
                        e!.version + 1,
                        "scope='private' AND gate='closed' AND published_at IS NULL AND title=? AND text=? AND date=? AND training_id IS ? AND video_id IS ? AND source_kind IS ? AND source_id IS ?",
                        [title, body, date, a.training, a.video, ref?.kind ?? null, ref?.id ?? null]
                    )
                ],
                id
            );
        }
        return privateSourceWrite(() => getOwnReflection(p, target, c));
    }
    async function shareReflection(p: Principal | null, id: string, input: unknown, key: string) {
        const c = await personal(p);
        const raw = object(input, ['scope', 'coachId', 'expectedVersion', 'expectedSharingVersion', 'expectedGeneration']);
        if ((raw.scope !== 'private' && raw.scope !== 'team') || raw.coachId != null) {
            throw new DomainError('INVALID_INPUT', '请选择一个阅读范围。');
        }
        const scope = raw.scope;
        // Keep null in the normalized operation input for old private/team idempotency keys.
        const coachId = null;
        const e = expected(raw);
        const op = await operation(c.user.id, 'reflection-share', id, key, {
            scope,
            coachId,
            expected: e
        });
        if (op.replay) return getOwnReflection(p, id);
        const old = await getOwnReflection(p, id);
        const previous = await q('SELECT published_at FROM reflections WHERE id=?', id).first<{
            published_at: string | null;
        }>();
        const publishedAt = scope === 'team' && old.scope === 'team' ? previous?.published_at ?? null : null;
        const shared = scope === 'private' ? null : await activeMember(p);
        const guards = shared ? [memberGuard(op, shared)] : [];
        await commit(
            op,
            [
                ...begin(op, p, c, id, e),
                ...guards,
                q(
                    `UPDATE reflections SET scope=?,coach_id=?,coach_epoch=?,author_epoch=?,published_at=?,
                                gate=?,active_op_id=NULL,last_committed_op_id=? WHERE ${finalWhere}`,
                    scope,
                    coachId,
                    null,
                    shared?.membership.epoch ?? null,
                    publishedAt,
                    scope === 'private' ? 'closed' : 'open',
                    op.opId,
                    id,
                    op.opId,
                    e.sharing + 1,
                    e.generation
                ),
                finished(
                    op,
                    id,
                    e,
                    e.version,
                    'scope=? AND coach_id IS ? AND coach_epoch IS ? AND published_at IS ? AND gate=?',
                    [scope, coachId, null, publishedAt, scope === 'private' ? 'closed' : 'open']
                )
            ],
            id
        );
        return getOwnReflection(p, id);
    }
    async function publishReflection(p: Principal | null, id: string, input: unknown, key: string) {
        const c = await personal(p);
        const raw = object(input, ['published', 'expectedVersion', 'expectedSharingVersion', 'expectedGeneration']);
        if (typeof raw.published !== 'boolean') throw new DomainError('INVALID_INPUT', '请确认发布或撤回。');
        const e = expected(raw);
        const op = await operation(c.user.id, 'reflection-publication', id, key, {
            published: raw.published,
            expected: e
        });
        if (op.replay) return getOwnReflection(p, id);
        const old = await getOwnReflection(p, id);
        const member = await activeMember(p);
        if (old.scope !== 'team') throw new DomainError('INVALID_INPUT', '请先单独确认全队阅读，再确认发布。');
        const current = await q('SELECT published_at FROM reflections WHERE id=?', id).first<{
            published_at: string | null;
        }>();
        const publishedAt = raw.published ? current?.published_at ?? now() : null;
        await commit(
            op,
            [
                ...begin(op, p, c, id, e),
                memberGuard(op, member),
                q(
                    `UPDATE reflections SET published_at=?,gate='open',active_op_id=NULL,last_committed_op_id=?
                                WHERE ${finalWhere} AND scope='team' AND author_epoch=?`,
                    publishedAt,
                    op.opId,
                    id,
                    op.opId,
                    e.sharing + 1,
                    e.generation,
                    member.membership.epoch
                ),
                finished(op, id, e, e.version, "scope='team' AND gate='open' AND published_at IS ?", [publishedAt])
            ],
            id
        );
        return getOwnReflection(p, id);
    }
    async function deleteReflection(p: Principal | null, id: string, input: unknown, key: string) {
        const c = await personal(p);
        const raw = object(input, ['expectedVersion', 'expectedSharingVersion', 'expectedGeneration']);
        const e = expected(raw);
        const op = await operation(c.user.id, 'reflection-delete', id, key, e);
        if (op.replay) {
            const access = accessMembershipFence(p, c);
            const current = await q(`SELECT deleted_at FROM reflections WHERE id=? AND owner_id=? AND ${access.predicate}`, id, c.user.id, ...access.values).first<{
                deleted_at: string | null;
            }>();
            if (!current) throw missing();
            return {
                id,
                deleted: current.deleted_at !== null
            };
        }
        await getOwnReflection(p, id);
        await commit(
            op,
            [
                ...begin(op, p, c, id, e),
                q(
                    `UPDATE reflections SET deleted_at=?,scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,
                                published_at=NULL,active_op_id=NULL,last_committed_op_id=?,version=version+1,generation=generation+1
                                WHERE ${finalWhere}`,
                    now(),
                    op.opId,
                    id,
                    op.opId,
                    e.sharing + 1,
                    e.generation
                ),
                assertGuard(
                    db,
                    op.opId,
                    'finish',
                    `EXISTS(SELECT 1 FROM reflections WHERE id=? AND version=? AND sharing_version=?
                                AND generation=? AND deleted_at IS NOT NULL AND scope='private' AND gate='closed' AND active_op_id IS NULL AND last_committed_op_id=?)`,
                    [id, e.version + 1, e.sharing + 1, e.generation + 1, op.opId]
                )
            ],
            id
        );
        return {
            id,
            deleted: true
        };
    }
    async function listDeletedReflections(p: Principal | null): Promise<DeletedReflection[]> {
        const c = await personal(p);
        const cutoff = new Date(clock().getTime() - 7 * 86400000).toISOString();
        const access = privateOwnerFence(p, c);
        const rows = (await q(`${select} WHERE r.owner_id=? AND r.deleted_at>? AND EXISTS(SELECT 1 FROM users u WHERE u.id=r.owner_id AND u.status='active')
            AND ${access.predicate} ORDER BY r.deleted_at DESC,r.id DESC`, c.user.id, cutoff, ...access.values).all<Row>()).results;
        const items = await Promise.all(rows.map(async r => ({
            ...await present(r, c, false) as ReflectionAuthor,
            deletedAt: r.deleted_at!,
            recoverUntil: new Date(Date.parse(r.deleted_at!) + 7 * 86400000).toISOString()
        })));
        return withCurrentOwnLinks(p, c, items);
    }
    async function restoreReflection(p: Principal | null, id: string, input: unknown, key: string) {
        const c = await personal(p);
        const raw = object(input, ['expectedVersion', 'expectedSharingVersion', 'expectedGeneration']);
        const e = expected(raw);
        const op = await operation(c.user.id, 'reflection-restore', id, key, e);
        if (op.replay) return getOwnReflection(p, id);
        const cutoff = new Date(clock().getTime() - 7 * 86400000).toISOString();
        if (!await q('SELECT id FROM reflections WHERE id=? AND owner_id=? AND deleted_at>?', id, c.user.id, cutoff).first()) throw missing();
        await commit(op, [
            ownerGuard(op, p, c),
            q(`UPDATE reflections SET deleted_at=NULL,version=version+1,sharing_version=sharing_version+1,generation=generation+1,
                scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,published_at=NULL,
                gate='closed',active_op_id=NULL,last_committed_op_id=?,updated_at=?
                WHERE id=? AND owner_id=? AND version=? AND sharing_version=? AND generation=?
                AND active_op_id IS NULL AND deleted_at>?`,
            op.opId, now(), id, c.user.id, e.version, e.sharing, e.generation, cutoff),
            assertGuard(db, op.opId, 'restored', `EXISTS(SELECT 1 FROM reflections WHERE id=? AND owner_id=?
                AND version=? AND sharing_version=? AND generation=? AND deleted_at IS NULL AND scope='private'
                AND coach_id IS NULL AND coach_epoch IS NULL AND author_epoch IS NULL AND published_at IS NULL
                AND gate='closed' AND active_op_id IS NULL AND last_committed_op_id=?)`,
            [id, c.user.id, e.version + 1, e.sharing + 1, e.generation + 1, op.opId])
        ], id);
        return getOwnReflection(p, id);
    }
    async function listMembers(p: Principal | null): Promise<PublicMember[]> {
        const c = await activeMember(p);
        return (await q(
            `SELECT u.id,p.*,p.disc_name AS discName,p.jersey_number AS jerseyNumber,m.role FROM memberships m
                        JOIN users u ON u.id=m.user_id JOIN profiles p ON p.user_id=u.id
                        WHERE m.team_id=? AND m.status='active' AND u.status='active' ORDER BY p.disc_name,u.id`,
            c.membership.teamId
        ).all<PublicMember>()).results.map(({ id, discName, jerseyNumber, role, bio, position }) => ({ id, discName, jerseyNumber, role, bio, ...(position ? { position } : {}) }));
    }
    async function getMemberProfile(p: Principal | null, id: string): Promise<PublicProfile> {
        const c = await activeMember(p);
        const member = (await listMembers(p)).find(m => m.id === id);
        if (!member) throw missing();
        const reflections = (await q(
            `SELECT r.id,r.title,r.date FROM reflections r
                        WHERE r.owner_id=? AND r.team_id=? AND r.scope='team' AND (${reflectionShared}) ORDER BY r.date DESC,r.id DESC`,
            id,
            c.membership.teamId,
            c.user.id
        ).all<{
            id: string;
            title: string;
            date: string;
        }>()).results;
        return {
            ...member,
            reflections
        };
    }
    const announcementSelect = 'SELECT id,title,text,status,version,published_at AS publishedAt,updated_at AS updatedAt FROM announcements';
    async function listAnnouncements(p: Principal | null) {
        const c = await activeMember(p, true);
        return (await q(`${announcementSelect} WHERE team_id=? AND status!='deleted' ORDER BY updated_at DESC,id DESC`, c.membership.teamId).all<Announcement>()).results;
    }
    async function getAnnouncement(p: Principal | null, id: string) {
        const c = await activeMember(p);
        const item = await q(
            `${announcementSelect} WHERE id=? AND team_id=? AND status!='deleted' ${c.membership.role === 'admin' ? '' : "AND status='published'"}`,
            id,
            c.membership.teamId
        ).first<Announcement>();
        if (!item) throw missing();
        return item;
    }
    async function saveAnnouncement(p: Principal | null, id: string | null, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const raw = object(input, ['title', 'text', 'status', 'expectedVersion']);
        const title = text(raw.title, 80);
        const body = text(raw.text, 5000);
        if (!['draft', 'published', 'deleted'].includes(String(raw.status))) throw new DomainError('INVALID_INPUT', '请选择公告状态。');
        const status = String(raw.status);
        const version = id ? positive(raw.expectedVersion) : null;
        const op = await operation(
            c.user.id,
            'announcement',
            id ?? c.membership.teamId,
            key,
            {
                title,
                body,
                status,
                version
            }
        );
        const target = op.replay?.result.id ?? id ?? crypto.randomUUID();
        if (op.replay) return status === 'deleted' ? {
            id: target,
            deleted: true
        } : getAnnouncement(p, target);
        const old = id ? await getAnnouncement(p, id) : null;
        const publishedAt = status === 'published' ? old?.publishedAt ?? now() : null;
        const committed = await commit(
            op,
            [
                memberGuard(op, c, true),
                id ? q(
                    `UPDATE announcements SET title=?,text=?,status=?,version=version+1,published_at=?,updated_at=?,last_op_id=?
                                WHERE id=? AND team_id=? AND version=?`,
                    title,
                    body,
                    status,
                    publishedAt,
                    now(),
                    op.opId,
                    id,
                    c.membership.teamId,
                    version
                ) : q(
                    `INSERT INTO announcements(id,team_id,title,text,status,published_at,created_at,updated_at,last_op_id) VALUES(?,?,?,?,?,?,?,?,?)`,
                    target,
                    c.membership.teamId,
                    title,
                    body,
                    status,
                    publishedAt,
                    now(),
                    now(),
                    op.opId
                ),
                assertGuard(
                    db,
                    op.opId,
                    'announcement-result',
                    `EXISTS(SELECT 1 FROM announcements WHERE id=? AND team_id=? AND version=?
                                AND last_op_id=? AND title=? AND text=? AND status=? AND published_at IS ?)`,
                    [target, c.membership.teamId, id ? version! + 1 : 1, op.opId, title, body, status, publishedAt]
                )
            ],
            target
        );
        return status === 'deleted' ? {
            id: committed.id!,
            deleted: true
        } : getAnnouncement(p, committed.id!);
    }
    async function workspaceDispatch(principal: Principal | null, cursor: string | null) {
        const c = await bindLearningMember(activeMember, principal);
        const member = learningMemberFence(c);
        let boundary = ['', ''];
        if (cursor) {
            try {
                const decoded = JSON.parse(atob(cursor));
                if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some(v => typeof v !== 'string' || v.length > 160)) throw Error();
                boundary = decoded;
            } catch { throw new DomainError('INVALID_INPUT', '动态分页位置无效。'); }
        }
        // D1 limits a compound SELECT to five terms. Materialize reflections and both training discussion sources separately.
        const { results } = await q(`WITH first_sources AS MATERIALIZED (
            SELECT 'n:'||r.id AS key,'reflection' AS kind,r.id AS source,r.title,substr(r.text,1,160) AS snippet,
                p.disc_name AS who,r.published_at AS date,NULL AS video,NULL AS comment FROM reflections r
                JOIN profiles p ON p.user_id=r.owner_id WHERE r.team_id=? AND r.published_at IS NOT NULL AND ${reflectionShared}
            UNION ALL SELECT 'c:'||vc.id,'discussion',v.training_id,t.title,substr(vc.text,1,160),p.disc_name,vc.created_at,v.id,vc.id
                FROM video_comments vc JOIN videos v ON vc.video_id=v.id AND v.team_id=vc.team_id
                JOIN trainings t ON t.id=v.training_id AND t.team_id=v.team_id JOIN profiles p ON p.user_id=vc.author_id
                WHERE vc.team_id=? AND vc.status='active' AND v.status='active' AND t.status IN ('published','archived')
            UNION ALL SELECT 'tc:'||d.id,'discussion',t.id,t.title,substr(d.body,1,160),p.disc_name,d.created_at,NULL,d.id
                FROM training_discussions d JOIN trainings t ON t.id=d.training_id JOIN profiles p ON p.user_id=d.author_id
                WHERE t.team_id=? AND t.status IN ('published','archived') AND d.status='active'
            ) SELECT * FROM (SELECT * FROM first_sources
            UNION ALL SELECT 'v:'||v.id,'training_video',t.id,v.title,'',coalesce(p.disc_name,'队内训练'),e.published_at,v.id,NULL
                FROM video_events e JOIN videos v ON v.id=e.video_id JOIN trainings t ON t.id=v.training_id AND t.team_id=v.team_id
                LEFT JOIN profiles p ON p.user_id=v.publisher_id WHERE v.team_id=? AND v.status='active' AND t.status='published'
            UNION ALL SELECT 'lc:'||lc.id,'discussion',lp.id,lpub.title,substr(lc.text,1,160),p.disc_name,lc.created_at,NULL,lc.id
                FROM learning_comments lc JOIN learning_posts lp ON lp.id=lc.post_id AND lp.team_id=lc.team_id
                JOIN learning_post_publications lpub ON lpub.post_id=lp.id JOIN profiles p ON p.user_id=lc.author_id
                WHERE lc.team_id=? AND lc.status='active' AND ${learningPostVisible}
            UNION ALL SELECT 'la:'||la.id,lpub.kind,lp.id,lpub.title,'',p.disc_name,la.shared_at,NULL,NULL
                FROM learning_activity_events la JOIN learning_posts lp ON lp.id=la.post_id
                JOIN learning_post_publications lpub ON lpub.post_id=lp.id JOIN profiles p ON p.user_id=lp.owner_id
                WHERE lp.team_id=? AND ${learningActivityVisible}
            UNION ALL SELECT 'a:'||a.id,'announcement',a.id,a.title,'','队伍公告',a.published_at,NULL,NULL
                FROM announcements a WHERE a.team_id=? AND a.status='published' AND a.published_at IS NOT NULL
            ) WHERE ${member.sql} AND (?='' OR date<? OR (date=? AND key<?)) ORDER BY date DESC,key DESC LIMIT 101`,
            c.membership.teamId,c.user.id,c.membership.teamId,c.membership.teamId,c.membership.teamId,c.membership.teamId,c.membership.teamId,c.membership.teamId,...member.values,
            boundary[0],boundary[0],boundary[0],boundary[1]).all<{ key:string;date:string }>();
        const items=results.slice(0,100);
        const last=items.at(-1);
        return {items,next:results.length>100 && last ? btoa(JSON.stringify([last.date,last.key])) : null};
    }
    async function listActivity(p: Principal | null, cursor: string | null = null, limit = 20): Promise<ActivityPage> {
        const c = await bindLearningMember(activeMember, p);
        const member = learningMemberFence(c);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new DomainError('INVALID_INPUT', '分页大小不可用。');
        let after: {
            time: string;
            id: string;
        } | null = null;
        if (cursor) {
            try {
                after = JSON.parse(atob(cursor));
                if (!after || typeof after.time !== 'string' || typeof after.id !== 'string' || after.time.length > 40 || after.id.length > 100) throw new Error();
            } catch {
                throw new DomainError('INVALID_INPUT', '分页位置不可用，请重新加载。');
            }
        }
        const rows = (await q(
            `SELECT * FROM (
                        SELECT 'reflection:'||r.id AS id,'reflection' AS kind,r.title,'/reflections/'||r.id AS href,r.published_at AS publishedAt,r.updated_at AS updatedAt,
                               NULL AS publisherId,NULL AS publisherName
                        FROM reflections r WHERE r.team_id=? AND r.scope='team' AND r.published_at IS NOT NULL AND (${reflectionShared})
                        UNION ALL SELECT 'video:'||v.id,'video',v.title,'/videos/'||v.id,e.published_at,v.updated_at,v.publisher_id,
                               (SELECT p.disc_name FROM profiles p JOIN users pu ON pu.id=p.user_id
                                WHERE p.user_id=v.publisher_id AND pu.status='active')
                        FROM video_events e JOIN videos v ON v.id=e.video_id JOIN trainings t ON t.id=v.training_id
                        WHERE v.team_id=? AND v.status='active' AND t.status='published'
                        UNION ALL SELECT 'announcement:'||a.id,'announcement',a.title,'/announcements/'||a.id,a.published_at,a.updated_at,NULL,NULL
                        FROM announcements a WHERE a.team_id=? AND a.status='published' AND a.published_at IS NOT NULL
                        UNION ALL ${learningActivitySelect}
                        ) WHERE ${member.sql} AND (? IS NULL OR publishedAt<? OR (publishedAt=? AND id<?))
                        ORDER BY publishedAt DESC,id DESC LIMIT ?`,
            c.membership.teamId,
            c.user.id,
            c.membership.teamId,
            c.membership.teamId,
            c.membership.teamId,
            ...member.values,
            after?.time ?? null,
            after?.time ?? null,
            after?.time ?? null,
            after?.id ?? null,
            limit + 1
        ).all<ActivityItem & { publisherId: string | null; publisherName: string | null }>()).results;
        const items = rows.slice(0, limit).map(({ kind, publisherId, publisherName, ...item }): ActivityItem =>
            kind === 'video' ? { ...item, kind, publisherId, publisherName } : { ...item, kind }
        );
        const last = items.at(-1);
        return {
            items,
            nextCursor: rows.length > limit && last ? btoa(JSON.stringify({
                time: last.publishedAt,
                id: last.id
            })) : null
        };
    }
    return {
        getReflection,
        getOwnReflection,
        listMyReflections, homeReflectionSummaries,
        saveReflection,
        shareReflection,
        publishReflection,
        deleteReflection,
        listDeletedReflections,
        restoreReflection,
        listMembers,
        getMemberProfile,
        listActivity, workspaceDispatch,
        listAnnouncements,
        getAnnouncement,
        saveAnnouncement
    };
}
