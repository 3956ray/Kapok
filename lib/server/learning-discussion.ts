import { referenceTimes } from './workspace-material-details.ts';
import type { Principal } from '../contracts/index';
import {
    learningCommentReasonLimit, learningCommentTextLimit, type LearningComment, type LearningCommentStatus,
} from '../contracts/learning-social.ts';
import { assertGuard, DomainError, type StoredResult } from './domain.ts';
import {
    bindLearningMember, learningConflict, learningMemberFence, learningMemberGuard, learningMissing, learningObject,
    learningPostVisible, type LearningContext, type LearningDependencies, type LearningOp,
} from './learning.ts';

const publicSource = `FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
    WHERE lp.id=? AND lp.team_id=? AND ${learningPostVisible}`;
const validTarget = `FROM learning_comments target JOIN learning_comments root ON root.id=COALESCE(target.root_id,target.id)
    AND root.post_id=target.post_id AND root.team_id=target.team_id AND root.root_id IS NULL AND root.status='active'
    WHERE target.id=? AND target.post_id=? AND target.team_id=? AND target.status='active'`;
const discussionMissing = () => new DomainError('NOT_FOUND', '这条讨论已不可用。', 404);
const invalid = (message: string) => new DomainError('INVALID_INPUT', message);
const forbidden = () => new DomainError('FORBIDDEN', '操作的账号权限已变化，或无权操作此讨论。', 403);

function text(value: unknown, max: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(`内容需为1–${max}字。`);
    return value.trim();
}

function expectedVersion(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid('请重新加载后操作。');
    return Number(value);
}

type Source = { version: number; kind: string; video_url: string | null };
type CommentRow = Omit<LearningComment, 'author' | 'replyTarget' | 'matchesCurrentMedia' | 'edited'> & {
    authorId: string; authorName: string; jerseyNumber: string; replyAuthorName: string | null; edited: number;
};

