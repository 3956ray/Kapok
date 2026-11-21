'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Clock, MessageCircle, Send } from 'lucide-react';
import { api, ApiError } from '../../lib/client/api';
import { confirmedRejection, learningMutation, learningRecovery, sendLearning, type LearningMutation } from '../../lib/client/learning-images';
import type { LearningPost, LearningVideo } from '../../lib/contracts/learning';
import {
    learningCommentReasonLimit, learningCommentTextLimit,
    type LearningComment, type LearningCommentAction, type LearningCommentEditInput,
    type LearningCommentInput, type LearningCommentModerationInput,
} from '../../lib/contracts/learning-social';
import { useLearningAction } from './learning-controls';
import type { YouTubeControls } from './youtube-player';

type Choice = { mode: 'root' } | { mode: 'reply' | 'edit' | 'delete' | LearningCommentAction; id: string };
type Input = { text: string; seconds: string; mediaUrl: string | null; version?: number; pending: LearningMutation | null };
type Owner = { actorId: string; epoch: string; userId: string; admin: boolean };
const actionLabels = { root: '发送讨论', reply: '发送回复', edit: '保存修改', delete: '删除', report: '举报', hide: '管理员隐藏', restore: '管理员恢复' };
const timeLabel = (seconds: number) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
const unavailable = (error: unknown) => error instanceof ApiError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code);

