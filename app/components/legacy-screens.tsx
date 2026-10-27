'use client';
import { Fragment, useCallback } from 'react';
import Link from 'next/link';
import type { BootstrapStatus, Me } from '../../lib/contracts';
import type { UploadPage } from '../../lib/contracts/media';
import type { Training, Video } from '../../lib/contracts/training';
import { useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError } from '../../lib/client/api';
import { AccountBoundary } from './secure-resource';
import { Activity } from './community';
import { DateGroup, ProfileSummary } from './presentation';
import { LocalDrafts, MyReflections } from './reflections';
import { BootstrapForm, InviteForm, JoinForm } from './forms';
import { AddVideoDialog, TrainingForm, UploadCleanup, VideoEditForm } from './training-forms';

function requireMember(me: Me, admin = false) {
    if (me.user?.status !== 'active' || me.membership?.status !== 'active' || (admin && me.membership.role !== 'admin')) throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有此队伍内容的访问权限。', retryable: false }, requestId: '' });
    return me;
}
function TrainingIndex({ actorId, items, admin }: { actorId: string; items: Training[]; admin: boolean }) {
    const [date, setDate] = useNavigationField(actorId, 'training-date', '');
    const visible = date ? items.filter(t => t.date === date) : items;
    return <>
        <label>按训练日期筛选<input data-own-buffer name="training-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        {date && <button className="secondary" onClick={() => setDate('')}>清除日期筛选</button>}
        {visible.length ? <TrainingCards items={visible} grouped /> : <section className="panel">
            <h2>{date ? '这一天还没有训练' : admin ? '还没有训练' : '还没有已发布训练'}</h2>
            <p>{date ? '可以清除日期筛选，查看其他训练。' : admin ? '在下方创建训练，准备视频与说明后再发布。' : '训练发布后，会按日期出现在这里。'}</p>
        </section>}
    </>;
}
function TrainingCards({ items, grouped = false }: { items: Training[]; grouped?: boolean }) {
    return items.length ? items.map((t, index) => <Fragment key={t.id}>
        {grouped && (index === 0 || items[index - 1].date.slice(0, 7) !== t.date.slice(0, 7)) && <DateGroup date={t.date} />}
        <Link className="panel training-card task-card" href={'/trainings/' + t.id}>
            <div className="page-heading"><span className="status-label">{({ draft: '草稿', published: '已发布', archived: '归档 · 只读', hidden: '已隐藏' } as Record<string, string>)[t.status]}</span><time dateTime={t.date}>{t.date}</time></div>
            <h2>{t.title}</h2>
            {t.description && <p>{t.description}</p>}
            <div className="task-foot"><span>打开训练</span><span aria-hidden="true">→</span></div>
        </Link>
    </Fragment>) : <section className="panel"><h2>还没有近期训练</h2><p>训练发布后，从这里继续回看。</p></section>;
}
export function HomeScreen({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me);
        return { me: account.me, trainings: await api<Training[]>('trainings', undefined, actorId, signal) };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{({ me, trainings }) => <>
        <p className="intro">{me.team?.name}{me.team?.description ? ` · ${me.team.description}` : ''}</p>
        <section className="section">
            <div className="section-heading"><h2>近期训练</h2><Link href="/trainings">全部训练</Link></div>
            <TrainingCards items={trainings.slice(0, 1)} />
            {!trainings.length && me.membership?.role === 'admin' && <Link className="button secondary" href="/trainings">创建训练</Link>}
        </section>
        <LocalDrafts actorId={actorId} />
        <MyReflections actorId={actorId} home />
        <Link className="row-link" href="/members"><span>队伍成员<small>{me.team?.name}</small></span><span aria-hidden="true">→</span></Link>
        <Activity actorId={actorId} home />
        <Link href="/reflections/new" className="button secondary">写下这次训练的想法</Link>
    </>}</AccountBoundary>;
}
export function TrainingsScreen({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me);
        return { me: account.me, items: await api<Training[]>('trainings', undefined, actorId, signal) };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{({ me, items }) => <>
        <p className="muted">按训练日期回看，一次训练可以有多段视频。</p>
        <TrainingIndex actorId={actorId} items={items} admin={me.membership?.role === 'admin'} />
        {me.membership?.role === 'admin' && <details className="panel">
            <summary>管理员 · 创建训练</summary>
            <TrainingForm actorId={actorId} />
        </details>}
    </>}</AccountBoundary>;
}
export function TrainingScreen({ actorId, id }: { actorId: string; id: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me);
        const training = await api<Training & { videos: Video[] }>('trainings/' + id, undefined, actorId, signal);
        const uploads = account.me.membership?.role === 'admin' ? await api<UploadPage>('uploads', undefined, actorId, signal) : { items: [], nextCursor: null };
        return { me: account.me, training, uploads };
    }, [actorId, id]);
    return <AccountBoundary key={id} actorId={actorId} load={load}>{({ me, training: t, uploads }) => {
        const admin = me.membership?.role === 'admin';
        const writable = ['draft', 'published'].includes(t.status);
        return <>
            <section className="panel sage">
                <p className="eyebrow"><time dateTime={t.date}>{t.date}</time></p>
                <h2>{t.title}</h2>
                <p className="preserve">{t.description}</p>
                <span className="status-label">{t.status === 'archived' ? '归档 · 历史只读' : t.status === 'published' ? '已发布 · 队内可读' : '草稿 · 仅管理员可见'}</span>
            </section>
            {t.status === 'archived' && <p className="notice">已归档。历史视频与讨论仍可回看，不能新增视频或讨论。</p>}
            <section className="section">
                {admin && writable ? <AddVideoDialog actorId={actorId} trainingId={t.id} nextPosition={Math.min(10000, Math.max(-1, ...t.videos.map(v => v.position)) + 1)} /> : <h2>训练视频</h2>}
                {t.videos.length ? t.videos.map(v => <article className="panel" key={v.id}>
                    {v.status === 'active' ? <Link className="row-link" href={'/videos/' + v.id}>{v.title} · {v.source === 'upload' ? '私有短片' : 'B站引用'} →</Link> : <p>{v.title} · 已隐藏</p>}
                    {admin && writable && <details>
                        <summary>管理顺序与视频</summary>
                        <VideoEditForm actorId={actorId} video={v} />
                    </details>}
                </article>) : <p className="panel">视频暂未添加，你仍可记录本次训练。</p>}</section>
            <Link className="panel training-card clay" href={`/reflections/new?training=${t.id}`}><h2>写本次训练复盘</h2><p>先留给自己，之后再决定阅读范围。</p><span className="task-foot">进入复盘 →</span></Link>
            {admin && <>
                <details className="panel">
                    <summary>管理员 · 编辑训练 / 发布 / 归档</summary>
                    <TrainingForm actorId={actorId} training={t} />
                </details>
                <UploadCleanup actorId={actorId} initial={uploads} />
            </>}
        </>;
    }}</AccountBoundary>;
}
export function MyScreen({ actorId }: { actorId: string }) {
    return <AccountBoundary<Me> actorId={actorId} load="me">{me => {
        if (me.user?.status !== 'active' || !me.profile) return <p>当前账号没有可用档案，请通过有效邀请建档。</p>;
        const admin = me.membership?.status === 'active' && me.membership.role === 'admin';
        return <>
            <p className="eyebrow">{me.membership?.status === 'active' ? me.team?.name : '当前不在有效队伍中'}</p>
            <section className="panel sage profile-card">
                <ProfileSummary name={me.profile.discName} number={me.profile.jerseyNumber} large />
                <Link className="button secondary" href="/me/edit">编辑资料</Link>
            </section>
            <p className="small">默认头像由已保存的盘名生成。</p>
            {me.membership?.status === 'active' && <Link className="row-link" href={'/members/' + me.user.id}><span>本人公开预览<small>查看队友看到的基本资料与全队复盘</small></span><span aria-hidden="true">→</span></Link>}
            <Link className="row-link" href="/growth"><span>成长记录<small>本人复盘、收藏与私人备注</small></span><span aria-hidden="true">→</span></Link>
            <Link className="row-link" href="/me/data"><span>隐私与个人数据<small>导出、回收站与退出队伍</small></span><span aria-hidden="true">→</span></Link>
            {admin && <section className="section">
                <h2>队伍管理</h2>
                <Link className="row-link" href="/admin/invites">邀请管理 →</Link>
                <Link className="row-link" href="/admin/announcements">公告管理 →</Link>
                <Link className="row-link" href="/admin/members">成员角色与状态 →</Link>
            </section>}
        </>;
    }}</AccountBoundary>;
}
export function InviteScreen({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus) => { requireMember(account.me, true); return account.me; }, []);
    return <AccountBoundary actorId={actorId} load={load}>{() => <section className="panel"><h2>邀请队友</h2><InviteForm actorId={actorId} /></section>}</AccountBoundary>;
}
export function JoinScreen({ actorId, token, returnTo }: { actorId: string; token: string; returnTo: string }) {
    return <AccountBoundary<BootstrapStatus> actorId={actorId} load="bootstrap" allowUnprofiled>{() => <JoinForm actorId={actorId} token={token} returnTo={returnTo} />}</AccountBoundary>;
}
export function BootstrapScreen({ actorId }: { actorId: string }) {
    return <AccountBoundary<BootstrapStatus> actorId={actorId} load="bootstrap" allowUnprofiled checkingMessage="正在重新确认当前账号与初始化状态…">{status => status.initialized ? <section className="notice">
        <h2>合成队伍已初始化</h2>
        <p>不能重新指定首位管理员。一次性邀请仅在原始成功回执中显示，重新确认不会取回或重建邀请。</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Critical recovery uses document navigation if client routing is unavailable. */}
        <a href="/" className="button">前往首页</a>
    </section> : <>
        <p>初始化仅接受已配置的站点所有者账号。不会自动赋予首访者管理员权限。</p>
        <details>
            <summary>本账号的站点身份标识</summary>
            <p className="mono">{status.siteUserId}</p>
        </details>
        {status.canBootstrap ? <BootstrapForm actorId={actorId} /> : <p className="notice">当前账号尚未获准初始化。请由站点所有者完成身份配置，或通过有效邀请建档。</p>}
    </>}</AccountBoundary>;
}
