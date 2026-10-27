import type { DeletedReflection } from '../contracts/data-rights';
import type { Me, Principal } from '../contracts/index';
import type { Announcement, ActivityItem, ActivityPage, PublicMember, PublicProfile, Reflection, ReflectionAuthor, ReflectionReader } from '../contracts/reflections';
import { assertGuard, DomainError } from './domain.ts';
import type { StoredResult } from './domain';
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
    function ownerGuard(op: Op, owner: string) {
        return assertGuard(db, op.opId, 'owner', "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')", [owner]);
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
    async function link(p: Principal | null, r: Row) {
        if (!r.training_id) return null;
        const c = await me(p);
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
    async function present(p: Principal | null, r: Row, actor: string): Promise<Reflection> {
        const base: ReflectionReader = {
            id: r.id,
            title: r.title,
            text: r.text,
            date: r.date,
            updatedAt: r.updated_at,
            author: {
                id: r.owner_id,
                discName: r.disc_name,
                jerseyNumber: r.jersey_number
            },
            isAuthor: actor === r.owner_id,
            link: await link(p, r)
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
            videoId: r.video_id
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
        const r = await q(
            `${select} WHERE r.id=? AND r.deleted_at IS NULL AND
                        (r.owner_id=? OR (${reflectionShared}))`,
            id,
            c.user.id,
            c.user.id
        ).first<Row>();
        if (!r) throw missing();
        return present(p, r, c.user.id);
    }
    async function getOwnReflection(p: Principal | null, id: string): Promise<ReflectionAuthor> {
        const c = await personal(p);
        const r = await q(`${select} WHERE r.id=? AND r.owner_id=? AND r.deleted_at IS NULL`, id, c.user.id).first<Row>();
        if (!r) throw missing();
        return (await present(p, r, c.user.id)) as ReflectionAuthor;
    }
    async function listMyReflections(p: Principal | null) {
        const c = await personal(p);
        const rows = (await q(`${select} WHERE r.owner_id=? AND r.deleted_at IS NULL ORDER BY r.date DESC,r.id DESC`, c.user.id).all<Row>()).results;
        return Promise.all(rows.map(r => present(p, r, c.user.id) as Promise<ReflectionAuthor>));
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
    function begin(op: Op, owner: string, id: string, e: ReturnType<typeof expected>) {
        return [
            ownerGuard(op, owner),
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
                'expectedVersion',
                'expectedSharingVersion',
                'expectedGeneration'
            ]
        );
        const title = text(raw.title ?? '', 60, true);
        const body = text(raw.text, 5000);
        const date = text(raw.date, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
            throw new DomainError('INVALID_INPUT', '请填写有效日期。');
        }
        const e = id ? expected(raw) : null;
        const normalized = {
            title,
            text: body,
            date,
            trainingId: raw.trainingId ?? null,
            videoId: raw.videoId ?? null,
            expected: e
        };
        const op = await operation(c.user.id, 'reflection-save', id ?? c.user.id, key, normalized);
        const target = op.replay?.result.id ?? id ?? crypto.randomUUID();
        if (op.replay) return getOwnReflection(p, target);
        if (id) await getOwnReflection(p, id);
        const a = await association(p, raw.trainingId, raw.videoId);
        if (!id) {
            if (!c.membership) throw new DomainError('FORBIDDEN', '请先完成队伍建档。', 403);
            const committed = await commit(
                op,
                [
                    ownerGuard(op, c.user.id),
                    ...associationGuard(op, a),
                    q(
                        `INSERT INTO reflections(id,owner_id,team_id,title,text,date,training_id,video_id,last_committed_op_id,created_at,updated_at)
                                        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                        target,
                        c.user.id,
                        c.membership.teamId,
                        title,
                        body,
                        date,
                        a.training,
                        a.video,
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
            return getOwnReflection(p, committed.id!);
        } else {
            await commit(
                op,
                [
                    ...begin(op, c.user.id, id, e!),
                    ...associationGuard(op, a),
                    q(
                        `UPDATE reflections SET title=?,text=?,date=?,training_id=?,video_id=?,version=version+1,
                                        scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,published_at=NULL,
                                        active_op_id=NULL,last_committed_op_id=?,updated_at=? WHERE ${finalWhere}`,
                        title,
                        body,
                        date,
                        a.training,
                        a.video,
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
                        "scope='private' AND gate='closed' AND published_at IS NULL AND title=? AND text=? AND date=? AND training_id IS ? AND video_id IS ?",
                        [title, body, date, a.training, a.video]
                    )
                ],
                id
            );
        }
        return getOwnReflection(p, target);
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
                ...begin(op, c.user.id, id, e),
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
                ...begin(op, c.user.id, id, e),
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
            const current = await q('SELECT deleted_at FROM reflections WHERE id=? AND owner_id=?', id, c.user.id).first<{
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
                ...begin(op, c.user.id, id, e),
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
        const rows = (await q(`${select} WHERE r.owner_id=? AND r.deleted_at>? AND EXISTS(SELECT 1 FROM users u WHERE u.id=r.owner_id AND u.status='active') ORDER BY r.deleted_at DESC,r.id DESC`, c.user.id, cutoff).all<Row>()).results;
        return Promise.all(rows.map(async r => ({
            ...await present(p, r, c.user.id) as ReflectionAuthor,
            deletedAt: r.deleted_at!,
            recoverUntil: new Date(Date.parse(r.deleted_at!) + 7 * 86400000).toISOString()
        })));
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
            ownerGuard(op, c.user.id),
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
            `SELECT u.id,p.disc_name AS discName,p.jersey_number AS jerseyNumber,m.role FROM memberships m
                        JOIN users u ON u.id=m.user_id JOIN profiles p ON p.user_id=u.id
                        WHERE m.team_id=? AND m.status='active' AND u.status='active' ORDER BY p.disc_name,u.id`,
            c.membership.teamId
        ).all<PublicMember>()).results;
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
    async function listActivity(p: Principal | null, cursor: string | null = null, limit = 20): Promise<ActivityPage> {
        const c = await activeMember(p);
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
                        SELECT 'reflection:'||r.id AS id,'reflection' AS kind,r.title,'/reflections/'||r.id AS href,r.published_at AS publishedAt,r.updated_at AS updatedAt
                        FROM reflections r WHERE r.team_id=? AND r.scope='team' AND r.published_at IS NOT NULL AND (${reflectionShared})
                        UNION ALL SELECT 'video:'||v.id,'video',v.title,'/videos/'||v.id,e.published_at,v.updated_at
                        FROM video_events e JOIN videos v ON v.id=e.video_id JOIN trainings t ON t.id=v.training_id
                        WHERE v.team_id=? AND v.status='active' AND t.status='published'
                        UNION ALL SELECT 'announcement:'||a.id,'announcement',a.title,'/announcements/'||a.id,a.published_at,a.updated_at
                        FROM announcements a WHERE a.team_id=? AND a.status='published' AND a.published_at IS NOT NULL
                        ) WHERE (? IS NULL OR publishedAt<? OR (publishedAt=? AND id<?)) ORDER BY publishedAt DESC,id DESC LIMIT ?`,
            c.membership.teamId,
            c.user.id,
            c.membership.teamId,
            c.membership.teamId,
            after?.time ?? null,
            after?.time ?? null,
            after?.time ?? null,
            after?.id ?? null,
            limit + 1
        ).all<ActivityItem>()).results;
        const items = rows.slice(0, limit);
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
        listMyReflections,
        saveReflection,
        shareReflection,
        publishReflection,
        deleteReflection,
        listDeletedReflections,
        restoreReflection,
        listMembers,
        getMemberProfile,
        listActivity,
        listAnnouncements,
        getAnnouncement,
        saveAnnouncement
    };
}