export function LearningDiscussion({ actorId, epoch, userId, admin, post, initial, video, player, playerSurface, children }: Owner & {
    children: ReactNode; post: LearningPost; initial: LearningComment[] | null; video: LearningVideo | null;
    player: RefObject<YouTubeControls | null>; playerSurface: RefObject<HTMLDivElement | null>;
}) {
    const postId = post.id;
    const title = useId();
    const composer = useRef<HTMLFormElement>(null);
    const focusComposer = useRef(false);
    const [choice, setChoice] = useState<Choice>({ mode: 'root' });
    const [readback, setReadback] = useState<{ from: LearningComment[] | null; comments: LearningComment[] } | null>(null);
    const [status, setStatus] = useState('');
    const [loadError, setLoadError] = useState('');
    const reset = useCallback(() => {
        setChoice({ mode: 'root' });
        setReadback(null);
        setStatus('');
        setLoadError('');
        focusComposer.current = false;
    }, []);
    const { busy, run, session } = useLearningAction(reset);
    const comments = readback?.from === initial ? readback.comments : initial ?? [];
    const path = 'learning/posts/' + postId + '/comments';
    const [attempt, setAttempt] = useState(0);
    const { subscribe, verify } = session;
    useEffect(() => {
        if (initial !== null) return;
        const controller = new AbortController();
        const unsubscribe = subscribe(() => controller.abort());
        void api<{ value: LearningComment[] }>(`page-read/article-discussion/${post.id}?version=${post.publishedVersion}`, undefined, actorId, controller.signal).then(({ value: comments }) => {
            if (!controller.signal.aborted) setReadback({ from: null, comments });
        }).catch(error => {
            if (controller.signal.aborted) return;
            if (unavailable(error)) void verify();
            else setLoadError('讨论暂时无法加载。');
        });
        return () => { controller.abort(); unsubscribe(); };
    }, [initial, post, actorId, subscribe, verify, attempt]);
    const target = 'id' in choice ? comments.find(comment => comment.id === choice.id) : undefined;
    const roots = comments.filter(comment => !comment.rootId);
    const replies = new Map<string, LearningComment[]>();
    for (const comment of comments) {
        if (!comment.rootId) continue;
        const group = replies.get(comment.rootId) ?? [];
        group.push(comment);
        replies.set(comment.rootId, group);
    }
    const scope = choice.mode + ('id' in choice ? ':' + choice.id : '');
    function select(next: Choice) {
        setStatus('');
        setChoice(next);
        focusComposer.current = true;
    }
    useLayoutEffect(() => {
        if (!focusComposer.current) return;
        focusComposer.current = false;
        const element = composer.current;
        (element?.querySelector<HTMLElement>('textarea') ?? element)?.focus();
    }, [scope]);

    async function refresh(signal: AbortSignal, current: () => boolean) {
        try {
            const updated = await api<LearningComment[]>(path, undefined, actorId, signal);
            if (current()) {
                setReadback({ from: initial, comments: updated });
                setLoadError('');
            }
        } catch (error) {
            // A disappearing source invalidates the whole reading surface. Recheck the
            // source through the parent boundary, including when a single comment is missing.
            if (current() && unavailable(error)) void session.verify();
            throw error;
        }
    }

    function row(comment: LearningComment, root: LearningComment) {
        const active = comment.status === 'active';
        const mine = comment.author.id === userId;
        const canUseTime = comment.matchesCurrentMedia && video?.url === comment.mediaUrl;
        return <article className="discussion">
            <span className="default-avatar" aria-hidden="true">{Array.from(comment.author.discName)[0]}</span>
            <div className="discussion-content">
                <div className="discussion-heading">
                    <div className="discussion-meta">
                        <strong>{comment.author.discName}{mine && '（我）'}</strong>
                        <span>#{comment.author.jerseyNumber}</span>
                        <time dateTime={comment.createdAt}>{comment.createdAt.slice(0, 10)}</time>
                        {active && comment.edited && <span>已编辑</span>}
                        {active && comment.replyToId && <span className="discussion-recipient">
                            {comment.replyTarget ? '回复 ' + comment.replyTarget.authorName : '回复对象已不可用'}
                        </span>}
                    </div>
                    {comment.timestampSec !== null && (canUseTime && video?.source === 'youtube'
                        ? <button type="button" className="video-time-chip" onClick={() => {
                            player.current?.seekTo(comment.timestampSec!);
                            playerSurface.current?.focus();
                            playerSurface.current?.scrollIntoView?.({ block: 'nearest' });
                        }} aria-label={'定位到 ' + timeLabel(comment.timestampSec)}>{timeLabel(comment.timestampSec)}</button>
                        : <small className="muted">{timeLabel(comment.timestampSec)} · {canUseTime
                            ? <a href={video?.url} target="_blank" rel="noreferrer">打开 B 站手动定位</a>
                            : '原视频已更换'}</small>)}
                </div>
                <p className="discussion-text">{comment.text ?? (comment.status === 'deleted' ? '这条讨论已删除。' : '这条讨论已隐藏。')}</p>
                <div className="discussion-actions">
                    {active && root.status === 'active' && <button type="button" className="discussion-reply" disabled={busy}
                        aria-label={'回复 ' + comment.author.discName} onClick={() => select({ mode: 'reply', id: comment.id })}>
                        <MessageCircle aria-hidden="true" /> 回复
                    </button>}
                    {((mine && comment.status !== 'deleted') || active || (admin && comment.status === 'hidden')) &&
                        <details className="comment-more">
                            <summary>更多操作<span className="muted"> · {comment.author.discName}的讨论</span></summary>
                            <div className="learning-actions">
                                {mine && active && <button type="button" className="secondary" disabled={busy}
                                    onClick={() => select({ mode: 'edit', id: comment.id })}>编辑</button>}
                                {mine && comment.status !== 'deleted' && <button type="button" className="secondary" disabled={busy}
                                    onClick={() => select({ mode: 'delete', id: comment.id })}>删除</button>}
                                {active && <button type="button" className="secondary" disabled={busy}
                                    onClick={() => select({ mode: 'report', id: comment.id })}>举报</button>}
                                {admin && comment.status !== 'deleted' && <button type="button" className="secondary" disabled={busy}
                                    onClick={() => select({ mode: active ? 'hide' : 'restore', id: comment.id })}>
                                    {active ? '管理员隐藏' : '管理员恢复'}
                                </button>}
                            </div>
                        </details>}
                </div>
            </div>
        </article>;
    }

    return <div className="video-discussion-layout training-watch-layout">
        <div className="video-discussion-scroll" role="region" aria-label="学习资料与讨论" tabIndex={0}>
            <div className="video-content">
                {children}
                <section className="video-discussion-list learning-discussion" aria-labelledby={title}>
                    <header className="training-discussion-heading">
                        <h2 id={title}>{video ? '视频讨论' : '讨论'}</h2>
                    </header>
                    {initial === null && !readback ? (loadError
                        ? <button type="button" onClick={() => { setLoadError(''); setAttempt(n => n + 1); }}>重新加载讨论</button>
                        : <p role="status">正在加载讨论…</p>) : roots.length ? <div className="training-discussion-threads">
                        {roots.map(root => <div className="discussion-card panel" key={root.id}>
                            {row(root, root)}
                            {replies.get(root.id)?.length ? <div className="discussion-replies">
                                <ol>{replies.get(root.id)?.map(reply => <li key={reply.id}>{row(reply, root)}</li>)}</ol>
                            </div> : null}
                        </div>)}
                    </div> : <p className="panel">还没有讨论。可以先留一条观察。</p>}
                </section>
            </div>
        </div>
        <div className="video-discussion-dock">
            {status && <p role="status" className="notice">{status}</p>}
            {loadError && <p role="alert" className="notice">{loadError}</p>}
            <DiscussionComposer key={scope} form={composer} choice={choice} target={target}
                targetAvailable={choice.mode !== 'reply' || (!!target && target.status === 'active' &&
                    (!target.rootId || comments.some(comment => comment.id === target.rootId && comment.status === 'active')))}
                actorId={actorId} epoch={epoch} path={path} video={video} player={player} busy={busy || (initial === null && !readback)}
                cancel={() => select({ mode: 'root' })}
                reload={() => void run(refresh, error => setLoadError(error instanceof Error ? error.message : '暂未能刷新讨论。'))}
                submit={(request, rejected, saved, failed) => {
                    setStatus('');
                    void run(async (signal, current) => {
                        try {
                            await sendLearning<{ id: string }>(request, actorId, signal);
                        } catch (error) {
                            if (current() && confirmedRejection(error)) {
                                rejected();
                                if (error instanceof ApiError && error.code === 'NOT_FOUND') {
                                    try { await refresh(signal, current); } catch { /* Refresh rechecks the source boundary. */ }
                                } else if (unavailable(error)) void session.verify();
                            }
                            throw error;
                        }
                        await refresh(signal, current);
                        if (!current()) return;
                        saved();
                        setStatus(({ edit: '讨论已修改。', delete: '讨论已删除。', report: '已提交举报。',
                            hide: '讨论已隐藏。', restore: '讨论已恢复。' } as Partial<Record<Choice['mode'], string>>)[choice.mode] ?? '讨论已发送。');
                        setChoice({ mode: 'root' });
                    }, failed);
                }} />
        </div>
    </div>;
}

