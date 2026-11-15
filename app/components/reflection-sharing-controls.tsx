'use client';

import Link from 'next/link';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { LockKeyhole, UsersRound } from 'lucide-react';
import type { ReflectionAuthor } from '../../lib/contracts/reflections';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { useNavigationField } from '../../lib/client/navigation-state';

type Intent = 'team' | 'private' | 'publish' | 'withdraw';
type Revision = { expectedVersion: number; expectedSharingVersion: number; expectedGeneration: number };
type Pending = { intent: Intent; path: string; body: Revision & { scope?: 'private' | 'team'; published?: boolean }; key: string; refused?: boolean };
type Buffer = { base: string; scope: 'private' | 'team'; pending: Pending | null };
const revision = (r: ReflectionAuthor): Revision => ({ expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation });
const stamp = (r: ReflectionAuthor) => JSON.stringify([r.version, r.sharingVersion, r.generation, r.scope, r.published]);
const content: Record<Intent, { title: string; text: string; confirm: string; success: string }> = {
    team: { title: '允许全队阅读？', text: '现有及未来的有效队员可阅读，并可在你的队内档案中看到。这不会发布到动态。', confirm: '允许全队阅读', success: '全队已可阅读，尚未发布到动态。' },
    publish: { title: '发布到队内动态？', text: '这篇复盘将出现在首页和队内动态。阅读范围仍为全队。', confirm: '发布到动态', success: '已发布到队内动态。' },
    withdraw: { title: '撤回这条动态？', text: '动态将移除，全队仍可通过已有链接和队内档案阅读。若希望仅自己可读，请收回阅读权限。', confirm: '撤回动态', success: '动态已撤回，全队仍可阅读。' },
    private: { title: '收回阅读权限？', text: '其他队员将无法继续访问这篇复盘，相关动态也会撤回。你的正文会保留。', confirm: '收回阅读权限', success: '已收回阅读权限，现在仅自己可读。' }
};
function matches(r: ReflectionAuthor, operation: Pending) {
    const b = operation.body;
    return r.version === b.expectedVersion && r.sharingVersion === b.expectedSharingVersion + 1 && r.generation === b.expectedGeneration &&
        r.scope === (b.scope ?? 'team') && r.published === (b.published ?? false);
}
export function ReflectionSharingControls({ actorId, reflection: r, authorize, isCurrent, refresh, subscribe, onVerified }: {
    actorId: string;
    reflection: ReflectionAuthor;
    authorize: () => Promise<number>;
    isCurrent: (token: number) => boolean;
    refresh: () => Promise<void>;
    subscribe: (listener: (ended: boolean) => void) => () => void;
    onVerified: (snapshot: ReflectionAuthor) => void;
}) {
    const [buffer, setBuffer] = useNavigationField<Buffer>(actorId, 'sharing-control:' + r.id, { base: stamp(r), scope: r.scope, pending: null });
    const [intent, setIntent] = useState<Intent | null>(null);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ text: string; error?: boolean; success?: boolean; viewActivity?: boolean } | null>(null);
    const [copyFeedback, setCopyFeedback] = useState('');
    const surface = useRef<HTMLElement>(null);
    const title = useRef<HTMLHeadingElement>(null);
    const publication = useRef<HTMLButtonElement>(null);
    const reconcile = useRef<HTMLButtonElement>(null);
    const completionFocus = useRef<HTMLButtonElement | null>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const flight = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const requestKey = useRef(createRequestKey());
    const latestBuffer = useRef(buffer);
    useEffect(() => { latestBuffer.current = buffer; }, [buffer]);
    const scopeId = useId();
    const titleId = useId();
    const descriptionId = useId();
    const publicationDescriptionId = useId();
    const scope = buffer.base === stamp(r) || buffer.pending ? buffer.scope : r.scope;
    const dirty = scope !== r.scope;
    const invalid = r.scope === 'private' && r.published;
    const pending = buffer.pending;
    const writeBuffer = (next: Buffer) => { latestBuffer.current = next; setBuffer(next); };
    const synchronize = (snapshot: ReflectionAuthor) => writeBuffer({ base: stamp(snapshot), scope: snapshot.scope, pending: null });
    useEffect(() => subscribe(ended => {
        // A native modal is in the top layer: hiding its ancestor alone is insufficient.
        if (dialog.current) { dialog.current.hidden = true; if (dialog.current.open) dialog.current.close(); }
        completionFocus.current = null;
        setIntent(null);
        setFeedback(null);
        setCopyFeedback('');
        controller.current?.abort();
        if (ended) { latestBuffer.current = { base: '', scope: 'private', pending: null }; }
    }), [subscribe]);
    useEffect(() => () => { controller.current?.abort(); if (dialog.current?.open) dialog.current.close(); }, []);
    useLayoutEffect(() => {
        // Completion can remove the original action or enable reconciliation in this commit.
        const original = completionFocus.current;
        if (busy || !original) return;
        completionFocus.current = null;
        if (!surface.current?.isConnected || surface.current.closest('[hidden]')) return;
        const target = pending ? reconcile.current : original;
        if (target?.isConnected && !target.matches(':disabled') && !target.closest('[hidden]')) target.focus();
        else title.current?.focus();
    });
    function closeDialog(reset = false) {
        if (flight.current) return;
        if (reset) synchronize(r);
        dialog.current?.close();
        setIntent(null);
        trigger.current?.focus();
    }
    function open(next: Intent, element: HTMLButtonElement) {
        if (flight.current || pending || invalid) return;
        trigger.current = element;
        setIntent(next);
        setFeedback(null);
        if (dialog.current) { dialog.current.hidden = false; dialog.current.showModal(); }
        cancel.current?.focus();
    }
    async function snapshot(signal: AbortSignal) {
        const token = await authorize();
        signal.throwIfAborted();
        let fresh: ReflectionAuthor;
        try { fresh = await api<ReflectionAuthor>(`reflections/${r.id}/edit`, undefined, actorId, signal); } catch (e) {
            if (e instanceof ApiError && ['NOT_FOUND', 'FORBIDDEN'].includes(e.code)) void refresh();
            throw e;
        }
        signal.throwIfAborted();
        const checked = await authorize();
        signal.throwIfAborted();
        if (!isCurrent(token) || !isCurrent(checked)) throw new Error('分享状态尚未确认。');
        if (fresh.scope === 'private' && fresh.published) throw new Error('正在核对分享状态');
        onVerified(fresh);
        return fresh;
    }
    async function run(operation: Pending, original: HTMLButtonElement | null) {
        if (flight.current) return;
        flight.current = true; setBusy(true);
        const current = new AbortController(); controller.current = current;
        let sent = !!pending || operation.refused === true;
        let receipt: ReflectionAuthor | null = null;
        let refused = operation.refused === true;
        let focusAfter = original;
        setFeedback({ text: pending ? '正在核对上次操作，请稍候' : operation.intent === 'publish' ? '正在发布…' : operation.intent === 'withdraw' ? '正在撤回动态…' : '正在更新阅读范围…' });
        try {
            const token = await authorize();
            current.signal.throwIfAborted();
            if (!refused) {
                sent = true;
                writeBuffer({ ...latestBuffer.current, pending: operation });
                try {
                    receipt = await api<ReflectionAuthor>(operation.path, { actorId, method: 'PUT', body: operation.body, key: operation.key }, undefined, current.signal);
                } catch (e) {
                    if (e instanceof ApiError && !e.retryable && ['VERSION_CONFLICT', 'INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'READ_ONLY', 'FORBIDDEN', 'NOT_FOUND'].includes(e.code)) {
                        refused = true;
                        writeBuffer({ ...latestBuffer.current, pending: { ...operation, refused: true } });
                    } else throw e;
                }
            }
            if (!isCurrent(token)) throw new Error('分享状态尚未确认。');
            const fresh = await snapshot(current.signal);
            if (refused || !receipt || !matches(receipt, operation) || !matches(fresh, operation) || stamp(fresh) !== stamp(receipt)) {
                synchronize(fresh);
                setFeedback({ text: '分享状态已变化，请核对后重新选择', error: true });
            } else {
                synchronize(fresh);
                setFeedback({ text: content[operation.intent].success, success: true, viewActivity: operation.intent === 'publish' });
                if (operation.intent === 'team') focusAfter = publication.current;
            }
        } catch {
            if (!current.signal.aborted) setFeedback({ text: sent ? '暂未确认操作结果。你的选择仍保留，请重试核对。' : '尚未确认账号与权限，请重新确认后操作。', error: true });
        } finally {
            flight.current = false;
            dialog.current?.close();
            if (!current.signal.aborted) completionFocus.current = focusAfter;
            if (controller.current === current) controller.current = null;
            setIntent(null);
            setBusy(false);
        }
    }
    function confirm() {
        if (!intent || flight.current || pending) return;
        const body = { ...revision(r), ...(intent === 'team' || intent === 'private' ? { scope: intent } : { published: intent === 'publish' }) };
        const operation: Pending = { intent, path: `reflections/${r.id}/${intent === 'team' || intent === 'private' ? 'grants' : 'publication'}`, body, key: requestKey.current(actorId, body) };
        void run(operation, trigger.current);
    }
    return <section ref={surface} className="reflection-sharing" data-own-buffer>
        <h2 ref={title} tabIndex={-1} className="sharing-title">{r.title || '训练复盘'}</h2>
        <div className="sharing-summary" aria-label="当前已确认状态">
            {invalid ? <p role="status">正在核对分享状态</p> : <>
                <p><span>阅读：</span><strong>{r.scope === 'private' ? '仅自己' : '全队'}</strong></p>
                <p><span>动态：</span><strong>{r.published ? '已发布' : '未发布'}</strong></p>
            </>}
        </div>
        <section className="sharing-card">
            <h2>谁可以阅读</h2>
            <fieldset className="scope-choice" disabled={busy || !!pending || invalid}>
                <legend className="sr-only">谁可以阅读</legend>
                <label className="permission"><span className="detail-tile"><LockKeyhole size={18} aria-hidden="true" /></span><span>仅自己<small>默认私密，留给自己</small></span><input type="radio" name={scopeId} value="private" checked={scope === 'private'} onChange={() => { writeBuffer({ base: stamp(r), scope: 'private', pending: null }); setFeedback(null); }} /></label>
                <label className="permission"><span className="detail-tile"><UsersRound size={18} aria-hidden="true" /></span><span>全队<small>现有及未来的有效成员可阅读，并可在你的队内档案中看到。动态发布需另行确认。</small></span><input type="radio" name={scopeId} value="team" checked={scope === 'team'} onChange={() => { writeBuffer({ base: stamp(r), scope: 'team', pending: null }); setFeedback(null); }} /></label>
            </fieldset>
            {dirty ? <><p>{scope === 'team' ? '仅授权阅读范围，不会发布到动态。' : '收回后，其他队员将无法继续阅读，相关动态也会撤回。'}</p><div className="sharing-actions"><button className={scope === 'private' ? 'secondary danger' : ''} disabled={busy || !!pending || invalid} onClick={e => open(scope, e.currentTarget)}>{scope === 'team' ? '确认全队可读' : '收回阅读权限'}</button><button className="secondary" disabled={busy || !!pending || invalid} onClick={() => { synchronize(r); setFeedback(null); }}>取消修改</button></div></> : <p className="muted">{invalid ? '正在核对分享状态' : '当前阅读范围已生效'}</p>}
        </section>
        <section className="sharing-card">
            <h2>队内动态</h2>
            <p id={publicationDescriptionId}>{invalid ? '正在核对分享状态' : r.scope === 'private' ? '全队可读后，你可以另行发布到队内动态。' : r.published ? '撤回后，全队仍可通过已有链接和队内档案阅读。' : '全队已可阅读，尚未发布。确认发布后，这篇复盘会出现在首页和队内动态。'}</p>
            {dirty && <p className="muted">请先确认或取消阅读范围修改</p>}
            <button ref={publication} aria-describedby={publicationDescriptionId} className={r.published ? 'secondary' : ''} disabled={busy || !!pending || invalid || dirty || r.scope !== 'team'} onClick={e => open(r.published ? 'withdraw' : 'publish', e.currentTarget)}>{r.published ? '撤回动态' : '发布到动态'}</button>
        </section>
        {pending && <p><button ref={reconcile} className="secondary" disabled={busy} onClick={e => void run(pending, e.currentTarget)}>核对结果</button></p>}
        {invalid && <p><button className="secondary" disabled={busy} onClick={() => void refresh()}>核对分享状态</button></p>}
        {feedback && <p role={feedback.error ? 'alert' : 'status'} aria-live={feedback.error ? undefined : 'polite'} className={`notice ${feedback.error ? 'error' : feedback.success ? 'success' : ''}`}>
            {feedback.text}{feedback.viewActivity && r.published && <> <Link href="/activity" className="underline">查看动态</Link></>}
        </p>}
        <p><button className="secondary" disabled={busy} onClick={async () => { setCopyFeedback('正在复制阅读链接…'); try { const token = await authorize(); await navigator.clipboard.writeText(window.location.origin + '/reflections/' + r.id); if (isCurrent(token)) setCopyFeedback('阅读链接已复制。'); } catch { setCopyFeedback('未能复制，请使用浏览器地址栏复制阅读页地址。'); } }}>复制阅读链接</button><small className="sharing-link-note">链接不会改变阅读范围</small></p>
        {copyFeedback && <p role={copyFeedback.startsWith('未能') ? 'alert' : 'status'} aria-live="polite">{copyFeedback}</p>}
        <dialog ref={dialog} className="sharing-dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={e => { e.preventDefault(); closeDialog(); }} onKeyDown={e => { if (e.key === 'Tab') { const nodes = [cancel.current, dialog.current?.querySelector<HTMLButtonElement>('[data-confirm]')].filter((node): node is HTMLButtonElement => !!node && !node.disabled); if (!nodes.length) { e.preventDefault(); return; } if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus(); } } }}>
            <h2 id={titleId}>{intent ? content[intent].title : ''}</h2><p id={descriptionId}>{intent ? content[intent].text : ''}</p>
            {busy && <p role="status" aria-live="polite">正在确认结果</p>}
            <div className="sharing-actions"><button ref={cancel} className="secondary" disabled={busy} onClick={() => closeDialog()}>取消</button><button data-confirm className={intent === 'private' || intent === 'withdraw' ? 'secondary danger' : ''} disabled={busy} onClick={confirm}>{intent ? content[intent].confirm : '确认'}</button></div>
        </dialog>
    </section>;
}
