'use client';
import { TextLinks } from './learning-text';

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { ChevronRight, Download, LockKeyhole, RotateCcw } from 'lucide-react';
import type { Me } from '../../lib/contracts';
import type { DeletedReflection, ManagedMember } from '../../lib/contracts/data-rights';
import type { ReflectionAuthor } from '../../lib/contracts/reflections';
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
const needsRefresh = (e: unknown) => e instanceof ApiError && ['MEMBERSHIP_CONFLICT', 'VERSION_CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(e.code);
const roleLabel = { member: '队员', coach: '教练', admin: '管理员' };
const statusLabel = { active: '有效成员', paused: '队内访问已暂停', left: '已离队' };

export function PersonalData({ actorId }: { actorId: string }) {
    const secure = useSecureResource<Me>(actorId, 'me');
    const [pending, setPending] = useNavigationField<LeaveRequest | null>(actorId, 'leave-pending', null);
    const busy = useRef(false);
    const [action, setAction] = useState<'export' | 'leave' | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [exportFeedback, setExportFeedback] = useState<{ error: boolean; text: string } | null>(null);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const errorId = useId();
    async function download() {
        if (busy.current) return;
        busy.current = true;
        setAction('export');
        setExportFeedback(null);
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
            setExportFeedback({ error: false, text: '已请求浏览器下载本人 JSON。请确认设备中的文件并自行保管。' });
        } catch (e) {
            setExportFeedback({ error: true, text: `数据导出暂未完成。没有生成可下载文件。${message(e)}` });
            if (needsRefresh(e)) await secure.verify();
        } finally {
            busy.current = false;
            setAction(null);
        }
    }
    async function leave() {
        if (busy.current || !confirmed || !secure.data?.membership) return;
        busy.current = true;
        setAction('leave');
        const membership = secure.data.membership;
        setError('');
        setStatus('');
        let sent = false;
        try {
            await submitLeaveRequest(actorId, {
                confirmed,
                membership,
                pending,
            }, {
                authorize: secure.authorize,
                isCurrent: secure.isCurrent,
                setPending: request => { if (request) sent = true; setPending(request); },
                setConfirmed,
                refresh: secure.verify,
                showStatus: setStatus,
            });
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setConfirmed(false);
            setError(sent && uncertain(e) ? '退出请求结果暂未确认。请核对当前成员状态，仍有访问权限时可确认上次请求。' : message(e));
            if ((sent && uncertain(e)) || needsRefresh(e)) await secure.verify();
        } finally {
            busy.current = false;
            setAction(null);
        }
    }
    const membership = secure.data?.membership;
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div className="account-stack" data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data?.profile ? <>
                <section className="panel account-private">
                    <p className="workspace-overline">个人记录</p>
                    <h2><LockKeyhole size={18} aria-hidden="true" />只属于你的记录</h2>
                    <p>私人复盘与备注仅你可读，队伍管理员也无法阅读。</p>
                </section>
                <section className="panel" aria-busy={action === 'export'}>
                    <h2>导出本人数据</h2>
                    <p>下载本人资料、复盘、收藏引用、私人备注、秒数、本人评论、本人学习资料与主题合集，以及配图元数据。当前无权读取的来源仅保留引用与不可用标记。</p>
                    <p className="muted">请自行保管下载的文件。</p>
                    <button disabled={!!action || secure.locked} onClick={() => void download()}><Download size={17} aria-hidden="true" />{action === 'export' ? '正在导出…' : exportFeedback?.error ? '重新导出' : '下载本人 JSON'}</button>
                    {exportFeedback && <p className={exportFeedback.error ? 'notice error' : 'notice success'} role={exportFeedback.error ? 'alert' : 'status'}>{exportFeedback.text}</p>}
                </section>
                <Link className="detail-row" href="/me/recycle">
                    <span className="detail-tile"><RotateCcw size={18} aria-hidden="true" /></span>
                    <span><strong>本人复盘回收站</strong><small>在 7 天内恢复为私密原稿</small></span>
                    <ChevronRight size={18} aria-hidden="true" />
                </Link>
                {membership && <section className="panel danger-zone account-leave" aria-busy={action === 'leave'}>
                    <div className="account-card-heading"><h2>退出队伍</h2><span className="status-label">{statusLabel[membership.status]}</span></div>
                    <p>离队会关闭队内访问并撤销对外分享。账号、本人私稿和备注会保留。请在退出前先导出需要保留的记录。</p>
                    {membership.role === 'admin' && <p className="muted">最后一位有效管理员须先交接管理职责。</p>}
                    {(membership.status !== 'left' || pending) && <>
                        <label><input type="checkbox" checked={confirmed} disabled={!!action} onChange={e => setConfirmed(e.target.checked)} aria-describedby={error ? errorId : undefined} />我已理解退出及撤销分享的后果</label>
                        <button className="secondary danger" disabled={!!action || !confirmed || secure.locked} onClick={() => void leave()}>{action === 'leave' ? '正在确认…' : pending ? '重新确认上次退出请求' : '确认退出队伍'}</button>
                    </>}
                    {error && <p id={errorId} className="notice error" role="alert">{error}</p>}
                    {status && <p className="notice success" role="status">{status}</p>}
                </section>}
                <p className="small">账号注销与恢复暂未开放。如需核实账号状态，请联系队伍管理员。</p>
            </> : secure.data && <section className="notice" role="status">
                <h2>当前账号无法访问个人数据页</h2>
                {membership && <p>当前队内状态为{statusLabel[membership.status]}。</p>}
                {error && <p role="alert">{error}</p>}
                {status && <p role="status">{status}</p>}
                <Link className="button secondary" href="/me">返回我的账户</Link>
            </section>}
        </div>
    </>;
}

