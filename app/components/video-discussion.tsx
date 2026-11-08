'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Comment, Training, Video } from '../../lib/contracts/training';
import type { BootstrapStatus } from '../../lib/contracts';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Bookmark, Clock, Send } from 'lucide-react';
import { AccountBoundary, useAccountSession } from './secure-resource';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { bilibiliPlayerUrl } from '../../lib/client/bilibili';
import { createVideoSeek } from '../../lib/client/video-seek';
import { acknowledgeMutation, navigationBuffer, currentRoute } from '../../lib/client/navigation-state';
import { SaveCollection } from './collections';
const message = (e: unknown) => e instanceof Error ? e.message : '操作未完成，请保留输入重试。';
const stamp = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
type Snapshot = { video: Video & { training: Training }; comments: Comment[]; userId: string; admin: boolean };
type Feedback = { kind: 'neutral' | 'success' | 'error'; text: string; source?: true };
type ComposerMode = { kind: 'reply' | 'edit'; id: string } | null;
type Draft = { text: string; seconds: string; timeDraft: string | null; editVersion?: number };
const emptyDraft: Draft = { text: '', seconds: '', timeDraft: null };
const discussionTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const readable = (c: Comment) => c.status === 'active' && c.text !== null;
const unavailable = '当前不可用的讨论';
export function VideoDiscussion({ actorId, videoId, initialSeconds, environmentNote }: {
    actorId: string; videoId: string; initialSeconds?: number; environmentNote?: ReactNode;
}) {
    const boundary = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const workspace = boundary.current?.closest<HTMLElement>('.video-workspace');
        const viewport = window.visualViewport;
        if (!workspace || !viewport) return;
        const updateViewport = () => {
            // Mobile keyboards may resize only the visual viewport. Leave pinch zoom to the browser.
            const keyboard = viewport.scale === 1 && window.innerHeight - viewport.height > 80;
            workspace.toggleAttribute('data-video-keyboard', keyboard);
            workspace.style.setProperty('--video-viewport-height', keyboard ? `${viewport.height}px` : '100dvh');
            workspace.style.setProperty('--video-viewport-top', keyboard ? `${viewport.offsetTop}px` : '0px');
        };
        updateViewport();
        viewport.addEventListener('resize', updateViewport);
        viewport.addEventListener('scroll', updateViewport);
        return () => {
            viewport.removeEventListener('resize', updateViewport);
            viewport.removeEventListener('scroll', updateViewport);
            workspace.removeAttribute('data-video-keyboard');
            workspace.style.removeProperty('--video-viewport-height');
            workspace.style.removeProperty('--video-viewport-top');
        };
    }, []);
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal): Promise<Snapshot> => {
        if (account.me.membership?.status !== 'active' || !account.me.user) throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有队伍访问权限。', retryable: false }, requestId: '' });
        const comments = await api<Comment[]>(`videos/${videoId}/comments`, undefined, actorId, signal);
        // Re-read the source after comments, so a removed/archived source cannot retain old write controls.
        const latest = await api<Snapshot['video']>(`videos/${videoId}`, undefined, actorId, signal);
        return { video: latest, comments, userId: account.me.user.id, admin: account.me.membership.role === 'admin' };
    }, [actorId, videoId]);
    return <div className="video-discussion-boundary" ref={boundary}>
        <AccountBoundary key={videoId} actorId={actorId} load={load}>{snapshot => <Discussion actorId={actorId} {...snapshot} initialSeconds={initialSeconds} environmentNote={environmentNote} />}</AccountBoundary>
    </div>;
}
function Discussion({ actorId, userId, admin, video, comments, initialSeconds, environmentNote }: Snapshot & { actorId: string; initialSeconds?: number; environmentNote?: ReactNode }) {
    const session = useAccountSession();
    const player = useRef<HTMLVideoElement>(null);
    const externalPlayer = useRef<HTMLIFrameElement>(null);
    const [embed, setEmbed] = useState({ video, actorId, userId, initialSeconds, visible: true, seconds: initialSeconds, request: 0 });
    // Only a fresh authorized snapshot can reopen a locked frame. Discard old seek intent.
    if (embed.video !== video || embed.actorId !== actorId || embed.userId !== userId || !Object.is(embed.initialSeconds, initialSeconds)) {
        const visible = embed.video !== video || embed.visible;
        setEmbed({ video, actorId, userId, initialSeconds, visible, seconds: visible ? initialSeconds : undefined, request: 0 });
    }
    const embedUrl = bilibiliPlayerUrl(video.url, embed.seconds);
    useEffect(() => {
        if (embed.visible && embed.request > 0) externalPlayer.current?.scrollIntoView?.({ block: 'center' });
    }, [embed.visible, embed.request]);
    const key = useRef(createRequestKey());
    const submitting = useRef(false);
    const writeRequest = useRef<AbortController | null>(null);
    const composerInput = useRef<HTMLTextAreaElement>(null);
    const [route] = useState(currentRoute);
    const entity = 'discussion:' + video.id;
    const [buffer] = useState(() => navigationBuffer(actorId, route, entity));
    const [saved] = useState(() => buffer.read<{ mode: ComposerMode; shown: Record<string, boolean> }>());
    const [mode, setMode] = useState<ComposerMode>(saved?.mode ?? null);
    const draftBuffer = (target: ComposerMode) => navigationBuffer(actorId, route, entity + (target ? ':' + target.kind + ':' + target.id : ':root'));
    const commentsById = useMemo(() => new Map(comments.map(c => [c.id, c])), [comments]);
    function visibleComment(id: string) {
        const comment = commentsById.get(id);
        return comment && readable(comment) ? comment : undefined;
    }
    function ownedComment(id: string) {
        const comment = visibleComment(id);
        return comment?.authorId === userId ? comment : undefined;
    }
    function readDraft(target: ComposerMode): Draft {
        const stored = draftBuffer(target).read<Draft>();
        if (stored) return stored;
        const comment = target?.kind === 'edit' ? ownedComment(target.id) : null;
        return comment?.text != null ? {
            text: comment.text, seconds: comment.timestampSec === null ? '' : String(comment.timestampSec),
            timeDraft: null, editVersion: comment.version
        } : emptyDraft;
    }
    const [draft, setDraft] = useState(() => readDraft(mode));
    const { text, seconds, timeDraft } = draft;
    const reply = mode?.kind === 'reply' ? mode : null;
    const edit = mode?.kind === 'edit' ? mode : null;
    const selectedReply = reply ? visibleComment(reply.id) : undefined;
    const replyRoot = selectedReply?.rootId ? visibleComment(selectedReply.rootId) : undefined;
    const currentReply = selectedReply && (!selectedReply.rootId || (replyRoot && !replyRoot.rootId)) ? selectedReply : undefined;
    const replyName = currentReply ? currentReply.authorId === userId ? '自己' : currentReply.authorName : unavailable;
    const replyUnavailable = !!reply && !currentReply;
    const editUnavailable = !!edit && (!ownedComment(edit.id) || draft.editVersion === undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState<Feedback | null>(null);
    const [playerStatus, setPlayerStatus] = useState<Feedback | null>(null);
    const [playable, setPlayable] = useState(false);
    const [timeToolsOpen, setTimeToolsOpen] = useState(false);
    const showTimeTools = timeToolsOpen || timeDraft !== null;

    const [shown, setShown] = useState<Record<string, boolean>>(saved?.shown ?? {});
    const writable = video.training.status === 'published';
    const initialTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [seek] = useState(() => createVideoSeek((kind, text) => setPlayerStatus({ kind, text })));
    useEffect(() => { buffer.write({ mode, shown }); }, [buffer, mode, shown]);
    function updateDraft(patch: Partial<Draft>) {
        const next = { ...draft, ...patch };
        draftBuffer(mode).write(next);
        setDraft(next);
    }
    function switchComposer(next: ComposerMode) {
        setMode(next);
        setDraft(readDraft(next));
        setError('');
        setStatus(null);
    }
    function cancelComposer() {
        switchComposer(null);
        const trigger = reply && document.getElementById('comment-' + reply.id)?.querySelector<HTMLButtonElement>('.discussion-reply');
        (trigger && !trigger.closest('[hidden]') ? trigger : composerInput.current)?.focus();
    }
    useEffect(() => () => seek.dispose(), [seek]);
    useEffect(() => {
        const timer = setTimeout(() => { const media = player.current; if (media && !media.closest('[hidden]')) setPlayable(media.readyState >= 1); }, 0);
        return () => clearTimeout(timer);
    }, [video]);
    useEffect(() => {
        const timer = setTimeout(() => {
            if (initialSeconds === undefined) return;
            if (!Number.isSafeInteger(initialSeconds) || initialSeconds < 0) { setPlayerStatus({ kind: 'error', text: '时间点需为有效的非负整数秒。' }); return; }
            if (video.source === 'bilibili') setPlayerStatus({ kind: 'neutral', text: `已请求从 ${stamp(initialSeconds)} 加载播放器；如未开始播放，请点击播放。` });
            else seek.request(video.id, initialSeconds, player.current);
        }, 0);
        initialTimer.current = timer;
        return () => clearTimeout(timer);
    }, [initialSeconds, seek, video.id, video.source]);
    useEffect(() => {
        const id = window.location.hash.slice(1);
        if (!/^comment-[a-zA-Z0-9_-]+$/.test(id)) return;
        const timer = setTimeout(() => {
            const comment = comments.find(c => 'comment-' + c.id === id && c.text !== null);
            if (!comment) { setStatus({ kind: 'error', text: '这条讨论当前不可用。' }); return; }
            if (comment.rootId) setShown(current => ({ ...current, [comment.rootId!]: true }));
            window.requestAnimationFrame(() => { const node = document.getElementById(id); node?.scrollIntoView?.({ block: 'center' }); node?.focus(); });
        }, 0);
        return () => clearTimeout(timer);
    }, [comments]);
    useEffect(() => session.subscribe(ended => {
        clearTimeout(initialTimer.current);
        writeRequest.current?.abort();
        // Hiding an iframe does not stop audio. Unload it synchronously on every lock.
        if (externalPlayer.current) externalPlayer.current.src = 'about:blank';
        setEmbed(current => ({ ...current, visible: false, seconds: undefined, request: 0 }));
        seek.clear();
        setStatus(null);
        setPlayerStatus(null);
        setPlayable(false);
        if (ended) {
            buffer.clear();
            setMode(null);
            setDraft(emptyDraft);
            setShown({});
            key.current = createRequestKey();
        }
        const media = player.current;
        if (media) {
            media.pause();
        }
    }), [session, seek, buffer]);
    async function change(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST', onSaved?: () => void) {
        if (submitting.current) return;
        submitting.current = true;
        setError(''); setStatus(null); setBusy(true);
        let generation: number | undefined;
        try {
            generation = await session.authorize();
            if (!session.isCurrent(generation)) return;
            const request = new AbortController();
            writeRequest.current = request;
            await api(path, { method, actorId, body, key: key.current(actorId, body) }, undefined, request.signal);
            if (!session.isCurrent(generation)) return;
            writeRequest.current = null;
            acknowledgeMutation(actorId, method, path, body);
            // Refresh begins synchronously; no response from this mutation can reopen an older epoch.
            void session.verify();
            onSaved?.();
        } catch (e) {
            if (generation !== undefined && !session.isCurrent(generation)) return;
            setError(message(e));
            if (e instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'READ_ONLY'].includes(e.code)) void session.verify();
        } finally {
            writeRequest.current = null;
            submitting.current = false;
            setBusy(false);
        }
    }
    function jump(n: number) {
        setError('');
        if (video.source === 'bilibili') {
            if (!Number.isSafeInteger(n) || n < 0 || (video.durationSec !== null && n > video.durationSec)) {
                setPlayerStatus({ kind: 'error', text: '时间点需为视频范围内的非负整数秒。' }); return;
            }
            const frame = externalPlayer.current;
            if (!embed.visible || !frame || frame.closest('[hidden]') || frame.getAttribute('src') === 'about:blank') return;
            // A new frame also repeats an identical target. Ordinary composer renders keep its key/src.
            setEmbed(current => ({ ...current, seconds: n, request: current.request + 1 }));
            setPlayerStatus({ kind: 'neutral', text: `已请求从 ${stamp(n)} 加载播放器；如未开始播放，请点击播放。` });
            return;
        }
        seek.request(video.id, n, player.current);
    }
    function renderComment(c: Comment) {
        // A null target name is authoritative. A visible target is only needed to identify a self-reply.
        const target = c.rootId && c.replyTargetName ? visibleComment(c.replyToId ?? c.rootId) : undefined;
        const targetName = target?.authorId === c.authorId ? '自己' : c.replyTargetName ?? unavailable;
        return <article id={'comment-' + c.id} tabIndex={-1} className={'discussion' + (c.rootId ? ' reply' : '')}>
            <span className="default-avatar" aria-hidden="true">{Array.from(c.authorName)[0] || '队'}</span>
            <div className="discussion-content">
                <header className="discussion-meta">
                    <strong>{c.authorName}</strong>
                    {c.authorJerseyNumber && <span>#{c.authorJerseyNumber}</span>}
                    {c.rootId && <span className="discussion-recipient">回复 {targetName}</span>}
                    <time dateTime={c.createdAt}>发表于 {discussionTime.format(new Date(c.createdAt))}</time>
                    {!!c.edited && <span>已编辑</span>}
                </header>
                {c.timestampSec !== null && <button type="button" className="video-time-chip" onClick={() => jump(c.timestampSec!)} aria-label={`讨论时间点 ${stamp(c.timestampSec)}`}><span className="discussion-time-prefix">讨论时间点 </span>{stamp(c.timestampSec)}</button>}
                <p className="discussion-text preserve">
                    {c.text ?? (c.status === 'deleted' ? '原讨论已删除' : '讨论已隐藏')}
                </p>
                <div className="discussion-actions">
                    {readable(c) && <>
                        {writable && <button
                            type="button"
                            className="discussion-reply"
                            disabled={busy}
                            onClick={() => {
                                switchComposer({ kind: 'reply', id: c.id });
                                composerInput.current?.focus();
                            }}
                        >回复</button>}
                        <details className="comment-more">
                            <summary>更多操作<span className="muted"> · {c.authorName}的讨论</span></summary>
                            <div className="actions">
                                {writable && c.authorId === userId && <>
                                    <button
                                        className="secondary"
                                        disabled={busy}
                                        onClick={() => {
                                            switchComposer({ kind: 'edit', id: c.id });
                                            composerInput.current?.focus();
                                        }}
                                    >编辑本人讨论
                                    </button>
                                    <button
                                        className="secondary danger"
                                        disabled={busy}
                                        onClick={async () => {
                                            if (window.confirm('删除自己的这条讨论？独立回复和本人备注会保留。')) {
                                                await change(`videos/${video.id}/comments/${c.id}`, { action: 'delete', expectedVersion: c.version }, 'PATCH',
                                                    () => setStatus({ kind: 'success', text: '讨论已删除。' }));
                                            }
                                        }}
                                    >删除
                                    </button>
                                </>}
                                {<button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={async () => {
                                        const reason = window.prompt('填写举报原因（仅合成测试）');
                                        if (reason?.trim()) await change(`comments/${c.id}/moderation`, { action: 'report', reason }, 'POST',
                                            () => setStatus({ kind: 'success', text: '举报已提交。' }));
                                    }}
                                >举报
                                </button>}
                                {admin && <button
                                    className="secondary danger"
                                    disabled={busy}
                                    onClick={async () => {
                                        const reason = window.prompt('填写隐藏理由');
                                        if (reason?.trim())
                                            await change(`comments/${c.id}/moderation`, { action: 'hide', reason });
                                    }}
                                >管理员隐藏
                                </button>}
                            </div>
                        </details>
                    </>}
                    <SaveCollection actorId={actorId} sourceKind="comment" sourceId={c.id} />
                    {admin && c.status === 'hidden' && <details className="comment-more">
                        <summary>更多操作<span className="muted"> · {c.authorName}的讨论</span></summary>
                        <button
                            className="secondary"
                            disabled={busy}
                            onClick={async () => {
                                const reason = window.prompt('填写恢复理由');
                                if (reason?.trim())
                                    await change(`comments/${c.id}/moderation`, { action: 'restore', reason });
                            }}
                        >管理员恢复</button>
                    </details>}
                </div>
            </div>
        </article>;
    }
    return <div className="video-discussion-layout">
        <div className="video-discussion-scroll" role="region" aria-label="视频与讨论内容" tabIndex={0}>
            <div className="video-content">
                <section className="video-stage" aria-label="视频播放器">
                    {video.source === 'upload' ?
                        <video
                            ref={player}
                            className="video-player"
                            controls
                            playsInline
                            preload="metadata"
                            src={`/api/v1/videos/${video.id}/media`}
                            onLoadedMetadata={event => { setPlayable(true); seek.ready(video.id, event.currentTarget); }}
                            onCanPlay={event => { setPlayable(true); seek.ready(video.id, event.currentTarget); }}
                            onError={() => {
                                seek.clear();
                                setPlayable(false);
                                setPlayerStatus({ kind: 'error', text: '短片暂不可播放，讨论与本人引用仍保留，请联系管理员处理。' });
                            }}
                            onSeeked={event => seek.seeked(video.id, event.currentTarget)}
                        /> : embedUrl && embed.visible && <iframe
                            key={embed.request}
                            ref={externalPlayer}
                            data-kapok-player="bilibili"
                            className="video-player bilibili-player"
                            src={embedUrl}
                            title={`${video.title} · B站播放器`}
                            allow="fullscreen; picture-in-picture; encrypted-media"
                            allowFullScreen
                            referrerPolicy="no-referrer"
                        />}
                    {playerStatus && !playerStatus.source && <p className={`notice ${playerStatus.kind}`} role={playerStatus.kind === 'error' ? 'alert' : 'status'}>{playerStatus.text}</p>}
                </section>
                <div className="video-actions">
                    <details className="video-note-disclosure">
                        <summary><Bookmark size={16} aria-hidden="true" />收藏与备注</summary>
                        <SaveCollection actorId={actorId} sourceKind="video" sourceId={video.id} privateNote timestampSec={seconds === '' ? null : Number(seconds)} />
                    </details>
                    <Link className="video-reflection-link" href={`/reflections/new?training=${video.trainingId}&video=${video.id}`}>写复盘<ArrowRight size={14} aria-hidden="true" /></Link>
                </div>
                <header className="video-detail-header">
                    <h2>{video.title}</h2>
                    <div className="video-detail-links">
                        <p className="detail-meta"><Link href={'/trainings/' + video.trainingId}>关联训练：{video.training.title}</Link><time dateTime={video.training.date}>{video.training.date}</time></p>
                        <details className="video-source-disclosure" open={video.source === 'bilibili' && !embedUrl ? true : undefined}>
                            <summary>播放来源</summary>
                            <div className="video-source-info">
                                <p className="small">{video.source === 'upload' ? '私有合成短片 · 仅有效队员可播放。' : '若 B 站限制播放或加载失败，可在原站打开。讨论时间点需手动填写。'} {video.durationSec !== null && stamp(video.durationSec)}</p>
                                {video.source === 'bilibili' && <>
                                    <div className="actions video-external-actions">
                                        <a className="button secondary" href={video.url!} target="_blank" rel="noopener noreferrer">原站观看 · 新标签 <ArrowUpRight size={16} aria-hidden="true" />
                                        </a>
                                        <button
                                            className="secondary"
                                            onClick={async () => {
                                                setPlayerStatus({ kind: 'neutral', text: '正在复制原站地址…', source: true });
                                                try {
                                                    const generation = await session.authorize();
                                                    await navigator.clipboard.writeText(video.url!);
                                                    if (!session.isCurrent(generation)) return;
                                                    setPlayerStatus({ kind: 'success', text: '原站地址已复制。', source: true });
                                                }
                                                catch {
                                                    setPlayerStatus({ kind: 'error', text: '复制未成功，请手动选择原站地址。', source: true });
                                                }
                                            }}
                                        >复制地址
                                        </button>
                                    </div>
                                    <label>原站地址
                                        <input readOnly value={video.url!} onFocus={e => e.currentTarget.select()} />
                                    </label>
                                </>}
                                {playerStatus?.source && <p className={`notice ${playerStatus.kind}`} role={playerStatus.kind === 'error' ? 'alert' : 'status'}>{playerStatus.text}</p>}
                                {environmentNote}
                            </div>
                        </details>
                    </div>
                    {video.publisherName && <p className="detail-meta video-publisher">发布者 {video.publisherName}</p>}
                </header>
                <section className="video-discussion-list" aria-labelledby="video-discussion-heading">
                    <h2 id="video-discussion-heading">讨论</h2>
                    {comments.length ? comments.filter(c => !c.rootId).map(c => {
                        const replies = comments.filter(r => r.rootId === c.id);
                        const expanded = shown[c.id];
                        return <section className="discussion-card panel" key={c.id}>
                            {renderComment(c)}
                            {replies.length > 0 && <div className="discussion-replies">
                                <small>{replies.length} 条回复</small>
                                <ol role="list">{(expanded ? replies : replies.slice(0, 3)).map(r => <li key={r.id}>{renderComment(r)}</li>)}</ol>
                                {replies.length > 3 && <button type="button" className="secondary" aria-expanded={!!expanded} onClick={() => setShown({ ...shown, [c.id]: !expanded })}>
                                    {expanded ? '收起回复' : '展开回复'}
                                </button>}
                            </div>}
                        </section>;
                    }) : <p className="panel">还没有讨论，留下训练中想记住的一刻。</p>}
                    {!writable && <p className="notice">此训练当前只可回看，不接受新讨论。</p>}
                </section>
            </div>
        </div>
        <div className="video-discussion-dock">
            {error && <p className="notice error" role="alert">{error}</p>}
            {status && <p className={`notice ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>}
            <form className="discussion-composer" data-buffer-id="discussion" data-own-buffer hidden={!writable} aria-busy={busy}
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy || !writable) return;
                    if (timeDraft !== null) { setError('请先确认或取消时间修改。'); return; }
                    if (replyUnavailable || editUnavailable) return;
                    const timestamp = seconds === '' ? null : Number(seconds);
                    if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0 || (video.durationSec !== null && timestamp > video.durationSec))) { setError('时间点需为视频范围内的非负整数秒。'); return; }
                    const body = {
                        text,
                        timestampSec: timestamp,
                        ...(edit ? { expectedVersion: draft.editVersion } : currentReply ? { rootId: currentReply.rootId ?? currentReply.id, replyToId: currentReply.id } : { rootId: null })
                    };
                    const submittedDraft = draftBuffer(mode);
                    await change(`videos/${video.id}/comments${edit ? '/' + edit.id : ''}`, body, edit ? 'PATCH' : 'POST', () => {
                        submittedDraft.clear();
                        switchComposer(null);
                        setStatus({ kind: 'success', text: edit ? '本人讨论已保存。' : reply ? '回复已发送。' : '讨论已发送。' });
                        key.current = createRequestKey();
                    });
                }}
            >
                {mode && <div className="discussion-context">
                    <div className="discussion-context-copy">
                        <strong id="discussion-target">{edit ? '正在编辑本人讨论' : `正在回复 ${replyName}`}</strong>
                        {currentReply && <span>{currentReply.text}</span>}
                    </div>
                    <button type="button" className="discussion-cancel" disabled={busy} onClick={cancelComposer}>
                        {edit ? '取消编辑' : '取消回复'}
                    </button>
                </div>}
                {(replyUnavailable || editUnavailable) && <p className="notice error" role="alert">这条讨论当前不可用，草稿仍保留。可以取消并返回根讨论。</p>}
                <div className="composer-row">
                    <div className="composer-field">
                        <textarea
                            id="comment-input"
                            aria-label={edit ? '编辑讨论' : '讨论内容'}
                            aria-describedby={mode ? 'discussion-target' : undefined}
                            ref={node => {
                                composerInput.current = node;
                                if (node) { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; }
                            }}
                            value={text}
                            disabled={busy}
                            onChange={e => updateDraft({ text: e.target.value })}
                            maxLength={2000}
                            rows={1}
                            placeholder={currentReply ? `回复${replyName}…` : '说说你的观察…'}
                            required
                        />
                        <button type="button" className="composer-time-toggle" aria-label="讨论时间点选项" title="讨论时间点选项"
                            aria-expanded={showTimeTools} aria-controls="discussion-time-tools" disabled={busy || timeDraft !== null}
                            onClick={() => setTimeToolsOpen(open => !open)}>
                            <Clock size={17} aria-hidden="true" />
                        </button>
                    </div>
                    <button type="submit" disabled={busy || replyUnavailable || editUnavailable}>
                        <span className="discussion-send-label">{busy ? '正在保存…' : edit ? '保存本人讨论' : reply ? '发送回复' : '发送讨论'}</span>
                        <Send size={20} aria-hidden="true" />
                    </button>
                </div>
                <div className="time-editor" hidden={timeDraft === null}>
                    <label>可选时间点（整数秒）
                        <input
                            type="number"
                            min={0}
                            max={video.durationSec ?? undefined}
                            step={1}
                            value={timeDraft ?? seconds}
                            disabled={busy}
                            onChange={e => updateDraft({ timeDraft: e.target.value })}
                        />
                    </label>

                    {timeDraft !== null && <>
                        <p role="status">时间修改尚未确认；确认或取消后再发送。</p>
                        <div className="actions">
                            <button type="button" disabled={busy} onClick={() => {
                                const n = timeDraft === '' ? null : Number(timeDraft);
                                if (n !== null && (!Number.isSafeInteger(n) || n < 0 || (video.durationSec !== null && n > video.durationSec))) { setError('时间点需为视频范围内的非负整数秒。'); return; }
                                updateDraft({ seconds: timeDraft, timeDraft: null }); setError('');
                            }}>确认时间点</button>
                            <button type="button" className="secondary" disabled={busy} onClick={() => { updateDraft({ timeDraft: null }); setError(''); }}>取消时间修改</button>
                        </div>
                    </>}
                </div>
                {seconds !== '' && <div className="selected-time">
                    <button type="button" className="video-time-chip" disabled={busy} onClick={() => jump(Number(seconds))}>已添加时间点 {stamp(Number(seconds))}（已固定）</button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => updateDraft({ timeDraft: seconds })}>修改时间点</button>
                </div>}
                <div id="discussion-time-tools" hidden={!showTimeTools}>
                    <div className="actions time-tools">
                        {seconds === '' && timeDraft === null && <button type="button" className="secondary" disabled={busy} onClick={() => updateDraft({ timeDraft: '' })}>手动添加时间点</button>}
                        <button
                            type="button"
                            className="secondary"
                            disabled={busy || (seconds === '' && timeDraft === null)}
                            onClick={() => updateDraft({ seconds: '', timeDraft: null })}
                        >去掉时间点
                        </button>
                        {video.source === 'upload' && <button
                            type="button"
                            className="secondary"
                            disabled={busy || !playable}
                            onClick={() => { const n = player.current?.currentTime; if (n === undefined || !Number.isFinite(n) || n < 0) { setError('播放器当前时间不可读。'); return; } updateDraft({ seconds: String(Math.floor(n)), timeDraft: null }); }}
                        >添加当前视频时间
                        </button>}
                    </div>
                    <p className="small">时间标注选填；添加后固定，不随播放变化。可不附加时间发送。</p>
                    {video.source === 'upload' && !playable && <p className="muted">媒体就绪后，可读取播放器的当前秒数。
                    </p>}
                </div>
            </form>
        </div>
    </div>;
}
