'use client';
import { ReflectionIcon } from './reflection-icon';
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { Bookmark, LockKeyhole, Pencil, Trash2 } from 'lucide-react';
import type { Collection, Video } from '../../lib/contracts/training';
import { learningReflectionHref, type LearningSourceKind } from '../../lib/contracts/reflections';
import { acknowledgeMutation, clearFormUI, navigationBuffer, useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { DateGroup } from './presentation';
import { AccountBoundary, useAccountSession, useOptionalAccountSession } from './secure-resource';
const message = (e: unknown) => e instanceof Error ? e.message : '未能保存，请保留内容重试。';
type SaveProps = { actorId: string; sourceKind: Collection['sourceKind']; sourceId: string; timestampSec?: number | null; privateNote?: boolean; watch?: { source: Video; trigger: HTMLElement } };
export function SaveCollection(props: SaveProps) {
    const session = useOptionalAccountSession();
    if (props.watch) return <WatchVideoNote actorId={props.actorId} {...props.watch} timestampSec={props.timestampSec ?? null} />;
    return session ? <CollectionEditor {...props} /> : <AccountBoundary actorId={props.actorId} load="me">{() => <CollectionEditor {...props} />}</AccountBoundary>;
}
export function LearningBookmark({ actorId, sourceKind, sourceId, showReflection = true }: {
    actorId: string; sourceKind: LearningSourceKind; sourceId: string; showReflection?: boolean;
}) {
    return <div>
        <AccountBoundary<Collection[]> actorId={actorId} load="collections">{items => {
            const item = items.find(row => row.sourceKind === sourceKind && row.sourceId === sourceId);
            return item ? <CollectionCard compact actorId={actorId} item={item} /> :
                <CollectionEditor actorId={actorId} sourceKind={sourceKind} sourceId={sourceId} privateNote refreshOnSave />;
        }}</AccountBoundary>
        {showReflection && <Link className="button secondary" href={learningReflectionHref(sourceKind, sourceId)}><ReflectionIcon size={16} aria-hidden="true" />想和写</Link>}
    </div>;
}

function CollectionEditor({ actorId, sourceKind, sourceId, timestampSec, privateNote = false, refreshOnSave = false }: SaveProps & { refreshOnSave?: boolean }) {
    const session = useAccountSession();
    const [open, setOpen] = useNavigationField(actorId, `collection-open:${sourceKind}:${sourceId}`, privateNote);
    const [note, setNote] = useNavigationField(actorId, `collection-new-note:${sourceKind}:${sourceId}`, '');
    const [pending, setPending] = useNavigationField<{ sourceKind: Collection['sourceKind']; sourceId: string;
        timestampSec: number | null; privateNote: string } | null>(actorId, `collection-new-save:${sourceKind}:${sourceId}`, null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    const key = useRef(createRequestKey());
    if (done) return <div className="notice success collection-saved">
        <p role="status">{privateNote ? '私人备注已保存到账号。' : '已加入本人成长。'}</p>
        <Link href="/growth">管理私人备注</Link>
    </div>;
    return <section className={privateNote ? 'private-note' : 'collection-action'}>
        {privateNote && <><h2><Bookmark size={18} aria-hidden="true" />收藏与私人备注</h2><p className="privacy-line"><LockKeyhole size={16} aria-hidden="true" />仅自己可见，可在成长中回看。</p></>}
        {!privateNote && <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}><Bookmark size={16} aria-hidden="true" />{open ? '收起收藏表单' : '加入成长'}</button>}
        <form data-buffer-id={`collection-new:${sourceKind}:${sourceId}`} hidden={!privateNote && !open} onSubmit={async e => {
            e.preventDefault();
            if (busy) return;
            const body = pending ?? { sourceKind, sourceId, timestampSec: timestampSec ?? null, privateNote: note };
            if (refreshOnSave) setPending(body);
            setBusy(true); setError('');
            try {
                const generation = await session.authorize();
                const receipt = await api<{ id: string }>('collections', { method: 'POST', actorId, body, key: key.current(actorId, body) });
                if (!session.isCurrent(generation)) return;
                // POST can return an existing collection without updating its note.
                // Accept only the currently authorized owner value, never infer a note save from that receipt.
                const current = await api<Collection[]>('collections', undefined, actorId);
                if (!session.isCurrent(generation)) return;
                await session.authorize();
                if (!session.isCurrent(generation)) return;
                const saved = typeof receipt.id === 'string' && receipt.id ? current.find(item => item.id === receipt.id && item.sourceKind === sourceKind && item.sourceId === sourceId) : undefined;
                if (!saved) {
                    setError('尚未核对到收藏记录，输入仍保留，请稍后重试。');
                    return;
                }
                if (saved.privateNote !== body.privateNote.trim()) {
                    // This existing-ID result is reconciled even though this input was not saved.
                    acknowledgeMutation(actorId, 'POST', 'collections', body);
                    setPending(null);
                    setError('已收藏此来源，此次备注尚未保存。输入仍保留，请到成长管理已有私人备注。');
                    return;
                }
                acknowledgeMutation(actorId, 'POST', 'collections', body);
                clearFormUI(actorId, `collection-new:${sourceKind}:${sourceId}`);
                setDone(true); setNote(''); setPending(null);
                if (refreshOnSave) await session.verify();
            } catch (e) {
                if (e instanceof ApiError && !e.retryable) {
                    acknowledgeMutation(actorId, 'POST', 'collections', body);
                    setPending(null);
                }
                setError(message(e));
            } finally { setBusy(false); }
        }}>
            <label>私人备注（可选）<textarea name="note" maxLength={2000} rows={3} value={note} onChange={e => setNote(e.target.value)} disabled={busy || pending !== null} placeholder={refreshOnSave ? "想留给自己的内容" : "为什么想回看这一刻？"} />
            </label>
            {!refreshOnSave && <p className="small">{typeof timestampSec === 'number' ? `收藏时间点 ${timestampSec} 秒。` : '收藏来源，随时回看。'}已有备注可在成长中编辑。</p>}
            {error && <p role="alert" className="form-error">{error}</p>}
            {error && <Link href="/growth">到成长管理私人备注</Link>}
            <button disabled={busy}>{busy ? '正在保存…' : pending ? '确认收藏结果' : refreshOnSave ? '保存收藏' : privateNote ? '保存私人备注' : '保存收藏'}</button>
        </form>
    </section>;
}
function WatchVideoNote({ actorId, source, trigger, timestampSec }: { actorId: string; source: Video; trigger: HTMLElement; timestampSec: number | null }) {
    const { trainingId, id: videoId } = source;
    const panelId = useId();
    const [open, setOpen] = useState(false);
    const session = useAccountSession();
    const { authorize, subscribe, verify } = session;
    const [buffer] = useState(() => navigationBuffer(actorId, '/trainings/' + trainingId, 'discussion:' + videoId + ':private-note'));
    const [draft, setDraft] = useState(() => buffer.read<string>());
    const [saved, setSaved] = useState<Collection | null | undefined>(undefined);
    const [error, setError] = useState('');
    const [request, setRequest] = useState(0);
    const [busy, setBusy] = useState(false);
    const operation = useRef<AbortController | null>(null);
    const reading = useRef<AbortController | null>(null);
    const key = useRef(createRequestKey());
    const active = useRef(true);
    function note(value: string | null) {
        if (value === null) buffer.clear();
        else buffer.write(value);
        setDraft(value);
    }

    useLayoutEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            operation.current?.abort();
        };
    }, []);
    useLayoutEffect(() => subscribe(() => {
        operation.current?.abort();
        reading.current?.abort();
        setSaved(undefined);
        setError('');
    }), [subscribe]);

    useLayoutEffect(() => {
        const controller = new AbortController();
        reading.current = controller;
        void (async () => {
            try {
                const items = await api<Collection[]>('collections', undefined, actorId, controller.signal);
                if (controller.signal.aborted) return;
                setSaved(items.find(item => item.sourceKind === 'video' && item.sourceId === videoId) ?? null);
            } catch (error) {
                if (!controller.signal.aborted) setError(message(error));
            }
        })();
        return () => controller.abort();
    }, [actorId, request, videoId, source]);

    async function submit() {
        if (operation.current || saved === undefined) return;
        const controller = new AbortController();
        operation.current = controller;
        setBusy(true);
        setError('');
        const method = saved ? 'PATCH' : 'POST';
        const path = saved ? 'collections/' + saved.id : 'collections';
        const privateNote = draft ?? '';
        const body = saved ? { privateNote, expectedVersion: saved.version } : { sourceKind: 'video', sourceId: videoId, timestampSec, privateNote };
        let generation: number | undefined;
        try {
            generation = await authorize();
            controller.signal.throwIfAborted();
            if (!session.isCurrent(generation)) return;
            const receipt = await api<{ id: string }>(path, { method, actorId, body, key: key.current(actorId, body) }, undefined, controller.signal);
            const items = await api<Collection[]>('collections', undefined, actorId, controller.signal);
            if (!session.isCurrent(generation)) return;
            const confirmed = items.find(item => item.id === receipt.id && item.sourceKind === 'video' && item.sourceId === videoId);
            if (!confirmed) throw new Error('尚未核对到收藏记录，输入仍保留，请重试确认。');
            acknowledgeMutation(actorId, method, path, body);
            setSaved(confirmed);
            if (confirmed.privateNote !== privateNote.trim()) throw new Error('当前账号备注已变化，输入仍保留；请核对后再次保存。');
            note(null);
            key.current = createRequestKey();
        } catch (error) {
            if (controller.signal.aborted || (generation !== undefined && !session.isCurrent(generation))) return;
            setError(message(error));
            if (error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'READ_ONLY', 'VERSION_CONFLICT'].includes(error.code)) void verify();
        } finally {
            if (operation.current === controller) operation.current = null;
            if (active.current) setBusy(false);
        }
    }

    const label = saved ? '已收藏，编辑备注' : '收藏与备注';
    return <>
        {createPortal(<button type="button" className="training-title-action training-title-bookmark"
            aria-label={label} title={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            <Bookmark size={18} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
        </button>, trigger)}
        <section id={panelId} hidden={!open} className="private-note" data-own-buffer>
            <p className="privacy-line"><LockKeyhole size={16} aria-hidden="true" />仅自己可见，可在成长中回看。</p>
            {saved === undefined ? error ?
                <button type="button" className="secondary" onClick={() => { setError(''); setRequest(value => value + 1); }}>重新读取收藏</button> :
                <p role="status">正在确认收藏状态…</p> :
                saved && draft === null ? <>
                    <p className="preserve">{saved.privateNote || '暂无私人备注'}</p>
                    <button type="button" className="secondary" onClick={() => note(saved.privateNote)}>编辑已收藏备注</button>
                </> : <form aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
                    <label>私人备注（可选）<textarea name="note" maxLength={2000} rows={3} value={draft ?? ''} onChange={event => note(event.target.value)} disabled={busy} /></label>
                    <div className="actions">
                        <button disabled={busy}>{busy ? '正在保存…' : saved ? '保存备注' : '保存私人备注'}</button>
                        {saved && <button type="button" className="secondary" disabled={busy} onClick={() => { note(null); setError(''); }}>取消</button>}
                    </div>
                </form>}
            {error && <p role="alert" className="form-error">{error}</p>}
        </section>
    </>;
}