export function createLearningDiscussion({ db, clock, activeMember, operation }: Pick<LearningDependencies, 'db' | 'clock' | 'activeMember' | 'operation'>) {
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);

    async function source(c: LearningContext, postId: string) {
        const member = learningMemberFence(c);
        const row = await q(`SELECT lpub.version,lpub.kind,lpub.video_url ${publicSource} AND ${member.sql}`,
            postId, c.membership.teamId, ...member.values).first<Source>();
        if (!row) throw learningMissing();
        return row;
    }

    async function listLearningComments(p: Principal | null, postId: string): Promise<LearningComment[]> {
        const c = await bindLearningMember(activeMember, p);
        const member = learningMemberFence(c);
        const { results } = await q(`SELECT lc.id,lp.id AS postId,lc.root_id AS rootId,lc.reply_to_id AS replyToId,
            lc.author_id AS authorId,author.disc_name AS authorName,author.jersey_number AS jerseyNumber,
            recipient.disc_name AS replyAuthorName,
            CASE WHEN lc.status='active' THEN lc.text END AS text,
            CASE WHEN lc.status='active' THEN lc.reference_times END AS referenceTimes, CASE WHEN lc.status='active' THEN lc.timestamp_sec END AS timestampSec,
            CASE WHEN lc.status='active' AND lpub.kind='video' AND lc.media_url=lpub.video_url THEN lc.media_url END AS mediaUrl,
            lc.status,lc.version,lc.created_at AS createdAt,lc.edited
            FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
            LEFT JOIN learning_comments lc ON lc.post_id=lp.id AND lc.team_id=lp.team_id
            LEFT JOIN profiles author ON author.user_id=lc.author_id
            LEFT JOIN learning_comments root ON root.id=lc.root_id AND root.post_id=lc.post_id AND root.team_id=lc.team_id
                AND root.root_id IS NULL AND root.status='active'
            LEFT JOIN learning_comments target ON target.id=lc.reply_to_id AND target.post_id=lc.post_id AND target.team_id=lc.team_id
                AND target.status='active' AND COALESCE(target.root_id,target.id)=root.id
            LEFT JOIN profiles recipient ON recipient.user_id=target.author_id
            WHERE lp.id=? AND lp.team_id=? AND ${learningPostVisible} AND ${member.sql}
            ORDER BY lc.created_at,lc.id`, postId, c.membership.teamId, ...member.values).all<CommentRow>();
        if (!results.length) throw learningMissing();
        return results.filter(row => row.id).map(({ authorId, authorName, jerseyNumber, replyAuthorName, edited, ...comment }) => ({
            ...comment, author: { id: authorId, discName: authorName, jerseyNumber },
            replyTarget: comment.replyToId && replyAuthorName ? { id: comment.replyToId, authorName: replyAuthorName } : null,
            edited: !!edited, matchesCurrentMedia: comment.mediaUrl !== null,
        }));
    }

    function sourceGuard(op: LearningOp, c: LearningContext, postId: string, version: number, phase: string) {
        return assertGuard(db, op.opId, phase, `EXISTS(SELECT 1 ${publicSource} AND lpub.version=?)`,
            [postId, c.membership.teamId, version]);
    }

    async function commit(op: LearningOp, c: LearningContext, postId: string, version: number, writes: D1PreparedStatement[], id: string) {
        try {
            return (await op.commit([
                learningMemberGuard(db, op, c, 'before'), sourceGuard(op, c, postId, version, 'before-source'),
                ...writes,
                learningMemberGuard(db, op, c, 'after'), sourceGuard(op, c, postId, version, 'after-source'),
            ], { id, membershipId: c.membership.id, membershipEpoch: c.membership.epoch })).result;
        } catch (error) {
            if (error instanceof DomainError) throw error;
            if (/CHECK constraint failed:\s*write_guard_pass\b/i.test(String(error))) throw learningConflict();
            // The commit can succeed even when its response and the recovery lookup both fail.
            throw new DomainError('RESULT_UNKNOWN', '尚未确认讨论操作结果，请保留内容并使用同一请求重试。', 503, true);
        }
    }

    async function receipt(c: LearningContext, postId: string, result: StoredResult) {
        await source(c, postId);
        if (result.membershipId !== c.membership.id || result.membershipEpoch !== c.membership.epoch) throw forbidden();
        return { id: result.id! };
    }

    async function saveLearningComment(p: Principal | null, postId: string, id: string | null, input: unknown, key: string) {
        const c = await bindLearningMember(activeMember, p);
        const post = await source(c, postId);
        const raw = learningObject(input, id
            ? ['text', 'referenceTimes', 'timestampSec', 'mediaUrl', 'expectedVersion', 'action']
            : ['text', 'referenceTimes', 'timestampSec', 'mediaUrl', 'rootId', 'replyToId']);
        if (raw.action !== undefined && raw.action !== 'save' && raw.action !== 'delete') throw invalid('请检查讨论操作。');
        const deleting = raw.action === 'delete';
        if (deleting && (raw.text !== undefined || raw.timestampSec !== undefined || raw.mediaUrl !== undefined)) throw invalid('请检查删除内容。');
        const times = referenceTimes(raw.referenceTimes,raw.timestampSec);
        const bodyText = deleting || (times && raw.text === '') ? '' : text(raw.text, learningCommentTextLimit);
        const expected = id ? expectedVersion(raw.expectedVersion) : null;
        const claimedRoot = raw.rootId == null ? null : text(raw.rootId, 80);
        const replyToId = raw.replyToId == null ? claimedRoot : text(raw.replyToId, 80);
        const timestampSec = raw.timestampSec == null ? null : Number(raw.timestampSec);
        if (timestampSec !== null && (!Number.isSafeInteger(raw.timestampSec) || timestampSec < 0))
            throw invalid('请输入有效的非负整数秒数。');
        const mediaUrl = timestampSec !== null ? text(raw.mediaUrl, 2048) : null;
        if (timestampSec === null && raw.mediaUrl != null) throw invalid('请先填写视频时刻。');
        const op = await operation(c.user.id, 'learning-comment', id ? postId + '/' + id : postId, key,
            { bodyText, ...(times ? {times} : {}), timestampSec, mediaUrl, claimedRoot, replyToId, deleting, expected });
        if (op.replay) return receipt(c, postId, op.replay.result);
        if (timestampSec !== null && post.kind !== 'video') throw invalid('图文讨论不能附视频时刻。');
        if (timestampSec !== null && mediaUrl !== post.video_url) throw learningConflict();

        const writes: D1PreparedStatement[] = [];
        const now = clock().toISOString();
        const team = c.membership.teamId;
        const commentId = id ?? crypto.randomUUID();
        if (id) {
            const current = await q('SELECT author_id,status,version FROM learning_comments WHERE id=? AND post_id=? AND team_id=?',
                id, postId, team).first<{ author_id: string; status: LearningCommentStatus; version: number }>();
            if (!current || current.status === 'deleted') throw discussionMissing();
            if (current.author_id !== c.user.id) throw forbidden();
            if (current.version !== expected) throw learningConflict();
            if (!deleting && current.status !== 'active') throw discussionMissing();
            writes.push(
                assertGuard(db, op.opId, 'comment-version', `EXISTS(SELECT 1 FROM learning_comments
                    WHERE id=? AND post_id=? AND team_id=? AND author_id=? AND version=? AND status=?)`,
                [id, postId, team, c.user.id, expected, current.status]),
                q(`UPDATE learning_comments SET text=?,timestamp_sec=?,reference_times=?,media_url=?,status=?,edited=1,version=version+1,updated_at=? WHERE id=?`,
                    bodyText, timestampSec, times ?? null, mediaUrl, deleting ? 'deleted' : 'active', now, id),
            );
        } else {
            let rootId = null;
            if (replyToId) {
                const root = await q(`SELECT root.id ${validTarget}`, replyToId, postId, team).first<{ id: string }>();
                if (!root || (claimedRoot !== null && claimedRoot !== root.id)) throw invalid('回复对象必须属于同一份资料的有效讨论串。');
                rootId = root.id;
                writes.push(assertGuard(db, op.opId, 'reply-target', `EXISTS(SELECT 1 ${validTarget} AND root.id=?)`,
                    [replyToId, postId, team, rootId]));
            }
            writes.push(q(`INSERT INTO learning_comments(id,post_id,team_id,author_id,root_id,reply_to_id,text,timestamp_sec,reference_times,media_url,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, commentId, postId, team, c.user.id, rootId, replyToId, bodyText, timestampSec, times ?? null, mediaUrl, now, now));
        }
        return receipt(c, postId, await commit(op, c, postId, post.version, writes, commentId));
    }

    async function moderateLearningComment(p: Principal | null, postId: string, id: string, input: unknown, key: string) {
        const raw = learningObject(input, ['action', 'reason', 'expectedVersion']);
        const { action } = raw;
        if (action !== 'report' && action !== 'hide' && action !== 'restore') throw invalid('请检查治理操作。');
        const reason = text(raw.reason, learningCommentReasonLimit);
        const expected = expectedVersion(raw.expectedVersion);
        const c = await bindLearningMember(activeMember, p, action !== 'report');
        const post = await source(c, postId);
        const op = await operation(c.user.id, 'learning-comment-' + action, postId + '/' + id, key, { action, reason, expected });
        if (op.replay) return receipt(c, postId, op.replay.result);
        const status = action === 'restore' ? 'hidden' : 'active';
        const scope = [id, postId, c.membership.teamId];
        const current = await q('SELECT status,version FROM learning_comments WHERE id=? AND post_id=? AND team_id=?',
            ...scope).first<{ status: LearningCommentStatus; version: number }>();
        if (!current || current.status === 'deleted') throw discussionMissing();
        if (current.version !== expected) throw learningConflict();
        if (current.status !== status) throw discussionMissing();
        const now = clock().toISOString();
        const writes = [
            assertGuard(db, op.opId, 'comment-version', `EXISTS(SELECT 1 FROM learning_comments
                WHERE id=? AND post_id=? AND team_id=? AND version=? AND status=?)`, [...scope, expected, status]),
            q('INSERT INTO learning_comment_moderation(id,comment_id,actor_id,action,reason,created_at) VALUES(?,?,?,?,?,?)',
                op.opId, id, c.user.id, action, reason, now),
        ];
        if (action !== 'report') writes.push(q('UPDATE learning_comments SET status=?,version=version+1,updated_at=? WHERE id=?',
            action === 'hide' ? 'hidden' : 'active', now, id));
        return receipt(c, postId, await commit(op, c, postId, post.version, writes, id));
    }

    return { listLearningComments, saveLearningComment, moderateLearningComment };
}
