import { pendingMutationKey, rejectMutationKey } from './navigation-state.ts';
import { MEDIA_UPLOAD_TIMEOUT_MS } from '../contracts/media.ts';
import { signalAccountChange, signalSessionExpiry } from './session-guard.ts';
import type { ApiErrorBody, ApiSuccess } from '../contracts/index';

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  requestId: string;
  constructor(body: ApiErrorBody) { super(body.error.message); this.code = body.error.code; this.retryable = body.error.retryable; this.requestId = body.requestId; }
}
// Bound both transport and response-body waits; cancellation must also settle uncooperative transports.
export async function withRequestDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, write = false, uploadTimeout = false): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let interrupted: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    interrupted = () => reject(controller.signal.reason);
    if (controller.signal.aborted) interrupted();
    else controller.signal.addEventListener('abort', interrupted, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(new ApiError({
    error: { code: 'REQUEST_TIMEOUT', message: write ? '请求等待超时，操作结果尚未确认。请先确认当前状态；重试同一操作会沿用原请求标识。' : '确认请求超时，暂未能确认当前状态。请重新确认。', retryable: true }, requestId: '',
  })), uploadTimeout ? MEDIA_UPLOAD_TIMEOUT_MS : 15_000);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run(controller.signal);
    }), cancellation]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    if (interrupted) controller.signal.removeEventListener('abort', interrupted);
  }
}
export async function api<T>(path: string, options?: { method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; key?: string; actorId: string; uploadTimeout?: boolean }, expectedActor?: string, signal?: AbortSignal): Promise<T> {
  const requestKey = options ? pendingMutationKey(options.actorId, options.method ?? 'GET', path, options.body ?? {}, options.key ?? '') : '';
  return withRequestDeadline(async currentSignal => {
    const response = await fetch(`/api/v1/${path}`, {
      method: options?.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', signal: currentSignal,
      headers: options ? { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey, 'X-Kapok-Actor': options.actorId } : {},
      ...(options ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
    // A superseded request must not broadcast a stale account/expiry signal or parse its payload.
    currentSignal.throwIfAborted();
    const actor = options?.actorId ?? expectedActor;
    if (actor && response.status === 401 && !response.headers.has('X-Kapok-Actor')) {
      signalSessionExpiry(actor);
      throw new ApiError({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: '登录已过期。本机稿仍保留，请使用原账号重新登录后确认。',
          retryable: true,
        },
        requestId: '',
      });
    }
    if (actor && response.headers.get('X-Kapok-Actor') !== actor) {
      const changed = response.headers.has('X-Kapok-Actor');
      if (changed) signalAccountChange(actor);
      throw new ApiError({ error: { code: changed ? 'ACCOUNT_CHANGED' : 'SESSION_UNVERIFIED', message: changed ? '登录账号已变化，请重新加载。' : '尚未确认当前账号，请保留内容并重试。', retryable: !changed }, requestId: '' });
    }
    const body = await response.json() as ApiSuccess<T> | ApiErrorBody;
    currentSignal.throwIfAborted();
    if ('error' in body) {
      if (options && response.status < 500 && !body.error.retryable) rejectMutationKey(options.actorId, options.method ?? 'GET', path, options.body ?? {}, requestKey, body.error.code);
      throw new ApiError(body);
    }
    if (!response.ok) throw new Error('暂时未能完成请求。');
    return body.data;
  }, signal, !!options, options?.uploadTimeout === true);
}
// Keep one instance for an actor/form. Same normalized submission keeps its key after a network failure.
export function createRequestKey() {
  let previous = '';
  let key = '';
  return (actorId: string, body: unknown) => {
    const input = JSON.stringify([actorId, body]);
    if (input !== previous) { previous = input; key = crypto.randomUUID(); }
    return key;
  };
}
