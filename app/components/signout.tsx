'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { api } from '../../lib/client/api';
import type { BootstrapStatus } from '../../lib/contracts';
import { cleanupActorDrafts, signalAccountChange, signalSessionExpiry } from '../../lib/client/session-guard';
import type { SessionSignal } from '../../lib/client/session-guard';
import { clearRegistrationPrefill } from '../../lib/client/registration-prefill';
import { registrationDraft } from '../../lib/client/registration-draft';

const accountChangedMessage = '登录账号已变化，请重新加载。';

export function SignOut({ actorId, href, switchEmail = false }: { actorId: string; href: string; switchEmail?: boolean }) {
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const request = useRef<AbortController | null>(null);
    useLayoutEffect(() => () => request.current?.abort(), [actorId]);
    return <>
        <a href={href} target="_top" className="button secondary" aria-busy={busy} aria-disabled={busy || undefined} onClick={async e => {
            e.preventDefault();
            if (request.current) return;
            if (!window.confirm(switchEmail ? '更换邮箱需要退出当前登录，并清除当前账号在本机的草稿。确认更换？' : '退出登录会清理此账号在本机的未上云草稿。可取消并先保存记录。确认退出？')) return;
            setError('');
            const controller = new AbortController();
            request.current = controller;
            setBusy(true);
            const cancel = () => controller.abort();
            const cancelForAccountChange = (event: Event) => {
                if (controller.signal.aborted) return;
                cancel();
                if ((event as CustomEvent<string>).detail === actorId) setError(accountChangedMessage);
            };
            window.addEventListener('kapok-account-changed', cancelForAccountChange);
            window.addEventListener('pagehide', cancel);
            let channel: BroadcastChannel | undefined;
            try {
                // Even failed logout verification must synchronously conceal every mounted protected surface.
                let initiallyConcealed = true;
                for (const node of document.querySelectorAll<HTMLElement>('[data-kapok-sensitive]')) {
                    try { node.hidden = true; } catch { initiallyConcealed = false; }
                }
                try { channel = new BroadcastChannel('kapok-session'); } catch { /* Lock the document even if cross-tab observation is unavailable. */ }
                if (channel) {
                    channel.onmessage = (event: MessageEvent<SessionSignal>) => {
                        if (event.data?.kind === 'ended') cancel();
                    };
                }
                const initiallyLocked = signalSessionExpiry(actorId);
                if (!channel || !initiallyConcealed || !initiallyLocked) {
                    setError('未能确认页面已完整锁定，请重新加载后再退出。');
                    return;
                }
                const account = await api<BootstrapStatus>('bootstrap', undefined, actorId, controller.signal);
                if ((account.actorId ?? account.siteUserId) !== actorId) throw new Error(accountChangedMessage);
            } catch (e) {
                // Ordinary expiry already conceals via its recoverable signal; do not turn it into cleanup.
                if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '尚未确认当前账号，请重新加载后再退出。');
                return;
            } finally {
                window.removeEventListener('kapok-account-changed', cancelForAccountChange);
                window.removeEventListener('pagehide', cancel);
                channel?.close();
                request.current = null;
                setBusy(false);
            }
            if (controller.signal.aborted) return;
            // The verification listeners are gone before this operation sends its own ended signal.
            // Conceal the current document before any subscriber or storage factory can fail.
            let concealed = true;
            for (const node of document.querySelectorAll<HTMLElement>('[data-kapok-sensitive]')) {
                try { node.hidden = true; } catch { concealed = false; }
            }
            const delivered = signalAccountChange(actorId);
            const cleaned = cleanupActorDrafts(actorId, () => localStorage);
            const prefillCleaned = clearRegistrationPrefill();
            const registrationCleaned = registrationDraft(actorId).clear();
            if (!concealed || !delivered || !cleaned || !registrationCleaned || !prefillCleaned) {
                setError('页面已锁定，但未能完成本机内容或会话清理。未确认退出成功，请处理设备存储后重新加载。');
                return;
            }
            window.location.assign(href);
        }}><LogOut size={17} aria-hidden="true" />{busy ? '正在确认当前账号…' : switchEmail ? '退出当前登录，换一个邮箱' : '退出当前登录'}</a>
        {error && <p className="form-error" role="alert">{error}</p>}
        {error === accountChangedMessage && <button type="button" className="secondary" onClick={() => window.location.reload()}>重新加载页面</button>}
    </>;
}
