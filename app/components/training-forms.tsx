'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Training, Video } from '../../lib/contracts/training';
import { acknowledgeMutation, clearFormUI } from '../../lib/client/navigation-state';
import { api, createRequestKey } from '../../lib/client/api';
import { cancelUploadReservation } from '../../lib/client/upload.ts';
import { MEDIA_PART_BYTES } from '../../lib/contracts/media.ts';
import type { UploadPage } from '../../lib/contracts/media';
import { useAccountSession } from './secure-resource';
function confirmStatus(kind: string, title: string, previous: string, next: string) {
    if (previous === next) return true;
    const effects: Record<string, string> = {
        published: '发布后有效队员可阅读与讨论。',
        draft: '改为草稿后仅管理员可读，成员将不能访问。',
        archived: '归档后队员仍可回看，但不能新增或修改讨论。',
        hidden: '隐藏后成员不能访问，相关收藏来源将显示不可用。',
        deleted: '删除后相关内容与收藏来源将显示不可用。',
        active: '恢复可见后，符合训练权限的队员可访问。'
    };
    return window.confirm(`${kind}「${title}」将更改状态。${effects[next] ?? ''}确认继续？`);
}
const message = (e: unknown) => e instanceof Error ? e.message : '暂未保存，请保留内容重试。';
export function TrainingForm({ actorId, training }: {
    actorId: string;
    training?: Training;
}) {
    const session = useAccountSession();
    const router = useRouter();
    const [deleted, setDeleted] = useState(false);
    const submitting = useRef(false);
    const key = useRef(createRequestKey());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    type TrainingInput = { title: string; date: string; description: string; status: string; expectedVersion?: number };
    const confirmation = useRef<HTMLDialogElement>(null);
    const pending = useRef<TrainingInput | null>(null);
    const [confirmationText, setConfirmationText] = useState('');
    const confirmationId = useId();
    const dismissConfirmation = () => {
        pending.current = null;
        confirmation.current?.close();
    };
    useEffect(() => session.subscribe(() => {
        // A modal is in the top layer: hide it synchronously with the protected
        // surface and discard its authorization intent, while retaining fields.
        pending.current = null;
        confirmation.current?.close();
    }), [session]);
    async function save(body: TrainingInput) {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
            const generation = await session.authorize();
            const result = await api<Training>(
                training ? `trainings/${training.id}` : 'trainings',
                { method: training ? 'PATCH' : 'POST', actorId, body, key: key.current(actorId, body) }
            );
            if (!session.isCurrent(generation)) return;
            acknowledgeMutation(actorId, training ? 'PATCH' : 'POST', training ? `trainings/${training.id}` : 'trainings', body);
            clearFormUI(actorId, training?.id ?? 'training-new');
            if (result.status === 'deleted') {
                setDeleted(true);
                await session.verify();
                return;
            }
            if (training) await session.verify();
            else router.push('/trainings/' + result.id);
        }
        catch (e) {
            setError(message(e));
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    if (deleted)
        return <section className="notice success" role="status">
            <p>训练已删除，相关来源将显示不可用。
            </p>
            <Link className="button secondary" href="/trainings">返回全部训练
            </Link>
        </section>;
    return <form data-buffer-id={training?.id ?? 'training-new'}
        onSubmit={async (e) => {
            e.preventDefault();
            if (submitting.current)
                return;
            const data = new FormData(e.currentTarget);
            const body = {
                title: String(data.get('title')),
                date: String(data.get('date')),
                description: String(data.get('description')),
                status: String(data.get('status')),
                ...(training ? { expectedVersion: training.version } : {})
            };
            if (pending.current) return;
            if ((training?.status ?? 'draft') !== body.status) {
                const effects: Record<string, string> = {
                    published: '发布后有效队员可阅读与讨论。',
                    draft: '改为草稿后仅管理员可读，成员将不能访问。',
                    archived: '归档后队员仍可回看，但不能新增或修改讨论。',
                    hidden: '隐藏后成员不能访问，相关收藏来源将显示不可用。',
                    deleted: '删除后相关内容与收藏来源将显示不可用。'
                };
                pending.current = body;
                setConfirmationText(`训练「${body.title}」将更改状态。${effects[body.status] ?? ''}`);
                confirmation.current?.showModal();
                return;
            }
            void save(body);
        }}
    >
        <label>训练名称
            <input disabled={busy} name="title" required maxLength={80} defaultValue={training?.title} />
        </label>
        <label>训练日期
            <input
                disabled={busy}
                name="date"
                type="date"
                required
                defaultValue={training?.date ?? new Date().toLocaleDateString('en-CA')}
            />
        </label>
        <label>训练简介
            <textarea
                disabled={busy}
                name="description"
                maxLength={2000}
                rows={4}
                defaultValue={training?.description}
            />
        </label>
        <label>状态
            <select data-retain-ui disabled={busy} name="status" defaultValue={training?.status ?? 'draft'}>
                <option value="draft">草稿 · 仅管理员
                </option>
                <option value="published">发布 · 队内可读
                </option>
                <option value="archived">归档 · 历史只读
                </option>
                <option value="hidden">隐藏 · 成员不可读
                </option>
                <option value="deleted">删除 · 来源显示不可用
                </option>
            </select>
        </label>
        {error && <p role="alert" className="form-error">
            {error}
        </p>}
        <button disabled={busy}>
            {busy ? '正在保存…' : '保存训练'}
        </button>
        <dialog ref={confirmation} className="add-video-dialog" aria-labelledby={confirmationId}
            onCancel={dismissConfirmation} onClose={() => { pending.current = null; }}>
            <div className="section-heading">
                <h2 id={confirmationId}>确认训练状态</h2>
                <button type="button" className="secondary dialog-close" aria-label="关闭状态确认" onClick={dismissConfirmation}>关闭</button>
            </div>
            <p>{confirmationText}</p>
            <div className="actions">
                <button type="button" className="secondary" onClick={dismissConfirmation}>取消</button>
                <button type="button" onClick={() => {
                    const body = pending.current;
                    if (!body || submitting.current) return;
                    pending.current = null;
                    confirmation.current?.close();
                    void save(body);
                }}>确认并保存</button>
            </div>
        </dialog>
    </form>;
}
export function VideoEditForm({ actorId, video }: {
    actorId: string;
    video: Video;
}) {
    const session = useAccountSession();
    const key = useRef(createRequestKey());
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    return <form data-buffer-id={video.id}
        onSubmit={async (e) => {
            e.preventDefault();
            if (busy)
                return;
            const d = new FormData(e.currentTarget);
            const body = {
                title: String(d.get('title')),
                position: Number(d.get('position')),
                status: String(d.get('status')),
                expectedVersion: video.version
            };
            if (!confirmStatus('视频', body.title, video.status, body.status)) return;
            setBusy(true);
            try {
                const generation = await session.authorize();
                await api(`videos/${video.id}`, { method: 'PATCH', actorId, body, key: key.current(actorId, body) });
                if (session.isCurrent(generation)) { acknowledgeMutation(actorId, 'PATCH', `videos/${video.id}`, body); clearFormUI(actorId, video.id); await session.verify(); }
            }
            catch (e) {
                setError(message(e));
            } finally {
                setBusy(false);
            }
        }}
    >
        <label>视频标题
            <input disabled={busy} name="title" defaultValue={video.title} maxLength={80} required />
        </label>
        <label>顺序
            <input
                disabled={busy}
                name="position"
                type="number"
                min={0}
                max={10000}
                defaultValue={video.position}
                required
            />
        </label>
        <label>状态
            <select data-retain-ui disabled={busy} name="status" defaultValue={video.status}>
                <option value="active">可见
                </option>
                <option value="hidden">隐藏
                </option>
                <option value="deleted">删除（替换请添加新视频）
                </option>
            </select>
        </label>
        {error && <p role="alert">
            {error}
        </p>}
        <button disabled={busy}>
            {busy ? '正在保存…' : '保存视频信息'}
        </button>
    </form>;
}
function uploadMessage(error: unknown) {
    if (error instanceof Error && ('code' in error || /[\u4e00-\u9fff]/.test(error.message))) return error.message;
    return '暂时无法确认上传进度或结果。请稍后重新确认。';
}
export function AddVideoDialog({ actorId, trainingId, nextPosition }: { actorId: string; trainingId: string; nextPosition: number }) {
    const session = useAccountSession();
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const [notice, setNotice] = useState('');
    useEffect(() => session.subscribe(() => { dialog.current?.close(); }), [session]);
    return <>
        <div className="section-heading">
            <h2>训练视频</h2>
            <button type="button" className="add-video-trigger" aria-label="添加视频" aria-haspopup="dialog" onClick={() => { setNotice(''); dialog.current?.showModal(); }}><span aria-hidden="true">＋</span></button>
        </div>
        {notice && <p role="status" className="muted">{notice}</p>}
        <dialog ref={dialog} className="add-video-dialog" aria-labelledby={titleId}>
            <div className="section-heading">
                <h2 id={titleId}>添加B站视频</h2>
                <button type="button" className="secondary dialog-close" aria-label="关闭添加视频" onClick={() => dialog.current?.close()}>关闭</button>
            </div>
            <AddVideoForm actorId={actorId} trainingId={trainingId} defaultPosition={nextPosition} onAdded={() => { dialog.current?.close(); setNotice('视频已添加到下方列表。'); }} />
        </dialog>
    </>;
}
export function AddVideoForm({ actorId, trainingId, defaultPosition = 0, onAdded }: { actorId: string; trainingId: string; defaultPosition?: number; onAdded?: () => void }) {
    const session = useAccountSession();
    const key = useRef(createRequestKey());
    const submitting = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    return <form data-buffer-id={`video-new:${trainingId}`} onSubmit={async e => {
        e.preventDefault(); if (submitting.current) return;
        const form = e.currentTarget, d = new FormData(form);
        const body = { title: String(d.get('title')).trim(), position: Number(d.get('position')), source: 'bilibili', url: String(d.get('url')).trim() };
        submitting.current = true; setBusy(true); setError(''); setNotice('');
        try {
            const generation = await session.authorize();
            await api(`trainings/${trainingId}/videos`, { method: 'POST', actorId, body, key: key.current(actorId, body) });
            if (!session.isCurrent(generation)) return;
            acknowledgeMutation(actorId, 'POST', `trainings/${trainingId}/videos`, body);
            clearFormUI(actorId, `video-new:${trainingId}`);
            form.reset(); key.current = createRequestKey(); setNotice('视频已添加，点击视频标题即可播放。');
            onAdded?.();
            await session.verify();
        } catch (e) { setError(message(e)); }
        finally { submitting.current = false; setBusy(false); }
    }}>
        <p className="muted">直接粘贴 B 站 App 复制的整段分享内容或视频链接，无需先转换短链接。</p>
        <label>B站分享内容、链接或BV号<input disabled={busy} name="url" required maxLength={2000} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="【视频标题】 https://b23.tv/…" /></label>
        <label>视频标题<input disabled={busy} name="title" required maxLength={80} placeholder="例如：本周训练回看" /></label>
        <details><summary>排序（可选）</summary><label>顺序<input disabled={busy} type="number" name="position" min={0} max={10000} defaultValue={defaultPosition} required /></label></details>
        {notice && <p role="status">{notice}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? '正在添加…' : '添加B站视频'}</button>
    </form>;
}
export function UploadCleanup({ actorId, initial }: { actorId: string; initial: UploadPage }) {
    const session = useAccountSession();
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    // Keep one bounded replacement page. A newly authorized parent snapshot
    // invalidates it, preserving the existing protected refresh lifecycle.
    const [selected, setSelected] = useState<{ base: UploadPage; page: UploadPage } | null>(null);
    const page = selected?.base === initial ? selected.page : initial;
    const key = useRef(createRequestKey());
    async function loadPage(cursor: string | null) {
        setBusy(true); setError('');
        try {
            const generation = await session.authorize();
            const result = await api<UploadPage>(cursor ? `uploads?cursor=${encodeURIComponent(cursor)}` : 'uploads', undefined, actorId);
            if (!session.isCurrent(generation)) return;
            setSelected({ base: initial, page: result });
        } catch (e) { setError(uploadMessage(e)); }
        finally { setBusy(false); }
    }
    if (!page.items.length && !selected)
        return notice ? <p role="status">{notice}</p> : null;
    return <details className="panel">
        <summary>本人未挂载上传 · 清理空间</summary>
        <p>上传中断或离开页面后，可在这里取消并清理。已经挂载的视频不会列出。</p>
        {page.items.map(item => <div key={item.id} className="discussion">
            <p>{item.createdAt.slice(0, 10)} · {(item.bytes / 1024 / 1024).toFixed(2)}MiB · {item.cleanupState === 'pending' ? '待清理 · 仍占用空间' : item.status === 'ready' ? '已核验，未挂载' : '尚未完成'}</p>
            <button disabled={busy} className="secondary" onClick={async () => {
                if (!window.confirm('取消并清理这次未完成上传？继续上传需要重新选择文件。')) return;
                setBusy(true); setNotice('正在取消并清理这次上传…'); setError('');
                try {
                    const generation = await session.authorize();
                    await cancelUploadReservation(item.id, actorId, key.current(actorId, item.id), Math.ceil(item.bytes / MEDIA_PART_BYTES), () => session.isCurrent(generation));
                    if (!session.isCurrent(generation)) return;
                    setNotice('这次上传已取消并清理，可以重新选择文件。');
                    await session.verify();
                } catch (e) { setNotice(''); setError(uploadMessage(e)); }
                finally { setBusy(false); }
            }}>取消并清理</button>
        </div>)}
        {page.nextCursor && <button type="button" className="secondary" disabled={busy} onClick={() => void loadPage(page.nextCursor)}>查看更早的未挂载上传</button>}
        {selected && <button type="button" className="secondary" disabled={busy} onClick={() => void loadPage(null)}>查看最新未挂载上传</button>}
        {notice && <p role="status">{notice}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
    </details>;
}
