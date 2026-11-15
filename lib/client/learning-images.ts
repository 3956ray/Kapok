import { api, ApiError, withRequestDeadline } from './api.ts';
import { draftKey, signalAccountChange, signalSessionExpiry } from './session-guard.ts';
import { learningDefaults, learningImageTypes } from '../contracts/learning.ts';
import type { LearningDraft, LearningImage, LearningImageReservation, LearningImageType, LearningImageUpload, LearningPostInput } from '../contracts/learning';
import type { ApiErrorBody, ApiSuccess } from '../contracts/index';

export async function putLearningImage(path: string, file: File, mime: LearningImageType, key: string, actorId: string, signal?: AbortSignal) {
    return withRequestDeadline(async active => {
        const response = await fetch(`/api/v1/${path}`, {
            method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: active, body: file,
            // Browsers generate Origin for same-origin PUT; its value cannot be overridden by script.
            headers: { 'Content-Type': mime, 'X-Kapok-Actor': actorId, 'Idempotency-Key': key },
        });
        active.throwIfAborted();
        const actor = response.headers.get('X-Kapok-Actor');
        if (actor !== actorId) {
            if (actor !== null) signalAccountChange(actorId);
            else if (response.status === 401) signalSessionExpiry(actorId);
            throw new ApiError({
                error: {
                    code: actor !== null ? 'ACCOUNT_CHANGED' : response.status === 401 ? 'AUTHENTICATION_REQUIRED' : 'SESSION_UNVERIFIED',
                    message: actor !== null ? '登录账号已变化，请重新加载。' : '尚未确认当前账号或上传结果，请重新确认。',
                    retryable: actor === null,
                },
                requestId: '',
            });
        }
        const body = await response.json() as ApiSuccess<LearningImageUpload> | ApiErrorBody;
        active.throwIfAborted();
        if ('error' in body) throw new ApiError(body);
        if (!response.ok || !['uploaded', 'ready'].includes(body.data?.status)) throw new Error('尚未确认图片上传结果。');
        return body.data;
    }, signal, true, true);
}

export type LearningMutation = { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body: unknown; key: string };
export function learningMutation(path: string, method: LearningMutation['method'], body: unknown): LearningMutation {
    return { path, method, body, key: crypto.randomUUID() };
}
export function sendLearning<T>(request: LearningMutation, actorId: string, signal: AbortSignal) {
    return api<T>(request.path, { ...request, actorId }, undefined, signal);
}
export function confirmedRejection(error: unknown) {
    return error instanceof ApiError && !error.retryable &&
        !['ACCOUNT_CHANGED', 'AUTHENTICATION_REQUIRED', 'SESSION_UNVERIFIED'].includes(error.code);
}

// This is account-bound recoverable input. It deliberately stores neither bytes nor service DTOs.
export function learningRecovery<T>(actorId: string, scope: string, epoch: string) {
    const key = draftKey(actorId, 'learning:' + scope);
    return {
        read(): T | null {
            try {
                const record = JSON.parse(localStorage.getItem(key) ?? 'null') as { epoch: string; value: T } | null;
                return record?.epoch === epoch ? record.value : null;
            } catch { return null; }
        },
        write(value: T) {
            localStorage.setItem(key, JSON.stringify({ epoch, value }));
        },
        clear() { localStorage.removeItem(key); },
    };
}

export type ImageOrder = { key: string; id: string | null; alt: string; decorative: boolean };
export type QueuedLearningImage = {
    key: string; name: string; bytes: number; mime: LearningImageType; digest: string;
    id: string | null; uploaded: boolean; reserveKey: string; uploadKey: string; completeKey: string; removeKey: string;
    attempted: boolean; removing: boolean;
};
export async function learningFileDigest(file: File) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function learningFileMime(file: File): LearningImageType {
    const mime = learningImageTypes.find(type => type === file.type);
    if (!mime) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    if (file.size > learningDefaults.maxImageBytes) throw new Error('每张图片最多 2 MiB。');
    if (file.size === 0) throw new Error('请选择非空图片。');
    return mime;
}
export async function queueLearningImage(file: File): Promise<QueuedLearningImage> {
    const mime = learningFileMime(file);
    return {
        key: crypto.randomUUID(), name: file.name, bytes: file.size, mime, digest: await learningFileDigest(file),
        id: null, uploaded: false, reserveKey: crypto.randomUUID(), uploadKey: crypto.randomUUID(),
        completeKey: crypto.randomUUID(), removeKey: crypto.randomUUID(), attempted: false, removing: false,
    };
}
export async function matchesLearningFile(row: QueuedLearningImage, file: File) {
    return file.type === row.mime && file.size === row.bytes && await learningFileDigest(file) === row.digest;
}

export async function finishLearningImage(
    path: string, item: QueuedLearningImage, file: File | undefined, actorId: string, signal: AbortSignal,
    checkpoint: (next: QueuedLearningImage) => void,
): Promise<LearningImage> {
    const supplied = file;
    const post = <T>(endpoint: string, key: string) => sendLearning<T>({ path: endpoint, method: 'POST', body: {}, key }, actorId, signal);
    // Replaying a reservation also queries its current uploaded/ready status.
    if (!item.attempted && !supplied) throw new Error('请重新选择原图片。');
    if (supplied && !await matchesLearningFile(item, supplied)) throw new Error('请选择与原图内容相同的文件。');
    signal.throwIfAborted();
    if (!item.id || !item.uploaded) {
        item = { ...item, attempted: true };
        checkpoint(item);
        const reservation = await post<LearningImageReservation>(path, item.reserveKey);
        item = { ...item, id: reservation.id, uploaded: reservation.status !== 'reserved' };
        checkpoint(item);
    }
    const endpoint = `${path}/${item.id}`;
    if (!item.uploaded) {
        if (!supplied) throw new Error('服务尚未确认图片已上传，请重新选择原图片。');
        await putLearningImage(endpoint + '/content', supplied, item.mime, item.uploadKey, actorId, signal);
        item = { ...item, uploaded: true };
        checkpoint(item);
    }
    return post<LearningImage>(endpoint + '/complete', item.completeKey);
}

export function draftImageOrder(images: LearningImage[]): ImageOrder[] {
    return images.map(({ id, alt, decorative }) => ({ key: id, id, alt, decorative }));
}

export function preserveImageOrder(order: ImageOrder[], confirmed: LearningDraft, known: string[]) {
    const active = new Set(confirmed.images.map(image => image.id));
    return [
        ...order.filter(row => !row.id || active.has(row.id)),
        ...draftImageOrder(confirmed.images.filter(image => !known.includes(image.id) && !order.some(row => row.id === image.id))),
    ];
}

export function imageReferences(order: ImageOrder[]): NonNullable<LearningPostInput['images']> {
    return order.flatMap(({ id, alt, decorative }) => id ? [{ id, alt: decorative ? '' : alt, decorative }] : []);
}
