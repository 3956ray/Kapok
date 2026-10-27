import { MEDIA_ENGINEERING_MAX_BYTES, MEDIA_MAX_VALIDATION_STEPS, MEDIA_PART_BYTES, MEDIA_UPLOAD_TIMEOUT_MS, manifestRoot } from '../contracts/media.ts';
import { api } from './api.ts';
import type { UploadManifest, UploadProgress } from '../contracts/media';
import { signalAccountChange, signalSessionExpiry } from './session-guard.ts';

// Sequential slices keep both browser requests and Worker buffering bounded.
export async function transferUpload(file: File, id: string, actorId: string, key: string, current: () => boolean, onRequest: (request: XMLHttpRequest | null) => void, onProgress: (percent: number) => void, startPart = 1, singlePart = false) {
    for (let offset = (startPart - 1) * MEDIA_PART_BYTES, part = startPart; offset < file.size; offset += MEDIA_PART_BYTES, part++) {
        if (!current()) throw new Error('页面已锁定，上传已停止。请重新确认后继续。');
        const content = file.slice(offset, Math.min(offset + MEDIA_PART_BYTES, file.size));
        await new Promise<void>((resolve, reject) => {
            const request = new XMLHttpRequest();
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                onRequest(null);
                if (error) reject(error); else resolve();
            };
            onRequest(request);
            request.open('PUT', `/api/v1/uploads/${id}/content`);
            request.timeout = MEDIA_UPLOAD_TIMEOUT_MS;
            request.setRequestHeader('Content-Type', 'application/octet-stream');
            request.setRequestHeader('Idempotency-Key', key);
            request.setRequestHeader('X-Kapok-Actor', actorId);
            request.setRequestHeader('X-Kapok-Part', String(part));
            request.upload.onprogress = event => {
                if (current() && event.lengthComputable) onProgress(Math.round((offset + event.loaded) / file.size * 100));
            };
            const unknown = () => finish(new Error('连接中断，暂时无法确认上传是否完成。'));
            request.onerror = unknown;
            request.ontimeout = unknown;
            request.onabort = () => finish(new Error('文件传输已停止。可确认状态后重试或清理此上传。'));
            request.onload = () => {
                if (!current()) return finish(new Error('页面已锁定，上传已停止。请重新确认后继续。'));
                const actor = request.getResponseHeader('X-Kapok-Actor');
                if (actor && actor !== actorId) { signalAccountChange(actorId); return finish(new Error('账号已变化。')); }
                if (!actor && request.status === 401) { signalSessionExpiry(actorId); return finish(new Error('登录已过期，上传已暂停。')); }
                if (actor !== actorId) return unknown();
                try {
                    const body = JSON.parse(request.responseText);
                    if (request.status >= 200 && request.status < 300 && body.data?.id === id) finish();
                    else finish(new Error(body.error?.message ?? '暂时无法确认上传是否完成。'));
                } catch { unknown(); }
            };
            if (!current()) { finish(new Error('页面已锁定，上传已停止。')); return; }
            request.send(content);
        });
        if (singlePart) return;
    }
}

// A root commits to every slice, its order, total size and the protocol part size.
// File names and modification times are hints only and never participate in trust.
export async function hashUploadFile(file: File, current: () => boolean, progress: (percent: number) => void = () => {}) {
    if (!file.size || file.size > MEDIA_ENGINEERING_MAX_BYTES) throw new Error('文件超出当前工程处理范围。');
    const digests: string[] = [];
    for (let offset = 0; offset < file.size; offset += MEDIA_PART_BYTES) {
        if (!current()) throw new Error('页面已锁定，文件核对已停止。');
        const slice = await file.slice(offset, Math.min(offset + MEDIA_PART_BYTES, file.size)).arrayBuffer();
        digests.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', slice)), b => b.toString(16).padStart(2, '0')).join(''));
        progress(Math.round(Math.min(file.size, offset + MEDIA_PART_BYTES) / file.size * 100));
    }
    if (!current()) throw new Error('页面已锁定，文件核对已停止。');
    const root = await manifestRoot(file.size, digests);
    if (!current()) throw new Error('页面已锁定，文件核对已停止。');
    return { root, digests };
}

