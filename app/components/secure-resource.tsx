'use client';

import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BootstrapStatus } from '../../lib/contracts';
import { api, withRequestDeadline } from '../../lib/client/api';
import { handleSessionSignal, createSessionGuard } from '../../lib/client/session-guard';
import { confirmNavigationActor, clearNavigationActor, clearNavigationRoute, currentRoute, retainRouteUI } from '../../lib/client/navigation-state';
import type { SessionSignal } from '../../lib/client/session-guard';
type Loader<T> = string | ((account: BootstrapStatus, signal: AbortSignal) => Promise<T>);
export function useSecureResource<T>(actorId: string, path: Loader<T>, allowUnprofiled = false) {
    const [data, setData] = useState<T | null>(null);
    const [locked, setLocked] = useState(true);
    const [checking, setChecking] = useState(true);
    const [verificationMessage, setVerificationMessage] = useState('');
    const verification = useRef<AbortController | null>(null);
    const latestVerification = useRef<Promise<void> | null>(null);
    const interruption = useRef(0);
    const confirmedStamp = useRef('');
    const [sessionEnded, setSessionEnded] = useState(false);
    const [error, setError] = useState('');
    const [authorizationStamp, setAuthorizationStamp] = useState('');
    const route = useRef(currentRoute());
    const container = useRef<HTMLDivElement>(null);
    const invalidated = useRef(false);
    const guard = useRef(createSessionGuard(actorId));
    const listeners = useRef(new Set<(ended: boolean) => void>());
    const notify = useCallback((ended: boolean) => {
        let failed = false;
        for (const listener of listeners.current) {
            try { listener(ended); } catch { failed = true; }
        }
        if (failed) throw new Error('未能完成页面内容清理。');
    }, []);
    const attach = useCallback(
        (node: HTMLDivElement | null) => {
            container.current = node;
            // Reveal only in React's commit, after the current verified data was rendered.
            if (node) node.hidden = !guard.current.current(guard.current.token());
        },
        []
    );
    const conceal = useCallback(
        (revalidation: unknown = false) => {
            if (revalidation !== true) interruption.current += 1;
            guard.current.conceal();
            if (container.current) container.current.hidden = true;
            setLocked(true);
            setChecking(false);
            verification.current?.abort();
            try {
                notify(guard.current.ended());
                return true;
            } catch {
                setError('页面已锁定，但未能完成内容清理。');
                return false;
            }
        },
        [notify]
    );
    useLayoutEffect(() => {
        const activeGuard = guard.current;
        const surface = container.current;
        return () => {
            // Commit-time unmount invalidation also rejects callbacks during an actor-key replacement.
            interruption.current += 1;
            activeGuard.conceal();
            if (surface) surface.hidden = true;
            verification.current?.abort();
            try { notify(false); } catch { /* The removed surface remains concealed. */ }
        };
    }, [notify]);
    const processSignal = useCallback((signal: SessionSignal) => {
        interruption.current += 1;
        const result = handleSessionSignal(guard.current, actorId, signal, {
            surface: container.current,
            lock: () => { setLocked(true); setChecking(false); verification.current?.abort(); notify(signal.actorId === actorId && signal.kind === 'ended'); },
            clearResource: () => { if (signal.actorId === actorId && signal.kind === 'ended') setData(null); },
            endEditor: () => {
                clearNavigationActor(actorId);
                invalidated.current = true;
                setSessionEnded(true);
            },
            getStorage: () => localStorage,
        });
        if (result.cleanupFailed || result.callbackFailed) {
            setError('页面已锁定，但未能完成本机内容清理。请保持页面锁定，处理设备存储后重新加载；未确认清理成功。');
        } else if (result.action === 'expired') {
            setError('登录已过期。本机稿仍保留，请使用原账号重新登录，再重新确认。');
        } else if (result.action === 'ended') {
            setError('账号会话已变化，请重新加载。');
        }
        return result.action;
    }, [actorId, notify]);
    const runVerification = useCallback(
        async (message = '') => {
            // All verification entry points invalidate/hide/lock before fallible stop/capture effects.
            if (!conceal(true)) return;
            if (invalidated.current || guard.current.ended()) return;
            const token = guard.current.start();
            const controller = new AbortController();
            verification.current = controller;
            setChecking(true);
            setVerificationMessage(message);
            setError('');
            try {
                await withRequestDeadline(async signal => {
                    const before = await api<BootstrapStatus>('bootstrap', undefined, actorId, signal);
                    if (guard.current.token() !== token) return;
                    if (before.siteUserId !== actorId) {
                        processSignal({ actorId, kind: 'ended' });
                        return;
                    }
                    if (before.me.user?.status !== 'active' && !(allowUnprofiled && before.me.user === null)) {
                        clearNavigationActor(actorId);
                        setData(null);
                        throw new Error('当前账号暂不可用，请确认账号状态后重试。');
                    }
                    const latest = typeof path === 'string' ? await api<T>(path, undefined, actorId, signal) : await path(before, signal);
                    if (guard.current.token() !== token) return;
                    const after = await api<BootstrapStatus>('bootstrap', undefined, actorId, signal);
                    if (guard.current.token() !== token) return;
                    if (after.siteUserId !== actorId) {
                        processSignal({ actorId, kind: 'ended' });
                        return;
                    }
                    if (after.me.user?.status !== 'active' && !(allowUnprofiled && after.me.user === null)) {
                        clearNavigationActor(actorId);
                        setData(null);
                        throw new Error('当前账号暂不可用，请确认账号状态后重试。');
                    }
                    if (JSON.stringify(before.me.membership) !== JSON.stringify(after.me.membership)) {
                        clearNavigationActor(actorId);
                        setData(null);
                        throw new Error('成员权限在确认期间已变化，请重新确认。');
                    }
                    if (!guard.current.confirm(token, after.siteUserId, true)) return;
                    const stamp = JSON.stringify([after.me.user?.id, after.me.membership]);
                    confirmNavigationActor(actorId, stamp);
                    confirmedStamp.current = stamp;
                    setAuthorizationStamp(stamp);
                    setData(latest);
                    setError('');
                    setLocked(false);
                }, controller.signal);
            } catch (e) {
                if (guard.current.token() !== token) return;
                if (e instanceof Error && 'code' in e && e.code === 'ACCOUNT_CHANGED') {
                    processSignal({ actorId, kind: 'ended' });
                    return;
                }
                if (e instanceof Error && 'code' in e && e.code === 'AUTHENTICATION_REQUIRED') {
                    processSignal({ actorId, kind: 'expired' });
                    return;
                }
                if (e instanceof Error && 'code' in e && ['FORBIDDEN', 'NOT_FOUND'].includes(String(e.code))) {
                    clearNavigationRoute(actorId, route.current);
                    setData(null);
                }
                if (!conceal()) return;
                setError(e instanceof Error ? e.message : '暂未能确认账号及当前状态，当前未开放操作。');
            } finally {
                if (verification.current === controller) {
                    verification.current = null;
                    setChecking(false);
                }
            }
        },
        [actorId, path, processSignal, allowUnprofiled, conceal]
    );
    const verify = useCallback((message = '') => {
        const task = runVerification(message);
        latestVerification.current = task;
        return task;
    }, [runVerification]);
    useEffect(
        () => {
            let mounted = true;
            const activeGuard = guard.current;
            queueMicrotask(() => {
                if (mounted) void verify();
            });
            let playerFocused = false;
            const show = () => { playerFocused = false; void verify(); };
            const focus = () => {
                if (playerFocused && activeGuard.current(activeGuard.token())) { playerFocused = false; return; }
                show();
            };
            const blur = () => {
                // Focusing the official embedded player stays inside this visible page.
                // A real window/tab departure still hasFocus=false or visibility=hidden.
                const active = document.activeElement;
                if (document.visibilityState === 'visible' && document.hasFocus() &&
                    active?.tagName === 'IFRAME' && active.getAttribute('data-kapok-player') === 'bilibili' &&
                    container.current?.contains(active)) { playerFocused = true; return; }
                playerFocused = false;
                conceal();
            };
            const visibility = () => {
                if (document.visibilityState === 'visible') void verify();
                else conceal();
            };
            const sessionSignal = (signal: SessionSignal) => {
                if (processSignal(signal) === 'recheck') void verify();
            };
            const localChange = (event: Event) => sessionSignal({ actorId: (event as CustomEvent<string>).detail, kind: 'ended' });
            const localExpiry = (event: Event) => sessionSignal({ actorId: (event as CustomEvent<string>).detail, kind: 'expired' });
            const channel = new BroadcastChannel('kapok-session');
            channel.onmessage = event => sessionSignal(event.data as SessionSignal);
            window.addEventListener('kapok-account-changed', localChange);
            window.addEventListener('kapok-session-expired', localExpiry);
            window.addEventListener('pagehide', conceal);
            window.addEventListener('pageshow', show);
            window.addEventListener('blur', blur);
            window.addEventListener('focus', focus);
            document.addEventListener('visibilitychange', visibility);
            return () => {
                mounted = false;
                activeGuard.conceal();
                verification.current?.abort();
                channel.close();
                window.removeEventListener('kapok-account-changed', localChange);
                window.removeEventListener('kapok-session-expired', localExpiry);
                window.removeEventListener('pagehide', conceal);
                window.removeEventListener('pageshow', show);
                window.removeEventListener('blur', blur);
                window.removeEventListener('focus', focus);
                document.removeEventListener('visibilitychange', visibility);
            };
        },
        [conceal, processSignal, verify]
    );
    useEffect(() => {
        if (locked || !data || !container.current) return;
        return retainRouteUI(actorId, container.current);
    }, [actorId, locked, data]);
    async function authorize() {
        const expectedStamp = confirmedStamp.current;
        const started = interruption.current;
        // Focus/pageshow can supersede a read while a native confirmation returns.
        // Only repeat authorization reads, never the business mutation, and only
        // after the replacement boundary has verified the same permission stamp.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (!invalidated.current && !guard.current.current(guard.current.token())) {
                if (verification.current && latestVerification.current) await latestVerification.current;
                else await verify();
            }
            const confirmedToken = guard.current.token();
            const task = latestVerification.current;
            if (interruption.current !== started || invalidated.current || !guard.current.current(confirmedToken)) {
                throw new Error('请先重新确认账号，输入仍保留。');
            }
            if (confirmedStamp.current !== expectedStamp) throw new Error('成员权限已变化，请重新确认后操作。');
            let current: BootstrapStatus;
            try {
                current = await api<BootstrapStatus>('bootstrap', undefined, actorId);
            } catch (e) {
                if (guard.current.current(confirmedToken) && e instanceof Error && 'code' in e) {
                    if (e.code === 'ACCOUNT_CHANGED') processSignal({ actorId, kind: 'ended' });
                    else if (e.code === 'AUTHENTICATION_REQUIRED') processSignal({ actorId, kind: 'expired' });
                }
                throw e;
            }
            if (interruption.current !== started || invalidated.current) throw new Error('页面已锁定，请重新确认账号后再保存，输入仍保留。');
            if (!guard.current.current(confirmedToken)) {
                if (latestVerification.current !== task) {
                    await latestVerification.current;
                    continue;
                }
                throw new Error('页面正在重新确认，请保留内容并再次操作。');
            }
            if (current.siteUserId !== actorId) {
                processSignal({ actorId, kind: 'ended' });
                throw new Error('登录账号已变化，请重新加载。');
            }
            if (current.me.user?.status !== 'active' && !(allowUnprofiled && current.me.user === null)) {
                conceal();
                clearNavigationActor(actorId);
                setData(null);
                throw new Error('当前账号暂不可用，请确认账号状态后重试。');
            }
            if (JSON.stringify([current.me.user?.id, current.me.membership]) !== expectedStamp) {
                conceal();
                clearNavigationActor(actorId);
                setData(null);
                throw new Error('成员权限已变化，请重新确认后操作。');
            }
            return confirmedToken;
        }
        throw new Error('页面仍在确认账号，请等待加载结束后再保存，输入仍保留。');
    }
    return {
        data,
        authorizationStamp,
        setData,
        subscribe: (listener: (ended: boolean) => void) => {
            listeners.current.add(listener);
            return () => { listeners.current.delete(listener); };
        },
        locked,
        checking,
        verificationMessage,
        error,
        sessionEnded,
        attach,
        verify,
        authorize,
        isCurrent: (token: number) => guard.current.current(token)
    };
}
export function SecureStatus({
    locked,
    error,
    checking,
    checkingMessage = '正在重新确认当前账号与权限…',
    retry
}: {
    locked: boolean;
    error: string;
    checking: boolean;
    checkingMessage?: string;
    retry: () => void;
}) {
    return locked ? <div className={error ? "notice error" : "notice"} role={error ? 'alert' : 'status'} aria-busy={checking}>

        <h2>{checking ? '正在加载…' : error ? '暂时无法加载' : '请重新确认账号'}</h2>
        <p>{error || (checking ? checkingMessage : '页面已暂时锁定，请重新确认当前账号与权限。')}</p>

        {!checking && <button className="secondary" onClick={retry}>重新确认</button>}

    </div> : null;
}

