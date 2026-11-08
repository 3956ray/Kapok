'use client';
import { Fragment, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { Bookmark, CalendarDays, ChevronRight, LockKeyhole, Megaphone, Pencil, Play, Sprout, UserRound, UsersRound } from 'lucide-react';
import type { BootstrapStatus, Me } from '../../lib/contracts';
import type { Training, Video } from '../../lib/contracts/training';
import { useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError } from '../../lib/client/api';
import { AccountBoundary } from './secure-resource';
import { Activity } from './community';
import { DateGroup, ProfileSummary } from './presentation';
import { LocalDrafts, MyReflections } from './reflections';
import { JoinForm } from './forms';
import { registrationDraft } from '../../lib/client/registration-draft';

function requireMember(me: Me, admin = false) {
    if (me.user?.status !== 'active' || me.membership?.status !== 'active' || (admin && me.membership.role !== 'admin')) throw new ApiError({ error: { code: 'FORBIDDEN', message: '当前账号没有此队伍内容的访问权限。', retryable: false }, requestId: '' });
    return me;
}
function TrainingIndex({ actorId, items }: { actorId: string; items: Training[] }) {
    const [date, setDate] = useNavigationField(actorId, 'training-date', '');
    const visible = date ? items.filter(t => t.date === date) : items;
    return <>
        <div className="training-filter">
            <label>按训练日期筛选<input data-own-buffer name="training-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
            {date && <button className="secondary" onClick={() => setDate('')}>清除日期筛选</button>}
        </div>
        {visible.length ? <TrainingRecords items={visible} /> : <section className="panel">
            <h2>{date ? '这一天还没有训练' : '还没有已发布训练'}</h2>
            <p>{date ? '可以清除日期筛选，查看其他训练。' : '训练发布后，会按日期出现在这里。'}</p>
        </section>}
    </>;
}
const trainingStatus: Record<string, string> = { draft: '草稿', published: '已发布', archived: '归档 · 只读', hidden: '已隐藏' };

function TrainingRecords({ items }: { items: Training[] }) {
    return items.map((t, index) => <Fragment key={t.id}>
        {(index === 0 || items[index - 1].date.slice(0, 7) !== t.date.slice(0, 7)) && <DateGroup date={t.date} />}
        <Link className="panel training-record" href={'/trainings/' + t.id}>
            <time className="record-date" dateTime={t.date}><b>{t.date.slice(8, 10)}</b>{t.date.slice(5, 7)}月</time>
            <div>
                <h3>{t.title}</h3>
                {t.description && <p>{t.description}</p>}
                {trainingStatus[t.status] && <span className="status-label">{trainingStatus[t.status]}</span>}
            </div>
            <ChevronRight size={18} aria-hidden="true" />
        </Link>
    </Fragment>);
}

function FeaturedTraining({ training }: { training: Training }) {
    return <Link className="training-feature" href={'/trainings/' + training.id}>
        <div className="training-feature-label"><span>TRAINING SESSION</span>{trainingStatus[training.status] && <span className="status-label">{trainingStatus[training.status]}</span>}</div>
        <h3>{training.title}</h3>
        {training.description && <p>{training.description}</p>}
        <div className="training-feature-footer">
            <time dateTime={training.date}>{training.date}</time>
            <span className="training-feature-arrow" aria-hidden="true"><ChevronRight size={19} /></span>
        </div>
    </Link>;
}
export function HomeScreen({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me);
        const me = account.me.team ? account.me : await api<Me>('me', undefined, actorId, signal);
        const trainings = await api<Training[]>('trainings', undefined, actorId, signal);
        return { me, featured: trainings.find(training => training.status === 'published') };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{({ me, featured }) => <div className="home-layout">
        <div>
            <section>
                <div className="section-heading"><h2>最近训练</h2><Link href="/trainings">全部训练 <ChevronRight size={15} aria-hidden="true" /></Link></div>
                {featured ? <FeaturedTraining training={featured} /> : <div className="panel">
                    <h3>还没有近期训练</h3>
                    <p>训练发布后，从这里继续回看。</p>
                    {me.membership?.role === 'admin' && <Link className="button secondary" href="/admin/trainings/new">创建训练</Link>}
                </div>}
            </section>
            <Activity actorId={actorId} home />
        </div>
        <div className="home-rail">
            <section>
                <div className="section-heading"><h2>留给自己</h2><LockKeyhole size={16} aria-hidden="true" /></div>
                <div className="writing-card">
                    <p className="workspace-overline">PRIVATE JOURNAL</p>
                    <h3>今天，有哪一刻想再想想？</h3>
                    <p>不必写成总结。先记下一个观察就好。</p>
                    <Link href="/reflections/new" className="writing-link"><Pencil size={16} aria-hidden="true" />开始写复盘</Link>
                </div>
            </section>
            <section className="section home-quick-links">
                <h2>快速访问</h2>
                <Link className="row-link" href="/growth"><span className="quick-icon"><Bookmark size={18} aria-hidden="true" /></span><span>成长记录<small>复盘、收藏与私人备注</small></span><ChevronRight size={16} aria-hidden="true" /></Link>
                <Link className="row-link" href="/members"><span className="quick-icon"><UsersRound size={18} aria-hidden="true" /></span><span>队伍成员<small>认识一起训练的人</small></span><ChevronRight size={16} aria-hidden="true" /></Link>
            </section>
            {me.team && <p className="home-team-note">{me.team.name}{me.team.description && <span>{me.team.description}</span>}</p>}
            <LocalDrafts actorId={actorId} />
            <MyReflections actorId={actorId} home />
        </div>
    </div>}</AccountBoundary>;
}
export function TrainingsScreen({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me);
        return { me: account.me, items: await api<Training[]>('trainings', undefined, actorId, signal) };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{({ me, items }) => <>
        {me.membership?.role === 'admin' && <div className="training-library-actions">
            <Link className="button secondary" href="/admin/trainings">管理训练 <ChevronRight size={16} aria-hidden="true" /></Link>
        </div>}
        <TrainingIndex actorId={actorId} items={items.filter(t => ['published', 'archived'].includes(t.status))} />
    </>}</AccountBoundary>;
}
export function TrainingScreen({ actorId, id, memberView = false }: { actorId: string; id: string; memberView?: boolean }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        requireMember(account.me, memberView);
        const training = await api<Training & { videos: Video[] }>('trainings/' + encodeURIComponent(id) + (memberView ? '?view=member' : ''), undefined, actorId, signal);
        return { me: account.me, training };
    }, [actorId, id, memberView]);
    return <AccountBoundary key={id + (memberView ? ':member' : '')} actorId={actorId} load={load}>{({ me, training: t }) => {
        const admin = me.membership?.role === 'admin';
        const managementPath = '/admin/trainings/' + t.id;
        const videos = t.videos.filter(v => v.status === 'active');
        return <>
            {memberView && <p className="notice training-preview-banner"><strong>队员视角预览</strong></p>}
            <section className="panel training-detail">
                <span className="status-label">{trainingStatus[t.status]}</span>
                <h2 className="detail-title">{t.title}</h2>
                <p className="detail-meta"><time dateTime={t.date}>{t.date}</time></p>
                {t.description && <p className="preserve">{t.description}</p>}
            </section>
            {t.status === 'archived' && <p className="notice">已归档。历史视频与讨论仍可回看，不能新增视频或讨论。</p>}
            <section className="section training-detail-section">
                <div className="section-heading"><h2>训练视频</h2></div>
                {videos.length ? videos.map(v => <article className="training-video-row" key={v.id}>
                    <Link className="detail-row" href={'/videos/' + v.id}>
                        <span className="detail-tile"><Play size={18} aria-hidden="true" /></span>
                        <span><strong>{v.title}</strong><small>{v.source === 'upload' ? '私有短片' : 'B站引用'}</small></span>
                        <ChevronRight size={18} aria-hidden="true" />
                    </Link>
                </article>) : <p className="panel">本次训练暂无视频。</p>}
            </section>
            {admin && !memberView && <Link className="training-inline" href={managementPath}>管理本次训练 <ChevronRight size={16} aria-hidden="true" /></Link>}
            <section className="section training-detail-section">
                <h2>训练之后</h2>
                <div className="panel training-journal">
                    <p className="privacy-line"><LockKeyhole size={16} aria-hidden="true" />仅自己可读</p>
                    <p>今天哪一个瞬间，让你有了新的想法？</p>
                    <Link className="button" href={`/reflections/new?training=${t.id}`}><Pencil size={16} aria-hidden="true" />写本次训练复盘</Link>
                </div>
            </section>
        </>;
    }}</AccountBoundary>;
}
export function MyScreen({ actorId }: { actorId: string }) {
    return <AccountBoundary<Me> actorId={actorId} load="me">{me => {
        if (me.user?.status !== 'active' || !me.profile) return <p>当前账号没有可用档案，请确认账号状态。</p>;
        const member = me.membership?.status === 'active';
        const admin = member && me.membership?.role === 'admin';
        const links = [
            ...(member ? [{ href: '/members/' + me.user.id, title: '我的队内档案', detail: '预览队友看到的资料和全队可读复盘', Icon: UserRound }] : []),
            { href: '/growth', title: '成长记录', detail: '本人复盘、收藏与私人备注', Icon: Sprout },
            ...(member ? [{ href: '/members', title: '队伍成员', detail: '认识一起训练的人', Icon: UsersRound }] : []),
            { href: '/me/data', title: '隐私与个人数据', detail: '导出、回收站与退出队伍', Icon: LockKeyhole },
        ];
        return <div className="account-layout">
            <section className="panel account-profile">
                <p className="workspace-overline">{member ? me.team?.name : '当前不在有效队伍中'}</p>
                <ProfileSummary name={me.profile.discName} number={me.profile.jerseyNumber} role={member ? admin ? '管理员' : me.membership?.role === 'coach' ? '教练' : '队员' : undefined} large />
                <Link className="button secondary" href="/me/edit"><Pencil size={16} aria-hidden="true" />编辑资料</Link>
            </section>
            <div className="account-links">
                <section aria-labelledby="account-records">
                    <h2 id="account-records">资料与记录</h2>
                    <div className="panel">
                        {links.map(({ href, title, detail, Icon }) => <Link key={href} className="row-link" href={href}>
                            <span className="quick-icon"><Icon size={17} aria-hidden="true" /></span>
                            <span>{title}<small>{detail}</small></span><ChevronRight size={17} aria-hidden="true" />
                        </Link>)}
                    </div>
                </section>
                {admin && <section aria-labelledby="account-admin">
                    <h2 id="account-admin">队伍管理</h2>
                    <div className="panel">
                        <Link className="row-link" href="/admin/trainings"><span className="quick-icon"><CalendarDays size={17} aria-hidden="true" /></span><span>训练管理<small>发布训练与管理视频</small></span><ChevronRight size={17} aria-hidden="true" /></Link>
                        <Link className="row-link" href="/admin/announcements"><span className="quick-icon"><Megaphone size={17} aria-hidden="true" /></span><span>公告管理<small>编辑草稿与发布公告</small></span><ChevronRight size={17} aria-hidden="true" /></Link>
                        <Link className="row-link" href="/admin/members"><span className="quick-icon"><UsersRound size={17} aria-hidden="true" /></span><span>成员角色与状态<small>管理队内访问权限</small></span><ChevronRight size={17} aria-hidden="true" /></Link>
                    </div>
                </section>}
            </div>
        </div>;
    }}</AccountBoundary>;
}
function RegistrationResolved({ actorId, destination }: { actorId: string; destination?: string }) {
    useEffect(() => { const draft = registrationDraft(actorId); draft.read(); draft.clear(); }, [actorId]);
    return destination ? <section>
        <p role="status">该账号已完成注册。</p>
        <a className="kapok-auth-primary" href={destination}>进入应用 →</a>
    </section> : <p className="notice" role="alert">当前账号没有队伍访问权限，请联系管理员。</p>;
}

export function JoinScreen({ actorId, returnTo, reverifyHref }: { actorId: string; returnTo: string; reverifyHref?: string }) {
    return <AccountBoundary<BootstrapStatus> actorId={actorId} load="bootstrap" allowUnprofiled reverifyHref={reverifyHref}>{({ me }) => {
        if (me.membership?.status === 'active') {
            const target = me.membership.role !== 'admin' && returnTo.startsWith('/admin/') ? '/' : returnTo;
            return <RegistrationResolved actorId={actorId} destination={target === '/' ? '/home' : target} />;
        }
        if (me.membership) return <RegistrationResolved actorId={actorId} />;
        return <JoinForm actorId={actorId} returnTo={returnTo} />;
    }}</AccountBoundary>;
}
