// Tokens protect client state from late responses after concealment/account changes.
export function createSessionGuard(actorId: string) {
    let generation = 0;
    let verified = false;
    let ended = false;
    return {
        end() {
            ended = true;
            verified = false;
            generation += 1;
        },
        ended() {
            return ended;
        },
        conceal() {
            verified = false;
            generation += 1;
        },
        start() {
            verified = false;
            generation += 1;
            return generation;
        },
        confirm(token: number, subject: string, active: boolean) {
            if (ended || token !== generation || subject !== actorId || !active) return false;
            verified = true;
            return true;
        },
        current(token: number) {
            return verified && token === generation;
        },
        token() {
            return generation;
        }
    };
}
export const draftPrefix = 'kapok:reflection-draft:';
export const draftKey = (actorId: string, draftId: string) => draftPrefix + encodeURIComponent(actorId) + ':' + encodeURIComponent(draftId);
export function clearActorDrafts(storage: Storage, actorId: string) {
    const prefix = draftPrefix + encodeURIComponent(actorId) + ':';
    for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) storage.removeItem(key);
    }
}
export type SessionSignal = {
    actorId: string;
    kind: 'expired' | 'ended';
};
function broadcastSessionSignal(signal: SessionSignal) {
    if (typeof window === 'undefined') return true;
    let delivered = true;
    const event = signal.kind === 'expired' ? 'kapok-session-expired' : 'kapok-account-changed';
    try {
        window.dispatchEvent(new CustomEvent(event, { detail: signal.actorId }));
    } catch {
        delivered = false;
    }
    let channel: BroadcastChannel | null = null;
    try {
        channel = new BroadcastChannel('kapok-session');
        channel.postMessage(signal);
    } catch {
        delivered = false;
    } finally {
        try {
            channel?.close();
        } catch {
            delivered = false;
        }
    }
    return delivered;
}
export function signalAccountChange(actorId: string) {
    return broadcastSessionSignal({ actorId, kind: 'ended' });
}
export function signalSessionExpiry(actorId: string) {
    return broadcastSessionSignal({ actorId, kind: 'expired' });
}
export function applySessionSignal(
    guard: ReturnType<typeof createSessionGuard>,
    actorId: string,
    signal: SessionSignal
) {
    const action = signal.actorId !== actorId ? 'recheck' : signal.kind;
    if (action === 'ended') guard.end();
    else guard.conceal();
    return action;
}
// The factory is deliberately lazy: expiry/recheck must never obtain browser storage.
export function cleanupActorDrafts(actorId: string, getStorage: () => Storage) {
    try {
        clearActorDrafts(getStorage(), actorId);
        return true;
    } catch {
        return false;
    }
}
export type SessionEffects = {
    surface: { hidden: boolean } | null;
    lock: () => void;
    clearResource: () => void;
    endEditor: () => void;
    getStorage: () => Storage;
};
export function handleSessionSignal(
    guard: ReturnType<typeof createSessionGuard>,
    actorId: string,
    signal: SessionSignal,
    effects: SessionEffects
) {
    // Intrinsic gate/epoch invalidation precedes even consumer callbacks.
    const action = applySessionSignal(guard, actorId, signal);
    let callbackFailed = false;
    const attempt = (effect: () => void) => {
        try {
            effect();
        } catch {
            callbackFailed = true;
        }
    };
    // Synchronous DOM concealment is independent of React's next render and cleanup.
    attempt(() => {
        if (effects.surface) effects.surface.hidden = true;
    });
    attempt(effects.lock);
    if (action !== 'recheck') attempt(effects.clearResource);
    if (action === 'ended') attempt(effects.endEditor);
    const cleanupFailed = action === 'ended' && !cleanupActorDrafts(actorId, effects.getStorage);
    return { action, cleanupFailed, callbackFailed };
}