export type AccountSession = Pick<ReturnType<typeof useSecureResource>, 'authorize' | 'isCurrent' | 'subscribe' | 'sessionEnded' | 'verify'>;
const AccountContext = createContext<AccountSession | null>(null);
export function useAccountSession() {
    const session = useContext(AccountContext);
    if (!session) throw new Error('此操作需要账号阅读边界。');
    return session;
}
export function useOptionalAccountSession() { return useContext(AccountContext); }
type BoundaryProps<T> = {
    actorId: string;
    load: Loader<T>;
    allowUnprofiled?: boolean;
    checkingMessage?: string;
    children: (data: T) => ReactNode;
};
export function AccountBoundary<T>(props: BoundaryProps<T>) {
    // A new official actor always receives new in-memory state, even on a retained route component.
    return <AccountBoundarySession key={props.actorId} {...props} />;
}
function AccountBoundarySession<T>({ actorId, load, allowUnprofiled = false, checkingMessage, children }: BoundaryProps<T>) {
    const secure = useSecureResource<T>(actorId, load, allowUnprofiled);
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} checkingMessage={secure.verificationMessage || checkingMessage} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            <AccountContext.Provider key={secure.authorizationStamp} value={secure}>
                {secure.data !== null && children(secure.data)}
            </AccountContext.Provider>
        </div>
    </>;
}