export function ReflectionRecycle({ actorId }: { actorId: string }) {
    const secure = useSecureResource<DeletedReflection[]>(actorId, 'me/recycle');
    const [pending, setPending] = useNavigationField<Pending | null>(actorId, 'recycle-pending', null);
    const submitting = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    async function restore(r?: DeletedReflection) {
        if (submitting.current) return;
        const request: Pending | undefined = pending ?? (r && {
            path: `reflections/${r.id}/restore`, method: 'POST', key: crypto.randomUUID(),
            body: { expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation },
        });
        if (!request) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        setStatus('');
        try {
            const token = await secure.authorize();
            setPending(request);
            const restored = await api<ReflectionAuthor>(request.path, { ...request, actorId });
            if (!secure.isCurrent(token)) return;
            setPending(null);
            setStatus(restored.scope === 'private' && !restored.published
                ? '已恢复为私密复盘。你可以在成长记录查看。'
                : '已确认上次恢复请求。当前阅读范围与发布状态以成长记录为准。');
            await secure.verify();
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setError(message(e));
            if (needsRefresh(e)) await secure.verify();
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    const pendingInList = secure.data?.some(r => pending?.path === `reflections/${r.id}/restore`);
    return <>
        <section className="panel account-private">
            <h2><LockKeyhole size={18} aria-hidden="true" />恢复为私密原稿</h2>
            <p>删除后的 7 天内可恢复本人复盘。恢复后仅你可读，原阅读权限和动态发布仍保持撤销。</p>
        </section>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div className="account-stack" data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked} aria-busy={busy}>
            {status && <p className="notice success" role="status">{status}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {pending && !pendingInList && <div className="notice">
                <p>上次恢复请求的结果暂未确认。</p>
                <button className="secondary" disabled={busy || secure.locked} onClick={() => void restore()}>{busy ? '正在确认…' : '重新确认上次恢复请求'}</button>
            </div>}
            {secure.data?.length === 0 && <p className="panel" role="status">当前没有可恢复的本人复盘。</p>}
            {secure.data?.map(r => <article className="panel" key={r.id}>
                <h2>{r.title.trim() || '未命名复盘'}</h2>
                <p className="detail-meta"><time dateTime={r.date}>{r.date}</time> · 恢复截止 <time dateTime={r.recoverUntil}>{new Date(r.recoverUntil).toLocaleString('zh-CN')}</time></p>
                <details><summary>查看本人原稿</summary><p className="reflection-body"><TextLinks text={r.text}/></p></details>
                <button className="secondary" disabled={busy || secure.locked || !!pending && pending.path !== `reflections/${r.id}/restore`} onClick={() => void restore(r)}>{busy ? '正在确认…' : pending ? '重新确认上次恢复请求' : '仅恢复为私密原稿'}</button>
            </article>)}
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
    const memberVersion = `${member.userId}:${member.epoch}:${member.version}`;
    const [role, setRole] = useNavigationField(actorId, 'member-role:' + memberVersion, member.role);
    const [status, setStatus] = useNavigationField(actorId, 'member-status:' + memberVersion, member.status);
    const canSubmit = confirmed && !busy && (pending || role !== member.role || status !== member.status);
    return <form className="panel account-member" aria-label={`管理 ${member.discName}，背号 ${member.jerseyNumber}`} onSubmit={event => {
        event.preventDefault();
        if (!canSubmit) return;
        setConfirmed(false);
        submit(member, role, status);
    }}>
        <div className="account-card-heading">
            <ProfileSummary name={member.discName} number={member.jerseyNumber} role={roleLabel[member.role]} />
            <span className="status-label">{statusLabel[member.status]}</span>
        </div>
        <div className="account-member-fields">
            <label>队内角色
                <select value={role} disabled={busy || pending} onChange={e => { setRole(e.target.value as ManagedMember['role']); setConfirmed(false); }}>
                    <option value="member">队员</option><option value="coach">教练</option><option value="admin">管理员</option>
                </select>
            </label>
            <label>成员状态
                <select value={status} disabled={busy || pending} onChange={e => { setStatus(e.target.value as ManagedMember['status']); setConfirmed(false); }}>
                    <option value="active">有效</option><option value="paused">暂停队内访问</option><option value="left">离队 / 移除</option>
                </select>
            </label>
        </div>
        <p id={`${id}-consequence`} className="muted">{pending ? '上次请求的结果暂未确认。可确认同一次请求。' : '暂停或移除会关闭队内访问，并撤销此人的对外分享。恢复成员身份后，旧分享仍保持撤销。'}</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy} aria-describedby={`${id}-consequence`} onChange={e => setConfirmed(e.target.checked)} />{pending ? '确认核对上次请求' : `确认将 ${member.discName}（#${member.jerseyNumber}）设为${roleLabel[role]}，状态为${statusLabel[status]}`}</label>
        <button disabled={!canSubmit}>{pending ? '重新确认上次请求' : '确认成员变更'}</button>
    </form>;
}

export function MemberManagement({ actorId }: { actorId: string }) {
    const secure = useSecureResource<ManagedMember[]>(actorId, 'admin/members');
    const [search, setSearch] = useNavigationField(actorId, 'managed-member-search', '');
    const [pending, setPending] = useNavigationField<Pending | null>(actorId, 'member-management-pending', null);
    const submitting = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    async function update(m: ManagedMember, role: string, status: string) {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        setStatus('');
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
            setStatus('成员变更已确认。下方显示当前成员状态。');
            await secure.verify();
        } catch (e) {
            if (!uncertain(e)) setPending(null);
            setError(message(e));
            if (needsRefresh(e)) await secure.verify();
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    const matching = secure.data?.filter(m => m.discName.includes(search) || m.jerseyNumber.includes(search));
    return <>
        <section className="panel account-private">
            <h2>成员访问权限</h2>
            <p>最后一位有效管理员须先交接管理职责，才能降级、暂停或移除。管理员无法查看他人的私人复盘和备注。</p>
        </section>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div className="account-stack" data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked} aria-busy={busy}>
            {secure.data && <label className="member-search">查找成员<input type="search" placeholder="输入盘名或背号" value={search} onChange={event => setSearch(event.target.value)} /></label>}
            {status && <p className="notice success" role="status">{status}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {secure.data?.length === 0 && <p className="panel" role="status">队伍暂时没有可管理的成员。</p>}
            {!!secure.data?.length && !matching?.length && <p className="panel" role="status">没有匹配的成员。</p>}
            {matching?.map(m => <MemberForm actorId={actorId} key={`${m.id}-${m.epoch}-${m.version}-${secure.authorizationStamp}`} member={m} busy={busy || secure.locked || !!pending && pending.path !== `admin/members/${m.userId}`} pending={pending?.path === `admin/members/${m.userId}`} submit={(member, role, status) => void update(member, role, status)} />)}
        </div>
    </>;
}