export function CollectionList({ actorId }: { actorId: string; initial?: Collection[] }) {
    return <AccountBoundary<Collection[]> actorId={actorId} load="collections">{items => <>
        {items.length ? items.map((item, index) => <Fragment key={item.id}>
            {index === 0 || items[index - 1].createdAt.slice(0, 7) !== item.createdAt.slice(0, 7) ? <DateGroup date={item.createdAt} /> : null}
            <CollectionCard actorId={actorId} item={item} />
        </Fragment>) : <section className="panel">
            <h2>还没有收藏</h2>
            <p>在视频或讨论中加入成长，留下想回看的时间点与私人思考。</p>
            <Link className="button secondary" href="/trainings">去看训练</Link>
        </section>}
    </>}</AccountBoundary>;
}
export function CollectionCard({ actorId, item, compact = false }: { actorId: string; item: Collection; compact?: boolean }) {
    const session = useAccountSession();
    const noteId = useId();
    const key = useRef(createRequestKey());
    const [editing, setEditing] = useNavigationField(actorId, `collection-edit:${item.id}`, false);
    const [buffer, setBuffer] = useNavigationField<string | null>(actorId, `collection-note:${item.id}`, null);
    const [pending, setPending] = useNavigationField<{ privateNote: string; expectedVersion: number } | null>(actorId, `collection-save:${item.id}`, null);
    const note = buffer ?? item.privateNote;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const editButton = useRef<HTMLButtonElement>(null);
    const noteInput = useRef<HTMLTextAreaElement>(null);
    const focusEditor = useRef(false);
    useLayoutEffect(() => {
        if (!focusEditor.current) return;
        const target = editing ? noteInput.current : editButton.current;
        if (target && !target.closest('[hidden]') && !target.disabled) {
            focusEditor.current = false;
            const active = document.activeElement;
            if (active === document.body || target.closest('.collection-card')?.contains(active)) target.focus();
        }
    }, [editing]);
    useEffect(() => {
        if (!pending || item.version <= pending.expectedVersion || item.privateNote !== pending.privateNote.trim()) return;
        // A PATCH receipt alone cannot confirm the note; only the fresh owner snapshot can.
        let mounted = true;
        queueMicrotask(() => {
            if (!mounted) return;
            acknowledgeMutation(actorId, 'PATCH', `collections/${item.id}`, pending);
            clearFormUI(actorId, item.id);
            setPending(null); setBuffer(null); setEditing(false); setError('');
        });
        return () => { mounted = false; };
    }, [actorId, item.id, item.privateNote, item.version, pending, setPending, setBuffer, setEditing]);
    async function submit(body: { privateNote: string; expectedVersion: number } | { action: 'delete'; expectedVersion: number }) {
        if (busy) return;
        setBusy(true); setError('');
        if ('privateNote' in body) setPending(body);
        try {
            const generation = await session.authorize();
            const receipt = await api<{ id: string }>(`collections/${item.id}`, { method: 'PATCH', actorId, body, key: key.current(actorId, body) });
            if (!session.isCurrent(generation)) return;
            if (receipt.id !== item.id) throw new Error('尚未核对到收藏记录，输入仍保留，请重试确认。');
            if ('privateNote' in body) {
                const current = await api<Collection[]>('collections', undefined, actorId);
                if (!session.isCurrent(generation)) return;
                await session.authorize();
                if (!session.isCurrent(generation)) return;
                const saved = current.find(row => row.id === item.id);
                if (!saved) throw new Error('尚未核对到收藏记录，输入仍保留，请重试确认。');
                if (saved.privateNote !== body.privateNote.trim()) {
                    acknowledgeMutation(actorId, 'PATCH', `collections/${item.id}`, body);
                    setPending(null);
                    setError('当前账号备注已变化，输入仍保留；请核对后再次保存。');
                }
            } else acknowledgeMutation(actorId, 'PATCH', `collections/${item.id}`, body);
            // verify() may fail without throwing. Keep the buffer until a matching snapshot arrives.
            await session.verify();
        } catch (e) {
            if (e instanceof ApiError && !e.retryable) setPending(null);
            setError(message(e));
        } finally { setBusy(false); }
    }
    const sourceLabel = { video: '视频收藏', comment: '讨论收藏', reflection: '队友复盘收藏',
        training: '训练收藏', learning_post: '学习资料收藏', topic_collection: '专题合集收藏' }[item.sourceKind];
    const hasSavedNote = Boolean(item.privateNote.trim());
    const actions = <div className="collection-card-actions" role="group" aria-label="收藏操作">
        <button ref={editButton} className="secondary collection-card-action" type="button" aria-label="编辑私人备注" title="编辑私人备注"
            aria-expanded={editing} aria-controls={noteId} disabled={editing}
            onClick={() => { focusEditor.current = true; setError(''); setEditing(true); }}>
            <Pencil size={18} aria-hidden="true" />
        </button>
        {hasSavedNote && !editing && !busy && pending === null ?
            <Link prefetch={false} className="button secondary collection-card-action" href={`/reflections/new?collection=${encodeURIComponent(item.id)}`}
                aria-label="转为复盘" title="转为复盘"><ReflectionIcon size={18} aria-hidden="true" /></Link> :
            <button className="secondary collection-card-action" type="button" disabled aria-label="转为复盘" title="转为复盘">
                <ReflectionIcon size={18} aria-hidden="true" />
            </button>}
        {!compact && <button className="secondary danger collection-card-action" type="button" aria-label="删除收藏" title="删除收藏"
            disabled={busy || pending !== null} onClick={() => {
                if (window.confirm('删除这条本人收藏和私人备注？来源内容不会删除。')) void submit({ action: 'delete', expectedVersion: item.version });
            }}><Trash2 size={18} aria-hidden="true" /></button>}
    </div>;
    return <article className={compact ? "collection-card" : "panel collection-card"}>
        {!compact && <>
            <header className="collection-card-header">
                <p className="detail-meta"><time dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time> · {sourceLabel}{item.timestampSec !== null ? ` · ${item.timestampSec}秒` : ''}</p>
                {actions}
            </header>
            {item.source ? <>
                <h2><Link prefetch={false} href={item.source.href}>{item.source.title}</Link></h2>
                {item.source.text && <p className="preserve">{item.source.text}</p>}
            </> : <h2>来源暂不可用</h2>}
        </>}
        <section className="private-note">
            <div className="note-card-heading">
                <h3><LockKeyhole size={16} aria-hidden="true" />本人私人备注</h3>
                {compact && actions}
            </div>
            {editing ? <form id={noteId} data-own-buffer data-buffer-id={item.id} aria-busy={busy} onSubmit={e => { e.preventDefault(); focusEditor.current = true; void submit(pending ?? { privateNote: note, expectedVersion: item.version }); }}>
                <label><span className="sr-only">本人私人备注</span><textarea ref={noteInput} name="note" maxLength={2000} rows={3} value={note} onChange={e => setBuffer(e.target.value)} disabled={busy || pending !== null} /></label>
                <div className="actions">
                    <button disabled={busy}>{busy ? '正在保存…' : pending ? '确认保存备注结果' : '保存备注'}</button>
                    <button className="secondary" type="button" disabled={busy || pending !== null} onClick={() => { focusEditor.current = true; setBuffer(null); setEditing(false); setError(''); clearFormUI(actorId, item.id); }}>取消</button>
                </div>
                <p className="muted">{pending ? '上次保存尚待确认，输入仍保留。请先确认保存结果。' : '请先保存备注，再转为复盘；取消会放弃本次修改。'}</p>
            </form> : <>
                <p id={noteId} className="preserve">{hasSavedNote ? item.privateNote : '暂无私人备注'}</p>
                {hasSavedNote ? <p className="muted" role="status">当前备注已保存在账号中。</p> :
                    <p className="muted">先添加并保存私人备注，才能转为复盘。</p>}
            </>}
            {error && <p role="alert" className="form-error">{error}</p>}
        </section>
    </article>;
}

export function ReflectionBookmark({ actorId, sourceId, trigger }: { actorId: string; sourceId: string; trigger: HTMLElement }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    return <AccountBoundary<Collection[]> actorId={actorId} load="collections">{items => {
        const saved = items.find(item => item.sourceKind === 'reflection' && item.sourceId === sourceId);
        const label = saved ? '已收藏，查看私人备注' : '收藏复盘';
        return <>
            {createPortal(<button type="button" className="reflection-title-bookmark" aria-label={label} title={label}
                aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
                <Bookmark size={18} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
            </button>, trigger)}
            <div id={panelId} hidden={!open} className="reflection-bookmark-panel">
                {saved ? <CollectionCard compact actorId={actorId} item={saved} /> :
                    <CollectionEditor actorId={actorId} sourceKind="reflection" sourceId={sourceId} privateNote refreshOnSave />}
            </div>
        </>;
    }}</AccountBoundary>;
}
