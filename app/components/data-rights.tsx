'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { Me } from '../../lib/contracts';
import type { DeletedReflection, ManagedMember } from '../../lib/contracts/data-rights';
import { useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError } from '../../lib/client/api';
import { downloadOwnData } from '../../lib/client/data-export';
import { submitLeaveRequest } from '../../lib/client/leave-team';
import type { LeaveRequest } from '../../lib/client/leave-team';
import { ProfileSummary } from './presentation';
import { SecureStatus, useSecureResource } from './secure-resource';

type Pending = { path: string; method: 'POST' | 'PATCH'; body: unknown; key: string };
const message = (e: unknown) => e instanceof Error ? e.message : '暂时未能完成，请保留当前请求并重试。';
const uncertain = (e: unknown) => !(e instanceof ApiError) || e.retryable;

export function PersonalData({ actorId }: { actorId: string }) {
    const secure = useSecureResource<Me>(actorId, 'me');
    const [pending, setPending] = useNavigationField<LeaveRequest | null>(actorId, 'leave-pending', null);
    const [busy, setBusy] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const errorId = useId();
    async function download() {
        if (busy) return;
        setBusy(true);
        setError('');
        setStatus('');
        try {
            await downloadOwnData(actorId, secure.authorize, secure.isCurrent, data => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
                try {
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = 'kapok-personal.json';
                    anchor.click();
                } finally {
                    URL.revokeObjectURL(url);
                }
            });
            setStatus('已请求浏览器下载本人 JSON。请确认设备中的文件并自行保管。');
        } catch (e) {
            setError(message(e));
        } finally {
            setBusy(false);
        }
    }
    async function leave() {
        if (busy || !confirmed || !secure.data?.membership) return;
        setBusy(true);
        setError('');
        setStatus('');
        try {
            await submitLeaveRequest(actorId, {
                confirmed,
                membership: secure.data.membership,
                pending,
            }, {
                authorize: secure.authorize,
                isCurrent: secure.isCurrent,
                setPending,
                setConfirmed,
                refresh: secure.verify,
                showStatus: setStatus,
            });
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setError(message(e));
        } finally {
            setBusy(false);
        }
    }
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            <section className="panel">
                <h2>导出本人数据</h2>
                <p>每次下载重新核验账号及当前来源权限，包含本人资料、复盘、收藏引用、私人备注、秒数和本人评论。不会复制他人正文或分享对象。</p>
                <p className="muted">当前无权读取的来源仅保留引用与不可用标记。文件下载后由你自行保管，本服务不保留导出副本。</p>
                <button disabled={busy || secure.locked} onClick={() => void download()}>{busy ? '正在处理…' : '下载本人 JSON'}</button>
            </section>
            <Link className="row-link" href="/me/recycle">本人复盘回收站 →</Link>
            {secure.data?.membership && <section className="panel danger-zone">
                <h2>退出队伍</h2>
                <p>当前状态：{secure.data.membership.status === 'active' ? '有效成员' : secure.data.membership.status === 'paused' ? '队内访问已暂停' : '已离队'}。</p>
                <p>退出保留账号、本人私稿、备注和导出，关闭队内来源与成员资料读取，同时撤销本人对外分享。重新加入也不会恢复旧分享。</p>
                <p className="muted">最后一位有效管理员须先保留另一位有效管理员。退出队伍与注销账号是两件事。</p>
                {(secure.data.membership.status !== 'left' || pending) && <>
                    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} aria-describedby={error ? errorId : undefined} />我已理解退出及撤销分享的后果</label>
                    <button className="secondary danger" disabled={busy || !confirmed || secure.locked} onClick={() => void leave()}>{busy ? '正在确认…' : pending ? '重新确认上次退出请求' : '确认退出队伍'}</button>
                </>}
                {secure.data.membership.status !== 'active' && <p><Link href="/join">通过有效合成邀请重新加入</Link></p>}
            </section>}
            <p className="muted">账号注销与恢复、到期自动清理、独立备份与恢复演练尚待交付。当前不承诺自动清理或备份时限。</p>
            {error && <p id={errorId} className="form-error" role="alert">{error}</p>}
            {status && <p className="notice" role="status">{status}</p>}
        </div>
    </>;
}

