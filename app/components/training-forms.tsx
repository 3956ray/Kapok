'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import type { Training, TrainingPublication, Video } from '../../lib/contracts/training';
import { acknowledgeMutation, clearFormUI, navigationBuffer } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { cancelUploadReservation } from '../../lib/client/upload.ts';
import { MEDIA_PART_BYTES } from '../../lib/contracts/media.ts';
import type { UploadPage } from '../../lib/contracts/media';
import { useAccountSession } from './secure-resource';
const statusEffects: Record<string, string> = {
    published: '发布后有效队员可阅读与讨论。',
    draft: '改为草稿后仅管理员可读，成员将不能访问。',
    archived: '归档后队员仍可回看，但不能新增或修改讨论。',
    hidden: '隐藏后成员不能访问，相关收藏来源将显示不可用。',
    deleted: '删除后相关内容与收藏来源将显示不可用。',
    active: '恢复可见后，符合训练权限的队员可访问。'
};
function confirmStatus(kind: string, title: string, previous: string, next: string) {
    return previous === next || window.confirm(`${kind}「${title}」将更改状态。${statusEffects[next] ?? ''}确认继续？`);
}
const message = (e: unknown) => e instanceof Error ? e.message : '暂未保存，请保留内容重试。';
const readField = (data: FormData, field: string) => String(data.get(field) ?? '').trim();
type FieldError = { field?: string; text: string };
function videoLinkError(e: unknown, field: string): FieldError {
    const text = message(e);
    const invalidLink = e instanceof ApiError && (['DUPLICATE', 'UPSTREAM_UNAVAILABLE'].includes(e.code) ||
        (e.code === 'INVALID_INPUT' && /B\s*站|BV|短链|分P|链接/.test(text)));
    return { field: invalidLink ? field : undefined, text };
}
function useTrainingError(form: RefObject<HTMLFormElement | null>) {
    const [error, setError] = useState<FieldError | null>(null);
    const errorId = useId();
    useEffect(() => {
        if (!error || form.current?.closest('[hidden]')) return;
        const target = error.field ? form.current?.elements.namedItem(error.field) : document.getElementById(errorId);
        if (target instanceof HTMLElement) target.focus();
    }, [error, errorId, form]);
    return {
        setError, error,
        field: (name: string) => error?.field === name ? { 'aria-invalid': true, 'aria-describedby': errorId } : {},
        alert: error && <p id={errorId} role="alert" tabIndex={-1} className="training-error">{error.text}</p>
    };
}
type TrainingFields = { title: string; date: string; description: string };
type TrainingEdit = TrainingFields & { status: string; expectedVersion: number };
type TrainingPublish = TrainingFields & { video?: { title: string; url: string } };
export function TrainingForm({ actorId, training }: { actorId: string; training?: Training }) {
    const session = useAccountSession();
    const router = useRouter();
    const submitting = useRef(false);
    const key = useRef(createRequestKey());
    const [busy, setBusy] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);
    const validation = useTrainingError(formRef);
    const confirmation = useRef<HTMLDialogElement>(null);
    const pending = useRef<TrainingEdit | null>(null);
    const submitButton = useRef<HTMLButtonElement>(null);
    const [confirmationText, setConfirmationText] = useState('');
    const confirmationId = useId();
    const id = useId();
    const detailPath = training ? '/admin/trainings/' + training.id : '/admin/trainings';
    const bufferId = training?.id ?? 'training-new';

    function dismissConfirmation() {
        pending.current = null;
        confirmation.current?.close();
        if (!submitButton.current?.closest('[hidden]')) submitButton.current?.focus();
    }
    useEffect(() => session.subscribe(() => {
        pending.current = null;
        confirmation.current?.close();
    }), [session]);

    async function save(body: TrainingEdit | TrainingPublish) {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        validation.setError(null);
        const method = training ? 'PATCH' : 'POST';
        const path = training ? 'trainings/' + training.id : 'trainings/publish';
        let generation: number | undefined;
        let navigating = false;
        try {
            generation = await session.authorize();
            const result = await api<Training | TrainingPublication>(path, { method, actorId, body, key: key.current(actorId, body) });
            if (!session.isCurrent(generation)) return;
            acknowledgeMutation(actorId, method, path, body);
            clearFormUI(actorId, bufferId);
            const saved = 'training' in result ? result.training : result;
            const destination = saved.status === 'deleted' ? '/admin/trainings' : '/admin/trainings/' + saved.id;
            if (!training) navigationBuffer(actorId, destination, 'training-published').write(true);
            router.push(destination);
            navigating = true;
        } catch (e) {
            if (generation === undefined || session.isCurrent(generation)) {
                if (!training && generation !== undefined && !(e instanceof ApiError)) {
                    validation.setError({ text: '请求结果尚未确认。请保留输入，再次确认发布会沿用原请求标识。' });
                } else {
                    validation.setError(!training && 'video' in body ? videoLinkError(e, 'videoLink') : { text: message(e) });
                }
            }
        } finally {
            if (!navigating) {
                submitting.current = false;
                setBusy(false);
            }
        }
    }
    return <form ref={formRef} className="panel training-surface training-fields" data-buffer-id={bufferId} noValidate aria-busy={busy}
        onInput={e => { if ((e.target as HTMLInputElement).name === validation.error?.field) validation.setError(null); }}
        onSubmit={e => {
            e.preventDefault();
            if (submitting.current || pending.current) return;
            const data = new FormData(e.currentTarget);
            const fields = { title: readField(data, 'title'), date: readField(data, 'date'), description: readField(data, 'description') };
            const fail = (field: string, text: string) => validation.setError({ field, text });
            if (!fields.title || fields.title.length > 80) return fail('title', '请输入 1–80 字的训练名称。');
            const date = new Date(fields.date + 'T00:00:00Z');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== fields.date)
                return fail('date', '请选择有效的训练日期。');
            if (fields.description.length > 2000) return fail('description', '训练简介最多 2000 字。');
            if (!training) {
                const video = { title: readField(data, 'videoTitle'), url: readField(data, 'videoLink') };
                if (video.title && !video.url) return fail('videoLink', '请输入 B 站链接或 BV 号。');
                if (video.url && (!video.title || video.title.length > 80)) return fail('videoTitle', '请输入 1–80 字的视频标题。');
                if (video.url.length > 2000) return fail('videoLink', 'B 站分享内容最多 2000 字。');
                void save({ ...fields, ...(video.url ? { video } : {}) });
                return;
            }
            const body = { ...fields, status: readField(data, 'status'), expectedVersion: training.version };
            if (training.status !== body.status) {
                validation.setError(null);
                pending.current = body;
                setConfirmationText(`训练「${body.title}」将更改状态。${statusEffects[body.status] ?? ''}`);
                confirmation.current?.showModal();
                return;
            }
            void save(body);
        }}>
        <div>
            <label htmlFor={id + '-title'}>训练名称 <small>必填</small></label>
            <input id={id + '-title'} disabled={busy} name="title" required maxLength={80} defaultValue={training?.title} placeholder="例如：周末跑位配合" {...validation.field('title')} />
        </div>
        <div>
            <label htmlFor={id + '-date'}>训练日期 <small>必填</small></label>
            <input id={id + '-date'} disabled={busy} name="date" type="date" required defaultValue={training?.date} {...validation.field('date')} />
        </div>
        <div>
            <label htmlFor={id + '-description'}>训练简介 <small>选填</small></label>
            <textarea id={id + '-description'} disabled={busy} name="description" maxLength={2000} rows={training ? 4 : 2}
                defaultValue={training?.description} placeholder="这次练了什么？有什么值得回看的？" {...validation.field('description')} />
        </div>
        {training ? <div>
            <label htmlFor={id + '-status'}>状态</label>
            <select id={id + '-status'} data-retain-ui disabled={busy} name="status" defaultValue={training.status}>
                <option value="draft">草稿 · 仅管理员</option>
                <option value="published">发布 · 队内可读</option>
                <option value="archived">归档 · 历史只读</option>
                <option value="hidden">隐藏 · 成员不可读</option>
                <option value="deleted">删除 · 来源显示不可用</option>
            </select>
        </div> : <fieldset className="training-optional-video">
            <legend>训练视频 <small>选填</small></legend>
            <div>
                <label htmlFor={id + '-video-link'}>B 站链接或 BV 号</label>
                <textarea id={id + '-video-link'} disabled={busy} name="videoLink" maxLength={2000} rows={2} autoCapitalize="none" autoCorrect="off"
                    spellCheck={false} placeholder="粘贴 B 站分享内容、完整链接或 BV 号" {...validation.field('videoLink')} />
            </div>
            <div>
                <label htmlFor={id + '-video-title'}>视频标题</label>
                <input id={id + '-video-title'} disabled={busy} name="videoTitle" maxLength={80} placeholder="例如：跑位配合 · 第一组" {...validation.field('videoTitle')} />
            </div>
        </fieldset>}
        {validation.alert}
        {!training && <p className="training-publish-note">发布后全队可见。</p>}
        <div className="training-actions">
            <button ref={submitButton} type="submit" disabled={busy}>{busy ? (training ? '正在保存…' : '正在发布…') : (training ? '保存训练信息' : '确认发布')} <ChevronRight size={17} aria-hidden="true" /></button>
            <Link className="button secondary" href={detailPath}>返回</Link>
        </div>
        {training && <dialog ref={confirmation} className="add-video-dialog" aria-labelledby={confirmationId}
            onCancel={e => { e.preventDefault(); dismissConfirmation(); }} onClose={() => { pending.current = null; }}>
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
                    dismissConfirmation();
                    void save(body);
                }}>确认并保存</button>
            </div>
        </dialog>}
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
export function AddVideoDialog({ actorId, trainingId, nextPosition, memberVisible = true }: {
    actorId: string; trainingId: string; nextPosition: number; memberVisible?: boolean;
}) {
    const session = useAccountSession();
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const [notice, setNotice] = useState('');
    useEffect(() => session.subscribe(() => { dialog.current?.close(); }), [session]);
    function focusTrigger() {
        if (!trigger.current?.closest('[hidden]')) trigger.current?.focus();
    }
    function close() {
        dialog.current?.close();
        focusTrigger();
    }
    return <>
        <div className="section-heading">
            <h2>训练视频</h2>
            <button type="button" ref={trigger} className="secondary training-add" aria-label="添加视频" aria-haspopup="dialog" onClick={() => {
                setNotice('');
                dialog.current?.showModal();
                dialog.current?.querySelector<HTMLTextAreaElement>('textarea[name=url]')?.focus();
            }}><Plus size={17} aria-hidden="true" />添加视频</button>
        </div>
        {notice && <p role="status" className="muted">{notice}</p>}
        <dialog ref={dialog} className="add-video-dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); close(); }}>
            <div className="section-heading">
                <h2 id={titleId}>添加 B 站视频</h2>
                <button type="button" className="secondary dialog-close" aria-label="关闭添加视频" onClick={close}>关闭</button>
            </div>
            <p className="muted">{memberVisible ? '添加后队员可立即在本次训练中看到视频。' : '训练发布后，队员可在本次训练中看到视频。'}</p>
            <AddVideoForm actorId={actorId} trainingId={trainingId} defaultPosition={nextPosition}
                onAdded={() => { close(); setNotice('视频已添加到下方列表。'); }}
                afterRefresh={() => window.requestAnimationFrame(focusTrigger)} />
        </dialog>
    </>;
}
export function AddVideoForm({ actorId, trainingId, defaultPosition = 0, onAdded, afterRefresh }: {
    actorId: string; trainingId: string; defaultPosition?: number; onAdded?: () => void; afterRefresh?: () => void;
}) {
    const session = useAccountSession();
    const key = useRef(createRequestKey());
    const submitting = useRef(false);
    const [busy, setBusy] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);
    const validation = useTrainingError(formRef);
    const [notice, setNotice] = useState('');
    const order = useRef<HTMLDetailsElement>(null);
    const id = useId();
    return <form ref={formRef} className="training-fields" data-buffer-id={`video-new:${trainingId}`} noValidate aria-busy={busy}
        onInput={e => { if ((e.target as HTMLInputElement).name === validation.error?.field) validation.setError(null); }}
        onSubmit={async e => {
            e.preventDefault();
            if (submitting.current) return;
            const form = e.currentTarget, d = new FormData(form);
            const position = readField(d, 'position');
            const body = { title: readField(d, 'title'), position: position === '' ? defaultPosition : Number(position), source: 'bilibili', url: readField(d, 'url') };
            if (!body.url || body.url.length > 2000) return validation.setError({ field: 'url', text: '请输入 B 站链接、分享内容或 BV 号（最多 2000 字）。' });
            if (!body.title || body.title.length > 80) return validation.setError({ field: 'title', text: '请输入 1–80 字的视频标题。' });
            const positionInput = form.elements.namedItem('position') as HTMLInputElement;
            if (positionInput.validity.badInput || !Number.isSafeInteger(body.position) || body.position < 0 || body.position > 10000) {
                if (order.current) order.current.open = true;
                return validation.setError({ field: 'position', text: '请输入 0–10000 的整数顺序。' });
            }
            submitting.current = true;
            setBusy(true);
            validation.setError(null);
            setNotice('');
            let generation: number | undefined;
            try {
                generation = await session.authorize();
                await api(`trainings/${trainingId}/videos`, { method: 'POST', actorId, body, key: key.current(actorId, body) });
                if (!session.isCurrent(generation)) return;
                acknowledgeMutation(actorId, 'POST', `trainings/${trainingId}/videos`, body);
                clearFormUI(actorId, `video-new:${trainingId}`);
                form.reset();
                key.current = createRequestKey();
                if (!onAdded) setNotice('视频已添加，点击视频标题即可播放。');
                onAdded?.();
                await session.verify();
                afterRefresh?.();
            } catch (e) {
                if (generation === undefined || session.isCurrent(generation)) validation.setError(videoLinkError(e, 'url'));
            } finally {
                submitting.current = false;
                setBusy(false);
            }
        }}>
        <div>
            <label htmlFor={id + '-url'}>B 站分享内容、链接或 BV 号</label>
            <textarea id={id + '-url'} disabled={busy} name="url" required rows={2} maxLength={2000} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="粘贴 B 站分享内容或完整视频地址" {...validation.field('url')} />
        </div>
        <div>
            <label htmlFor={id + '-title'}>视频标题</label>
            <input id={id + '-title'} disabled={busy} name="title" required maxLength={80} placeholder="例如：跑位配合 · 第一组" {...validation.field('title')} />
        </div>
        <details ref={order}><summary>排序（选填）</summary>
            <label htmlFor={id + '-position'}>顺序（从小到大）</label>
            <input id={id + '-position'} disabled={busy} type="number" name="position" min={0} max={10000} defaultValue={defaultPosition} {...validation.field('position')} />
        </details>
        {notice && <p role="status">{notice}</p>}
        {validation.alert}
        <button disabled={busy}>{busy ? '正在添加…' : '添加到训练'}</button>
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