// Reads are authenticated server facts. A lost response is reconciled before any
// retransmission; neither refresh nor an in-memory key can claim another upload.
export async function resumeUpload(file: File, id: string, actorId: string, manifest: UploadManifest, current: () => boolean, onRequest: (request: XMLHttpRequest | null) => void, onProgress: (percent: number) => void, readStatus = () => api<UploadProgress>(`uploads/${id}`, undefined, actorId), onConfirmed: (bytes: number) => void = () => {}) {
    const count = manifest.digests.length;
    let failures = 0;
    for (let calls = 0; calls < count + 3; calls++) {
        if (!current()) throw new Error('页面已锁定，上传已停止。');
        const status = await readStatus();
        if (!current()) throw new Error('页面已锁定，上传已停止。');
        if (status.protocol !== 2 || status.manifest?.root !== manifest.root || status.bytes !== file.size) throw new Error('续传文件与原文件不一致，请重新选择原文件。');
        if (status.cleanupState !== 'none') throw new Error('上传正在等待清理，空间仍保留。');
        if (!Number.isSafeInteger(status.nextPart) || status.nextPart < 1 || status.nextPart > count + 1) throw new Error('尚未确认上传进度。');
        onConfirmed(Math.min(file.size, (status.nextPart - 1) * MEDIA_PART_BYTES));
        onProgress(Math.round((status.nextPart - 1) / count * 100));
        if (status.nextPart > count) return;
        try {
            await transferUpload(file, id, actorId, manifest.root, current, onRequest, onProgress, status.nextPart, true);
        } catch (error) {
            if (!current() || ++failures >= 3) throw error;
            // Re-read committed progress on the next iteration. An active server
            // lease is shown to the user instead of automatically busy-looping.
            const confirmed = await readStatus();
            if (!current()) throw new Error('页面已锁定，上传已停止。');
            if (confirmed.nextPart <= status.nextPart) throw error;
        }
    }
    throw new Error('续传确认次数已达上限，请重新确认上传状态。');
}
export async function finishUpload(id: string, actorId: string, key: string, parts: number, current: () => boolean, stage: (value: string) => void, signal?: AbortSignal) {
    // At most three assembly generations and three staging attempts per part,
    // plus one bounded metadata state machine; progress survives every yield.
    for (let n = 0; n < parts * 6 + MEDIA_MAX_VALIDATION_STEPS + 16; n++) {
        if (!current()) throw new Error('页面已锁定，核验已停止。');
        const result = await api<{ id: string; status?: string; mime?: string; assembledParts?: number }>(`uploads/${id}/complete`, { method: 'POST', actorId, body: {}, key, uploadTimeout: true }, undefined, signal);
        if (!current()) throw new Error('页面已锁定，核验已停止。');
        if (result.status === 'ready' || result.mime) return;
        stage(result.status === 'assembling' ? `正在整理文件 ${result.assembledParts ?? 0}/${parts}` : '正在核验格式与时长');
    }
    throw new Error('本次核验次数已达上限，进度已保留，请确认后继续。');
}
export async function cancelUploadReservation(id: string, actorId: string, key: string, parts: number, current: () => boolean) {
    for (let n = 0; n < parts * 3 + 8; n++) {
        if (!current()) throw new Error('页面已锁定，清理结果尚未确认。');
        const result = await api<{ status?: string }>(`uploads/${id}/cancel`, { method: 'POST', actorId, body: {}, key, uploadTimeout: true });
        if (!current()) throw new Error('页面已锁定，清理结果尚未确认。');
        if (!result.status || ['cancelled', 'rejected'].includes(result.status)) return;
    }
    throw new Error('清理进度已保留，请稍后继续。');
}