export function ReflectionRecycle({ actorId }: { actorId: string }) {
    const secure = useSecureResource<DeletedReflection[]>(actorId, 'me/recycle');
    const [pending, setPending] = useNavigationField<Pending | null>(actorId, 'recycle-pending', null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function restore(r: DeletedReflection) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const token = await secure.authorize();
            const request = pending ?? {
                path: `reflections/${r.id}/restore`, method: 'POST', key: crypto.randomUUID(),
                body: { expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation },
            };
            setPending(request);
            await api(request.path, { ...request, actorId });
            if (!secure.isCurrent(token)) return;
            setPending(null);
            await secure.verify();
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setError(message(e));
        } finally {
            setBusy(false);
        }
    }
    return <>
        <p>本人删除的复盘在删除后 7 天内可恢复，截止时刻之后不可恢复。恢复仅回到本人私密原稿，原阅读范围与动态发布全部保持撤销。</p>
        <p className="muted">到期自动物理清理尚待交付，当前不承诺清理时限。</p>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data?.length === 0 && <p className="notice">当前没有可恢复的本人复盘。</p>}
            {secure.data?.map(r => <article className="panel" key={r.id}>
                <h2>{r.title.trim() || '未命名复盘'}</h2>
                <p>{r.date} · 恢复截止 {new Date(r.recoverUntil).toLocaleString('zh-CN')}</p>
                <details><summary>查看本人原稿</summary><p className="reflection-body">{r.text}</p></details>
                <button className="secondary" disabled={busy || secure.locked || !!pending && pending.path !== `reflections/${r.id}/restore`} onClick={() => void restore(r)}>{busy ? '正在确认…' : pending ? '重新确认上次恢复请求' : '仅恢复为私密原稿'}</button>
            </article>)}
            {error && <p className="form-error" role="alert">{error}</p>}
        </div>
    </>;
}

function MemberForm({ actorId, member, busy, pending, submit }: {
    actorId: string;
    member: ManagedMember;
    busy: boolean;
    pending: boolean;
    submit: (member: ManagedMember, role: string, status: string) => void;
}) {
    const id = useId();
    const [confirmed, setConfirmed] = useState(false);
    const [role, setRole] = useNavigationField(actorId, 'member-role:' + member.userId, member.role);
    const [status, setStatus] = useNavigationField(actorId, 'member-status:' + member.userId, member.status);
    return <form className="panel" onSubmit={event => {
        event.preventDefault();
        if (confirmed && !busy) submit(member, role, status);
    }}>
        <ProfileSummary name={member.discName} number={member.jerseyNumber} />
        <label htmlFor={`${id}-role`}>队内角色</label>
        <select id={`${id}-role`} value={role} disabled={busy || pending} onChange={e => { setRole(e.target.value as ManagedMember['role']); setConfirmed(false); }}>
            <option value="member">队员</option><option value="coach">教练</option><option value="admin">管理员</option>
        </select>
        <label htmlFor={`${id}-status`}>成员状态</label>
        <select id={`${id}-status`} value={status} disabled={busy || pending} onChange={e => { setStatus(e.target.value as ManagedMember['status']); setConfirmed(false); }}>
            <option value="active">有效</option><option value="paused">暂停队内访问</option><option value="left">离队 / 移除</option>
        </select>
        <p id={`${id}-consequence`} className="muted">暂停/离队会撤销此人的对外分享，并关闭队内访问。恢复成员身份不会恢复旧分享。再次启用会产生新的成员世代。管理员可管理队伍，但不能查看他人私稿。</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy} aria-describedby={`${id}-consequence`} onChange={e => setConfirmed(e.target.checked)} />确认对 {member.discName} 的角色及成员状态变更</label>
        <button disabled={busy || !confirmed}>{busy ? '正在确认…' : pending ? '重新确认上次请求' : '确认成员变更'}</button>
    </form>;
}

export function MemberManagement({ actorId }: { actorId: string }) {
    const secure = useSecureResource<ManagedMember[]>(actorId, 'admin/members');
    const [search, setSearch] = useNavigationField(actorId, 'managed-member-search', '');
    const [pending, setPending] = useNavigationField<Pending | null>(actorId, 'member-management-pending', null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function update(m: ManagedMember, role: string, status: string) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const token = await secure.authorize();
            const request = pending ?? {
                path: `admin/members/${m.userId}`, method: 'PATCH', key: crypto.randomUUID(),
                body: { role, status, expectedVersion: m.version, expectedEpoch: m.epoch },
            };
            setPending(request);
            await api(request.path, { ...request, actorId });
            if (!secure.isCurrent(token)) return;
            setPending(null);
            await secure.verify();
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setError(message(e));
        } finally {
            setBusy(false);
        }
    }
    return <>
        <p>仅当前有效管理员可变更队内角色与状态。最后一位有效管理员不能被降级、暂停或移除；须先保留另一位有效管理员。</p>
        <p className="small">教练仍是队内角色。复盘阅读范围只有仅自己与全队。</p>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && <label>查找成员<input type="search" placeholder="输入盘名或背号" value={search} onChange={event => setSearch(event.target.value)} /></label>}
            {secure.data?.length === 0 && <p className="panel">队伍暂时没有可管理的成员。</p>}
            {!!secure.data?.length && !secure.data.some(m => m.discName.includes(search) || m.jerseyNumber.includes(search)) && <p className="panel">没有匹配的成员。</p>}
            {secure.data?.filter(m => m.discName.includes(search) || m.jerseyNumber.includes(search)).map(m => <MemberForm actorId={actorId} key={`${m.id}-${m.version}-${secure.authorizationStamp}`} member={m} busy={busy || secure.locked || !!pending && pending.path !== `admin/members/${m.userId}`} pending={pending?.path === `admin/members/${m.userId}`} submit={(member, role, status) => void update(member, role, status)} />)}
            {error && <p className="form-error" role="alert">{error}</p>}
        </div>
    </>;
}
