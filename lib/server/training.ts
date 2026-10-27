import { resolveBilibiliShare } from './bilibili.ts';
import type { Me, Principal } from '../contracts/index';
import type { Training, Video, Comment, Collection, CollectionReflectionSeed } from '../contracts/training';
import { DomainError, assertGuard } from './domain.ts';
import type { StoredResult } from './domain';
import type { Reflection } from '../contracts/reflections';
import { reflectionShared } from './reflections.ts';
import { createResumableUploads } from './resumable-upload.ts';
import type { MediaPolicy, UploadPage, UploadReservation } from '../contracts/media';
import { inspectMP4Ranges } from './media.ts';
import { MEDIA_MAX_BYTES, MEDIA_MAX_SECONDS, MEDIA_PART_BYTES, MEDIA_TEAM_BYTES } from '../contracts/media.ts';
type Context = Me & {
    user: NonNullable<Me['user']>;
    membership: NonNullable<Me['membership']>;
};
type Op = {
    opId: string;
    replay: {
        result: StoredResult;
    } | null;
    commit: (body: D1PreparedStatement[], result: StoredResult) => Promise<{
        result: StoredResult;
    }>;
};
type Dependencies = {
    db: D1Database;
    mediaPolicy?: MediaPolicy;
    getReflection: (p: Principal | null, id: string) => Promise<Reflection>;
    bucket?: R2Bucket;
    clock: () => Date;
    me: (p: Principal | null) => Promise<Me>;
    activeMember: (p: Principal | null, admin?: boolean) => Promise<Context>;
    operation: (actor: string, kind: string, target: string, key: string, input: unknown) => Promise<Op>;
};
function object(input: unknown, fields: string[]) {
    if(!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k)))
        throw new DomainError('INVALID_INPUT', '请检查填写内容。');
    return input as Record<string, unknown>;
}
function text(v: unknown, max: number, optional = false) {
    if(typeof v !== 'string' || (!optional && !v.trim()) || v.trim().length > max)
        throw new DomainError('INVALID_INPUT', `内容需为${optional ? '0' : '1'}–${max}字。`);
    return v.trim();
}
function version(v: unknown) {
    if(!Number.isSafeInteger(v) || Number(v) < 1)
        throw new DomainError('INVALID_INPUT', '请重新加载后编辑。');
    return Number(v);
}
function seconds(v: unknown, duration: number | null = null) {
    if(v == null || v === '')
        return null;
    if(!Number.isSafeInteger(v) || Number(v) < 0 || (duration !== null && Number(v) > duration))
        throw new DomainError('INVALID_INPUT', '请输入有效的非负整数秒数。');
    return Number(v);
}
export function createTrainingService({ db, bucket, clock, mediaPolicy, activeMember, me, operation, getReflection }: Dependencies) {
    const q = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args);
    const resumable = createResumableUploads({ db, bucket, clock, activeMember, operation, mediaPolicy });
    const now = () => clock().toISOString();
    const missing = () => new DomainError('NOT_FOUND', '内容不可用或当前无权查看。', 404);
    const trainingSelect = 'SELECT id,title,date,description,status,version,updated_at AS updatedAt FROM trainings';
    const videoSelect = `SELECT v.id,v.training_id AS trainingId,v.title,v.source,v.url,v.position,v.status,v.version,u.duration_sec AS durationSec FROM videos v LEFT JOIN uploads u ON u.id=v.upload_id`;
    function memberGuard(op: Op, c: Context, admin = false, phase = 'member') {
        return assertGuard(
            db,
            op.opId,
            phase,
            `EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.user_id=? AND m.team_id=? AND m.epoch=? AND m.status='active' AND u.status='active' ${admin ? "AND m.role='admin'" : ''})`,
            [c.membership.id, c.user.id, c.membership.teamId, c.membership.epoch]
        );
    }
    function trainingGuard(op: Op, id: string, team: string, writable = true) {
        return assertGuard(
            db,
            op.opId,
            'training',
            `EXISTS(SELECT 1 FROM trainings WHERE id=? AND team_id=? AND status IN (${writable ? "'draft','published'" : "'published','archived'"}))`,
            [id, team]
        );
    }
    async function commit(op: Op, c: Context, body: D1PreparedStatement[], result: StoredResult, admin = false) {
        try {
            return await op.commit(
                [
                    memberGuard(op, c, admin),
                    ...body,
                    assertGuard(
                        db,
                        op.opId,
                        'result',
                        'EXISTS(SELECT id FROM trainings WHERE id=? UNION ALL SELECT id FROM videos WHERE id=? UNION ALL SELECT id FROM video_comments WHERE id=? UNION ALL SELECT id FROM uploads WHERE id=?)',
                        [result.id, result.id, result.id, result.id]
                    ),
                    memberGuard(op, c, admin, 'member-final')
                ],
                result
            );
        }
        catch(e) {
            if(e instanceof DomainError)
                throw e;
            throw new DomainError('VERSION_CONFLICT', '内容或权限已经变化，请刷新后重试。', 409);
        }
    }
    async function listTrainings(p: Principal | null) {
        const c = await activeMember(p);
        return (await q(
            `${trainingSelect} WHERE team_id=? ${c.membership.role === 'admin' ? "AND status!='deleted'" : "AND status IN ('published','archived')"} ORDER BY date DESC,id DESC`,
            c.membership.teamId
        ).all<Training>()).results;
    }
    async function getTraining(p: Principal | null, id: string) {
        const c = await activeMember(p);
        const t = await q(
            `${trainingSelect} WHERE id=? AND team_id=? ${c.membership.role === 'admin' ? "AND status!='deleted'" : "AND status IN ('published','archived')"}`,
            id,
            c.membership.teamId
        ).first<Training>();
        if(!t)
            throw missing();
        const videoStatus = c.membership.role === 'admin' ? "v.status IN ('active','hidden')" : "v.status='active'";
        const videos = (await q(`${videoSelect} WHERE v.training_id=? AND v.team_id=? AND ${videoStatus} ORDER BY v.position,v.id`, id, c.membership.teamId).all<Video>()).results;
        return { ...t, videos };
    }
    async function saveTraining(p: Principal | null, id: string | null, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const r = object(input, ['title', 'date', 'description', 'status', 'expectedVersion']);
        const title = text(r.title, 80);
        const description = text(r.description, 2000, true);
        const date = text(r.date, 10);
        const status = text(r.status, 12);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || (!Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) || !['draft', 'published', 'archived', 'hidden', 'deleted'].includes(status))
            throw new DomainError('INVALID_INPUT', '请检查日期与训练状态。');
        const expected = id ? version(r.expectedVersion) : null;
        const op = await operation(c.user.id, 'training', id ?? c.membership.teamId, key, { title, date, description, status, expected });
        let target = op.replay?.result.id ?? id ?? crypto.randomUUID();
        if(!op.replay) {
            const committed = await commit(
                op,
                c,
                id ? [
                    assertGuard(
                        db,
                        op.opId,
                        'version',
                        'EXISTS(SELECT 1 FROM trainings WHERE id=? AND team_id=? AND version=?)',
                        [id, c.membership.teamId, expected]
                    ),
                    q(
                        'UPDATE trainings SET title=?,date=?,description=?,status=?,version=version+1,updated_at=? WHERE id=? AND team_id=? AND version=?',
                        title,
                        date,
                        description,
                        status,
                        now(),
                        id,
                        c.membership.teamId,
                        expected
                    ),
                    assertGuard(db, op.opId, 'updated', 'EXISTS(SELECT 1 FROM trainings WHERE id=? AND version=?)', [id, expected! + 1])
                ] : [
                    q(
                        'INSERT INTO trainings(id,team_id,title,date,description,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                        target,
                        c.membership.teamId,
                        title,
                        date,
                        description,
                        status,
                        now(),
                        now()
                    )
                ],
                { id: target },
                true
            );
            target = committed.result.id!;
        }
        const current = await activeMember(p, true);
        const saved = await q(`${trainingSelect} WHERE id=? AND team_id=?`, target, current.membership.teamId).first<Training>();
        if (!saved) throw missing();
        return saved;
    }
    async function getVideo(p: Principal | null, id: string) {
        const c = await activeMember(p);
        const v = await q(`${videoSelect} WHERE v.id=? AND v.team_id=? AND v.status='active'`, id, c.membership.teamId).first<Video>();
        if(!v)
            throw missing();
        const training = await getTraining(p, v.trainingId);
        return { ...v, training };
    }
    async function addVideo(p: Principal | null, trainingId: string, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const r = object(input, ['title', 'source', 'url', 'uploadId', 'position']);
        const t = await getTraining(p, trainingId);
        if(!['draft', 'published'].includes(t.status))
            throw new DomainError('READ_ONLY', '归档训练只可回看，请先重新开放。', 409);
        const title = text(r.title, 80);
        const source = r.source;
        if(source !== 'bilibili' && source !== 'upload')
            throw new DomainError('INVALID_INPUT', '请选择视频来源。');
        if(!Number.isSafeInteger(r.position) || Number(r.position) < 0 || Number(r.position) > 10000)
            throw new DomainError('INVALID_INPUT', '请检查视频顺序。');
        const url = source === 'bilibili' ? await resolveBilibiliShare(r.url) : null;
        const uploadId = source === 'upload' ? text(r.uploadId, 80) : null;
        const op = await operation(c.user.id, 'video-add', trainingId, key, { title, source, url, uploadId, position: r.position });
        let id = op.replay?.result.id ?? crypto.randomUUID();
        if(!op.replay) {
            const body = [trainingGuard(op, trainingId, c.membership.teamId)];
            if(uploadId)
                body.push(assertGuard(
                    db,
                    op.opId,
                    'upload',
                    "EXISTS(SELECT 1 FROM uploads WHERE id=? AND team_id=? AND owner_id=? AND status='ready' AND cleanup_state='none' AND transfer_active=0)",
                    [uploadId, c.membership.teamId, c.user.id]
                ));
            body.push(q(
                'INSERT INTO videos(id,training_id,team_id,title,source,url,upload_id,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                id,
                trainingId,
                c.membership.teamId,
                title,
                source,
                url,
                uploadId,
                r.position,
                now(),
                now()
            ));
            id = (await commit(op, c, body, { id }, true)).result.id!;
        }
        return getVideo(p, id);
    }
    async function updateVideo(p: Principal | null, id: string, input: unknown, key: string) {
        const c = await activeMember(p, true);
        const v = await q('SELECT training_id AS trainingId FROM videos WHERE id=? AND team_id=?', id, c.membership.teamId).first<{
            trainingId: string;
        }>();
        const r = object(input, ['title', 'position', 'status', 'expectedVersion']);
        if(!v)
            throw missing();
        await getTraining(p, v.trainingId);
        const title = text(r.title, 80);
        const expected = version(r.expectedVersion);
        if(!Number.isSafeInteger(r.position) || Number(r.position) < 0 || !['active', 'deleted', 'hidden'].includes(String(r.status)))
            throw new DomainError('INVALID_INPUT', '请检查视频顺序与状态。');
        const op = await operation(c.user.id, 'video-edit', id, key, { title, position: r.position, status: r.status, expected });
        if(!op.replay)
            await commit(
                op,
                c,
                [
                    trainingGuard(op, v.trainingId, c.membership.teamId),
                    assertGuard(db, op.opId, 'version', 'EXISTS(SELECT 1 FROM videos WHERE id=? AND version=?)', [id, expected]),
                    q(
                        'UPDATE videos SET title=?,position=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?',
                        title,
                        r.position,
                        r.status,
                        now(),
                        id,
                        expected
                    ),
                    assertGuard(db, op.opId, 'updated', 'EXISTS(SELECT 1 FROM videos WHERE id=? AND version=?)', [id, expected + 1])
                ],
                { id },
                true
            );
        return { id };
    }
    async function listComments(p: Principal | null, videoId: string) {
        await getVideo(p, videoId);
        return (await q(
            `SELECT c.id,c.video_id AS videoId,c.root_id AS rootId,c.author_id AS authorId,p.disc_name AS authorName,p.jersey_number AS authorJerseyNumber,rp.disc_name AS replyTargetName,CASE WHEN c.status='active' THEN c.text ELSE NULL END AS text,c.timestamp_sec AS timestampSec,c.status,c.version,c.created_at AS createdAt,CASE WHEN c.updated_at!=c.created_at THEN 1 ELSE 0 END AS edited FROM video_comments c JOIN profiles p ON p.user_id=c.author_id LEFT JOIN video_comments root ON root.id=c.root_id LEFT JOIN profiles rp ON rp.user_id=root.author_id WHERE c.video_id=? ORDER BY c.created_at,c.id`,
            videoId
        ).all<Comment>()).results;
    }
    async function saveComment(p: Principal | null, videoId: string, id: string | null, input: unknown, key: string) {
        const c = await activeMember(p);
        const v = await getVideo(p, videoId);
        const r = object(input, ['text', 'timestampSec', 'rootId', 'expectedVersion', 'action']);
        if(v.training.status !== 'published')
            throw new DomainError('READ_ONLY', '此训练暂不接受新讨论或修改。', 409);
        const action = r.action === 'delete' ? 'delete' : 'save';
        const bodyText = action === 'delete' ? '' : text(r.text, 2000);
        const timestampSec = seconds(r.timestampSec, v.durationSec);
        const rootId = r.rootId == null ? null : text(r.rootId, 80);
        const expected = id ? version(r.expectedVersion) : null;
        if(id) {
            const old = await q('SELECT author_id FROM video_comments WHERE id=? AND video_id=? AND team_id=?', id, videoId, c.membership.teamId).first<{
                author_id: string;
            }>();
            if(!old)
                throw missing();
            if(old.author_id !== c.user.id)
                throw new DomainError('FORBIDDEN', '只能编辑或删除自己的讨论。', 403);
        }
        if(rootId && !id && !await q(
            "SELECT id FROM video_comments WHERE id=? AND video_id=? AND team_id=? AND root_id IS NULL AND status='active'",
            rootId,
            videoId,
            c.membership.teamId
        ).first())
            throw new DomainError('INVALID_INPUT', '回复对象必须是同视频的有效根讨论。');
        const op = await operation(c.user.id, 'comment', id ?? videoId, key, { bodyText, timestampSec, rootId, expected, action });
        let target = op.replay?.result.id ?? id ?? crypto.randomUUID();
        if(!op.replay) {
            const guards = [
                assertGuard(
                    db,
                    op.opId,
                    'training',
                    "EXISTS(SELECT 1 FROM trainings WHERE id=? AND team_id=? AND status='published')",
                    [v.trainingId, c.membership.teamId]
                ),
                assertGuard(
                    db,
                    op.opId,
                    'video',
                    "EXISTS(SELECT 1 FROM videos WHERE id=? AND team_id=? AND status='active')",
                    [videoId, c.membership.teamId]
                )
            ];
            if(rootId && !id)
                guards.push(assertGuard(
                    db,
                    op.opId,
                    'root',
                    "EXISTS(SELECT 1 FROM video_comments WHERE id=? AND video_id=? AND team_id=? AND root_id IS NULL AND status='active')",
                    [rootId, videoId, c.membership.teamId]
                ));
            if(id)
                guards.push(
                    assertGuard(
                        db,
                        op.opId,
                        'version',
                        "EXISTS(SELECT 1 FROM video_comments WHERE id=? AND video_id=? AND author_id=? AND version=? AND status!='deleted')",
                        [id, videoId, c.user.id, expected]
                    ),
                    q(
                        `UPDATE video_comments SET text=?,timestamp_sec=?,status=CASE WHEN ?='delete' THEN 'deleted' ELSE status END,version=version+1,updated_at=? WHERE id=? AND author_id=? AND version=?`,
                        bodyText,
                        timestampSec,
                        action,
                        now(),
                        id,
                        c.user.id,
                        expected
                    ),
                    assertGuard(db, op.opId, 'updated', 'EXISTS(SELECT 1 FROM video_comments WHERE id=? AND version=?)', [id, expected! + 1])
                );
            else
                guards.push(q(
                    'INSERT INTO video_comments(id,video_id,team_id,author_id,root_id,text,timestamp_sec,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                    target,
                    videoId,
                    c.membership.teamId,
                    c.user.id,
                    rootId,
                    bodyText,
                    timestampSec,
                    now(),
                    now()
                ));
            target = (await commit(op, c, guards, { id: target })).result.id!;
        }
        await getVideo(p, videoId);
        if (!await q('SELECT id FROM video_comments WHERE id=? AND video_id=? AND author_id=?', target, videoId, c.user.id).first()) throw missing();
        return { id: target };
    }
    async function moderateComment(p: Principal | null, id: string, input: unknown, key: string) {
        const r = object(input, ['action', 'reason']);
        const action = text(r.action, 10);
        const reason = text(r.reason, 500);
        if(!['hide', 'restore', 'report'].includes(action))
            throw new DomainError('INVALID_INPUT', '请检查治理操作。');
        const c = await activeMember(p, action !== 'report');
        const comment = await q("SELECT video_id,status FROM video_comments WHERE id=? AND team_id=?", id, c.membership.teamId).first<{
            video_id: string;
            status: string;
        }>();
        if(!comment)
            throw missing();
        const v = await getVideo(p, comment.video_id);
        if(action === 'report' && comment.status !== 'active')
            throw missing();
        const op = await operation(c.user.id, 'comment-' + action, id, key, { action, reason });
        if(!op.replay)
            await commit(
                op,
                c,
                [
                    trainingGuard(op, v.trainingId, c.membership.teamId, false),
                    assertGuard(
                        db,
                        op.opId,
                        'source',
                        "EXISTS(SELECT 1 FROM videos v JOIN video_comments c ON c.video_id=v.id WHERE c.id=? AND c.team_id=? AND v.status='active' AND c.status!='deleted')",
                        [id, c.membership.teamId]
                    ),
                    ...(action === 'report' ? [
                        q(
                            'INSERT INTO comment_reports(id,comment_id,actor_id,reason,created_at) VALUES(?,?,?,?,?)',
                            op.opId,
                            id,
                            c.user.id,
                            reason,
                            now()
                        )
                    ] : [
                        q(
                            "UPDATE video_comments SET status=?,version=version+1 WHERE id=? AND status!='deleted'",
                            action === 'hide' ? 'hidden' : 'active',
                            id
                        ),
                        q(
                            'INSERT INTO moderation_audit(id,actor_id,target_id,action,reason,created_at) VALUES(?,?,?,?,?,?)',
                            op.opId,
                            c.user.id,
                            id,
                            action,
                            reason,
                            now()
                        )
                    ]),
                    assertGuard(
                        db,
                        op.opId,
                        'audit',
                        action === 'report' ? 'EXISTS(SELECT 1 FROM comment_reports WHERE id=?)' : 'EXISTS(SELECT 1 FROM moderation_audit WHERE id=?)',
                        [op.opId]
                    )
                ],
                { id },
                action !== 'report'
            );
        return { id };
    }
    async function personal(p: Principal | null) {
        const c = await me(p);
        if(c.user?.status !== 'active')
            throw new DomainError('FORBIDDEN', '请先完成建档。', 403);
        return c.user.id;
    }
    async function resolveSource(p: Principal | null, kind: string, id: string, timestampSec: number | null = null) {
        try {
            if (kind === 'reflection') {
                const r = await getReflection(p, id);
                return { title: r.title || '训练复盘', href: '/reflections/' + r.id, text: r.text };
            }
            if(kind === 'video') {
                const v = await getVideo(p, id);
                if(!['published', 'archived'].includes(v.training.status))
                    return null;
                return { title: v.title, href: '/videos/' + v.id + (timestampSec !== null ? '?t=' + timestampSec : '') };
            }
            const c = await q("SELECT video_id,text,status FROM video_comments WHERE id=?", id).first<{
                video_id: string;
                text: string;
                status: string;
            }>();
            if(!c || c.status !== 'active')
                return null;
            const v = await getVideo(p, c.video_id);
            if(!['published', 'archived'].includes(v.training.status))
                return null;
            return { title: v.title, href: '/videos/' + v.id + (timestampSec !== null ? '?t=' + timestampSec : '') + '#comment-' + id, text: c.text };
        }
        catch(e) {
            if(e instanceof DomainError && [403, 404].includes(e.status))
                return null;
            throw e;
        }
    }
    async function listCollections(p: Principal | null) {
        const owner = await personal(p);
        const rows = (await q(
            'SELECT id,source_kind AS sourceKind,source_id AS sourceId,timestamp_sec AS timestampSec,private_note AS privateNote,version,created_at AS createdAt FROM collections WHERE owner_id=? ORDER BY created_at DESC,id DESC',
            owner
        ).all<Omit<Collection, 'source'>>()).results;
        return Promise.all(rows.map(async (r) => ({ ...r, source: await resolveSource(p, r.sourceKind, r.sourceId, r.timestampSec) })));
    }
    async function getCollectionReflectionSeed(p: Principal | null, id: string): Promise<CollectionReflectionSeed> {
        const owner = await personal(p);
        const row = await q('SELECT source_kind,source_id,private_note FROM collections WHERE id=? AND owner_id=?', id, owner).first<{
            source_kind: string; source_id: string; private_note: string;
        }>();
        if (!row) throw missing();
        let trainingId: string | null = null;
        let videoId: string | null = null;
        try {
            let sourceVideo: string | null = null;
            let sourceTraining: string | null = null;
            if (row.source_kind === 'video') sourceVideo = row.source_id;
            else if (row.source_kind === 'comment') {
                const comment = await q("SELECT video_id FROM video_comments WHERE id=? AND status='active'", row.source_id).first<{ video_id: string }>();
                sourceVideo = comment?.video_id ?? null;
            } else if (row.source_kind === 'reflection') {
                const reflection = await getReflection(p, row.source_id);
                const link = reflection.link?.href.match(/^\/(videos|trainings)\/([a-zA-Z0-9_-]{1,80})$/);
                if (link?.[1] === 'videos') sourceVideo = link[2];
                if (link?.[1] === 'trainings') sourceTraining = link[2];
            }
            if (sourceVideo) {
                const video = await getVideo(p, sourceVideo);
                if (['published', 'archived'].includes(video.training.status)) {
                    trainingId = video.trainingId; videoId = video.id;
                }
            } else if (sourceTraining) {
                const training = await getTraining(p, sourceTraining);
                if (['published', 'archived'].includes(training.status)) trainingId = training.id;
            }
        } catch (e) {
            if (!(e instanceof DomainError && [403, 404].includes(e.status))) throw e;
        }
        // Source access may disappear independently; the owner's saved note remains theirs.
        if (await personal(p) !== owner) throw missing();
        return { text: row.private_note, trainingId, videoId };
    }
    async function saveCollection(p: Principal | null, id: string | null, input: unknown, key: string) {
        const owner = await personal(p);
        const r = object(input, ['sourceKind', 'sourceId', 'timestampSec', 'privateNote', 'expectedVersion', 'action']);
        const action = r.action === 'delete' ? 'delete' : 'save';
        const note = action === 'delete' ? '' : text(r.privateNote ?? '', 2000, true);
        let old: {
            id: string;
            source_kind: string;
            source_id: string;
            timestamp_sec: number | null;
        } | null = null;
        if(id) {
            old = await q('SELECT id,source_kind,source_id,timestamp_sec FROM collections WHERE id=? AND owner_id=?', id, owner).first();
            if(!old) {
                const completed = await q(
                    "SELECT result_json FROM operations WHERE actor_id=? AND kind='collection' AND target_id=? AND key=? AND status='done'",
                    owner,
                    id,
                    key
                ).first<{
                    result_json: string;
                }>();
                if(completed) {
                    const result = JSON.parse(completed.result_json) as {
                        id: string;
                        sourceKind: string;
                        sourceId: string;
                        timestampSec: number | null;
                    };
                    if(result.sourceKind && result.sourceId)
                        old = {
                            id,
                            source_kind: result.sourceKind,
                            source_id: result.sourceId,
                            timestamp_sec: result.timestampSec
                        };
                }
                if(!old)
                    throw missing();
            }
        }
        else {
            await activeMember(p);
            if(!['video', 'comment', 'reflection'].includes(String(r.sourceKind)))
                throw new DomainError('INVALID_INPUT', '请选择收藏来源。');
            if (r.sourceKind === 'reflection' && (await getReflection(p, String(r.sourceId))).isAuthor)
                throw new DomainError('INVALID_INPUT', '本人复盘已自动加入成长，无需再次收藏。');
            if(!await resolveSource(p, String(r.sourceKind), String(r.sourceId)))
                throw missing();
            old = await q(
                'SELECT id,source_kind,source_id,timestamp_sec FROM collections WHERE owner_id=? AND source_kind=? AND source_id=?',
                owner,
                r.sourceKind,
                r.sourceId
            ).first();
        }
        if(!id && r.sourceKind === 'video') {
            const video = await getVideo(p, String(r.sourceId));
            seconds(r.timestampSec, video.durationSec);
        }
        const kind = old?.source_kind ?? String(r.sourceKind);
        const source = old?.source_id ?? text(r.sourceId, 80);
        const expected = id ? version(r.expectedVersion) : null;
        let timestamp = old?.timestamp_sec ?? seconds(r.timestampSec);
        if(!id && kind === 'comment') {
            const c = await q('SELECT timestamp_sec FROM video_comments WHERE id=?', source).first<{
                timestamp_sec: number | null;
            }>();
            timestamp = c?.timestamp_sec ?? null;
        }
        const normalized = { kind, source, timestamp, note, expected, action };
        const op = await operation(owner, 'collection', id ?? kind + ':' + source, key, normalized);
        let target = op.replay?.result.id ?? old?.id ?? crypto.randomUUID();
        if(!op.replay) {
            const guards = [
                assertGuard(db, op.opId, 'owner', "EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')", [owner])
            ];
            if(id) {
                guards.push(
                    assertGuard(
                        db,
                        op.opId,
                        'version',
                        'EXISTS(SELECT 1 FROM collections WHERE id=? AND owner_id=? AND version=?)',
                        [id, owner, expected]
                    ),
                    action === 'delete' ? q('DELETE FROM collections WHERE id=? AND owner_id=? AND version=?', id, owner, expected) : q(
                        'UPDATE collections SET private_note=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=?',
                        note,
                        now(),
                        id,
                        owner,
                        expected
                    )
                );
            }
            else if(!old) {
                const c = await activeMember(p);
                guards.push(memberGuard(op, c));
                if(kind === 'video')
                    guards.push(assertGuard(
                        db,
                        op.opId,
                        'source',
                        "EXISTS(SELECT 1 FROM videos v JOIN trainings t ON t.id=v.training_id WHERE v.id=? AND v.team_id=? AND v.status='active' AND t.status IN ('published','archived'))",
                        [source, c.membership.teamId]
                    ));
                else if (kind === 'reflection')
                    guards.push(assertGuard(db, op.opId, 'source', `EXISTS(SELECT 1 FROM reflections r WHERE r.id=? AND r.owner_id!=? AND (${reflectionShared}))`, [source, owner, owner]));
                else
                    guards.push(assertGuard(
                        db,
                        op.opId,
                        'source',
                        "EXISTS(SELECT 1 FROM video_comments c JOIN videos v ON v.id=c.video_id JOIN trainings t ON t.id=v.training_id WHERE c.id=? AND c.team_id=? AND c.status='active' AND v.status='active' AND t.status IN ('published','archived'))",
                        [source, c.membership.teamId]
                    ));
                guards.push(q(
                    'INSERT INTO collections(id,owner_id,source_kind,source_id,timestamp_sec,private_note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                    target,
                    owner,
                    kind,
                    source,
                    timestamp,
                    note,
                    now(),
                    now()
                ));
            }
            if(id)
                guards.push(assertGuard(
                    db,
                    op.opId,
                    'collection-result',
                    action === 'delete' ? 'NOT EXISTS(SELECT 1 FROM collections WHERE id=? AND owner_id=?)' : 'EXISTS(SELECT 1 FROM collections WHERE id=? AND owner_id=? AND version=?)',
                    action === 'delete' ? [target, owner] : [target, owner, expected! + 1]
                ));
            else if(!old)
                guards.push(assertGuard(
                    db,
                    op.opId,
                    'collection-result',
                    'EXISTS(SELECT 1 FROM collections WHERE id=? AND owner_id=? AND version=1)',
                    [target, owner]
                ));
            try {
                target = (await op.commit(guards, { id: target, sourceKind: kind, sourceId: source, timestampSec: timestamp })).result.id!;
            }
            catch(e) {
                if(e instanceof DomainError)
                    throw e;
                throw new DomainError('VERSION_CONFLICT', '收藏已经变化，请刷新后重试。', 409);
            }
        }
        await personal(p);
        // A replay resolves the current owned collection; deleted receipts never recreate it.
        if (action !== 'delete' && !await q('SELECT id FROM collections WHERE id=? AND owner_id=?', target, owner).first()) throw missing();
        return { id: target };
    }
    async function createUpload(p: Principal | null, input: unknown, key: string) {
        if (input && typeof input === 'object' && 'manifest' in input) return resumable.create(p, input, key);
        const c = await activeMember(p, true);
        const r = object(input, ['bytes']);
        if(!Number.isSafeInteger(r.bytes) || Number(r.bytes) <= 0 || Number(r.bytes) > MEDIA_MAX_BYTES)
            throw new DomainError('UPLOAD_LIMIT', `文件太大。当前单个视频最多${MEDIA_MAX_BYTES / 1024 / 1024}MiB，此文件为${Number(r.bytes)}字节。请先压缩文件或裁剪片段，再选择上传。`, 413);
        if(!bucket)
            throw new DomainError('SERVICE_UNAVAILABLE', '私有媒体存储暂不可用。', 503);
        const op = await operation(c.user.id, 'upload-create', c.membership.teamId, key, { bytes: r.bytes });
        let id = op.replay?.result.id ?? crypto.randomUUID();
        if(!op.replay) {
            const used = await q(
                "SELECT coalesce(sum(max(bytes,reserved_bytes)),0) AS n FROM uploads WHERE team_id=? AND status NOT IN ('rejected','cancelled')",
                c.membership.teamId
            ).first<{
                n: number;
            }>();
            if((used?.n ?? 0) + Number(r.bytes) > MEDIA_TEAM_BYTES)
                throw new DomainError('UPLOAD_LIMIT', '队伍剩余容量不足，无法上传这个视频。请选择更小文件或联系管理员处理容量。', 413);
            const committed = await commit(
                op,
                c,
                [
                    assertGuard(
                        db,
                        op.opId,
                        'quota',
                        "(SELECT coalesce(sum(max(bytes,reserved_bytes)),0) FROM uploads WHERE team_id=? AND status NOT IN ('rejected','cancelled'))+?<=?",
                        [c.membership.teamId, r.bytes, MEDIA_TEAM_BYTES]
                    ),
                    q(
                        "INSERT INTO uploads(id,team_id,owner_id,bytes,reserved_bytes,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
                        id,
                        c.membership.teamId,
                        c.user.id,
                        r.bytes,
                        r.bytes,
                        now()
                    )
                ],
                { id },
                true
            );
            id = committed.result.id!;
        }
        await activeMember(p, true);
        if (!await q('SELECT id FROM uploads WHERE id=? AND owner_id=? AND team_id=?', id, c.user.id, c.membership.teamId).first()) throw missing();
        return { id };
    }
    async function listUploads(p: Principal | null, cursor: string | null = null): Promise<UploadPage> {
        const c = await activeMember(p, true);
        let after: { createdAt: string; id: string } | null = null;
        if (cursor) {
            try {
                if (typeof cursor !== 'string' || cursor.length > 512) throw new Error();
                after = JSON.parse(atob(cursor));
                if (!after || typeof after.createdAt !== 'string' || !/^[0-9T:.Z+-]{1,40}$/.test(after.createdAt) || typeof after.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(after.id)) throw new Error();
            } catch { throw new DomainError('INVALID_INPUT', '分页位置不可用，请重新查看本人上传。'); }
        }
        const rows = (await q(
            `SELECT id,bytes,status,protocol_version AS protocol,received_parts AS receivedParts,cleanup_state AS cleanupState,created_at AS createdAt FROM uploads
             WHERE owner_id=? AND team_id=? AND status NOT IN ('cancelled','rejected') AND NOT EXISTS(SELECT 1 FROM videos WHERE upload_id=uploads.id)
             AND (? IS NULL OR created_at<? OR (created_at=? AND id>?)) ORDER BY created_at DESC,id ASC LIMIT 51`,
            c.user.id, c.membership.teamId, after?.createdAt ?? null, after?.createdAt ?? null, after?.createdAt ?? null, after?.id ?? null
        ).all<UploadReservation>()).results;
        const items = rows.slice(0, 50), last = items.at(-1);
        return { items, nextCursor: rows.length > 50 && last ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id })) : null };
    }
    type UploadRow = {
        id: string;
        bytes: number;
        status: string;
        object_key: string | null;
        content_key: string | null;
        mime: string | null;
        duration_sec: number | null;
        version: number;
        cleanup_state: string;
        cleanup_target: string | null;
        cleanup_error: string | null;
        transfer_active: number;
        multipart_id: string | null;
        protocol_version: number;
    };
    async function ownUpload(p: Principal | null, id: string) {
        const c = await activeMember(p, true);
        const u = await q('SELECT * FROM uploads WHERE id=? AND owner_id=? AND team_id=?', id, c.user.id, c.membership.teamId).first<UploadRow>();
        if(!u)
            throw missing();
        if(!bucket)
            throw new DomainError('SERVICE_UNAVAILABLE', '私有媒体存储暂不可用。', 503);
        return { c, u };
    }
    async function beginCleanup(c: Context, id: string, target: 'cancelled' | 'rejected' | 'pending', errorCode: string | null = null) {
        // This is a durable intent, not a successful cancellation. Status keeps its quota until R2 confirms removal.
        await q(
            `UPDATE uploads SET cleanup_target=CASE WHEN cleanup_state='pending' AND cleanup_target!='pending' THEN cleanup_target ELSE ? END,
             cleanup_error=CASE WHEN cleanup_state='pending' AND cleanup_target!='pending' THEN cleanup_error ELSE ? END,
             cleanup_state='pending',version=version+1
             WHERE id=? AND owner_id=? AND status NOT IN ('cancelled','rejected')
             AND NOT EXISTS(SELECT 1 FROM videos WHERE upload_id=uploads.id)`,
            target,
            errorCode,
            id,
            c.user.id
        ).run();
    }
    async function finishCleanup(p: Principal | null, id: string, op: Op) {
        const { c, u } = await ownUpload(p, id);
        if(op.replay) {
            if(!['cancelled', 'rejected'].includes(u.status) || u.cleanup_state !== 'deleted') {
                throw new DomainError('RESULT_UNKNOWN', '清理结果尚未确认，请保留此条目并重试。', 503, true);
            }
            return { id };
        }
        if(u.cleanup_state !== 'pending' || !u.cleanup_target) {
            throw new DomainError('VERSION_CONFLICT', '上传状态已变化，请刷新后重试。', 409);
        }
        if(u.cleanup_error === 'MULTIPART_UNCONFIRMED' && !u.multipart_id) {
            throw new DomainError('CLEANUP_PENDING', '文件清理结果尚未确认，空间仍保留。请联系管理员处理。', 503, true);
        }
        if(u.transfer_active) {
            throw new DomainError('CLEANUP_PENDING', '文件接收尚未结束，空间仍保留。请稍后重试清理。', 503, true);
        }
        try {
            if(u.object_key) {
                if(u.multipart_id) {
                    try {
                        await bucket!.resumeMultipartUpload(u.object_key, u.multipart_id).abort();
                    }
                    catch(error) {
                        // R2 returns NoSuchUpload once an upload has completed or was already aborted.
                        if(!/NoSuchUpload|does not exist|not found|10024/i.test(String(error)))
                            throw error;
                    }
                }
                await bucket!.delete(u.object_key);
                if(await bucket!.head(u.object_key))
                    throw new Error('Object still present after delete');
            }
        }
        catch {
            throw new DomainError('CLEANUP_PENDING', '文件尚未确认清理，仍计入空间。可在未挂载上传中重试。', 503, true);
        }
        const target = u.cleanup_target;
        const reset = target === 'pending';
        const finalObject = reset ? null : u.object_key;
        const finalState = reset ? 'none' : 'deleted';
        await commit(
            op,
            c,
            [
                assertGuard(
                    db,
                    op.opId,
                    'cleanup-before',
                    `EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND version=?
                 AND cleanup_state='pending' AND cleanup_target=? AND transfer_active=0 AND object_key IS ?)
                 AND NOT EXISTS(SELECT 1 FROM videos WHERE upload_id=?)`,
                    [id, c.user.id, u.version, target, u.object_key, id]
                ),
                q(
                    `UPDATE uploads SET status=?,cleanup_state=?,object_key=?,
               multipart_id=CASE WHEN ? THEN NULL ELSE multipart_id END,
               content_key=CASE WHEN ? THEN NULL ELSE content_key END,
               cleanup_target=CASE WHEN ? THEN NULL ELSE cleanup_target END,version=version+1
               WHERE id=? AND owner_id=? AND version=? AND cleanup_state='pending' AND transfer_active=0`,
                    target,
                    finalState,
                    finalObject,
                    reset ? 1 : 0,
                    reset ? 1 : 0,
                    reset ? 1 : 0,
                    id,
                    c.user.id,
                    u.version
                ),
                assertGuard(
                    db,
                    op.opId,
                    'cleanup-after',
                    `EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND status=? AND cleanup_state=?
                 AND object_key IS ? AND version=? AND transfer_active=0)`,
                    [id, c.user.id, target, finalState, finalObject, u.version + 1]
                ),
            ],
            { id },
            true
        );
        return { id };
    }
    async function readUploadPart(stream: ReadableStream<Uint8Array> | null, expected: number) {
        if (!stream || expected <= 0 || expected > MEDIA_PART_BYTES) throw new DomainError('INVALID_INPUT', '需要有效的文件分块。');
        const result = new Uint8Array(expected);
        const reader = stream.getReader();
        let count = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (chunk.value.byteLength > expected - count) throw new DomainError('UPLOAD_LIMIT', '文件大小与上传申请不符。', 413);
                result.set(chunk.value, count);
                count += chunk.value.byteLength;
            }
            if (count !== expected) throw new DomainError('UPLOAD_LIMIT', '文件大小与上传申请不符。', 413);
            return result;
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    async function putUploadPart(p: Principal | null, id: string, stream: ReadableStream<Uint8Array> | null, key: string, partNumber: number) {
        const { c, u } = await ownUpload(p, id);
        if (u.protocol_version === 2) return resumable.part(p, id, stream, key, partNumber);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > Math.ceil(u.bytes / MEDIA_PART_BYTES))
            throw new DomainError('INVALID_INPUT', '需要有效的文件分块和请求标识。');
        if (u.cleanup_state !== 'none' || ['cancelled', 'rejected'].includes(u.status)) throw new DomainError('CLEANUP_PENDING', '此上传等待清理，请先重试清理。', 503, true);
        if (u.content_key && u.content_key !== key) throw new DomainError('IDEMPOTENCY_CONFLICT', '此上传已经绑定文件请求。', 409);
        const expected = Math.min(MEDIA_PART_BYTES, u.bytes - (partNumber - 1) * MEDIA_PART_BYTES);
        const bytes = await readUploadPart(stream, expected);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
        // The object generation is immutable during this multipart session. Reset cleanup creates a new generation.
        const objectKey = u.object_key ?? ('quarantine/' + id + '/' + crypto.randomUUID());
        const kind = 'upload-part-' + objectKey.split('/').at(-1);
        const op = await operation(c.user.id, kind, id, String(partNumber), { key, partNumber, digest, bytes: expected });
        if (op.replay) {
            const current = await ownUpload(p, id);
            if (current.u.object_key !== objectKey || current.u.cleanup_state !== 'none' || !['receiving', 'received', 'ready'].includes(current.u.status))
                throw new DomainError('UPLOAD_BUSY', '上传状态已变化。', 409);
            return { id, partNumber };
        }
        if (!['pending', 'receiving'].includes(u.status) || u.transfer_active) throw new DomainError('UPLOAD_BUSY', '上传正在处理。', 409);
        const previous = partNumber === 1 ? true : !!await q("SELECT id FROM operations WHERE actor_id=? AND kind=? AND target_id=? AND key=? AND status='done'", c.user.id, kind, id, String(partNumber - 1)).first();
        if (!previous)
            throw new DomainError('UPLOAD_INCOMPLETE', '请按顺序完成文件分块。', 409);
        const claim = await q(`UPDATE uploads SET status='receiving',object_key=?,content_key=?,transfer_active=1,version=version+1
            WHERE id=? AND owner_id=? AND version=? AND status IN ('pending','receiving') AND cleanup_state='none' AND transfer_active=0
            AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.status='active' AND m.role='admin' AND m.epoch=? AND u.status='active')`,
            objectKey, key, id, c.user.id, u.version, c.membership.id, c.membership.epoch).run();
        if (!claim.meta.changes) throw new DomainError('UPLOAD_BUSY', '上传正在处理或权限已变化。', 409);
        const leaseVersion = u.version + 1;
        let multipartId = u.multipart_id;
        let multipart: R2MultipartUpload | undefined;
        let recordedMultipart = !!u.multipart_id;
        try {
            multipart = multipartId ? bucket!.resumeMultipartUpload(objectKey, multipartId) : await bucket!.createMultipartUpload(objectKey);
            multipartId = multipart.uploadId;
            if (!recordedMultipart) {
                const recorded = await q('UPDATE uploads SET multipart_id=? WHERE id=? AND object_key=? AND transfer_active=1', multipartId, id, objectKey).run();
                if (!recorded.meta.changes) throw new DomainError('CLEANUP_PENDING', '接收状态未能确认，请重试清理。', 503, true);
                recordedMultipart = true;
            }
            const part = await multipart.uploadPart(partNumber, bytes);
            if (part.partNumber !== partNumber || !part.etag) throw new Error('Missing R2 part receipt');
            await commit(op, c, [
                assertGuard(db, op.opId, 'part-before', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND object_key=? AND version=? AND status='receiving' AND cleanup_state='none' AND transfer_active=1)", [id, objectKey, leaseVersion]),
                q("UPDATE uploads SET transfer_active=0,version=version+1 WHERE id=? AND object_key=? AND version=? AND cleanup_state='none' AND transfer_active=1", id, objectKey, leaseVersion),
                assertGuard(db, op.opId, 'part-after', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND object_key=? AND version=? AND cleanup_state='none' AND transfer_active=0)", [id, objectKey, leaseVersion + 1]),
            ], { id, partNumber, etag: part.etag, digest }, true);
            return { id, partNumber };
        } catch (error) {
            if (multipart && !recordedMultipart) {
                // Compensate creation if its ID could not be durably recorded. Never free
                // quota on an unconfirmed abort: persist a cleanup tombstone first.
                try { await multipart.abort(); }
                catch {
                    try { await q('UPDATE uploads SET multipart_id=coalesce(multipart_id,?) WHERE id=? AND object_key=?', multipartId, id, objectKey).run(); } catch { /* Keep the lease if the following durable tombstone also fails. */ }
                    await q("UPDATE uploads SET cleanup_state='pending',cleanup_target='cancelled',cleanup_error='MULTIPART_UNCONFIRMED',version=version+1 WHERE id=? AND object_key=?", id, objectKey).run();
                }
            }
            // Only release this lease, or its cancellation tombstone; never a newer request's lease.
            await q("UPDATE uploads SET transfer_active=0 WHERE id=? AND object_key=? AND transfer_active=1 AND (version=? OR cleanup_state='pending')", id, objectKey, leaseVersion).run();
            if (error instanceof DomainError) throw error;
            throw new DomainError('UPLOAD_FAILED', '连接中断，暂时无法确认上传是否完成。请确认状态后重试。', 503, true);
        }
    }
    async function finishParts(id: string, c: Context, u: UploadRow) {
        if (u.status !== 'receiving' || !u.object_key || !u.multipart_id || u.cleanup_state !== 'none' || u.transfer_active)
            throw new DomainError('UPLOAD_BUSY', '上传正在处理或尚未完成，请稍后重试。', 409);
        const kind = 'upload-part-' + u.object_key.split('/').at(-1);
        const records = await q("SELECT result_json FROM operations WHERE actor_id=? AND kind=? AND target_id=? AND status='done' ORDER BY CAST(key AS INTEGER) LIMIT 1024", c.user.id, kind, id).all<{ result_json: string }>();
        const expected = Math.ceil(u.bytes / MEDIA_PART_BYTES);
        const parts: R2UploadedPart[] = records.results.map((row, i) => {
            const result = JSON.parse(row.result_json) as StoredResult;
            if (result.partNumber !== i + 1 || !result.etag || !result.digest) throw new DomainError('UPLOAD_INCOMPLETE', '请先完成文件传输。', 409);
            return { partNumber: result.partNumber, etag: result.etag };
        });
        if (parts.length !== expected) throw new DomainError('UPLOAD_INCOMPLETE', '请先完成文件传输。', 409);
        const claim = await q(`UPDATE uploads SET transfer_active=1,version=version+1 WHERE id=? AND version=? AND object_key=? AND status='receiving' AND cleanup_state='none' AND transfer_active=0
            AND EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=? AND m.status='active' AND m.role='admin' AND m.epoch=? AND u.status='active')`,
            id, u.version, u.object_key, c.membership.id, c.membership.epoch).run();
        if (!claim.meta.changes) throw new DomainError('UPLOAD_BUSY', '上传状态已变化。', 409);
        const leaseVersion = u.version + 1;
        try {
            // Reconcile an R2 completion whose response was lost, only at this server-owned immutable key.
            let stored = await bucket!.head(u.object_key);
            if (!stored) stored = await bucket!.resumeMultipartUpload(u.object_key, u.multipart_id).complete(parts);
            if (stored.size !== u.bytes) throw new DomainError('UPLOAD_INCOMPLETE', '文件大小与上传申请不符。', 409);
            const op = await operation(c.user.id, 'upload-received', id, u.object_key.split('/').at(-1)!, {});
            await commit(op, c, [
                assertGuard(db, op.opId, 'receive-before', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND version=? AND object_key=? AND status='receiving' AND cleanup_state='none' AND transfer_active=1)", [id, leaseVersion, u.object_key]),
                q("UPDATE uploads SET status='received',transfer_active=0,version=version+1 WHERE id=? AND version=? AND object_key=? AND cleanup_state='none' AND transfer_active=1", id, leaseVersion, u.object_key),
                assertGuard(db, op.opId, 'receive-after', "EXISTS(SELECT 1 FROM uploads WHERE id=? AND version=? AND object_key=? AND status='received' AND cleanup_state='none' AND transfer_active=0)", [id, leaseVersion + 1, u.object_key]),
            ], { id }, true);
        } catch (error) {
            await q("UPDATE uploads SET transfer_active=0 WHERE id=? AND object_key=? AND transfer_active=1 AND (version=? OR cleanup_state='pending')", id, u.object_key, leaseVersion).run();
            if (error instanceof DomainError) throw error;
            throw new DomainError('RESULT_UNKNOWN', '暂时无法确认上传是否完成，请重试确认。', 503, true);
        }
    }
    async function putUpload(p: Principal | null, id: string, stream: ReadableStream<Uint8Array> | null, key: string) {
        const { c, u } = await ownUpload(p, id);
        if (u.protocol_version === 2) throw new DomainError('INVALID_INPUT', '请使用已绑定的分块上传。');
        if (u.bytes > MEDIA_PART_BYTES) throw new DomainError('UPLOAD_LIMIT', '请使用分块上传。', 413);
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(key) || !stream) {
            throw new DomainError('INVALID_INPUT', '需要有效的文件和请求标识。');
        }
        if(u.cleanup_state === 'pending') {
            throw new DomainError('CLEANUP_PENDING', '此上传等待清理，请先重试清理。', 503, true);
        }
        if(['received', 'ready'].includes(u.status)) {
            if(u.content_key !== key)
                throw new DomainError('IDEMPOTENCY_CONFLICT', '此上传已经收到文件。', 409);
            const existing = u.object_key ? await bucket!.get(u.object_key) : null;
            if(!existing)
                throw new DomainError('UPLOAD_INCOMPLETE', '文件暂不可用。', 409);
            if (existing.size !== u.bytes) {
                await existing.body.cancel();
                throw new DomainError('UPLOAD_INCOMPLETE', '文件暂不可用。', 409);
            }
            let incoming: Uint8Array;
            try { incoming = await readUploadPart(stream, u.bytes); }
            catch (error) {
                await existing.body.cancel();
                if (error instanceof DomainError && error.code === 'UPLOAD_LIMIT') throw new DomainError('IDEMPOTENCY_CONFLICT', '同一上传请求的文件内容不能改变。', 409);
                throw error;
            }
            const original = new Uint8Array(await existing.arrayBuffer());
            if(original.length !== u.bytes || incoming.some((b, i) => b !== original[i])) {
                throw new DomainError('IDEMPOTENCY_CONFLICT', '同一上传请求的文件内容不能改变。', 409);
            }
            const current = await ownUpload(p, id);
            if (current.u.version !== u.version || current.u.cleanup_state !== 'none') throw new DomainError('UPLOAD_BUSY', '上传状态已变化。', 409);
            return { id };
        }
        if(u.status !== 'pending')
            throw new DomainError('UPLOAD_BUSY', '此上传正在处理或已取消，请取消后重新选择文件。', 409);
        const lease = crypto.randomUUID();
        const objectKey = 'quarantine/' + id + '/' + lease;
        const claim = await q(
            `UPDATE uploads SET status='receiving',object_key=?,content_key=?,transfer_active=1,version=version+1
             WHERE id=? AND owner_id=? AND status='pending' AND cleanup_state='none'
             AND EXISTS(SELECT 1 FROM memberships WHERE id=? AND status='active' AND role='admin' AND epoch=?)`,
            objectKey,
            key,
            id,
            c.user.id,
            c.membership.id,
            c.membership.epoch
        ).run();
        if(!claim.meta.changes)
            throw new DomainError('UPLOAD_BUSY', '上传正在处理。', 409);
        let count = 0;
        const reader = stream.getReader();
        let multipart: R2MultipartUpload | undefined;
        try {
            multipart = await bucket!.createMultipartUpload(objectKey);
            const recorded = await q('UPDATE uploads SET multipart_id=? WHERE id=? AND object_key=? AND transfer_active=1', multipart.uploadId, id, objectKey).run();
            if(!recorded.meta.changes)
                throw new DomainError('CLEANUP_PENDING', '接收状态未能确认，请重试清理。', 503, true);
            const parts: R2UploadedPart[] = [];
            let buffer = new Uint8Array(5 * 1024 * 1024);
            let filled = 0;
            while(true) {
                const chunk = await reader.read();
                if(chunk.done)
                    break;
                count += chunk.value.byteLength;
                if(count > u.bytes || count > MEDIA_PART_BYTES)
                    throw new DomainError('UPLOAD_LIMIT', '文件超过申请大小或分块上限。', 413);
                let offset = 0;
                while(offset < chunk.value.byteLength) {
                    const n = Math.min(buffer.length - filled, chunk.value.byteLength - offset);
                    buffer.set(chunk.value.subarray(offset, offset + n), filled);
                    filled += n;
                    offset += n;
                    if(filled === buffer.length) {
                        parts.push(await multipart.uploadPart(parts.length + 1, buffer));
                        buffer = new Uint8Array(5 * 1024 * 1024);
                        filled = 0;
                    }
                }
            }
            if(count !== u.bytes)
                throw new DomainError('UPLOAD_LIMIT', '文件大小与上传申请不符。', 413);
            if(filled)
                parts.push(await multipart.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
            await multipart.complete(parts);
            const saved = await q(
                `UPDATE uploads SET status='received',transfer_active=0,version=version+1
                 WHERE id=? AND object_key=? AND status='receiving' AND cleanup_state='none'
                 AND EXISTS(SELECT 1 FROM memberships WHERE id=? AND status='active' AND role='admin' AND epoch=?)`,
                id,
                objectKey,
                c.membership.id,
                c.membership.epoch
            ).run();
            if(!saved.meta.changes)
                throw new DomainError('UPLOAD_BUSY', '上传已取消或权限变化，正在清理。', 409);
            return { id };
        }
        catch(error) {
            await reader.cancel().catch(() => {
            });
            // No future part/complete calls are issued after this point. Cleanup persists the multipart ID.
            await q(
                'UPDATE uploads SET transfer_active=0,multipart_id=coalesce(?,multipart_id) WHERE id=? AND object_key=?',
                multipart?.uploadId ?? null,
                id,
                objectKey
            ).run();
            await beginCleanup(c, id, 'pending');
            const cleanup = await operation(c.user.id, 'upload-abort', id, lease, {});
            await finishCleanup(p, id, cleanup);
            if(error instanceof DomainError)
                throw error;
            if(count !== u.bytes || count > MEDIA_PART_BYTES)
                throw new DomainError('UPLOAD_LIMIT', '文件大小与上传申请不符。', 413);
            throw new DomainError('UPLOAD_FAILED', '上传未完成，请保留文件后重试。', 503, true);
        }
    }
    function mediaFailure(code: string | null) {
        if (code === 'UNSUPPORTED_CODEC') return new DomainError('UNSUPPORTED_CODEC', '已识别这个视频，但当前上传暂不支持它的编码。', 415);
        return code === 'UPLOAD_LIMIT'
            ? new DomainError('UPLOAD_LIMIT', `视频太长。当前最多${MEDIA_MAX_SECONDS / 60}分钟，请先裁剪为较短片段，再选择上传。`, 413)
            : new DomainError('UNSUPPORTED_MEDIA', '文件未通过格式验证，已拒绝。', 415);
    }
    async function completeUpload(p: Principal | null, id: string, key: string) {
        let { c, u } = await ownUpload(p, id);
        if (u.protocol_version === 2) return resumable.complete(p, id, key);
        if (u.status === 'receiving' && u.cleanup_state === 'none') {
            await finishParts(id, c, u);
            ({ c, u } = await ownUpload(p, id));
        }
        const op = await operation(c.user.id, 'upload-complete', id, key, {});
        if(op.replay || u.status === 'ready') {
            if(u.status !== 'ready' || u.cleanup_state !== 'none')
                throw new DomainError('UPLOAD_INCOMPLETE', '上传已取消或等待清理。', 409);
            return { id, mime: u.mime, durationSec: u.duration_sec };
        }
        if(u.cleanup_state === 'pending' && u.cleanup_target === 'rejected') {
            const cleanup = await operation(c.user.id, 'upload-reject', id, 'validation', {});
            await finishCleanup(p, id, cleanup);
            throw mediaFailure(u.cleanup_error);
        }
        if(u.status === 'rejected')
            throw mediaFailure(u.cleanup_error);
        if(u.status !== 'received' || !u.object_key || u.cleanup_state !== 'none')
            throw new DomainError('UPLOAD_INCOMPLETE', '请先完成文件传输或清理。', 409);
        const file = await bucket!.head(u.object_key);
        if(!file || file.size !== u.bytes)
            throw new DomainError('UPLOAD_INCOMPLETE', '文件未完整收到，请重新上传。', 409);
        let media;
        try {
            const objectKey = u.object_key;
            media = await inspectMP4Ranges(file.size, async (offset, length) => {
                const range = await bucket!.get(objectKey, { range: { offset, length } });
                if (!range) throw new DomainError('VERSION_CONFLICT', '文件状态已变化，请确认上传状态后重试。', 409);
                return range.arrayBuffer();
            });
        }
        catch(error) {
            if (!(error instanceof DomainError)) throw new DomainError('RESULT_UNKNOWN', '暂时无法确认上传是否完成，请重试确认。', 503, true);
            if (!['UNSUPPORTED_MEDIA', 'UNSUPPORTED_CODEC', 'UPLOAD_LIMIT'].includes(error.code)) throw error;
            await beginCleanup(c, id, 'rejected', error.code);
            const cleanup = await operation(c.user.id, 'upload-reject', id, 'validation', {});
            await finishCleanup(p, id, cleanup);
            throw error;
        }
        await commit(
            op,
            c,
            [
                assertGuard(
                    db,
                    op.opId,
                    'received',
                    "EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND version=? AND status='received' AND object_key=? AND cleanup_state='none' AND transfer_active=0)",
                    [id, c.user.id, u.version, u.object_key]
                ),
                q(
                    "UPDATE uploads SET status='ready',mime=?,duration_sec=?,version=version+1 WHERE id=? AND version=? AND status='received' AND cleanup_state='none'",
                    media.mime,
                    media.durationSec,
                    id,
                    u.version
                ),
                assertGuard(
                    db,
                    op.opId,
                    'ready',
                    "EXISTS(SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND status='ready' AND object_key=? AND version=? AND mime=? AND duration_sec=? AND cleanup_state='none' AND transfer_active=0)",
                    [id, c.user.id, u.object_key, u.version + 1, media.mime, media.durationSec]
                ),
            ],
            { id },
            true
        );
        return { id, ...media };
    }
    async function cancelUpload(p: Principal | null, id: string, key: string) {
        const { c, u } = await ownUpload(p, id);
        if (u.protocol_version === 2) return resumable.cancel(p, id, key);
        const op = await operation(c.user.id, 'upload-cancel', id, key, {});
        if(op.replay)
            return finishCleanup(p, id, op);
        if(['cancelled', 'rejected'].includes(u.status) && u.cleanup_state === 'deleted') {
            // A second cancellation key is harmless but still gets a guarded operation receipt.
            await commit(
                op,
                c,
                [
                    assertGuard(
                        db,
                        op.opId,
                        'already-clean',
                        "EXISTS(SELECT 1 FROM uploads WHERE id=? AND status IN ('cancelled','rejected') AND cleanup_state='deleted' AND transfer_active=0)",
                        [id]
                    )
                ],
                { id },
                true
            );
            return { id };
        }
        await beginCleanup(c, id, 'cancelled');
        return finishCleanup(p, id, op);
    }
    async function getMedia(p: Principal | null, videoId: string, range: string | null) {
        const v = await getVideo(p, videoId);
        if(v.source !== 'upload')
            throw missing();
        const row = await q(
            "SELECT u.object_key,u.bytes,u.mime FROM videos v JOIN uploads u ON u.id=v.upload_id WHERE v.id=? AND u.status='ready' AND u.cleanup_state='none' AND u.transfer_active=0 AND u.team_id=v.team_id",
            videoId
        ).first<{
            object_key: string;
            bytes: number;
            mime: string;
        }>();
        if(!row || !bucket)
            throw missing();
        const headers: Record<string, string> = {
            'Cache-Control': 'private, no-store, max-age=0',
            'Vary': 'Cookie, oai-authenticated-user-id',
            'X-Content-Type-Options': 'nosniff',
            'Content-Type': row.mime,
            'Accept-Ranges': 'bytes'
        };
        let start = 0;
        let end = row.bytes - 1;
        if(range) {
            const match = range.match(/^bytes=(\d*)-(\d*)$/);
            if(!match || (!match[1] && !match[2]))
                return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${row.bytes}` } });
            if(!match[1]) {
                const n = Number(match[2]);
                start = Math.max(0, row.bytes - n);
                if(!n)
                    start = row.bytes;
            }
            else {
                start = Number(match[1]);
                if(match[2])
                    end = Math.min(end, Number(match[2]));
            }
            if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= row.bytes)
                return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${row.bytes}` } });
        }
        const file = await bucket.get(row.object_key, { range: { offset: start, length: end - start + 1 } });
        if(!file)
            throw missing();
        headers['Content-Length'] = String(end - start + 1);
        if(range)
            headers['Content-Range'] = `bytes ${start}-${end}/${row.bytes}`;
        return new Response(file.body, { status: range ? 206 : 200, headers });
    }
    return {
        listTrainings,
        getTraining,
        saveTraining,
        getVideo,
        addVideo,
        updateVideo,
        listComments,
        saveComment,
        moderateComment,
        listCollections,
        getCollectionReflectionSeed,
        saveCollection,
        createUpload,
        getUpload: resumable.get,
        getUploadPolicy: async (p: Principal | null) => { await activeMember(p, true); return resumable.policy; },
        listUploads,
        putUpload,
        putUploadPart,
        completeUpload,
        cancelUpload,
        getMedia
    };
}
