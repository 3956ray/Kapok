'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../../lib/client/api';
import {
    confirmedRejection, draftImageOrder, finishLearningImage, imageReferences, learningMutation, learningRecovery,
    matchesLearningFile, preserveImageOrder, queueLearningImage, sendLearning,
    type ImageOrder, type LearningMutation, type QueuedLearningImage,
} from '../../lib/client/learning-images';
import {
    learningCategories, learningDefaults, learningImageAltMax, learningImageTypes,
    type LearningDraft, type LearningImageReservation, type LearningPostFields, type LearningPostInput,
} from '../../lib/contracts/learning';
import type { LearningAssociation, TopicChoice } from '../../lib/contracts/topic-collections';
import type { BootstrapStatus } from '../../lib/contracts';
import { parseYouTubeSource } from '../../lib/video-source';
import { AccountBoundary } from './secure-resource';
import { LearningConfirm, LearningImageView, LearningLocalImage, LearningMedia, learningEpoch, useLearningAction } from './learning-controls';
import { LearningAssociationStatus, learningStatus } from './learning-posts';

const postsPath = 'learning/posts';
const acceptImages = learningImageTypes.join(',');
const postHref = (id: string) => '/learn/posts/' + id;
const getDraft = (id: string, actorId: string, signal: AbortSignal) => api<LearningDraft>(postsPath + '/' + id + '?view=draft', undefined, actorId, signal);
type Input = Omit<LearningPostFields, 'video'> & { url: string; collectionTargetId: string | null };
type Cleanup = { id: string; key: string; pinned?: boolean };
type Pending = { phase: 'save' | 'publish' | 'inclusion'; request: LearningMutation; expected?: number };
type Work = {
    id: string | null; version: number | null; fields: Input; order: ImageOrder[]; known: string[];
    queue: QueuedLearningImage[]; cleanup: Cleanup[]; pending: Pending | null;
};
const editorRecovery = (actor: string, id: string, epoch: string) => learningRecovery<Work>(actor, 'edit:' + id, epoch);
const newEditorRecovery = (actor: string, epoch: string) => learningRecovery<Work | { id: string }>(actor, 'edit:new', epoch);
const initialFields: Input = { kind: 'article', category: '战术', title: '', summary: '', body: '', url: '', collectionTargetId: null };

function workFrom(draft: LearningDraft | null): Work {
    const fields = draft ? { kind: draft.kind, category: draft.category, title: draft.title, summary: draft.summary,
        body: draft.body, url: draft.video?.url ?? '', collectionTargetId: draft.collectionTargetId } : initialFields;
    return {
        id: draft?.id ?? null, version: draft?.version ?? null, fields, order: draftImageOrder(draft?.images ?? []),
        known: draft?.images.map(image => image.id) ?? [], queue: [], cleanup: [], pending: null,
    };
}

function postInput(fields: Input, order: ImageOrder[]): LearningPostInput {
    const { url, ...rest } = fields;
    const source = parseYouTubeSource(url);
    return {
        ...rest,
        video: fields.kind === 'video' ? { source: source ? 'youtube' : 'bilibili', url: source?.url ?? url.trim() } : null,
        ...(fields.kind === 'article' ? { images: imageReferences(order) } : {}),
    };
}

export function LearningEditing({ actorId, id }: { actorId: string; id?: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        if (account.me.membership?.status !== 'active') {
            throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有队伍访问权限。', retryable: false }, requestId: '' });
        }
        const epoch = learningEpoch(account);
        const fromNew = !id ? newEditorRecovery(actorId, epoch).read()?.id : null;
        const target = id ?? (fromNew && /^[a-zA-Z0-9_-]{1,80}$/.test(fromNew) ? fromNew : null);
        const [draft, choices] = await Promise.all([
            target ? getDraft(target, actorId, signal) : null,
            api<TopicChoice[]>('learning/collections/editable', undefined, actorId, signal).catch(error => {
                if (signal.aborted || (error instanceof ApiError && ['ACCOUNT_CHANGED', 'AUTHENTICATION_REQUIRED', 'SESSION_UNVERIFIED'].includes(error.code))) throw error;
                return null;
            }),
        ]);
        return { draft, choices, epoch };
    }, [actorId, id]);
    return <AccountBoundary actorId={actorId} load={load}>{data => <Editor {...data} actorId={actorId} routeId={id} />}</AccountBoundary>;
}

