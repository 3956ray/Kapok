'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Me } from '../../lib/contracts';
import { AccountBoundary, useAccountSession } from './secure-resource';
import { ProfileForm } from './forms';
import { ProfileSummary } from './presentation';
export function ProfileEditor({ actorId }: { actorId: string }) {
    return <AccountBoundary<Me> actorId={actorId} load="me">{me => <Editor actorId={actorId} me={me} />}</AccountBoundary>;
}
function Editor({ actorId, me }: { actorId: string; me: Me }) {
    const session = useAccountSession();
    const [result, setResult] = useState<Me | null>(null);
    const [cancelled, setCancelled] = useState(false);
    if (!me.profile) return <p>当前账号没有可编辑资料。</p>;
    const shown = result?.profile && result.profile.version >= me.profile.version ? result : me;
    const superseded = !!result?.profile && me.profile.version > result.profile.version;
    if (result || cancelled) return <section className="panel">
        <p role="status">{result ? superseded ? '当前账号资料已更新，请核对。' : '资料已保存到账号。' : '已丢弃本次输入。下方为重新确认的账号资料。'}</p>
        <ProfileSummary name={shown.profile!.discName} number={shown.profile!.jerseyNumber} />
        <Link className="button" href="/me">返回我的</Link>
    </section>;
    return <section className="profile-editor">
        <ProfileSummary name={me.profile.discName} number={me.profile.jerseyNumber} />
        <p className="small">默认头像随已保存的盘名更新。</p>
        {me.membership?.status !== 'active' && <p>当前不在有效队伍中，仍可编辑本人资料。</p>}
        <p className="muted">返回会保留本次输入；取消修改会丢弃输入。</p>
        <ProfileForm me={me} actorId={actorId} onSaved={setResult} onCancel={() => { setCancelled(true); void session.verify(); }} />
    </section>;
}
