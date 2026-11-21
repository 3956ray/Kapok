'use client';
import { ReflectionIcon } from './reflection-icon';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react';
import type { Comment, Training, Video } from '../../lib/contracts/training';
import type { BootstrapStatus } from '../../lib/contracts';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Bookmark, Clock, ExternalLink, Film, Play, Send } from 'lucide-react';
import { AccountBoundary, supportsPageReads, useAccountSession } from './secure-resource';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { bilibiliPlayerUrl } from '../../lib/client/bilibili';
import { createVideoSeek } from '../../lib/client/video-seek';
import { acknowledgeMutation, navigationBuffer, currentRoute } from '../../lib/client/navigation-state';
import { parseYouTubeSource } from '../../lib/video-source';
import { YouTubePlayer, type YouTubeControls } from './youtube-player';
import { SaveCollection } from './collections';
const emptyComments: Comment[] = [];
const message = (e: unknown) => e instanceof Error ? e.message : '操作未完成，请保留输入重试。';
const stamp = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
type Snapshot = { video: Video & { training: Training }; comments: Comment[] | null; userId: string; admin: boolean };
type Feedback = { kind: 'neutral' | 'success' | 'error'; text: string; source?: true };
type ComposerMode = { kind: 'reply' | 'edit'; id: string } | null;
type Draft = { text: string; seconds: string; timeDraft: string | null; editVersion?: number };
const emptyDraft: Draft = { text: '', seconds: '', timeDraft: null };
const discussionTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const readable = (c: Comment) => c.status === 'active' && c.text !== null;
const unavailable = '当前不可用的讨论';
type WatchSlots = { stage: HTMLElement; note: HTMLElement; providerLink: HTMLElement; noteTrigger: HTMLElement; dock: HTMLElement; isLegacyVideo: boolean };
type SourceUnavailable = (videoId: string, scope: 'video' | 'training') => void;

export function WatchMediaIdentity({ source, title }: { source: 'youtube' | 'bilibili'; title: string }) {
    return <div className="training-stage-identity">
        <span className="training-stage-provider"><Film size={16} aria-hidden="true" />{source === 'youtube' ? 'YouTube' : 'B 站'}</span>
        <strong title={title} className="training-stage-video-title">{title}</strong>
    </div>;
}

