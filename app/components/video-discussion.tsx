'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Comment, Training, Video } from '../../lib/contracts/training';
import type { BootstrapStatus } from '../../lib/contracts';
import Link from 'next/link';
import { AccountBoundary, useAccountSession } from './secure-resource';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { bilibiliPlayerUrl } from '../../lib/client/bilibili';
import { createVideoSeek } from '../../lib/client/video-seek';
import { acknowledgeMutation, navigationBuffer, currentRoute } from '../../lib/client/navigation-state';
import { SaveCollection } from './collections';
const message = (e: unknown) => e instanceof Error ? e.message : '操作未完成，请保留输入重试。';
const stamp = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
type Snapshot = { video: Video & { training: Training }; comments: Comment[]; userId: string; admin: boolean };
export function VideoDiscussion({ actorId, videoId, initialSeconds }: {
    actorId: string; videoId: string; initialSeconds?: number;
}) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal): Promise<Snapshot> => {
        if (account.me.membership?.status !== 'active' || !account.me.user) throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有队伍访问权限。', retryable: false }, requestId: '' });
        const comments = await api<Comment[]>(`videos/${videoId}/comments`, undefined, actorId, signal);
        // Re-read the source after comments, so a removed/archived source cannot retain old write controls.
        const latest = await api<Snapshot['video']>(`videos/${videoId}`, undefined, actorId, signal);
        return { video: latest, comments, userId: account.me.user.id, admin: account.me.membership.role === 'admin' };
    }, [actorId, videoId]);
    return <AccountBoundary key={videoId} actorId={actorId} load={load}>{snapshot => <Discussion actorId={actorId} {...snapshot} initialSeconds={initialSeconds} />}</AccountBoundary>;
}
function Discussion({ actorId, userId, admin, video, comments, initialSeconds }: Snapshot & { actorId: string; initialSeconds?: number }) {
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
    const [buffer] = useState(() => navigationBuffer(actorId, currentRoute(), 'discussion:' + video.id));
    const [saved] = useState(() => buffer.read<{ text: string; seconds: string; replyId: string | null; editId: string | null; editVersion: number | null; timeDraft: string | null; shown: Record<string, boolean> }>());
    const validSaved = (!saved?.editId || comments.some(c => c.id === saved.editId && c.authorId === userId && c.text !== null));
    const [text, setText] = useState(validSaved ? saved?.text ?? '' : '');
    const [seconds, setSeconds] = useState(validSaved ? saved?.seconds ?? '' : '');
    const [reply, setReply] = useState<Pick<Comment, 'id'> | null>(saved?.replyId ? { id: saved.replyId } : null);
    const currentReply = reply ? comments.find(c => c.id === reply.id && !c.rootId && c.text !== null && c.status === 'active') : null;
    const replyUnavailable = !!reply && !currentReply;
    const [timeDraft, setTimeDraft] = useState<string | null>(saved?.timeDraft ?? null);
    const [edit, setEdit] = useState<Pick<Comment, 'id' | 'version'> | null>(() => { const current = comments.find(c => c.id === saved?.editId && c.authorId === userId && c.text !== null); return current ? { id: current.id, version: saved?.editVersion ?? current.version } : null; });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState<{ kind: 'neutral' | 'success' | 'error'; text: string } | null>(null);
    const [playable, setPlayable] = useState(false);

    const [shown, setShown] = useState<Record<string, boolean>>(saved?.shown ?? {});
    const writable = video.training.status === 'published';
    const initialTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [seek] = useState(() => createVideoSeek((kind, text) => setStatus({ kind, text })));
    useEffect(() => { buffer.write({ text, seconds, replyId: reply?.id ?? null, editId: edit?.id ?? null, editVersion: edit?.version ?? null, timeDraft, shown }); }, [buffer, text, seconds, reply, edit, timeDraft, shown]);
    useEffect(() => () => seek.dispose(), [seek]);
    useEffect(() => {
        const timer = setTimeout(() => { const media = player.current; if (media && !media.closest('[hidden]')) setPlayable(media.readyState >= 1); }, 0);
        return () => clearTimeout(timer);
    }, [video]);
    useEffect(() => {
        const timer = setTimeout(() => {
            if (initialSeconds === undefined) return;
            if (!Number.isSafeInteger(initialSeconds) || initialSeconds < 0) { setStatus({ kind: 'error', text: '时间点需为有效的非负整数秒。' }); return; }
            if (video.source === 'bilibili') setStatus({ kind: 'neutral', text: `已请求从 ${stamp(initialSeconds)} 加载播放器；如未开始播放，请点击播放。` });
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
        // Hiding an iframe does not stop audio. Unload it synchronously on every lock.
        if (externalPlayer.current) externalPlayer.current.src = 'about:blank';
        setEmbed(current => ({ ...current, visible: false, seconds: undefined, request: 0 }));
        seek.clear();
        setStatus(null);
        setPlayable(false);
        if (ended) {
            buffer.clear();
            setText('');
            setSeconds('');
            setTimeDraft(null);
            setReply(null);
            setEdit(null);
            setShown({});
            key.current = createRequestKey();
        }
        const media = player.current;
        if (media) {
            media.pause();
        }
    }), [session, seek, buffer]);
    async function change(path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') {
        if (submitting.current) return false;
        submitting.current = true;
        setError(''); setStatus(null); setBusy(true);
        try {
            const generation = await session.authorize();
            await api(path, { method, actorId, body, key: key.current(actorId, body) });
            if (!session.isCurrent(generation)) return false;
            acknowledgeMutation(actorId, method, path, body);
            // Refresh begins synchronously; no response from this mutation can reopen an older epoch.
            void session.verify();
            return true;
        } catch (e) {
            setError(message(e));
            if (e instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'READ_ONLY'].includes(e.code)) void session.verify();
            return false;
        } finally { submitting.current = false; setBusy(false); }
    }
    function jump(n: number) {
        setError('');
        if (video.source === 'bilibili') {
            if (!Number.isSafeInteger(n) || n < 0 || (video.durationSec !== null && n > video.durationSec)) {
                setStatus({ kind: 'error', text: '时间点需为视频范围内的非负整数秒。' }); return;
            }
            const frame = externalPlayer.current;
            if (!embed.visible || !frame || frame.closest('[hidden]') || frame.getAttribute('src') === 'about:blank') return;
            // A new frame also repeats an identical target. Ordinary composer renders keep its key/src.
            setEmbed(current => ({ ...current, seconds: n, request: current.request + 1 }));
            setStatus({ kind: 'neutral', text: `已请求从 ${stamp(n)} 加载播放器；如未开始播放，请点击播放。` });
            return;
        }
        seek.request(video.id, n, player.current);
    }
    function renderComment(c: Comment, isReply = false) {
        return <article key={c.id} id={'comment-' + c.id} tabIndex={-1} className={'discussion' + (isReply ? ' reply' : '')}>
            <header>
                <span className="default-avatar" aria-label="默认头像">{Array.from(c.authorName)[0] || '队'}</span>
                <span>{c.authorName} · {c.authorJerseyNumber ?? ''}</span>
                {isReply && <span>回复 {c.replyTargetName ?? comments.find(root => root.id === c.rootId)?.authorName ?? '原讨论作者'}</span>}
                <time dateTime={c.createdAt}>发表于 {new Date(c.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time>
                {!!c.edited && <span>已编辑
                </span>}
            </header>
            {c.timestampSec !== null && <button type="button" className="video-time-chip" onClick={() => jump(c.timestampSec!)} aria-label={`讨论时间点 ${stamp(c.timestampSec)}`}>讨论时间点 {stamp(c.timestampSec)}</button>}
            <p className="preserve">
                {c.text ?? (c.status === 'deleted' ? '原讨论已删除' : '讨论已隐藏')}
            </p>
            {c.text !== null && <>
                {writable && !isReply && <div className="actions">
                    <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                            setReply({ id: c.id });
                            setEdit(null);
                            document.getElementById('comment-input')?.focus();
                        }}
                    >回复
                    </button>
                </div>}
                <details className="comment-more">
                    <summary>更多操作<span className="muted"> · {c.authorName}的讨论</span></summary>
                    <div className="actions">
                    {writable && c.authorId === userId && <>
                        <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                                setEdit({ id: c.id, version: c.version });
                                setReply(null);
                                setText(c.text!);
                                setSeconds(c.timestampSec === null ? '' : String(c.timestampSec));
                                setTimeDraft(null);
                                document.getElementById('comment-input')?.focus();
                            }}
                        >编辑本人讨论
                        </button>
                        <button
                            className="secondary danger"
                            disabled={busy}
                            onClick={async () => {
                                if (window.confirm('删除自己的这条讨论？独立回复和本人备注会保留。')) {
                                    if (await change(`videos/${video.id}/comments/${c.id}`, { action: 'delete', expectedVersion: c.version }, 'PATCH'))
                                        setStatus({ kind: 'success', text: '讨论已删除。' });
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
                            if (reason?.trim() && await change(`comments/${c.id}/moderation`, { action: 'report', reason }))
                                setStatus({ kind: 'success', text: '举报已提交。' });
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
            >管理员恢复
            </button></details>}
        </article>;
    }
    return <>
        <p><Link className="back-link" href={'/trainings/' + video.trainingId}>返回所属训练</Link></p>
        <h2>{video.title}</h2>
        <p>{video.training.title} · {video.training.date} · {video.source === 'upload' ? '私有合成短片' : 'B站引用'}</p>
        <section className="video-source" aria-label="视频来源">
            {video.source === 'upload' ? <>
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
                        setStatus(null);
                        setPlayable(false);
                        setError('短片暂不可播放，讨论与本人引用仍保留，请联系管理员处理。');
                    }}
                    onSeeked={event => seek.seeked(video.id, event.currentTarget)}
                />
                <p className="muted">私有合成短片 · 仅有效队员可播放。
                </p>
            </> : <>
                {embedUrl && embed.visible && <iframe
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
                <p className="muted">点击播放器即可观看。若 B 站限制播放或加载失败，可在原站打开。讨论时间点需手动填写。</p>
                <div className="actions">
                    <a className="button" href={video.url!} target="_blank" rel="noopener noreferrer">原站观看 · 新标签
                    </a>
                    <button
                        className="secondary"
                        onClick={async () => {
                            setError('');
                            setStatus({ kind: 'neutral', text: '正在复制原站地址…' });
                            try {
                                const generation = await session.authorize();
                                await navigator.clipboard.writeText(video.url!);
                                if (!session.isCurrent(generation)) return;
                                setStatus({ kind: 'success', text: '原站地址已复制。' });
                            }
                            catch {
                                setStatus({ kind: 'error', text: '复制未成功，请手动选择下方地址。' });
                            }
                        }}
                    >复制地址
                    </button>
                </div>
                <label>原站地址
                    <input readOnly value={video.url!} onFocus={e => e.currentTarget.select()} />
                </label>
            </>}
            <SaveCollection
                actorId={actorId}
                sourceKind="video"
                sourceId={video.id}
                privateNote
                timestampSec={seconds === '' ? null : Number(seconds)}
            />
        </section>
        <section className="section">
            <h2>训练讨论
            </h2>
            <form className="discussion-composer" data-buffer-id="discussion" data-own-buffer hidden={!writable}
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy)
                        return;
                    if (timeDraft !== null) { setError('请先确认或取消时间修改。'); return; }
                    if (replyUnavailable) { setError('回复对象当前不可用，草稿仍保留，请选择其他讨论或取消回复并清除草稿。'); return; }
                    const timestamp = seconds === '' ? null : Number(seconds);
                    if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0 || (video.durationSec !== null && timestamp > video.durationSec))) { setError('时间点需为视频范围内的非负整数秒。'); return; }
                    const body = {
                        text,
                        timestampSec: seconds === '' ? null : Number(seconds),
                        ...(edit ? { expectedVersion: edit.version } : { rootId: reply?.id ?? null })
                    };
                    if (await change(`videos/${video.id}/comments${edit ? '/' + edit.id : ''}`, body, edit ? 'PATCH' : 'POST')) {
                        setText('');
                        setSeconds('');
                        setTimeDraft(null);
                        buffer.clear();
                        setReply(null);
                        setEdit(null);
                        setStatus({ kind: 'success', text: edit ? '本人讨论已保存。' : '讨论已发送。' });
                        key.current = createRequestKey();
                    }
                }}
            >
                {(reply || edit) && <p>
                    {edit ? '正在编辑本人讨论' : `回复 ${currentReply?.authorName ?? '当前不可用的讨论'}`}
                    <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                            setReply(null);
                            setEdit(null);
                            setText('');
                            setSeconds('');
                            setTimeDraft(null);
                            buffer.clear();
                        }}
                    >{edit ? '取消编辑并清除草稿' : '取消回复并清除草稿'}
                    </button>
                </p>}
                {replyUnavailable && <p className="notice error" role="alert">回复对象当前不可用，草稿仍保留。请选择其他可读讨论，或取消回复并清除草稿。</p>}
                <div className="composer-row">
                <label htmlFor="comment-input">
                    {edit ? '编辑讨论' : '想说的话'}
                    <textarea
                        id="comment-input"
                        ref={node => { if (node) { node.style.height = 'auto'; node.style.height = node.scrollHeight + 'px'; } }}
                        value={text}
                        disabled={busy}
                        onChange={e => { setText(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; }}
                        maxLength={2000}
                        rows={1}
                        style={{ maxHeight: 160, overflowY: 'auto' }}
                        required
                    />
                </label>
                <button disabled={busy}>
                    {busy ? '正在保存…' : edit ? '保存本人讨论' : '发送讨论'}
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
                        onChange={e => setTimeDraft(e.target.value)}
                    />
                </label>

                {timeDraft !== null && <>
                    <p role="status">时间修改尚未确认；确认或取消后再发送。</p>
                    <div className="actions">
                        <button type="button" disabled={busy} onClick={() => {
                            const n = timeDraft === '' ? null : Number(timeDraft);
                            if (n !== null && (!Number.isSafeInteger(n) || n < 0 || (video.durationSec !== null && n > video.durationSec))) { setError('时间点需为视频范围内的非负整数秒。'); return; }
                            setSeconds(timeDraft); setTimeDraft(null); setError('');
                        }}>确认时间点</button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => { setTimeDraft(null); setError(''); }}>取消时间修改</button>
                    </div>
                </>}
                </div>
                {seconds !== '' && <div className="selected-time">
                    <button type="button" className="video-time-chip" disabled={busy} onClick={() => jump(Number(seconds))}>已添加时间点 {stamp(Number(seconds))}（已固定）</button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => setTimeDraft(seconds)}>修改时间点</button>
                </div>}
                <div className="actions time-tools">
                    {seconds === '' && timeDraft === null && <button type="button" className="secondary" disabled={busy} onClick={() => setTimeDraft('')}>手动添加时间点</button>}
                    <button
                        type="button"
                        className="secondary"
                        disabled={busy || (seconds === '' && timeDraft === null)}
                        onClick={() => { setSeconds(''); setTimeDraft(null); }}
                    >去掉时间点
                    </button>
                    {video.source === 'upload' && <button
                        type="button"
                        className="secondary"
                        disabled={busy || !playable}
                        onClick={() => { const n = player.current?.currentTime; if (n === undefined || !Number.isFinite(n) || n < 0) { setError('播放器当前时间不可读。'); return; } setSeconds(String(Math.floor(n))); setTimeDraft(null); }}
                    >添加当前视频时间
                    </button>}
                </div>
                <p className="small">时间标注选填；添加后固定，不随播放变化。可不附加时间发送。</p>
                {video.source === 'upload' && !playable && <p className="muted">媒体就绪后，可读取播放器的当前秒数。
                </p>}

            </form>
            {!writable && <p className="notice">此训练当前只可回看，不接受新讨论。</p>}
            {error && <p className="notice error" role="alert">
                {error}
            </p>}
            {status && <p className={`notice ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>
                {status.text}
            </p>}
            {comments.length ? comments.filter(c => !c.rootId).map(c => {
                const replies = comments.filter(r => r.rootId === c.id);
                const expanded = shown[c.id];
                return <section className="discussion-card panel" key={c.id}>
                    {renderComment(c)}
                    <div className="discussion-replies">{(expanded ? replies : replies.slice(0, 3)).map(r => renderComment(r, true))}</div>
                    {replies.length > 3 && <button className="secondary" onClick={() => setShown({ ...shown, [c.id]: !expanded })}>
                        {expanded ? '收起回复' : '展开回复'}
                    </button>}
                </section>;
            }) : <p className="panel">还没有讨论，留下训练中想记住的一刻。
            </p>}
        </section>
        <Link className="row-link" href={`/reflections/new?training=${video.trainingId}&video=${video.id}`}>写这段视频的复盘 →</Link>
    </>;
}
