'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import type { Collection } from '../../lib/contracts/training';
import { acknowledgeMutation, clearFormUI, useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { DateGroup } from './presentation';
import { AccountBoundary, useAccountSession, useOptionalAccountSession } from './secure-resource';
const message = (e: unknown) => e instanceof Error ? e.message : '未能保存，请保留内容重试。';
type SaveProps = { actorId: string; sourceKind: 'video' | 'comment' | 'reflection'; sourceId: string; timestampSec?: number | null; privateNote?: boolean };
export function SaveCollection(props: SaveProps) {
    const session = useOptionalAccountSession();
    return session ? <CollectionEditor {...props} /> : <AccountBoundary actorId={props.actorId} load="me">{() => <CollectionEditor {...props} />}</AccountBoundary>;
}
function CollectionEditor({ actorId, sourceKind, sourceId, timestampSec, privateNote = false }: SaveProps) {
    const session = useAccountSession();
    const [open, setOpen] = useNavigationField(actorId, `collection-open:${sourceKind}:${sourceId}`, privateNote);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    const key = useRef(createRequestKey());
    if (done) return <p className="notice success" role="status">{privateNote ? '私人备注已保存到账号。' : '已加入本人成长。'}<Link href="/growth">管理私人备注</Link>
    </p>;
    return <section className={privateNote ? 'private-note' : 'collection-action'}>
        {privateNote && <><h2>留给自己</h2><p className="small">私人备注仅自己可见，保存后可在成长中回看。</p></>}
        {!privateNote && <button type="button" className="secondary" onClick={() => setOpen(!open)}>{open ? '收起收藏表单' : '加入成长'}</button>}
        <form data-buffer-id={`collection-new:${sourceKind}:${sourceId}`} hidden={!privateNote && !open} onSubmit={async e => {
            e.preventDefault();
            if (busy) return;
            const body = { sourceKind, sourceId, timestampSec: timestampSec ?? null, privateNote: note };
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
                const saved = typeof receipt.id === 'string' && receipt.id ? current.find(item => item.id === receipt.id) : undefined;
                if (!saved) {
                    setError('尚未核对到收藏记录，输入仍保留，请稍后重试。');
                    return;
                }
                if (saved.privateNote !== body.privateNote.trim()) {
                    // This existing-ID result is reconciled even though this input was not saved.
                    acknowledgeMutation(actorId, 'POST', 'collections', body);
                    setError('已收藏此来源，此次备注尚未保存。输入仍保留，请到成长管理已有私人备注。');
                    return;
                }
                if (session.isCurrent(generation)) { acknowledgeMutation(actorId, 'POST', 'collections', body); clearFormUI(actorId, `collection-new:${sourceKind}:${sourceId}`); setDone(true); setNote(''); }
            } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>
            <label>私人备注（可选）<textarea name="note" maxLength={2000} rows={3} value={note} onChange={e => setNote(e.target.value)} disabled={busy} />
            </label>
            <p className="muted">仅自己可见。收藏不会改变原内容的可见范围；重复收藏请到成长页管理已有备注。</p>
            {error && <p role="alert" className="form-error">{error}</p>}
            {error && <Link href="/growth">到成长管理私人备注</Link>}
            <button disabled={busy}>{busy ? '正在保存…' : privateNote ? '保存私人备注' : '保存收藏'}</button>
        </form>
    </section>;
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
export function CollectionCard({ actorId, item }: { actorId: string; item: Collection }) {
    const session = useAccountSession();
    const key = useRef(createRequestKey());
    const [editing, setEditing] = useNavigationField(actorId, `collection-edit:${item.id}`, false);
    const [buffer, setBuffer] = useNavigationField<string | null>(actorId, `collection-note:${item.id}`, null);
    const [pending, setPending] = useNavigationField<{ privateNote: string; expectedVersion: number } | null>(actorId, `collection-save:${item.id}`, null);
    const note = buffer ?? item.privateNote;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
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
    return <article className="panel collection-card">
        <p className="muted">{item.createdAt.slice(0, 10)} · {item.sourceKind === 'comment' ? '讨论收藏' : item.sourceKind === 'reflection' ? '队友复盘收藏' : '视频收藏'}{item.timestampSec !== null ? ` · ${item.timestampSec}秒` : ''}</p>
        {item.source ? <>
            <h2>
                <Link href={item.source.href}>{item.source.title}</Link>
            </h2>{item.source.text && <p className="preserve">{item.source.text}</p>}</> : <h2>来源暂不可用</h2>}
        <section className="private-note">
            <div className="note-card-heading"><h3>本人私人备注</h3>
                {!editing && <button type="button" className="secondary note-edit" aria-label="编辑私人备注" onClick={() => { setError(''); setEditing(true); }}><Pencil size={18} aria-hidden="true" /><span className="sr-only">编辑私人备注</span></button>}
            </div>
            {editing ? <form data-own-buffer data-buffer-id={item.id} onSubmit={e => { e.preventDefault(); void submit(pending ?? { privateNote: note, expectedVersion: item.version }); }}>
                <label>本人私人备注<textarea name="note" maxLength={2000} rows={3} value={note} onChange={e => setBuffer(e.target.value)} disabled={busy || pending !== null} /></label>
                <div className="actions">
                    <button disabled={busy}>{busy ? '正在保存…' : pending ? '确认保存备注结果' : '保存备注'}</button>
                    <button className="secondary" type="button" disabled={busy || pending !== null} onClick={() => { setBuffer(null); setEditing(false); setError(''); clearFormUI(actorId, item.id); }}>取消</button>
                    <button className="secondary" type="button" disabled>转为复盘</button>
                </div>
                <p className="muted">{pending ? '上次保存尚待确认，输入仍保留。请先确认保存结果。' : '请先保存备注，再转为复盘；取消会放弃本次修改。'}</p>
            </form> : <>
                <p className="preserve">{item.privateNote.trim() ? item.privateNote : '暂无私人备注'}</p>
                {item.privateNote.trim() && <p className="muted" role="status">当前备注已保存在账号中。</p>}
                {item.privateNote.trim() ? <Link className="button secondary" href={`/reflections/new?collection=${encodeURIComponent(item.id)}`}>转为复盘</Link> : <><button type="button" className="secondary" disabled>转为复盘</button><p className="muted">先添加并保存私人备注，才能转为复盘。</p></>}
            </>}
            {error && <p role="alert" className="form-error">{error}</p>}
        </section>
        <button className="secondary" type="button" disabled={busy || pending !== null} onClick={() => {
            if (window.confirm('删除这条本人收藏和私人备注？来源内容不会删除。')) void submit({ action: 'delete', expectedVersion: item.version });
        }}>删除收藏</button>
    </article>;
}
