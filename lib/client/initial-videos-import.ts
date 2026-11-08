import { api, ApiError } from './api';
import { acknowledgeMutation, pendingMutationKey } from './navigation-state';
import type { BootstrapStatus } from '../contracts';

// Every read and write uses the existing authenticated, actor-fenced transport.
export function importTransport(actorId: string, signal: AbortSignal, current: () => boolean) {
    return async (route: string, options: { actor?: string; key?: string; payload?: unknown; precondition?: unknown } = {}) => {
        if (!current() || (options.actor && options.actor !== actorId)) throw new Error('账号确认已失效。');
        if (options.payload && pendingMutationKey(actorId, 'POST', route, options.payload, options.key ?? '') !== options.key) {
            throw new Error('此内容已有其他未确认操作；请先处理原操作，再恢复导入账本。');
        }
        let data: unknown;
        try { data = await api<unknown>(route, options.payload ? { method: 'POST', actorId, key: options.key, body: options.payload, importPrecondition: options.precondition } : undefined, actorId, signal); }
        catch (error) {
            if (current() && options.payload && error instanceof ApiError && error.code === 'IMPORT_MAPPING_REJECTED_NO_COMMIT') acknowledgeMutation(actorId, 'POST', route, options.payload);
            throw error;
        }
        if (!current()) throw new Error('账号确认已失效。保留账本并重新核对。');
        if (route === 'bootstrap' && (data as BootstrapStatus).actorId !== actorId) throw new Error('账号已变化。');
        return { data, actor: actorId };
    };
}
