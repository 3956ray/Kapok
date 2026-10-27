'use client';

import { useState } from 'react';
import { api } from '../../lib/client/api';
import type { BootstrapStatus } from '../../lib/contracts';
import { cleanupActorDrafts, signalAccountChange, signalSessionExpiry } from '../../lib/client/session-guard';
export function SignOut({ actorId, href }: { actorId: string; href: string }) {
    const [error, setError] = useState('');
    return <>
        <a href={href} target="_top" className="button secondary" onClick={async e => {
            e.preventDefault();
            if (!window.confirm('退出登录会清理此账号在本机的未上云草稿。可取消并先保存记录。确认退出？')) return;
            setError('');
            // Even failed logout verification must synchronously conceal every mounted protected surface.
            let initiallyConcealed = true;
            for (const node of document.querySelectorAll<HTMLElement>('[data-kapok-sensitive]')) {
                try { node.hidden = true; } catch { initiallyConcealed = false; }
            }
            const initiallyLocked = signalSessionExpiry(actorId);
            if (!initiallyConcealed || !initiallyLocked) {
                setError('未能确认页面已完整锁定，请重新加载后再退出。');
                return;
            }
            try {
                await api<BootstrapStatus>('bootstrap', undefined, actorId);
            } catch (e) {
                // Ordinary expiry already conceals via its recoverable signal; do not turn it into cleanup.
                setError(e instanceof Error ? e.message : '尚未确认当前账号，请重新加载后再退出。');
                return;
            }
            // Conceal the current document before any subscriber or storage factory can fail.
            let concealed = true;
            for (const node of document.querySelectorAll<HTMLElement>('[data-kapok-sensitive]')) {
                try { node.hidden = true; } catch { concealed = false; }
            }
            const delivered = signalAccountChange(actorId);
            const cleaned = cleanupActorDrafts(actorId, () => localStorage);
            if (!concealed || !delivered || !cleaned) {
                setError('页面已锁定，但未能完成本机内容或会话清理。未确认退出成功，请处理设备存储后重新加载。');
                return;
            }
            window.location.assign(href);
        }}>退出当前登录</a>
        {error && <p className="form-error" role="alert">{error}</p>}
    </>;
}
