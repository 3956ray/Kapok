'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronRight, LockKeyhole, Pencil, UsersRound } from 'lucide-react';
import type { Training, Video, CollectionReflectionSeed } from '../../lib/contracts/training';
import type { BootstrapStatus } from '../../lib/contracts';
import { isLearningSourceId, isLearningSourceKind, isLearningSourceRef, learningReflectionHref,
    type LearningSourceKind, type Reflection, type ReflectionAuthor } from '../../lib/contracts/reflections';
import { transferNavigationSource } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { prepareDraftRequest, reconcileDraft, revision } from '../../lib/client/reflection-draft';
import type { Draft } from '../../lib/client/reflection-draft';
import { draftKey, draftPrefix } from '../../lib/client/session-guard';
import { SaveCollection } from './collections';
import { DateGroup, RecordRow } from './presentation';
import { SecureStatus, useSecureResource } from './secure-resource';
import { ReflectionSharingControls } from './reflection-sharing-controls';
const versions = (r: ReflectionAuthor) => ({
    expectedVersion: r.version,
    expectedSharingVersion: r.sharingVersion,
    expectedGeneration: r.generation
});
const errorMessage = (e: unknown) => e instanceof Error ? e.message : '未能保存，请保留内容重试。';
type RecoveredSeedDraft = { localDraft: Draft };
function readLocalDraft(storageKey: string): Draft | null {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const local = JSON.parse(raw) as Draft;
    const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    const validFields = (value: { title?: unknown; text?: unknown; date?: unknown } | null) => value &&
        typeof value.title === 'string' && value.title.length <= 60 && typeof value.text === 'string' && value.text.length <= 5000 &&
        typeof value.date === 'string' && (value.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.date));
    const validSource = (value: Pick<Draft, 'sourceRef'> & { trainingId?: string | null; videoId?: string | null }) =>
        value.sourceRef === undefined || value.sourceRef === null || (isLearningSourceRef(value.sourceRef) && !value.trainingId && !value.videoId);
    const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
    if (!local || local.schema !== 1 || !validFields(local) || typeof local.updatedAt !== 'string' || !validSource(local) ||
        !(local.trainingId === '' || validId(local.trainingId)) || !(local.videoId === '' || validId(local.videoId))) return null;
    if (local.cloud !== null && (!local.cloud || !validId(local.cloud.id) || !validVersion(local.cloud.version) ||
        !validVersion(local.cloud.sharingVersion) || !validVersion(local.cloud.generation))) return null;
    if (local.pending !== null) {
        const pending = local.pending;
        if (!pending || typeof pending.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.key) ||
            pending.targetId !== (local.cloud?.id ?? null) || !validFields(pending.body) || !validSource(pending.body) ||
            !(pending.body.trainingId === null || validId(pending.body.trainingId)) || !(pending.body.videoId === null || validId(pending.body.videoId))) return null;
        if (local.cloud && (pending.body.expectedVersion !== local.cloud.version || pending.body.expectedSharingVersion !== local.cloud.sharingVersion || pending.body.expectedGeneration !== local.cloud.generation)) return null;
    }
    return local;
}
export const scopeLabel = (r: ReflectionAuthor) => r.scope === 'private' ? '仅自己' : r.published ? '全队可读 · 已发布到动态' : '全队可读 · 未发布';
export function ReflectionEditor({
    actorId,
    id,
    collectionId,
    sourceKind,
    sourceId,
    trainingId = '',
    videoId = ''
}: {
    actorId: string;
    id?: string;
    collectionId?: string;
    sourceKind?: LearningSourceKind;
    sourceId?: string;
    trainingId?: string;
    videoId?: string;
}) {
    const router = useRouter();
    const seedPath = collectionId ? `collections/${collectionId}/reflection-seed` : sourceKind && sourceId
        ? `learning/${sourceKind === 'learning_post' ? 'posts' : 'collections'}/${sourceId}/reflection-seed` : null;
    const storageKey = draftKey(actorId, id ?? (collectionId ? `collection:${collectionId}` : sourceKind && sourceId ? `${sourceKind}:${sourceId}` : 'new'));
    const loadSeed = useCallback(async (_account: BootstrapStatus, signal: AbortSignal): Promise<CollectionReflectionSeed | RecoveredSeedDraft> => {
        try {
            return await api<CollectionReflectionSeed>(seedPath!, undefined, actorId, signal);
        } catch (e) {
            signal.throwIfAborted();
            if (e instanceof ApiError && e.code === 'NOT_FOUND') {
                try {
                    const localDraft = readLocalDraft(storageKey);
                    if (localDraft) return { localDraft: localDraft.pending || !localDraft.sourceRef
                        ? localDraft : { ...localDraft, sourceRef: null } };
                } catch { /* Malformed local storage cannot authorize a conversion. */ }
            }
            throw e;
        }
    }, [actorId, seedPath, storageKey]);
    // The loader runs between the secure resource's before/after account checks.
    const secure = useSecureResource<ReflectionAuthor | BootstrapStatus | CollectionReflectionSeed | RecoveredSeedDraft>(actorId, id ? `reflections/${id}/edit` : seedPath ? loadSeed : 'bootstrap');
    const [draft, setDraft] = useState<Draft | null>(null);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [associationOptions, setAssociationOptions] = useState<Training[] | null>(null);
    const [videoOptions, setVideoOptions] = useState<Video[]>([]);
    const [cloudConflict, setCloudConflict] = useState<ReflectionAuthor | null>(null);
    const [base, setBase] = useState<ReflectionAuthor | null>(null);
    const latestDraft = useRef<Draft | null>(null);
    const saving = useRef(false);
    const initialized = useRef(false);
    const confirmation = useRef<HTMLDialogElement>(null);
    const cancelSave = useRef<HTMLButtonElement>(null);
    const confirmSave = useRef<HTMLButtonElement>(null);
    const saveButton = useRef<HTMLButtonElement>(null);
    const restoreSaveFocus = useRef(false);
    const confirmationId = useId();
    const confirmationDescriptionId = useId();
    const subscribe = secure.subscribe;
    useEffect(() => subscribe(() => {
        // Native modals must be closed explicitly when the protected surface locks.
        if (confirmation.current?.open) confirmation.current.close();
        restoreSaveFocus.current = false;
    }), [subscribe]);
    useLayoutEffect(() => {
        if (busy || !restoreSaveFocus.current) return;
        restoreSaveFocus.current = false;
        const button = saveButton.current;
        if (!secure.locked && button && !button.disabled && (document.activeElement === document.body || document.activeElement === button)) button.focus();
    }, [busy, secure.locked]);
    function dismissConfirmation() {
        confirmation.current?.close();
        if (!secure.locked) saveButton.current?.focus();
    }
    useEffect(
        () => {
            if (!secure.sessionEnded) return;
            queueMicrotask(() => {
                latestDraft.current = null;
                setDraft(null);
                setBase(null);
            });
        },
        [secure.sessionEnded]
    );
    useEffect(
        () => {
            if (!secure.data || secure.locked || initialized.current) return;
            let mounted = true;
            queueMicrotask(() => {
                if (!mounted || initialized.current) return;
                initialized.current = true;
                const saved = id ? secure.data as ReflectionAuthor : null;
                setBase(saved);
                const recovered = seedPath && !id && secure.data && 'localDraft' in secure.data ? secure.data.localDraft : null;
                const seed = seedPath && !id && !recovered ? secure.data as CollectionReflectionSeed : null;
                let initial: Draft = recovered ?? {
                    schema: 1,
                    pending: null,
                    cloud: saved ? revision(saved) : null,
                    title: saved?.title ?? '',
                    text: saved?.text ?? seed?.text ?? '',
                    date: saved?.date ?? new Date().toISOString().slice(0, 10),
                    trainingId: saved?.trainingId ?? (seed ? seed.trainingId ?? '' : trainingId),
                    videoId: saved?.videoId ?? (seed ? seed.videoId ?? '' : videoId),
                    ...((saved ?? seed)?.sourceRef !== undefined ? { sourceRef: (saved ?? seed)?.sourceRef } : {}),
                    updatedAt: new Date().toISOString()
                };
                let restored = recovered !== null;
                if (recovered) setStatus(recovered.pending ? '上次云保存结果待确认；将核对上次保存，当前输入仍在本机。' : '已恢复本机草稿 · 仅存此设备，尚未上云');
                try {
                    const local = recovered ? null : readLocalDraft(storageKey);
                    if (local) {
                        // A fresh seed without a source can still recover the owner's text.
                        initial = seed && !seed.sourceRef && local.sourceRef && !local.pending ? { ...local, sourceRef: null } : local;
                        restored = true;
                        setStatus(local.pending ? '上次云保存结果待确认；将核对上次保存，当前输入仍在本机。' : '已恢复本机草稿 · 仅存此设备，尚未上云');
                        if (saved && !local.pending && (local.cloud?.version !== saved.version || local.cloud.sharingVersion !== saved.sharingVersion || local.cloud.generation !== saved.generation)) {
                            setCloudConflict(saved);
                            setError('云端记录已变化。本机稿仍保留，请先对照当前云端记录；可保留本机输入并基于当前云端版本继续，或放弃本机稿。');
                        }
                    } else if (!recovered) setStatus(saved ? '已保存到账号；修改后需再次保存。' : '输入后仅保存到本机，正式保存后才会上云。');
                } catch {
                    setStatus('未能读取本机草稿，请妥善保留输入。');
                }
                if (seed && !restored) {
                    try { localStorage.setItem(storageKey, JSON.stringify(initial)); }
                    catch { setStatus('未能保存到本机，请保留输入并尝试正式保存。'); }
                }
                latestDraft.current = initial;
                setDraft(initial);
            });
            return () => {
                mounted = false;
            };
        },
        [secure.data, secure.locked, id, seedPath, storageKey, trainingId, videoId]
    );
    function change(field: 'title' | 'text' | 'date' | 'videoId' | 'sourceRef', value: string | null) {
        if (!draft || secure.locked) return;
        const latest = {
            ...draft,
            [field]: value,
            updatedAt: new Date().toISOString()
        };
        latestDraft.current = latest;
        setDraft(latest);
        try {
            localStorage.setItem(storageKey, JSON.stringify(latest));
            setStatus('已存本机 · 仅存此设备，尚未上云');
        } catch {
            setStatus('未能保存到本机，请保留输入并尝试正式保存。');
        }
    }
    const currentReflection = id ? secure.data as ReflectionAuthor | null : base;
    const needsConfirmation = currentReflection?.scope === 'team' || currentReflection?.published === true;
    async function save(confirmed = false) {
        if (!draft || saving.current || secure.locked || (needsConfirmation && !confirmed)) return;
        if (!draft.pending && id && draft.cloud?.version !== base?.version) return;
        saving.current = true;
        setBusy(true);
        setError('');
        let token: number | null = null;
        try {
            token = await secure.authorize();
            const prepared = prepareDraftRequest(latestDraft.current ?? draft, crypto.randomUUID());
            // If persistence fails, do not send an unrecoverable create request.
            localStorage.setItem(storageKey, JSON.stringify(prepared));
            latestDraft.current = prepared;
            setDraft(prepared);
            const request = prepared.pending;
            const result = await api<ReflectionAuthor>(
                request.targetId ? `reflections/${request.targetId}` : 'reflections',
                {
                    actorId,
                    method: request.targetId ? 'PATCH' : 'POST',
                    body: request.body,
                    key: request.key
                }
            );
            if (!secure.isCurrent(token)) return;
            await secure.authorize();
            if (!secure.isCurrent(token)) return;
            setBase(result);
            if (id) secure.setData(result);
            const reconciled = reconcileDraft(latestDraft.current ?? prepared, result);
            latestDraft.current = reconciled.draft;
            if (!reconciled.saved) {
                localStorage.setItem(storageKey, JSON.stringify(reconciled.draft));
                setDraft(reconciled.draft);
                setStatus('上次保存结果已确认；当前输入仍未上云，请继续保存。');
                return;
            }
            localStorage.removeItem(storageKey);
            transferNavigationSource(actorId, `/reflections/${result.id}`);
            router.push(`/reflections/${result.id}?saved=1`);
        } catch (e) {
            if (token !== null && !secure.isCurrent(token)) return;
            if (token !== null && secure.isCurrent(token) && e instanceof ApiError && !e.retryable && latestDraft.current) {
                const retained = {
                    ...latestDraft.current,
                    pending: null
                };
                latestDraft.current = retained;
                setDraft(retained);
                try {
                    localStorage.setItem(storageKey, JSON.stringify(retained));
                } catch {/* The error remains visible below. */ }
            }
            if (token !== null && secure.isCurrent(token) && e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
                const target = latestDraft.current?.cloud?.id ?? id;
                if (target) {
                    try {
                        const latest = await api<ReflectionAuthor>(`reflections/${target}/edit`, undefined, actorId);
                        if (secure.isCurrent(token)) {
                            setCloudConflict(latest);
                            if (id) secure.setData(latest);
                        }
                    } catch {/* Keep the safe conflict and local input until current state can be read. */ }
                }
            }
            setError(errorMessage(e));
            setStatus(e instanceof ApiError && !e.retryable ? '未保存，当前输入保留在本机。' : '未确认云保存；本机稿与上次保存信息仍保留，可继续确认。');
            if (e instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND'].includes(e.code)) void secure.verify();
        } finally {
            saving.current = false;
            setBusy(false);
        }
    }
    const saveDisabled = busy || (!draft?.pending && (cloudConflict !== null || (!!id && draft?.cloud?.version !== base?.version)));
    const saveLabel = busy ? '正在保存到账号…' : draft?.pending ? '确认上次云保存结果' : '保存记录';
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {draft && <form className="reflection-editor" onSubmit={e => {
                e.preventDefault();
                if (saveDisabled || secure.locked || saving.current) return;
                if (needsConfirmation) {
                    if (confirmation.current && !confirmation.current.open) {
                        confirmation.current.showModal();
                        cancelSave.current?.focus();
                    }
                    return;
                }
                restoreSaveFocus.current = document.activeElement === saveButton.current;
                void save();
            }}>

                <p className="privacy-line"><LockKeyhole size={16} aria-hidden="true" />{needsConfirmation ? '保存前需确认收回分享' : '保存后仅自己可读'}</p>
                {collectionId && <p className="notice">{secure.data && 'localDraft' in secure.data ? '原收藏当前不可用，已恢复本机草稿。保存后仅自己可见。' : '从本人已保存的私人备注开始，关联仅在来源仍可访问时带入。原收藏会保留；这份复盘需明确保存到账号，保存后默认仅自己可见。'}</p>}

                {sourceKind && !collectionId && <p className="notice">{secure.data && 'localDraft' in secure.data
                    ? '学习来源当前不可用，已恢复本机草稿。' : '添加自己的复盘内容，保存后仅自己可见。'}</p>}
                <label className="reflection-title-field"><span className="sr-only">标题（可选，最多60字）</span>
                    <input value={draft.title} placeholder="标题（选填）" maxLength={60} onChange={e => change('title', e.target.value)} />
                </label>

                <label><span className="sr-only">复盘正文</span>
                    <textarea
                        className="reflection-input"
                        required
                        maxLength={5000}
                        rows={6}
                        placeholder="这次训练，你注意到了什么？"
                        value={draft.text}
                        onChange={e => change('text', e.target.value)}
                    />
                </label>

                <p className="muted">{draft.text.length} / 5000字</p>

                <details className="reflection-fields">

                    <summary><CalendarDays size={16} aria-hidden="true" />日期与关联 <span className="muted">{draft.sourceRef ? '已关联学习来源' : draft.videoId ? '已关联视频' : draft.trainingId ? '已关联训练' : '未关联来源'}</span></summary>
                    <label>记录日期
                        <input type="date" required value={draft.date} onChange={e => change('date', e.target.value)} onInvalid={e => {
                            const details = e.currentTarget.closest('details');
                            if (details) details.open = true;
                        }} />
                    </label>

                    {draft.sourceRef ? <button type="button" className="secondary" disabled={busy || draft.pending !== null}
                        onClick={() => change('sourceRef', null)}>移除学习来源关联</button> : <>
                    <button
                        type="button"
                        className="secondary"
                        onClick={async () => {
                            try {
                                const token = await secure.authorize();
                                const list = await api<Training[]>('trainings', undefined, actorId);
                                if (secure.isCurrent(token)) setAssociationOptions(list.filter(t => ['published', 'archived'].includes(t.status)));
                            } catch (e) {
                                setError(errorMessage(e));
                            }
                        }}
                    >加载可关联训练</button>

                    <label>关联训练（可选）
                        <select
                            value={draft.trainingId}
                            onChange={async e => {
                                const training = e.target.value;
                                const latest = {
                                    ...draft,
                                    trainingId: training,
                                    videoId: '',
                                    updatedAt: new Date().toISOString()
                                };
                                latestDraft.current = latest;
                                setDraft(latest);
                                setVideoOptions([]);
                                try {
                                    localStorage.setItem(storageKey, JSON.stringify(latest));
                                    setStatus('已存本机 · 尚未上云');
                                } catch {
                                    setStatus('未能保存到本机');
                                }
                                if (!training) return;
                                try {
                                    const token = await secure.authorize();
                                    const detail = await api<Training & {
                                        videos: Video[];
                                    }>(
                                        `trainings/${training}`,
                                        undefined,
                                        actorId
                                    );
                                    if (secure.isCurrent(token) && latestDraft.current?.trainingId === training) setVideoOptions(detail.videos.filter(v => v.status === 'active'));
                                } catch (e) {
                                    setError(errorMessage(e));
                                }
                            }}
                        >

                            <option value="">不关联</option>

                            {draft.trainingId && !associationOptions?.some(t => t.id === draft.trainingId) && <option value={draft.trainingId}>已关联的训练</option>}

                            {associationOptions?.map(t => <option key={t.id} value={t.id}>{t.date} {t.title}</option>)}

                        </select>
                    </label>

                    {draft.trainingId && <label>关联视频（可选）
                        <select value={draft.videoId} onChange={e => change('videoId', e.target.value)}>

                            <option value="">只关联训练</option>

                            {draft.videoId && !videoOptions.some(v => v.id === draft.videoId) && <option value={draft.videoId}>已关联的视频</option>}

                            {videoOptions.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}

                        </select>
                    </label>}

                    </>}
                </details>

                {cloudConflict && <section className="notice">

                    <h2>当前云端版本</h2>

                    <p>{cloudConflict.date} · {cloudConflict.title || '训练复盘'}</p>

                    <p className="preserve">{cloudConflict.text}</p>

                    <p>上方输入框仍是本机内容。继续编辑后保存会停止分享并撤回动态。</p>

                    <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                            const latest = {
                                ...draft,
                                pending: null,
                                cloud: revision(cloudConflict),
                                ...(!draft.trainingId && draft.sourceRef === undefined && cloudConflict.sourceRef
                                    ? { sourceRef: cloudConflict.sourceRef } : {})
                            };
                            latestDraft.current = latest;
                            setDraft(latest);
                            setBase(cloudConflict);
                            setCloudConflict(null);
                            setError('');
                            try {
                                localStorage.setItem(storageKey, JSON.stringify(latest));
                                setStatus('已保留本机输入，尚未覆盖云端；可再次明确保存。');
                            } catch {
                                setStatus('未能保存到本机');
                            }
                        }}
                    >保留本机输入，基于当前云版本继续</button>

                </section>}

                <div className="editor-save">
                    <button ref={saveButton} disabled={saveDisabled} aria-haspopup={needsConfirmation ? 'dialog' : undefined}>{saveLabel}</button>
                    <p role="status" className="muted">{busy ? '正在保存到账号…' : status}</p>
                </div>

                {error && <p role="alert" className="form-error">{error}</p>}

                <button
                    type="button"
                    className="secondary"
                    disabled={busy || draft.pending !== null}
                    onClick={() => {
                        if (window.confirm('放弃此设备上的未上云稿，并重新加载？')) {
                            localStorage.removeItem(storageKey);
                            window.location.reload();
                        }
                    }}
                >放弃本机稿</button>
                {draft.pending && <p className="muted">上次保存待确认时，先核对结果再放弃；也可前往成长查看已保存记录，本机恢复信息会保留。</p>}
                <dialog ref={confirmation} className="sharing-dialog" aria-labelledby={confirmationId} aria-describedby={confirmationDescriptionId} onCancel={e => {
                    e.preventDefault();
                    dismissConfirmation();
                }} onKeyDown={e => {
                    if (e.key !== 'Tab') return;
                    const edge = e.shiftKey ? cancelSave.current : confirmSave.current;
                    if (document.activeElement === edge) {
                        e.preventDefault();
                        (e.shiftKey ? confirmSave.current : cancelSave.current)?.focus();
                    }
                }}>
                    <h2 id={confirmationId}>保存并收回分享？</h2>
                    <p id={confirmationDescriptionId}>保存后，这篇复盘将仅自己可读，已发布的动态也会撤回。取消会保留本机稿，原有正文和分享状态不变。</p>
                    <div className="sharing-actions">
                        <button type="button" className="secondary" ref={cancelSave} onClick={dismissConfirmation}>取消</button>
                        <button type="button" ref={confirmSave} onClick={() => {
                            if (!confirmation.current?.open || secure.locked) return;
                            dismissConfirmation();
                            restoreSaveFocus.current = true;
                            void save(true);
                        }}>保存并收回分享</button>
                    </div>
                </dialog>
            </form>}
        </div>
    </>;
}
export function ReflectionRead({
    actorId,
    id,
    saved
}: {
    actorId: string;
    id: string;
    saved: boolean;
}) {
    const secure = useSecureResource<Reflection>(actorId, `reflections/${id}`);
    const r = secure.data;
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div
            data-kapok-sensitive
            ref={node => secure.attach(node)}
            hidden={secure.locked}
            className="reflection-reading"
        >
            {r && <>
                {saved && r.isAuthor && <p role="status" className="notice success">已保存到账号。</p>}
                <article className="reflection-paper">
                    <header>
                        <p className="detail-meta"><time dateTime={r.date}>{r.date}</time> · {r.author.discName} {r.author.jerseyNumber}</p>
                        <h2 className="detail-title">{r.title || '训练复盘'}</h2>
                        <p className="privacy-line">{r.isAuthor && (r as ReflectionAuthor).scope === 'private' ? <LockKeyhole size={16} aria-hidden="true" /> : <UsersRound size={16} aria-hidden="true" />}{r.isAuthor ? scopeLabel(r as ReflectionAuthor) : '全队可读'}</p>
                    </header>
                    <p className="preserve reflection-body">{r.text}</p>
                    {r.link ? <Link className="detail-row" href={r.link.href}>
                        <span className="detail-tile"><CalendarDays size={20} aria-hidden="true" /></span>
                        <span><strong>关联来源</strong><small>{r.link.title}</small></span>
                        <ChevronRight size={18} aria-hidden="true" />
                    </Link> : <p className="muted">未关联来源或来源当前不可用。</p>}
                </article>
                {r.isAuthor ? <AuthorActions
                    actorId={actorId}
                    reflection={r as ReflectionAuthor}
                    refresh={secure.verify}
                    authorize={secure.authorize}
                    isCurrent={secure.isCurrent}
                /> : <SaveCollection actorId={actorId} sourceKind="reflection" sourceId={r.id} />}
            </>}
        </div>
    </>;
}
function AuthorActions({
    actorId,
    reflection: r,
    refresh,
    authorize,
    isCurrent
}: {
    actorId: string;
    reflection: ReflectionAuthor;
    refresh: () => Promise<void>;
    authorize: () => Promise<number>;
    isCurrent: (token: number) => boolean;
}) {
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [copyFeedback, setCopyFeedback] = useState<{ kind: 'neutral' | 'success' | 'error'; text: string } | null>(null);
    const key = useRef(createRequestKey());
    async function submit(path: string, method: 'PUT' | 'DELETE', body: unknown) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const token = await authorize();
            await api(
                path,
                {
                    actorId,
                    method,
                    body,
                    key: key.current(actorId, body)
                }
            );
            if (!isCurrent(token)) return;
            if (method === 'DELETE') window.location.replace('/growth'); else await refresh();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    }
    return <section className="section reflection-author-actions" aria-label="本人记录操作">
        <div className="actions">
            <Link className="button secondary" href={`/reflections/${r.id}/edit`}><Pencil size={16} aria-hidden="true" />编辑记录</Link>
            <Link className="button" href={`/reflections/${r.id}/sharing`}>{r.scope === 'team' && !r.published ? '发布到队内动态' : '管理分享与发布'}</Link>
        </div>
        <div className="actions">
            <button
                type="button"
                className="secondary"
                onClick={async () => {
                    setCopyFeedback({ kind: 'neutral', text: '正在复制阅读链接…' });
                    try {
                        const token = await authorize();
                        await navigator.clipboard.writeText(window.location.origin + '/reflections/' + r.id);
                        if (isCurrent(token)) setCopyFeedback({ kind: 'success', text: '阅读链接已复制；链接不自动授予阅读权限。' });
                    } catch {
                        setCopyFeedback({ kind: 'error', text: '未能复制，请使用浏览器地址栏复制阅读页地址。' });
                    }
                }}
            >复制阅读链接</button>
            <button
                className="secondary danger"
                disabled={busy}
                onClick={() => {
                    if (window.confirm('删除这份复盘？将停止全部分享并撤回动态，可在7天内从本人回收站恢复为私密原稿。')) void submit(`reflections/${r.id}`, 'DELETE', versions(r));
                }}
            >删除记录</button>
        </div>

        {copyFeedback && <p role={copyFeedback.kind === 'error' ? 'alert' : 'status'} className={`notice ${copyFeedback.kind}`}>{copyFeedback.text}</p>}

        {error && <p role="alert" className="form-error">{error}</p>}

    </section>;
}
function ownerReflectionLabel(reflection: ReflectionAuthor) {
    if (reflection.title.trim()) return reflection.title;
    const characters = Array.from(reflection.text.trim());
    return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '');
}
export function MyReflections({
    actorId,
    home = false
}: {
    actorId: string;
    home?: boolean;
}) {
    const secure = useSecureResource<ReflectionAuthor[]>(actorId, 'reflections');
    const rows = home ? secure.data?.filter(r => r.scope === 'private').slice(0, 3) : secure.data;
    return <section className="section">

        <h2>{home ? '已保存的私密复盘' : '本人复盘'}</h2>

        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />

        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {rows?.length ? rows.map((r, index) => <Fragment key={r.id}>
                {!home && (index === 0 || rows[index - 1].date.slice(0, 7) !== r.date.slice(0, 7)) && <DateGroup date={r.date} />}
                <div className={'panel' + (home ? ' clay' : '')}><RecordRow date={r.date} title={ownerReflectionLabel(r)} href={`/reflections/${r.id}`} detail={scopeLabel(r)} /></div>
            </Fragment>) : <p className="muted">{home ? '还没有已保存的私密复盘。' : '还没有本人复盘，可以从一段想法开始。'}</p>}
        </div>

    </section>;
}
export function LocalDrafts({
    actorId
}: {
    actorId: string;
}) {
    const secure = useSecureResource<BootstrapStatus>(actorId, 'bootstrap');
    const [items, setItems] = useState<{
        href: string;
        updatedAt: string;
    }[]>([]);
    useEffect(
        () => {
            if (secure.locked) return;
            let mounted = true;
            queueMicrotask(() => {
                if (!mounted) return;
                const prefix = draftPrefix + encodeURIComponent(actorId) + ':';
                const found = [];
                try {
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (!key?.startsWith(prefix)) continue;
                        const draft = JSON.parse(localStorage.getItem(key) ?? '{}') as Draft;
                        if (!draft.text?.trim()) continue;
                        const id = decodeURIComponent(key.slice(prefix.length));
                        const [kind, sourceId] = id.split(':');
                        const href = id === 'new' ? '/reflections/new' : kind === 'collection' && isLearningSourceId(sourceId)
                            ? `/reflections/new?collection=${encodeURIComponent(sourceId)}`
                            : isLearningSourceKind(kind) && isLearningSourceId(sourceId)
                                ? learningReflectionHref(kind, sourceId) : `/reflections/${encodeURIComponent(id)}/edit`;
                        found.push({
                            href,
                            updatedAt: draft.updatedAt
                        });
                    }
                    setItems(found);
                } catch {/* Drafts are optional; no server empty state is inferred. */ }
            });
            return () => {
                mounted = false;
            };
        },
        [actorId, secure.locked]
    );
    return <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
        {!!items.length && <section className="section panel clay">
            <h2>继续本地草稿</h2>
            <p>仅存此设备，尚未上云。</p>

            {items.map(item => <p key={item.href}>
                <Link href={item.href}>继续写作</Link> ·
                {item.updatedAt?.slice(0, 16).replace('T', ' ')}
            </p>)}

        </section>}
    </div>;
}
export function ReflectionSharing({
    actorId,
    id
}: {
    actorId: string;
    id: string;
}) {
    const secure = useSecureResource<ReflectionAuthor>(actorId, `reflections/${id}/edit`);
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && <ReflectionSharingControls
                actorId={actorId}
                reflection={secure.data}
                refresh={secure.verify}
                authorize={secure.authorize}
                isCurrent={secure.isCurrent}
                subscribe={secure.subscribe}
                onVerified={secure.setData}
            />}
        </div>
    </>;
}