export function useVideoViewport(boundary: RefObject<HTMLElement | null>, enabled = true) {
    useEffect(() => {
        const workspace = boundary.current?.closest<HTMLElement>('.video-workspace');
        const viewport = window.visualViewport;
        if (!enabled || !workspace || !viewport) return;
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
    }, [boundary, enabled]);
}
export function VideoDiscussion({ actorId, videoId, initialSeconds, environmentNote, slots, trainingId, memberView = false, onUnavailable, onReady }: {
    actorId: string; videoId: string; initialSeconds?: number; environmentNote?: ReactNode;
    slots?: WatchSlots; trainingId?: string; memberView?: boolean; onUnavailable?: SourceUnavailable; onReady?: () => void;
}) {
    const boundary = useRef<HTMLDivElement>(null);
    useVideoViewport(boundary, !slots);
    const adjacentSurfaces = useMemo(() => slots ? [slots.stage, slots.note, slots.providerLink, slots.noteTrigger, slots.dock] : undefined, [slots]);
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal): Promise<Snapshot> => {
        if (account.me.membership?.status !== 'active' || !account.me.user) {
            signal.throwIfAborted();
            onUnavailable?.(videoId, 'training');
            throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有队伍访问权限。', retryable: false }, requestId: '' });
        }
        try {
            const comments = supportsPageReads() ? null : await api<Comment[]>(`videos/${videoId}/comments`, undefined, actorId, signal);
            // Re-read the source after comments to observe access changes during a read.
            const latest = await api<Snapshot['video']>(`videos/${videoId}`, undefined, actorId, signal);
            if (trainingId && (latest.trainingId !== trainingId || !['published', 'archived'].includes(latest.training.status))) {
                signal.throwIfAborted();
                onUnavailable?.(videoId, 'training');
                throw new Error('本次训练当前不可用。');
            }
            if (trainingId && latest.status !== 'active') throw new ApiError({ error: { code: 'NOT_FOUND', message: '该视频当前不可用。', retryable: false }, requestId: '' });
            return { video: latest, comments, userId: account.me.user.id, admin: !memberView && account.me.membership.role === 'admin' };
        } catch (error) {
            if (onUnavailable && error instanceof ApiError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)) {
                signal.throwIfAborted();
                onUnavailable(videoId, 'video');
                throw new Error('该视频当前不可用。');
            }
            throw error;
        }
    }, [actorId, videoId, trainingId, memberView, onUnavailable]);
    return <div className="video-discussion-boundary" ref={boundary}>
        <AccountBoundary key={videoId} actorId={actorId} load={load} adjacentSurfaces={adjacentSurfaces}>{snapshot => <Discussion actorId={actorId} {...snapshot} initialSeconds={initialSeconds} environmentNote={environmentNote} slots={slots} onReady={onReady} />}</AccountBoundary>
    </div>;
}
function Discussion({ actorId, userId, admin, video, comments: initialComments, initialSeconds, environmentNote, slots, onReady }: Snapshot & { actorId: string; initialSeconds?: number; environmentNote?: ReactNode; slots?: WatchSlots; onReady?: () => void }) {
    const session = useAccountSession();
    const [readback, setReadback] = useState<{ source: Video; rows?: Comment[]; error?: string } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const current = readback?.source === video ? readback : null;
    const comments = initialComments ?? current?.rows ?? emptyComments;
    const { subscribe, verify } = session;
    useEffect(() => {
        if (initialComments !== null) return;
        const controller = new AbortController();
        const unsubscribe = subscribe(() => controller.abort());
        void api<{ value: Comment[] }>(`page-read/video-discussion/${video.id}`, undefined, actorId, controller.signal).then(({ value: rows }) => {
            if (!controller.signal.aborted) setReadback({ source: video, rows });
        }).catch(error => {
            if (controller.signal.aborted) return;
            if (error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) void verify();
            else setReadback({ source: video, error: message(error) });
        });
        return () => { controller.abort(); unsubscribe(); };
    }, [video, actorId, initialComments, attempt, subscribe, verify]);
    useEffect(() => { onReady?.(); }, [onReady]);
    const player = useRef<HTMLVideoElement>(null);
    const youtubePlayer = useRef<YouTubeControls>(null);
    const youtubeKey = JSON.stringify([video.source, video.url, String(initialSeconds)]);
    const [youtubeReadiness, setYouTubeReadiness] = useState({ key: youtubeKey, ready: false });
    // Each replacement starts unloaded, including when navigation returns to a prior query.
    if (youtubeReadiness.key !== youtubeKey) setYouTubeReadiness({ key: youtubeKey, ready: false });
    const setYouTubeReady = useCallback((ready: boolean) => {
        setYouTubeReadiness(current => current.key === youtubeKey && current.ready !== ready
            ? { key: youtubeKey, ready } : current);
    }, [youtubeKey]);
    const externalPlayer = useRef<HTMLIFrameElement>(null);
    const [embed, setEmbed] = useState({ url: video.url, initialSeconds, loaded: false, seconds: initialSeconds, request: 0 });
    if (embed.url !== video.url || !Object.is(embed.initialSeconds, initialSeconds)) {
        setEmbed({ url: video.url, initialSeconds, loaded: false, seconds: initialSeconds, request: 0 });
    }
    const embedUrl = video.source === 'bilibili' ? bilibiliPlayerUrl(video.url, embed.seconds) : null;
    useEffect(() => {
        if (embed.loaded && embed.request > 0) externalPlayer.current?.scrollIntoView?.({ block: 'center' });
    }, [embed.loaded, embed.request]);
    const key = useRef(createRequestKey());
    const submitting = useRef(false);
    const writeRequest = useRef<AbortController | null>(null);
    const composerInput = useRef<HTMLTextAreaElement>(null);
    const [route] = useState(() => slots ? '/trainings/' + video.trainingId : currentRoute());
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
    const confirmation = useRef<HTMLDialogElement>(null);
    const confirmationTitle = useId();
    const confirmationTrigger = useRef<HTMLElement | null>(null);
    const [pendingAction, setPendingAction] = useState<{ action: 'hide' | 'restore' | 'report' | 'delete'; comment: Comment } | null>(null);
    const [moderationReason, setModerationReason] = useState('');
    function dismissAction() {
        if (confirmation.current?.open) confirmation.current.close();
        setPendingAction(null);
        setModerationReason('');
        setError('');
        confirmationTrigger.current?.focus();
    }
    function requestAction(action: 'hide' | 'restore' | 'report' | 'delete', comment: Comment) {
        confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setError('');
        setPendingAction({ action, comment });
        setModerationReason('');
        confirmation.current?.showModal();
    }
    const actionLabel = pendingAction?.action === 'hide' ? '隐藏' : pendingAction?.action === 'restore' ? '恢复' : pendingAction?.action === 'delete' ? '删除' : '举报';
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState<Feedback | null>(null);
    const [playerStatus, setPlayerStatus] = useState<Feedback | null>(null);
    const [playable, setPlayable] = useState(false);
    const [mediaGeneration, setMediaGeneration] = useState(0);
    const [timeToolsOpen, setTimeToolsOpen] = useState(false);
    const showTimeTools = timeToolsOpen || timeDraft !== null;

    const [shown, setShown] = useState<Record<string, boolean>>(saved?.shown ?? {});
    const writable = video.training.status === 'published';
    const initialTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(true);
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
    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            writeRequest.current?.abort();
            seek.dispose();
        };
    }, [seek]);
    useLayoutEffect(() => {
        const media = player.current;
        if (!slots || !media) return;
        return () => {
            media.pause();
            media.removeAttribute('src');
            media.load();
        };
    }, [mediaGeneration, slots]);
    useEffect(() => {
        const timer = setTimeout(() => { const media = player.current; if (media && !media.closest('[hidden]')) setPlayable(media.readyState >= 1); }, 0);
        return () => clearTimeout(timer);
    }, [video]);
    useEffect(() => {
        const timer = setTimeout(() => {
            if (initialSeconds === undefined) return;
            if (!Number.isSafeInteger(initialSeconds) || initialSeconds < 0) { setPlayerStatus({ kind: 'error', text: '时间点需为有效的非负整数秒。' }); return; }
            if (video.source === 'upload') seek.request(video.id, initialSeconds, player.current);
        }, 0);
        initialTimer.current = timer;
        return () => clearTimeout(timer);
    }, [initialSeconds, seek, video.id, video.source]);
    useEffect(() => {
        const id = window.location.hash.slice(1);
        if (!/^comment-[a-zA-Z0-9_-]{1,80}$/.test(id)) return;
        const timer = setTimeout(() => {
            const comment = comments.find(c => 'comment-' + c.id === id && readable(c));
            if (!comment) { setStatus({ kind: 'error', text: '这条讨论当前不可用。' }); return; }
            if (comment.rootId) setShown(current => ({ ...current, [comment.rootId!]: true }));
            window.requestAnimationFrame(() => {
                if (!mounted.current || window.location.hash !== '#' + id) return;
                const node = document.getElementById(id);
                if (node?.closest('[hidden]')) return;
                node?.scrollIntoView?.({ block: 'center' }); node?.focus();
            });
        }, 0);
        return () => clearTimeout(timer);
    }, [comments]);
    useLayoutEffect(() => session.subscribe(ended => {
        if (confirmation.current?.open) confirmation.current.close();
        setPendingAction(null);
        setModerationReason('');
        clearTimeout(initialTimer.current);
        writeRequest.current?.abort();
        // Hiding an iframe does not stop audio. Unload it synchronously on every lock.
        if (externalPlayer.current) externalPlayer.current.src = 'about:blank';
        setEmbed(current => ({ ...current, loaded: false, seconds: undefined, request: 0 }));
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
            if (slots) {
                media.removeAttribute('src');
                media.load();
                setMediaGeneration(current => current + 1);
            }
        }
    }), [session, seek, buffer, slots]);
    async function change(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST', onSaved?: () => void) {
        if (submitting.current) return;
        submitting.current = true;
        setError(''); setStatus(null); setBusy(true);
        let generation: number | undefined;
        try {
            generation = await session.authorize();
            if (!mounted.current || !session.isCurrent(generation)) return;
            const request = new AbortController();
            writeRequest.current = request;
            await api(path, { method, actorId, body, key: key.current(actorId, body) }, undefined, request.signal);
            if (!mounted.current || !session.isCurrent(generation)) return;
            writeRequest.current = null;
            acknowledgeMutation(actorId, method, path, body);
            // Refresh begins synchronously; no response from this mutation can reopen an older epoch.
            void session.verify();
            onSaved?.();
        } catch (e) {
            if (!mounted.current || (generation !== undefined && !session.isCurrent(generation))) return;
            setError(message(e));
            if (e instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'READ_ONLY', 'VERSION_CONFLICT'].includes(e.code)) {
                if (pendingAction) dismissAction();
                setError(message(e));
                void session.verify();
            }
        } finally {
            writeRequest.current = null;
            submitting.current = false;
            if (mounted.current) setBusy(false);
        }
    }
    function jump(n: number) {
        setError('');
        if (video.source === 'youtube') {
            youtubePlayer.current?.seekTo(n);
            return;
        }
        if (video.source === 'bilibili') {
            if (!Number.isSafeInteger(n) || n < 0 || (video.durationSec !== null && n > video.durationSec)) {
                setPlayerStatus({ kind: 'error', text: '时间点需为视频范围内的非负整数秒。' }); return;
            }
            const frame = externalPlayer.current;
            const loaded = embed.loaded && frame && !frame.closest('[hidden]') && frame.getAttribute('src') !== 'about:blank';
            // A new frame also repeats an identical target. Ordinary composer renders keep its key/src.
            setEmbed(current => ({ ...current, seconds: n, request: current.request + 1 }));
            setPlayerStatus({ kind: 'neutral', text: loaded
                ? `已请求从 ${stamp(n)} 加载播放器；如未开始播放，请点击播放。`
                : `请先载入 B 站视频，将保留 ${stamp(n)} 的定位。` });
            return;
        }
        seek.request(video.id, n, player.current);
    }
    const canReadTime = video.source === 'youtube' ? youtubeReadiness.key === youtubeKey && youtubeReadiness.ready : playable;
    function renderComment(c: Comment) {
        // A null target name is authoritative. A visible target is only needed to identify a self-reply.
        const target = c.rootId && c.replyTargetName ? visibleComment(c.replyToId ?? c.rootId) : undefined;
        const targetName = target?.authorId === c.authorId ? '自己' : c.replyTargetName ?? unavailable;
        return <article id={'comment-' + c.id} tabIndex={-1} className={'discussion' + (c.rootId ? ' reply' : '')}>
            <span className="default-avatar" aria-hidden="true">{Array.from(c.authorName)[0] || '队'}</span>
            <div className="discussion-content">
                <header className="discussion-heading">
                  <div className="discussion-meta">
                    <strong>{c.authorName}</strong>
                    {c.authorJerseyNumber && <span>#{c.authorJerseyNumber}</span>}
                    {c.rootId && <span className="discussion-recipient">回复 {targetName}</span>}
                    <time dateTime={c.createdAt}>发表于 {discussionTime.format(new Date(c.createdAt))}</time>
                    {!!c.edited && <span>已编辑</span>}
                  </div>
                {c.timestampSec !== null && <button type="button" className="video-time-chip" onClick={() => jump(c.timestampSec!)} aria-label={`讨论时间点 ${stamp(c.timestampSec)}`}><span className="discussion-time-prefix">讨论时间点 </span>{stamp(c.timestampSec)}</button>}
                </header>
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
                                        onClick={() => requestAction('delete', c)}
                                    >删除
                                    </button>
                                </>}
                                {<button
                                    className="secondary"
                                    disabled={busy}
                                    onClick={() => requestAction('report', c)}
                                >举报
                                </button>}
                                {admin && <button
                                    className="secondary danger"
                                    disabled={busy}
                                    onClick={() => requestAction('hide', c)}
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
                            onClick={() => requestAction('restore', c)}
                        >管理员恢复</button>
                    </details>}
                </div>
            </div>
        </article>;
    }
    const dialog = <dialog ref={confirmation} data-own-buffer className="add-video-dialog" aria-labelledby={confirmationTitle}
        onCancel={e => { e.preventDefault(); if (!submitting.current) dismissAction(); }}>
        <h2 id={confirmationTitle}>确认{actionLabel}讨论</h2>
        {pendingAction?.action === 'delete' ? <p>删除自己的这条讨论？独立回复和本人备注会保留。</p> : <label>
            {actionLabel}原因
            <textarea name="moderationReason" disabled={busy} value={moderationReason} onChange={e => setModerationReason(e.target.value)} />
        </label>}
        {error && <p role="alert">{error}</p>}
        <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={dismissAction}>取消</button>
            <button type="button" disabled={busy || !pendingAction || (pendingAction.action !== 'delete' && !moderationReason.trim())} onClick={() => {
                if (!pendingAction || submitting.current) return;
                const { action, comment } = pendingAction;
                const reason = moderationReason.trim();
                if (action !== 'delete' && !reason) return;
                if (action === 'delete') {
                    void change(`videos/${video.id}/comments/${comment.id}`, { action, expectedVersion: comment.version }, 'PATCH',
                        () => { dismissAction(); setStatus({ kind: 'success', text: '讨论已删除。' }); });
                } else {
                    void change(`comments/${comment.id}/moderation`, { action, reason }, 'POST',
                        () => { dismissAction(); setStatus({ kind: 'success', text: action === 'report' ? '举报已提交。' : action === 'hide' ? '讨论已隐藏。' : '讨论已恢复。' }); });
                }
            }}>确认{actionLabel}</button>
        </div>
    </dialog>;
    const showBilibiliDetailLinks = !slots || slots.isLegacyVideo;
    const youtube = video.source === 'youtube';
    const titleSourceLabel = youtube ? '在 YouTube 打开（新标签）' : '在 B 站打开（新标签）';
    let titleSourceUrl: string | undefined;
    if (slots && video.url) {
        if (youtube) titleSourceUrl = parseYouTubeSource(video.url)?.url;
        else if (embedUrl && !showBilibiliDetailLinks) titleSourceUrl = video.url;
    }
    const stageIdentity = slots && video.source !== 'upload' ? <WatchMediaIdentity source={video.source} title={video.title} /> : undefined;
    const stage = <section className="video-stage" aria-label="视频播放器">
        {video.source === 'upload' ?
            <video
                key={mediaGeneration}
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
            /> : video.source === 'youtube' ?
                <YouTubePlayer key={youtubeKey} url={video.url} initialSeconds={initialSeconds} ref={youtubePlayer}
                    setPlayable={setYouTubeReady} waitingIdentity={stageIdentity} waitingTitle={slots ? video.title : undefined}
                    hideExternalLink={!!slots} />
                : <div className="external-video-player">
                    {embedUrl && embed.loaded ? <iframe
                        key={embed.request}
                        ref={externalPlayer}
                        data-kapok-player="bilibili"
                        className="video-player bilibili-player"
                        src={embedUrl}
                        title={`${video.title} · B站播放器`}
                        allow="fullscreen; picture-in-picture; encrypted-media"
                        allowFullScreen
                        referrerPolicy="no-referrer"
                        onErrorCapture={event => {
                            if (event.currentTarget !== externalPlayer.current || event.currentTarget.closest('[hidden]')) return;
                            setEmbed(current => ({ ...current, loaded: false }));
                            setPlayerStatus({ kind: 'error', text: 'B 站播放器加载失败，可重新载入或在原站打开。' });
                        }}
                    /> : embedUrl && <>
                        {stageIdentity}
                        <button type="button" className={slots ? 'training-stage-play' : undefined}
                            aria-label={slots ? `载入 B 站视频：${video.title}` : undefined} onClick={e => {
                            if (e.currentTarget.closest('[hidden]')) return;
                            setEmbed(current => ({ ...current, loaded: true, seconds: current.seconds ?? initialSeconds }));
                            setPlayerStatus({ kind: 'neutral', text: '已载入 B 站播放器；如无法播放，可在原站打开。' });
                        }}>
                            {slots && <span className="training-stage-play-icon"><Play size={21} aria-hidden="true" /></span>}
                            载入 B 站视频
                        </button>
                    </>}
                    {showBilibiliDetailLinks && embedUrl && video.url && <a className="button secondary" href={video.url} target="_blank" rel="noopener noreferrer">在 B 站打开（新标签）</a>}
                </div>}
        {playerStatus && !playerStatus.source && <p className={`notice ${playerStatus.kind}`} role={playerStatus.kind === 'error' ? 'alert' : 'status'}>{playerStatus.text}</p>}
    </section>;
    const actions = <div className="video-actions">
        <details className="video-note-disclosure">
            <summary><Bookmark size={16} aria-hidden="true" />收藏与备注</summary>
            <SaveCollection actorId={actorId} sourceKind="video" sourceId={video.id} privateNote timestampSec={seconds === '' ? null : Number(seconds)} />
        </details>
        <Link className="video-reflection-link" href={`/reflections/new?training=${video.trainingId}&video=${video.id}`}><ReflectionIcon size={16} aria-hidden="true" />写复盘</Link>
    </div>;
    const detail = <header className="video-detail-header">
        {!slots && <h2>{video.title}</h2>}
        <div className="video-detail-links">
            {!slots && <p className="detail-meta"><Link href={'/trainings/' + video.trainingId}>关联训练：{video.training.title}</Link><time dateTime={video.training.date}>{video.training.date}</time></p>}
            <details className="video-source-disclosure" open={video.source === 'bilibili' && !embedUrl ? true : undefined}>
                <summary>播放来源</summary>
                <div className="video-source-info">
                    <p className="small">{video.source === 'upload' ? '私有合成短片 · 仅有效队员可播放。' : video.source === 'youtube' ? 'YouTube 视频 · 载入后连接至 YouTube。' : '若 B 站限制播放或加载失败，可在原站打开。讨论时间点需手动填写。'} {video.durationSec !== null && stamp(video.durationSec)}</p>
                    {video.source === 'bilibili' && <>
                        <div className="actions video-external-actions">
                            {showBilibiliDetailLinks && <a className="button secondary" href={video.url!} target="_blank" rel="noopener noreferrer">原站观看 · 新标签 <ArrowUpRight size={16} aria-hidden="true" />
                            </a>}
                            <button
                                className="secondary"
                                onClick={async () => {
                                    setPlayerStatus({ kind: 'neutral', text: '正在复制原站地址…', source: true });
                                    try {
                                        const generation = await session.authorize();
                                        if (!mounted.current || !session.isCurrent(generation)) return;
                                        await navigator.clipboard.writeText(video.url!);
                                        if (!mounted.current || !session.isCurrent(generation)) return;
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
    </header>;
    const rootThreads = comments.filter(c => !c.rootId).map(c => {
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
    });
    const threads = <section className="video-discussion-list" aria-labelledby="video-discussion-heading">
        {slots ? <header className="training-discussion-heading">
            <h2 id="video-discussion-heading">视频讨论</h2>
            <p>{video.title}</p>
        </header> : <h2 id="video-discussion-heading">讨论</h2>}
        {initialComments === null && !current?.rows ? (current?.error
            ? <p role="alert">{current.error} <button onClick={() => { setReadback(null); setAttempt(n => n + 1); }}>重新加载讨论</button></p>
            : <p role="status">正在加载讨论…</p>) : comments.length ? slots ? <div className="training-discussion-threads">{rootThreads}</div> : rootThreads
            : <p className="panel">还没有讨论，留下训练中想记住的一刻。</p>}
        {!writable && <p className="notice">此训练当前只可回看，不接受新讨论。</p>}
    </section>;
    const dock = <>
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
                    {video.source !== 'bilibili' && <button
                        type="button"
                        className="secondary"
                        disabled={busy || !canReadTime}
                        onClick={() => {
                            const n = video.source === 'youtube' ? youtubePlayer.current?.currentTime() : player.current?.currentTime;
                            if (n === undefined || !Number.isFinite(n) || n < 0) { setError('播放器当前时间不可读。'); return; }
                            updateDraft({ seconds: String(Math.floor(n)), timeDraft: null });
                            setError('');
                        }}
                    >{seconds === '' ? '添加当前视频时间' : '更新为当前视频时间'}
                    </button>}
                </div>
                <p className="small">时间标注选填；添加后固定，不随播放变化。可不附加时间发送。</p>
                {video.source !== 'bilibili' && !canReadTime && <p className="muted">媒体就绪后，可读取播放器的当前秒数。
                </p>}
            </div>
        </form>
        </>;

    if (slots) return <>
        {dialog}
        {createPortal(stage, slots.stage)}
        {titleSourceUrl && createPortal(
            <a className={youtube ? 'training-title-action training-title-youtube' : 'training-title-action'}
                href={titleSourceUrl} target="_blank" rel="noopener noreferrer"
                aria-label={titleSourceLabel} title={titleSourceLabel}
                onClick={event => { if (event.currentTarget.closest('[hidden]')) event.preventDefault(); }}>
                <ExternalLink size={18} aria-hidden="true" />
            </a>,
            slots.providerLink
        )}
        {createPortal(
            <SaveCollection actorId={actorId} sourceKind="video" sourceId={video.id} privateNote
                watch={{ source: video, trigger: slots.noteTrigger }} timestampSec={seconds === '' ? null : Number(seconds)} />,
            slots.note
        )}
        {detail}
        {threads}
        {createPortal(dock, slots.dock)}
    </>;

    return <div className="video-discussion-layout">
        {dialog}
        <div className="video-discussion-scroll" role="region" aria-label="视频与讨论内容" tabIndex={0}>
            <div className="video-content">{stage}{actions}{detail}{threads}</div>
        </div>
        <div className="video-discussion-dock">{dock}</div>
    </div>;
}
