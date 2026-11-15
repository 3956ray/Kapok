'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { api, ApiError } from '../../lib/client/api';
import type { BootstrapStatus } from '../../lib/contracts';
import type { PublicProfile } from '../../lib/contracts/reflections';
import { AccountProfileCard } from './account-profile-card';
import { AccountBoundary } from './secure-resource';

export function AccountPreview({ actorId }: { actorId: string }) {
    const load = useCallback(async ({ me }: BootstrapStatus, signal: AbortSignal) => {
        if (me.user?.status !== 'active' || me.membership?.status !== 'active') return { profile: null };
        const profile = await api<PublicProfile>(`members/${encodeURIComponent(me.user.id)}`, undefined, actorId, signal);
        if (profile.id !== me.user.id) {
            throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号的队内资料暂不可用。', retryable: false }, requestId: '' });
        }
        return { profile };
    }, [actorId]);

    return <AccountBoundary actorId={actorId} load={load}>{({ profile }) =>
        <div className="account-profile-preview">
            {profile ? <AccountProfileCard profile={profile} /> : <p className="notice" role="status">当前账号没有队伍访问权限，无法预览队内资料。</p>}
            <div className="account-profile-buttons">
                <Link className="button secondary" href="/me">返回我的账户</Link>
                {profile && <Link className="button" href="/me/edit">编辑个人资料</Link>}
            </div>
        </div>
    }</AccountBoundary>;
}
