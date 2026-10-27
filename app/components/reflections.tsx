'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Training, Video, CollectionReflectionSeed } from '../../lib/contracts/training';
import type { BootstrapStatus } from '../../lib/contracts';
import type { Reflection, ReflectionAuthor } from '../../lib/contracts/reflections';
import { transferNavigationSource, useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { prepareDraftRequest, reconcileDraft, revision } from '../../lib/client/reflection-draft';
import type { Draft } from '../../lib/client/reflection-draft';
import { draftKey, draftPrefix } from '../../lib/client/session-guard';
import { SaveCollection } from './collections';
import { DateGroup, RecordRow } from './presentation';
import { SecureStatus, useSecureResource } from './secure-resource';
const versions = (r: ReflectionAuthor) => ({
    expectedVersion: r.version,
    expectedSharingVersion: r.sharingVersion,
    expectedGeneration: r.generation
});
const errorMessage = (e: unknown) => e instanceof Error ? e.message : '未能保存，请保留内容重试。';
type RecoveredCollectionDraft = { localDraft: Draft };
function readCollectionDraftForRecovery(storageKey: string): Draft | null {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const local = JSON.parse(raw) as Draft;
    const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    const validFields = (value: { title?: unknown; text?: unknown; date?: unknown } | null) => value &&
        typeof value.title === 'string' && value.title.length <= 60 && typeof value.text === 'string' && value.text.length <= 5000 &&
        typeof value.date === 'string' && (value.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.date));
    const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
    if (!local || local.schema !== 1 || !validFields(local) || typeof local.updatedAt !== 'string' ||
        !(local.trainingId === '' || validId(local.trainingId)) || !(local.videoId === '' || validId(local.videoId))) return null;
    if (local.cloud !== null && (!local.cloud || !validId(local.cloud.id) || !validVersion(local.cloud.version) ||
        !validVersion(local.cloud.sharingVersion) || !validVersion(local.cloud.generation))) return null;
    if (local.pending !== null) {
        const pending = local.pending;
        if (!pending || typeof pending.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.key) ||
            pending.targetId !== (local.cloud?.id ?? null) || !validFields(pending.body) ||
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
    trainingId = '',
    videoId = ''
}: {
    actorId: string;
    id?: string;
    collectionId?: string;
    trainingId?: string;
    videoId?: string;
}) {
    const router = useRouter();
    const storageKey = draftKey(actorId, id ?? (collectionId ? `collection:${collectionId}` : 'new'));
    const loadCollection = useCallback(async (_account: BootstrapStatus, signal: AbortSignal): Promise<CollectionReflectionSeed | RecoveredCollectionDraft> => {
        try {
            return await api<CollectionReflectionSeed>(`collections/${collectionId}/reflection-seed`, undefined, actorId, signal);
        } catch (e) {
            signal.throwIfAborted();
            if (e instanceof ApiError && e.code === 'NOT_FOUND') {
                try {
                    const localDraft = readCollectionDraftForRecovery(storageKey);
                    if (localDraft) return { localDraft };
                } catch { /* Unreadable or malformed local storage cannot authorize an empty conversion. */ }
            }
            throw e;
        }
    }, [actorId, collectionId, storageKey]);
    // The loader runs between the secure resource's before/after account checks.
    const secure = useSecureResource<ReflectionAuthor | BootstrapStatus | CollectionReflectionSeed | RecoveredCollectionDraft>(actorId, id ? `reflections/${id}/edit` : collectionId ? loadCollection : 'bootstrap');
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
                const recovered = collectionId && !id && secure.data && 'localDraft' in secure.data ? secure.data.localDraft : null;
                const seed = collectionId && !id && !recovered ? secure.data as CollectionReflectionSeed : null;
                let initial: Draft = recovered ?? {
                    schema: 1,
                    pending: null,
                    cloud: saved ? revision(saved) : null,
                    title: saved?.title ?? '',
                    text: saved?.text ?? seed?.text ?? '',
                    date: saved?.date ?? new Date().toISOString().slice(0, 10),
                    trainingId: saved?.trainingId ?? (seed ? seed.trainingId ?? '' : trainingId),
                    videoId: saved?.videoId ?? (seed ? seed.videoId ?? '' : videoId),
                    updatedAt: new Date().toISOString()
                };
                let restored = recovered !== null;
                if (recovered) setStatus(recovered.pending ? '上次云保存结果待确认；将核对上次保存，当前输入仍在本机。' : '已恢复本机草稿 · 仅存此设备，尚未上云');
                try {
                    const raw = recovered ? null : localStorage.getItem(storageKey);
                    if (raw) {
                        const local = JSON.parse(raw) as Draft;
                        if (local.schema === 1 && typeof local.text === 'string' && typeof local.title === 'string' && typeof local.date === 'string' && typeof local.trainingId === 'string' && typeof local.videoId === 'string') {
                            initial = local;
                            restored = true;
                            setStatus(local.pending ? '上次云保存结果待确认；将核对上次保存，当前输入仍在本机。' : '已恢复本机草稿 · 仅存此设备，尚未上云');
                            if (saved && !local.pending && local.cloud?.version !== saved.version) {
                                setCloudConflict(saved);
                                setError('云端记录已变化。本机稿仍保留，请先对照当前云端记录；可保留本机输入并基于当前云端版本继续，或放弃本机稿。');
                            }
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
        [secure.data, secure.locked, id, collectionId, storageKey, trainingId, videoId]
    );
    function change(field: keyof Draft, value: string) {
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
    async function save() {
        if (!draft || saving.current || secure.locked) return;
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
                        if (secure.isCurrent(token)) setCloudConflict(latest);
                    } catch {/* Keep the safe conflict and local input until current state can be read. */ }
                }
            }
            setError(errorMessage(e));
            setStatus(e instanceof ApiError && !e.retryable ? '未保存，当前输入保留在本机。' : '未确认云保存；本机稿与上次保存信息仍保留，可继续确认。');
        } finally {
            saving.current = false;
            setBusy(false);
        }
    }
    const saveDisabled = busy || (!draft?.pending && id ? draft?.cloud?.version !== base?.version : false);
    const saveLabel = busy ? '正在保存到账号…' : draft?.pending ? '确认上次云保存结果' : '保存记录';
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {draft && <form className="reflection-editor" onSubmit={e => {
                e.preventDefault();
                void save();
            }}>

                {collectionId && <p className="notice">{secure.data && 'localDraft' in secure.data ? '原收藏当前不可用，已恢复此设备上的独立草稿；复盘仍需明确保存，默认仅自己可见。' : '从本人已保存的私人备注开始，关联仅在来源仍可访问时带入。原收藏会保留；这份复盘需明确保存到账号，保存后默认仅自己可见。'}</p>}
                {id && <p className="notice">保存修改将停止全部分享并撤回动态，需要重新分享。</p>}

                <p role="status" className="muted">{busy ? '正在保存到账号…' : status}</p>

                <details open className="reflection-fields">

                    <summary>标题、日期与关联</summary>

                    <label>标题（可选，最多60字）
                        <input value={draft.title} maxLength={60} onChange={e => change('title', e.target.value)} />
                    </label>

                    <label>记录日期
                        <input type="date" required value={draft.date} onChange={e => change('date', e.target.value)} />
                    </label>

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

                </details>

                <label>复盘正文
                    <textarea
                        className="reflection-input"
                        required
                        maxLength={5000}
                        rows={6}
                        value={draft.text}
                        onChange={e => change('text', e.target.value)}
                    />
                </label>

                <p className="muted">{draft.text.length} / 5000字。可以只写一段文字，不必关联训练。</p>



                {cloudConflict && <section className="notice">

                    <h2>当前云端版本</h2>

                    <p>{cloudConflict.date} · {cloudConflict.title || '训练复盘'}</p>

                    <p className="preserve">{cloudConflict.text}</p>

                    <p>上方输入框仍是本机内容。继续编辑后保存会停止分享并撤回动态。</p>

                    <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                            const latest = {
                                ...draft,
                                pending: null,
                                cloud: revision(cloudConflict)
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
                    <button disabled={saveDisabled}>{saveLabel}</button>
                    <p className="muted">{busy ? '正在保存到账号…' : status}</p>
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
                <h2>{r.title || '训练复盘'}</h2>
                <p>{r.date} · {r.author.discName} {r.author.jerseyNumber}</p>
                <p className="preserve reflection-body">{r.text}</p>
                {r.link ? <Link href={r.link.href}>关联：{r.link.title}</Link> : <p className="muted">未关联来源或来源当前不可用。</p>}
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
    isCurrent,
    manage = false
}: {
    actorId: string;
    manage?: boolean;
    reflection: ReflectionAuthor;
    refresh: () => Promise<void>;
    authorize: () => Promise<number>;
    isCurrent: (token: number) => boolean;
}) {
    const scopeId = useId();
    const [scope, setScope] = useNavigationField(actorId, 'sharing:' + r.id, r.scope);
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
    return <section className="section">

        <p className="status-label">{scopeLabel(r)}</p>

        {!manage && <p>
            <Link className="button secondary" href={`/reflections/${r.id}/edit`}>编辑记录</Link>
        </p>}

        {!manage && <p>
            <Link className="button secondary" href={`/reflections/${r.id}/sharing`}>管理分享与发布</Link>
        </p>}

        {manage && <section className="panel">
            <h2>阅读范围</h2>

            <form onSubmit={e => {
                e.preventDefault();
                const explanation = scope === 'team' ? '全队现有及以后有效成员可阅读，并在你的队内公开档案列出；不会进入首页动态。' : '停止全部分享并撤回动态，仅自己可读。';
                if (window.confirm(explanation)) void submit(
                    `reflections/${r.id}/grants`,
                    'PUT',
                    {
                        ...versions(r),
                        scope
                    }
                );
            }}>

                <fieldset className="scope-choice" disabled={busy}>
                    <legend>让谁读到这篇？</legend>
                    <label className="permission"><input type="radio" name={scopeId} value="private" checked={scope === 'private'} onChange={() => setScope('private')} /><span>仅自己<small>默认私密，留给自己</small></span></label>
                    <label className="permission"><input type="radio" name={scopeId} value="team" checked={scope === 'team'} onChange={() => setScope('team')} /><span>全队<small>包含当前及未来的有效成员</small></span></label>
                </fieldset>
                <button disabled={busy}>确认阅读范围</button>

            </form>

        </section>}

        {manage && <section className="publication-panel">
            <h2>是否出现在队内动态？</h2>
            <p className="muted">阅读范围与动态发布分别确认。全队可读后，才可选择发布。</p>
            <p className="small">{r.published ? '当前已发布到队内动态' : '当前尚未发布'}</p>
            <button
                className="secondary"
                disabled={busy || r.scope !== 'team'}
                onClick={() => {
                    if (window.confirm(r.published ? '撤回动态，仍允许全队阅读。' : '将此复盘加入首页与动态列表；队内公开档案和阅读链接仍依全队授权。')) void submit(
                        `reflections/${r.id}/publication`,
                        'PUT',
                        {
                            ...versions(r),
                            published: !r.published
                        }
                    );
                }}
            >{r.published ? '撤回动态，仍允许全队阅读' : '发布到动态'}</button>
        </section>}

        {manage && r.scope !== 'private' && <p>
            <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                    if (window.confirm('停止全部分享并撤回动态，仅自己可读？')) void submit(
                        `reflections/${r.id}/grants`,
                        'PUT',
                        {
                            ...versions(r),
                            scope: 'private'
                        }
                    );
                }}
            >停止分享，仅自己</button>
        </p>}

        <p>
            <button
                type="button"
                className="secondary"
                onClick={async () => {
                    setCopyFeedback({ kind: 'neutral', text: '正在复制阅读链接…' });
                    try {
                        await navigator.clipboard.writeText(window.location.origin + '/reflections/' + r.id);
                        setCopyFeedback({ kind: 'success', text: '阅读链接已复制；链接不自动授予阅读权限。' });
                    } catch {
                        setCopyFeedback({ kind: 'error', text: '未能复制，请使用浏览器地址栏复制阅读页地址。' });
                    }
                }}
            >复制阅读链接</button>
        </p>

        <button
            className="secondary danger"
            disabled={busy}
            onClick={() => {
                if (window.confirm('删除这份复盘？将停止全部分享并撤回动态，可在7天内从本人回收站恢复为私密原稿。')) void submit(`reflections/${r.id}`, 'DELETE', versions(r));
            }}
        >删除记录</button>

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
                        found.push({
                            href: id === 'new' ? '/reflections/new' : id.startsWith('collection:') ? `/reflections/new?collection=${encodeURIComponent(id.slice('collection:'.length))}` : `/reflections/${encodeURIComponent(id)}/edit`,
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
            {secure.data && <>
                <h2>{secure.data.title || '训练复盘'}</h2>
                <p>链接不自动授予阅读权限。保存修改、删除或停止分享会撤销旧阅读范围及动态。</p>
                <AuthorActions
                    actorId={actorId}
                    reflection={secure.data}
                    manage
                    refresh={secure.verify}
                    authorize={secure.authorize}
                    isCurrent={secure.isCurrent}
                />
            </>}
        </div>
    </>;
}
