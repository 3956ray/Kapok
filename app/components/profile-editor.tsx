'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Me } from '../../lib/contracts';
import { AccountBoundary, useAccountSession } from './secure-resource';
import { ProfileForm } from './forms';
import { AccountProfileCard } from './account-profile-card';
export function ProfileEditor({ actorId }: { actorId: string }) {
    return <AccountBoundary<Me> actorId={actorId} load="me">{me => <Editor actorId={actorId} me={me} />}</AccountBoundary>;
}
function Editor({ actorId, me }: { actorId: string; me: Me }) {
    const session = useAccountSession();
    const [result, setResult] = useState<Me | null>(null);
    const [cancelled, setCancelled] = useState(false);
    if (!me.profile) return <p>当前账号没有可编辑资料。</p>;
    const saved = result?.profile;
    const superseded = !!saved && me.profile.version > saved.version;
    const shown = saved && !superseded ? saved : me.profile;
    const role = me.membership?.status === 'active' ? me.membership.role : undefined;
    if (result || cancelled) return <div className="account-profile-preview">
        <p className="notice" role="status">{result ? superseded ? '当前账号资料已更新，请核对。' : '资料已保存到账号。' : '已丢弃本次输入。下方为重新确认的账号资料。'}</p>
        <AccountProfileCard profile={{ ...shown, role }} />
        <div className="account-profile-buttons">
            <Link className="button secondary" href="/me">返回我的账户</Link>
            {role && <Link className="button secondary" href="/me/preview">预览队友看到的我</Link>}
            <button type="button" onClick={async () => { await session.verify(); setResult(null); setCancelled(false); }}>编辑个人资料</button>
        </div>
    </div>;
    return <section className="account-editor" aria-label="个人资料表单">
        {me.membership?.status !== 'active' && <p className="notice">当前不在有效队伍中，仍可编辑本人资料。</p>}
        <ProfileForm me={me} actorId={actorId} onSaved={setResult} onCancel={() => { setCancelled(true); void session.verify(); }} />
    </section>;
}