function Editor({ draft, choices, epoch, actorId, routeId }: {
    draft: LearningDraft | null; choices: TopicChoice[] | null; epoch: string; actorId: string; routeId?: string;
}) {
    const router = useRouter();
    const newRecovery = newEditorRecovery(actorId, epoch);
    const [work, setWork] = useState(() => {
        const target = routeId ?? draft?.id;
        if (target) return editorRecovery(actorId, target, epoch).read() ?? workFrom(draft);
        const stored = newRecovery.read();
        return stored && 'fields' in stored ? stored : workFrom(draft);
    });
    const latest = useRef(work);
    const [accepted, setAccepted] = useState<LearningDraft | null>(null);
    const [files, setFiles] = useState<Map<string, File>>(() => new Map());
    const [activeImage, setActiveImage] = useState<string | null>(null);
    const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null);
    const [preview, setPreview] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const selectingRef = useRef(false);
    const selectionEpoch = useRef(0);
    const focusEditor = useRef(false);
    const [association, setAssociation] = useState<LearningAssociation | null>(null);
    const { busy, run } = useLearningAction(ended => {
        setActiveImage(null);
        if (!ended) return;
        selectionEpoch.current++;
        setFiles(new Map());
        setWork(workFrom(null));
        latest.current = workFrom(null);
    });
    useLayoutEffect(() => () => { selectionEpoch.current++; }, []);
    const cloud = (accepted?.version ?? 0) > (draft?.version ?? 0) ? accepted : draft;
    const imageById = new Map(cloud?.images.map(image => [image.id, image]));
    const stale = cloud?.version !== undefined && cloud.version !== work.version;
    const blocked = busy || selecting;
    const statusRef = useRef<HTMLHeadingElement>(null);
    const editTitle = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        if (preview) statusRef.current?.focus();
        else if (focusEditor.current) { editTitle.current?.focus(); focusEditor.current = false; }
    }, [preview]);

    function persist(next: Work) {
        if (next.id) {
            editorRecovery(actorId, next.id, epoch).write(next);
            if (!routeId) newRecovery.write({ id: next.id });
        } else newRecovery.write(next);
    }
    function clearWork(id: string) {
        if (!routeId || newRecovery.read()?.id === id) newRecovery.clear();
        if (!latest.current.cleanup.length) editorRecovery(actorId, id, epoch).clear();
    }
    function keep(next: Work, beforeRequest = false) {
        if (beforeRequest) persist(next);
        latest.current = next;
        setWork(next);
        if (!beforeRequest) {
            try { persist(next); }
            catch { setStatus({ message: '无法在本机保留未提交输入。请检查浏览器存储。', error: true }); }
        }
    }
    function edit(fields: Partial<Input>) {
        const current = latest.current;
        keep({ ...current, fields: { ...current.fields, ...fields } });
    }
    function markOrder(key: string, update: Partial<ImageOrder>) {
        keep({ ...latest.current, order: latest.current.order.map(row => row.key === key ? { ...row, ...update } : row) });
    }
    function checkpoint(item: QueuedLearningImage) {
        keep({ ...latest.current, queue: latest.current.queue.map(row => row.key === item.key ? item : row) }, true);
    }

    async function select(event: ChangeEvent<HTMLInputElement>, item?: QueuedLearningImage) {
        const picked = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        if (!picked.length || selectingRef.current || busy || latest.current.pending) return;
        const generation = selectionEpoch.current;
        selectingRef.current = true;
        setSelecting(true);
        const additions: { file: File; row: QueuedLearningImage }[] = [];
        const errors: string[] = [];
        try {
            for (const file of picked) {
                try {
                    if (item) {
                        if (!await matchesLearningFile(item, file)) throw new Error('请选择与原图内容相同的文件。');
                        additions.push({ file, row: item });
                    } else {
                        if (latest.current.order.length + additions.length >= learningDefaults.maxImages) {
                            errors.push('每份图文最多 6 张图片。');
                            break;
                        }
                        additions.push({ file, row: await queueLearningImage(file) });
                    }
                } catch (error) { errors.push(file.name + ' · ' + String((error as Error).message)); }
            }
            if (selectionEpoch.current !== generation) return;
            setFiles(previous => new Map([...previous, ...additions.map(({ row, file }) => [row.key, file] as const)]));
            if (item && additions.length) setImageErrors(previous => ({ ...previous, [item.key]: '' }));
            if (!item && additions.length) {
                const current = latest.current;
                keep({ ...current, queue: [...current.queue, ...additions.map(entry => entry.row)],
                    order: [...current.order, ...additions.map(({ row }) => ({ key: row.key, id: null, alt: '', decorative: false }))] });
            }
            if (errors.length) setStatus({ message: errors.join(' '), error: true });
        } finally {
            selectingRef.current = false;
            if (selectionEpoch.current === generation) setSelecting(false);
        }
    }

    function move(index: number, delta: number) {
        const order = [...latest.current.order];
        const other = index + delta;
        if (other < 0 || other >= order.length) return;
        [order[index], order[other]] = [order[other], order[index]];
        keep({ ...latest.current, order });
    }
    function remove(row: ImageOrder) {
        const current = latest.current;
        keep({ ...current, order: current.order.filter(entry => entry.key !== row.key),
            cleanup: row.id ? [...current.cleanup, { id: row.id, key: crypto.randomUUID() }] : current.cleanup,
            queue: current.queue.flatMap(entry => entry.key !== row.key ? [entry] : entry.attempted ? [{ ...entry, removing: true }] : []),
        });
        setFiles(previous => new Map([...previous].filter(([key]) => key !== row.key)));
    }

    function validate(publish: boolean) {
        const { fields, order } = latest.current;
        if (!fields.title.trim()) return '请输入标题。';
        if (fields.kind === 'article') {
            if (publish && !fields.body.trim()) return '发布图文前，请填写正文。';
            if (publish && order.some(image => !image.decorative && !image.alt.trim())) return '发布前，请填写每张说明图片的替代文字，或标记为装饰图片。';
        } else if (!fields.url.trim()) return '请输入 YouTube 或 B 站视频链接。';
        return '';
    }

    function adoptLatest() {
        void run(async (signal, current) => {
            const previous = latest.current;
            if (!previous.id) return;
            const fresh = await getDraft(previous.id, actorId, signal);
            if (!current()) return;
            setAccepted(fresh);
            keep({ ...previous, version: fresh.version, known: fresh.images.map(image => image.id),
                order: preserveImageOrder(previous.order, fresh, [...previous.known, ...previous.queue.flatMap(item => item.id ? [item.id] : [])]) });
            setStatus({ message: '已载入最新草稿版本，并保留你的表单输入。请检查后保存。' });
        }, report);
    }

    function report(error: unknown) {
        setStatus({ message: error instanceof Error ? error.message : '操作结果尚未确认，请重试原操作。', error: true });
    }

    function submit(intent: 'save' | 'publish' | 'inclusion', retryKey?: string) {
        const error = latest.current.pending || intent === 'inclusion' ? '' : validate(intent === 'publish');
        if (error) { setPreview(false); report(new Error(error)); return; }
        void run(async (signal, current) => {
            setStatus(null);
            const fence = () => {
                signal.throwIfAborted();
                if (!current()) throw new Error('账号状态已改变，请重新确认。');
            };
            const acceptedResponse = (value: LearningDraft) => {
                fence();
                setAccepted(value);
                return value;
            };
            const ids = (value: LearningDraft) => value.images.map(image => image.id);
            const conflict = () => new Error('服务器草稿已更新。你的表单仍保留，请载入最新草稿版本并检查后重试。');
            const updateDraft = (value: LearningDraft, expected: number) => {
                acceptedResponse(value);
                const previous = latest.current;
                if (value.version !== expected) {
                    keep({ ...previous, id: value.id, version: previous.version ?? expected, pending: null });
                    throw conflict();
                }
                keep({ ...previous, id: value.id, version: value.version, known: ids(value), pending: null });
                return value;
            };
            async function perform<T>(pending: Pending) {
                fence();
                keep({ ...latest.current, pending }, true);
                try {
                    const result = await sendLearning<T>(pending.request, actorId, signal);
                    fence();
                    return result;
                } catch (failure) {
                    fence();
                    if (confirmedRejection(failure)) {
                        keep({ ...latest.current, pending: null });
                        if (failure instanceof ApiError && ['VERSION_CONFLICT', 'READ_ONLY'].includes(failure.code) && latest.current.id) {
                            acceptedResponse(await getDraft(latest.current.id, actorId, signal));
                        }
                    }
                    throw failure;
                }
            }
            async function clean(path: string, includePinned = false) {
                let failed = false;
                for (const item of latest.current.cleanup) {
                    if (item.pinned && !includePinned) continue;
                    try {
                        await sendLearning({ path: path + '/images/' + item.id, body: {}, method: 'DELETE', key: item.key }, actorId, signal);
                        fence();
                        keep({ ...latest.current, cleanup: latest.current.cleanup.filter(entry => entry.id !== item.id) });
                    } catch (error) {
                        fence();
                        if (error instanceof ApiError && error.code === 'IMAGE_REFERENCED') {
                            keep({ ...latest.current, cleanup: latest.current.cleanup.map(entry => entry.id === item.id ? { ...entry, pinned: true } : entry) });
                        } else failed = true;
                    }
                }
                return failed;
            }
            async function confirmPublished(pending: Pending) {
                const result = await perform<LearningDraft>(pending);
                acceptedResponse(result);
                const previous = latest.current;
                keep({ ...previous, id: result.id, version: result.version, pending: null, known: ids(result) });
                setAssociation(result.association);
                const cleanupFailed = await clean(postsPath + '/' + result.id, true);
                clearWork(result.id);
                fence();
                if (cleanupFailed) setStatus({ message: '内容已发布，部分已移除图片的存储清理尚未确认。可回到编辑页重试保存。', error: true });
                else router.replace(postHref(result.id));
            }
            async function saveFields(path: string, version: number, order = latest.current.order) {
                const body = { ...postInput(latest.current.fields, order), expectedVersion: version };
                const request = { phase: 'save' as const, request: learningMutation(path, 'PATCH', body), expected: version + 1 };
                return updateDraft(await perform<LearningDraft>(request), request.expected);
            }
            const pending = latest.current.pending;
            if (pending?.phase === 'publish') { await confirmPublished(pending); return; }
            if (pending?.phase === 'inclusion' || intent === 'inclusion') {
                const currentAssociation = receipt;
                if (!pending && (!latest.current.id || currentAssociation?.status !== 'pending')) return;
                const request = pending ?? { phase: 'inclusion' as const, request: learningMutation(
                    postsPath + '/' + latest.current.id + '/inclusion-retry', 'POST', { expectedPublishedVersion: currentAssociation!.publishedVersion }) };
                const result = await perform<LearningAssociation>(request);
                setAssociation(result);
                keep({ ...latest.current, pending: null });
                return;
            }

            let currentDraft: LearningDraft | null = cloud;
            let fieldsSaved = false;
            if (pending?.phase === 'save') {
                currentDraft = updateDraft(await perform<LearningDraft>(pending), pending.expected!);
                fieldsSaved = true;
            }
            const starting = latest.current;
            if (!starting.id) {
                const input = postInput(starting.fields, []);
                const request = { phase: 'save' as const, request: learningMutation(postsPath, 'POST', input), expected: 1 };
                currentDraft = updateDraft(await perform<LearningDraft>(request), 1);
                fieldsSaved = true;
            } else if (!currentDraft || currentDraft.id !== starting.id) {
                currentDraft = acceptedResponse(await getDraft(starting.id, actorId, signal));
            }
            const id = latest.current.id!;
            const path = postsPath + '/' + id;
            let imageFailure = false;
            let imageChanged = false;
            // A pre-existing CAS difference may be an attachment whose confirmation was interrupted.
            if (currentDraft?.version !== latest.current.version &&
                !latest.current.queue.some(item => item.attempted && item.id && currentDraft?.images.some(image => image.id === item.id))) throw conflict();

            if (currentDraft?.version === latest.current.version && latest.current.fields.kind === 'article' &&
                latest.current.queue.some(item => !item.removing)) {
                if (currentDraft.kind === 'video' || latest.current.cleanup.some(item => !item.pinned)) {
                    // Release detached slots before new reservations, and allow new images after changing from video.
                    currentDraft = await saveFields(path, currentDraft.version);
                    fieldsSaved = true;
                    await clean(path);
                }
            }
            for (const item of latest.current.queue) {
                if (retryKey && retryKey !== item.key && !item.removing) continue;
                fence();
                setActiveImage(item.key);
                setImageErrors(previous => ({ ...previous, [item.key]: '' }));
                try {
                    if (item.removing || latest.current.fields.kind === 'video') {
                        if (item.attempted) {
                            const reservation = await sendLearning<LearningImageReservation>({
                                path: path + '/images', method: 'POST', body: {}, key: item.reserveKey,
                            }, actorId, signal);
                            fence();
                            const fresh = acceptedResponse(await getDraft(id, actorId, signal));
                            const attached = fresh.images.some(image => image.id === reservation.id);
                            const expected = latest.current.version! + Number(attached && !latest.current.known.includes(reservation.id));
                            if (fresh.version !== expected) throw conflict();
                            keep({ ...latest.current, version: fresh.version, known: ids(fresh), cleanup: [
                                ...latest.current.cleanup, { id: reservation.id, key: item.removeKey },
                            ] }, true);
                            currentDraft = fresh;
                        }
                        keep({ ...latest.current, order: latest.current.order.filter(row => row.key !== item.key),
                            queue: latest.current.queue.filter(row => row.key !== item.key) });
                        setFiles(previous => new Map([...previous].filter(([key]) => key !== item.key)));
                        imageChanged = true;
                        continue;
                    }
                    const image = await finishLearningImage(path + '/images', item, files.get(item.key), actorId, signal, value => {
                        fence();
                        checkpoint(value);
                    });
                    fence();
                    const fresh = acceptedResponse(await getDraft(id, actorId, signal));
                    const current = latest.current;
                    if (!fresh.images.some(entry => entry.id === image.id)) throw conflict();
                    const expected = current.version! + Number(!current.known.includes(image.id));
                    if (fresh.version !== expected) throw conflict();
                    keep({ ...current, version: fresh.version, known: ids(fresh),
                        order: current.order.filter(row => row.key === item.key || row.id !== image.id)
                            .map(row => row.key === item.key ? { ...row, id: image.id } : row),
                        queue: current.queue.filter(row => row.key !== item.key) }, true);
                    setFiles(previous => new Map([...previous].filter(([key]) => key !== item.key)));
                    currentDraft = fresh;
                    imageChanged = true;
                } catch (error) {
                    fence();
                    if (confirmedRejection(error) && !latest.current.queue.find(row => row.key === item.key)?.id) {
                        checkpoint({ ...item, attempted: false });
                    }
                    imageFailure = true;
                    setImageErrors(previous => ({ ...previous, [item.key]: (error as Error).message }));
                } finally {
                    if (current()) setActiveImage(null);
                }
            }

            if (!currentDraft || currentDraft.version !== latest.current.version) throw conflict();
            const working = latest.current;
            if (working.fields.kind === 'video' && working.order.length) {
                keep({ ...working, order: [], cleanup: [
                    ...working.cleanup, ...working.order.flatMap(row => row.id ? [{ id: row.id, key: crypto.randomUUID() }] : []),
                ] }, true);
                imageChanged = true;
            }
            if (!fieldsSaved || imageChanged) currentDraft = await saveFields(path, currentDraft.version);
            const cleanupFailed = await clean(path);
            if (imageFailure || latest.current.queue.length || cleanupFailed) {
                setStatus({ message: '草稿已保存，部分图片操作尚未完成。请查看队列并重试。', error: true });
                return;
            }
            if (intent === 'publish') {
                if (currentDraft.status === 'hidden') throw new Error('此资料已隐藏。你仍可保存私人草稿。');
                const body = { expectedVersion: currentDraft.version, expectedMembershipEpoch: currentDraft.membershipEpoch };
                await confirmPublished({ phase: 'publish', request: learningMutation(path + '/publish', 'POST', body) });
                return;
            }
            setStatus({ message: '草稿已保存。' });
            clearWork(id);
            if (!routeId) router.replace(postHref(id) + '/edit');
        }, report);
    }

    const { fields, order, queue, pending } = work;
    const receipt = association?.publishedVersion === cloud?.publishedVersion &&
        (association?.status !== 'pending' || cloud?.association?.status === 'pending')
        ? association : cloud?.association;
    const unavailable = cloud?.status === 'hidden';
    const currentTarget = fields.collectionTargetId;
    const targetChoice = choices?.find(choice => choice.id === currentTarget);
    const draftVideo = postInput(fields, []).video;
    const imageFor = (row: ImageOrder) => row.id ? imageById.get(row.id) : undefined;

    function visibleImage(row: ImageOrder) {
        const image = imageFor(row);
        const file = files.get(row.key);
        if (image) return <LearningImageView image={{ ...image, alt: row.alt, decorative: row.decorative }} />;
        if (file) return <LearningLocalImage file={file} alt={row.decorative ? '' : row.alt} />;
        return null;
    }

    return <div className="learning-editor">
        {cloud && <div className="learning-top">
            <p className="muted">{learningStatus[cloud.status]}{cloud.publishedVersion !== null && ' · 保存草稿后，队友仍看到当前发布版本'}</p>
            {cloud.publishedVersion !== null && <Link href={postHref(cloud.id)}>查看当前发布版本</Link>}
        </div>}
        {unavailable && <p className="notice">此资料已被管理员隐藏。你可以继续编辑和保存私人草稿。</p>}
        {receipt && <LearningAssociationStatus association={receipt} retry={() => submit('inclusion')} busy={blocked || (!!pending && pending.phase !== 'inclusion')} />}
        {status && <p className="notice" role={status.error ? 'alert' : 'status'}>{status.message}</p>}
        {pending && <div className="notice learning-top">
            <p>上次{pending.phase === 'publish' ? '发布' : pending.phase === 'inclusion' ? '合集收录' : '保存'}结果待确认。重试会沿用同一请求。</p>
            <button type="button" disabled={blocked} onClick={() => submit(pending.phase)}>{pending.phase === 'publish' ? '确认发布结果' : pending.phase === 'inclusion' ? '确认收录结果' : '确认保存结果'}</button>
        </div>}
        {stale && !pending && <div className="notice learning-top">
            <p>服务器草稿版本已变化。若上次图片操作中断，可先重试图片。</p>
            <button type="button" className="secondary" disabled={blocked} onClick={adoptLatest}>载入最新草稿版本</button>
        </div>}
        {preview ? <section className="panel learning-article">
            <h2 tabIndex={-1} ref={statusRef}>发布预览</h2>
            <h3>{fields.title || '未命名资料'}</h3>
            <p className="muted">{fields.kind === 'article' ? '图文' : '视频'} · {fields.category}</p>
            {fields.summary && <p className="learning-summary">{fields.summary}</p>}
            {draftVideo && <LearningMedia video={draftVideo} title={fields.title} />}
            {fields.body && <p className="learning-body">{fields.body}</p>}
            {fields.kind === 'article' && order.map(row => <figure key={row.key}>{visibleImage(row) ?? <p>这张图片需要重新选择或确认后才能预览。</p>}</figure>)}
            <div className="learning-actions">
                <button className="secondary" type="button" disabled={busy} onClick={() => {
                    focusEditor.current = true;
                    setPreview(false);
                }}>返回编辑</button>
                <LearningConfirm label="发布到队内" title="发布这份资料？" confirm="确认发布" disabled={blocked || !!pending || unavailable}
                    onConfirm={() => submit('publish')}>
                    <p>{cloud?.publishedVersion !== null && cloud?.publishedVersion !== undefined ? '队友将看到此预览所对应的新版本。' : '发布后，当前队友可在学习库阅读。'}</p>
                    {targetChoice && <p>发布后会尝试加入「{targetChoice.title}」。收录需要时可单独重试。</p>}
                </LearningConfirm>
            </div>
        </section> : <form className="panel learning-form" data-own-buffer onSubmit={event => { event.preventDefault(); submit('save'); }}>
            <fieldset disabled={blocked || !!pending}>
                <legend>内容信息</legend>
                <div className="learning-filters">
                    <label>内容类型<select value={fields.kind} onChange={event => edit({ kind: event.target.value as Input['kind'] })}>
                        <option value="article">图文</option><option value="video">视频</option>
                    </select></label>
                    <label>分类<select value={fields.category} onChange={event => edit({ category: event.target.value as Input['category'] })}>
                        {learningCategories.map(category => <option key={category}>{category}</option>)}
                    </select></label>
                </div>
                <label>标题<input ref={editTitle} name="title" value={fields.title} maxLength={learningDefaults.maxTitle} required onChange={event => edit({ title: event.target.value })} /></label>
                <label>摘要（选填）<input name="summary" value={fields.summary} maxLength={learningDefaults.maxSummary} onChange={event => edit({ summary: event.target.value })} /></label>
                <label>{fields.kind === 'article' ? '正文' : '视频说明（选填）'}<textarea name="body" rows={6} value={fields.body} maxLength={learningDefaults.maxBody} onChange={event => edit({ body: event.target.value })} /></label>
                {fields.kind === 'video' ? <>
                    <label>视频链接<textarea name="video-url" rows={2} maxLength={2000} value={fields.url} placeholder="YouTube 链接、B 站链接或 BV 号"
                        required onChange={event => edit({ url: event.target.value })} /></label>
                    {!!order.length && <p className="notice">保存为视频会移除草稿中的配图。</p>}
                </> : <section className="learning-image-editor">
                    <h2>配图</h2>
                    <label htmlFor="learning-images">选择本机图片</label>
                    <input id="learning-images" type="file" accept={acceptImages} multiple onChange={event => void select(event)} />
                    <p className="muted">最多 6 张，每张 2 MiB，支持 PNG、JPEG 和 WebP。</p>
                    {order.length === 0 && <p className="muted">图文可以只写文字。</p>}
                    <ol className="learning-list">
                        {order.map((row, index) => {
                            const item = queue.find(entry => entry.key === row.key);
                            const error = imageErrors[row.key];
                            const file = files.get(row.key);
                            return <li key={row.key} className="learning-image-row">
                                <div className="learning-thumb">{visibleImage(row)}</div>
                                <div>
                                    <strong>{item?.name ?? `图片 ${index + 1}`}</strong>
                                    <p className="muted">{activeImage === row.key ? '正在处理图片…' : row.id ? '已上传' : item?.uploaded ? '已上传，待确认附件' : file ? '待上传 · 本机预览' : '请重新选择原图片，或确认上传结果'}</p>
                                    {error && <p role="alert">{error}</p>}
                                    <label>替代文字<input maxLength={learningImageAltMax} value={row.alt} disabled={row.decorative}
                                        onChange={event => markOrder(row.key, { alt: event.target.value })} /></label>
                                    <label className="learning-check"><input type="checkbox" checked={row.decorative}
                                        onChange={event => markOrder(row.key, { decorative: event.target.checked })} />装饰图片</label>
                                    {item && !file && <label>重新选择原图片<input type="file" accept={acceptImages} onChange={event => void select(event, item)} /></label>}
                                    <div className="learning-actions">
                                        {item && (error || !file) && <button className="secondary" type="button" onClick={() => submit('save', item.key)}>重试图片</button>}
                                        <button className="secondary" type="button" aria-label={`上移图片 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
                                        <button className="secondary" type="button" aria-label={`下移图片 ${index + 1}`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>下移</button>
                                        <button className="secondary" type="button" aria-label={`移除图片 ${index + 1}`} onClick={() => remove(row)}>移除</button>
                                    </div>
                                </div>
                            </li>;
                        })}
                    </ol>
                    {queue.filter(item => item.removing && imageErrors[item.key]).map(item => <p key={item.key} role="alert">{item.name} · {imageErrors[item.key]}</p>)}
                </section>}
                <label>加入合集（选填）<select value={currentTarget ?? ''} disabled={!choices?.length && !currentTarget}
                    onChange={event => edit({ collectionTargetId: event.target.value || null })}>
                    <option value="">不加入合集</option>
                    {currentTarget && !targetChoice && <option value={currentTarget}>原选择的合集</option>}
                    {choices?.map(choice => <option key={choice.id} value={choice.id}>{choice.title}{choice.status === 'published' ? '' : '（未发布）'}</option>)}
                </select></label>
                <p className="muted">{choices?.length ? '确认发布后才会尝试收录。'
                    : choices ? '当前没有可选合集，仍可正常发布。' : '暂未能读取可选合集，仍可继续发布。'}</p>
            </fieldset>
            <div className="learning-actions">
                <button type="submit" disabled={blocked || !!pending}>{busy ? '正在处理…' : '保存草稿'}</button>
                <button className="secondary" type="button" disabled={blocked || !!pending} onClick={() => setPreview(true)}>预览内容</button>
            </div>
        </form>}
    </div>;
}