function DiscussionComposer({ form, choice, target, targetAvailable, actorId, epoch, path, video, player, busy, cancel, reload, submit }: {
    form: RefObject<HTMLFormElement | null>; choice: Choice; target?: LearningComment; targetAvailable: boolean;
    actorId: string; epoch: string; path: string; video: LearningVideo | null; player: RefObject<YouTubeControls | null>; busy: boolean;
    cancel: () => void; reload: () => void;
    submit: (request: LearningMutation, rejected: () => void, saved: () => void, failed: (error: unknown) => void) => void;
}) {
    const { mode } = choice;
    const writing = mode === 'root' || mode === 'reply' || mode === 'edit';
    const deleting = mode === 'delete';
    const recovery = learningRecovery<Input>(actorId, 'discussion:' + path + ':' + mode + ':' + ('id' in choice ? choice.id : ''), epoch);
    const empty = (): Input => ({
        text: mode === 'edit' ? target?.text ?? '' : '',
        seconds: mode === 'edit' && target?.matchesCurrentMedia && target.timestampSec != null ? String(target.timestampSec) : '',
        mediaUrl: mode === 'edit' && target?.matchesCurrentMedia ? target.mediaUrl : null,
        version: target?.version, pending: null,
    });
    const [input, setInput] = useState(() => recovery.read() ?? empty());
    const [error, setError] = useState('');
    const timeToolsId = useId();
    const [showTimeTools, setTimeToolsOpen] = useState(() => !!input.seconds);
    const staleTime = !!input.seconds && input.mediaUrl !== video?.url;
    const staleVersion = !!target && mode !== 'reply' && input.version !== target.version;
    const invalidTarget = !targetAvailable || (mode !== 'root' && (!target || target.status === 'deleted'));
    const locked = busy || !!input.pending;

    function update(next: Input) {
        setInput(next);
        try { recovery.write(next); } catch { /* Current composer remains usable in memory. */ }
    }

    function send(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError('');
        if (busy) return;
        let request = input.pending;
        if (!request) {
            if (invalidTarget || staleTime || staleVersion) return;
            const seconds = input.seconds === '' ? null : Number(input.seconds);
            if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds < 0)) {
                setTimeToolsOpen(true);
                setError('请输入有效的非负整数秒数。');
                return;
            }
            const timed = seconds !== null && video ? { timestampSec: seconds, mediaUrl: video.url } : {};
            const targetPath = target ? path + '/' + target.id : path;
            if (mode === 'root' || mode === 'reply') {
                const body: LearningCommentInput = { text: input.text, ...timed, ...(target && { rootId: target.rootId ?? target.id, replyToId: target.id }) };
                request = learningMutation(path, 'POST', body);
            } else if (mode === 'delete' || mode === 'edit') {
                const body: LearningCommentEditInput = mode === 'delete' ? { action: 'delete', expectedVersion: target!.version }
                    : { text: input.text, ...timed, expectedVersion: target!.version };
                request = learningMutation(targetPath, 'PATCH', body);
            } else {
                const body: LearningCommentModerationInput = { action: mode, expectedVersion: target!.version, reason: input.text };
                request = learningMutation(targetPath + '/moderation', 'POST', body);
            }
            update({ ...input, pending: request });
        }
        submit(request, () => update({ ...input, pending: null }), () => {
            try { recovery.clear(); } catch { /* A later replay uses the same key. */ }
            setInput({ ...empty(), text: '', seconds: '', mediaUrl: null });
        }, failure => setError(failure instanceof Error ? failure.message : '尚未确认请求结果，请重试。'));
    }

    return <form ref={form} tabIndex={-1} className="discussion-composer learning-discussion-composer" data-own-buffer aria-busy={busy} onSubmit={send}>
        {mode !== 'root' && <div className="discussion-context">
            <div className="discussion-context-copy">
                <strong>{mode === 'reply' ? '回复 ' : actionLabels[mode] + ' · '}{target?.author.discName ?? '讨论已不可用'}</strong>
                {targetAvailable && target?.text && <span>{target.text}</span>}
            </div>
            <button type="button" className="discussion-cancel" disabled={busy} onClick={cancel}>返回根讨论</button>
        </div>}
        {invalidTarget && <p className="notice" role="status">该讨论对象已不可用，已保留输入。</p>}
        {staleVersion && !input.pending && <p className="notice">讨论已更新。
            <button type="button" className="secondary" disabled={busy} onClick={() => update({ ...input, version: target?.version })}>采用当前版本</button>
        </p>}
        {deleting && <p>确认删除这条讨论？已有回复会保留。</p>}
        <div className="composer-row">
            {!deleting && <div className="composer-field">
                <textarea name="discussion-text" rows={1} required aria-label={writing ? '讨论内容' : '操作原因'}
                    placeholder={mode === 'reply' && target ? '回复' + target.author.discName + '…' : writing ? '说说你的观察…' : '操作原因'}
                    maxLength={writing ? learningCommentTextLimit : learningCommentReasonLimit}
                    ref={node => {
                        if (node) { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; }
                    }}
                    disabled={locked} value={input.text} onChange={event => update({ ...input, text: event.target.value })} />
                {writing && video && <button type="button" className="composer-time-toggle" aria-label="讨论时间点选项"
                    title="讨论时间点选项" aria-expanded={showTimeTools} aria-controls={timeToolsId} disabled={locked}
                    onClick={() => setTimeToolsOpen(!showTimeTools)}>
                    <Clock size={17} aria-hidden="true" />
                </button>}
            </div>}
            <button type="submit" className={deleting ? 'learning-confirm-delete' : undefined}
                disabled={busy || (!input.pending && (invalidTarget || staleTime || staleVersion || (!deleting && !input.text.trim())))}>
                <span className={deleting ? undefined : 'discussion-send-label'}>
                    {busy ? '正在确认…' : input.pending ? '确认上次结果' : deleting ? '确认删除' : actionLabels[mode]}
                </span>
                {!deleting && <Send size={20} aria-hidden="true" />}
            </button>
        </div>
        {writing && video && <div id={timeToolsId} className="learning-actions learning-discussion-time" hidden={!showTimeTools}>
            <label>视频时刻（秒，可选）
                <input name="discussion-time" type="number" min="0" step="1" disabled={locked || !showTimeTools} value={input.seconds}
                    onChange={event => update({ ...input, seconds: event.target.value, mediaUrl: event.target.value ? video.url : null })} />
            </label>
            {video.source === 'youtube' && <button type="button" className="secondary" disabled={locked} onClick={() => {
                const seconds = player.current?.currentTime();
                if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
                    setError('请先载入 YouTube 视频，或手动填写时刻。');
                } else {
                    setError('');
                    update({ ...input, seconds: String(Math.floor(seconds)), mediaUrl: video.url });
                }
            }}>附上当前播放时刻</button>}
        </div>}
        {staleTime && <p className="notice">原视频已更换，请移除旧时刻或重新填写。
            <button type="button" className="secondary" disabled={locked}
                onClick={() => update({ ...input, seconds: '', mediaUrl: null })}>移除时刻</button>
        </p>}
        {input.pending && !busy && <p className="notice" role="status">上次操作结果待确认。重试会沿用原请求。</p>}
        {error && <div className="notice" role="alert"><p>{error}</p>
            {!input.pending && <button type="button" className="secondary" disabled={busy} onClick={reload}>刷新讨论</button>}
        </div>}
    </form>;
}
