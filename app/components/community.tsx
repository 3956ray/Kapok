'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { BookOpen, ChevronRight, Megaphone, NotebookPen, Video } from 'lucide-react';
import type { ActivityItem, ActivityPage, Announcement, PublicMember, PublicProfile } from '../../lib/contracts/reflections';
import { acknowledgeMutation, clearFormUI, navigationBuffer, currentRoute, useNavigationField } from '../../lib/client/navigation-state';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { SecureStatus, useSecureResource } from './secure-resource';
import { ProfileSummary, RecordRow } from './presentation';
export function MemberDirectory({
    actorId,
    id
}: {
    actorId: string;
    id?: string;
}) {
    const secure = useSecureResource<PublicMember[] | PublicProfile>(actorId, id ? `members/${id}` : 'members');
    const [query, setQuery] = useNavigationField(actorId, 'member-search', '');
    const profile = id ? secure.data as PublicProfile | null : null;
    const members = id ? null : secure.data as PublicMember[] | null;
    const matching = members?.filter(m => m.discName.includes(query) || m.jerseyNumber.includes(query));
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {members && <label className="member-search">查找盘名或背号
                <input type="search" value={query} placeholder="输入盘名或背号" onChange={e => setQuery(e.target.value)} />
            </label>}
            {members && <section className="panel member-list" aria-label="成员列表">
                {matching?.map(m => <Link className="row-link" key={m.id} href={`/members/${m.id}`}>
                    <span className="profile-summary"><span className="default-avatar" aria-hidden="true">{Array.from(m.discName)[0] || '队'}</span><span>{m.discName}<small>背号 {m.jerseyNumber} · {m.role === 'coach' ? '教练' : m.role === 'admin' ? '管理员' : '队员'}</small></span></span><ChevronRight size={18} aria-hidden="true" />
                </Link>)}
                {!members.length ? <p>队伍暂时没有成员。</p> : !matching?.length && <p role="status">没有匹配的成员。可以修改盘名或背号搜索。</p>}
            </section>}
            {profile && <>
                <section className="panel account-profile">
                    <p className="workspace-overline">队内资料</p>
                    <ProfileSummary name={profile.discName} number={profile.jerseyNumber} role={profile.role === 'coach' ? '教练' : profile.role === 'admin' ? '管理员' : '队员'} large />
                <p>{profile.bio}</p></section>
                <section className="section" aria-labelledby="member-shared-reflections">
                    <div className="account-card-heading"><h2 id="member-shared-reflections">分享给全队的复盘</h2><span className="status-label">全队可读</span></div>
                    <div className="panel member-reflections">
                        {profile.reflections.length ? profile.reflections.map(r => <RecordRow key={r.id} date={r.date} href={`/reflections/${r.id}`} title={r.title || '训练复盘'} detail="全队可读" />) : <p>当前没有全队可读复盘。</p>}
                    </div>
                </section>
            </>}
        </div>
    </>;
}
const activityKinds = {
    reflection: { label: '主动发布的复盘', Icon: NotebookPen },
    learning: { label: '分享的学习资料', Icon: BookOpen },
    video: { label: '新视频', Icon: Video },
    announcement: { label: '队伍公告', Icon: Megaphone },
};

async function refreshLearningItems(items: ActivityItem[], actorId: string, signal?: AbortSignal) {
    const ids = [...new Set(items.filter(item => item.kind === 'learning').map(item => item.id.slice('learning:'.length)))];
    if (!ids.length) return items;
    const lookups: Promise<Extract<ActivityItem, { kind: 'learning' }>[]>[] = [];
    for (let start = 0; start < ids.length; start += 100) {
        lookups.push(api('activity/learning?ids=' + ids.slice(start, start + 100).join(','), undefined, actorId, signal));
    }
    const current = new Map((await Promise.all(lookups)).flat().map(item => [item.id, item]));
    return items.flatMap<ActivityItem>(item => {
        if (item.kind !== 'learning') return [item];
        const latest = current.get(item.id);
        if (!latest) return [];
        current.delete(item.id);
        return [latest];
    });
}

export function Activity({
    actorId,
    home = false
}: {
    actorId: string;
    home?: boolean;
}) {
    const loadInitial = useCallback(async (_account: unknown, signal: AbortSignal) => {
        const count = home ? 3 : Math.min(200, Math.max(20, navigationBuffer(actorId, currentRoute(), 'activity-count').read<number>() ?? 20));
        const items: ActivityPage['items'] = [];
        let cursor: string | null = null;
        do {
            const page: ActivityPage = await api<ActivityPage>('activity?limit=' + (home ? 3 : 20) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, actorId, signal);
            items.push(...page.items); cursor = page.nextCursor;
        } while (!home && cursor && items.length < count);
        return { items: await refreshLearningItems(items, actorId, signal), nextCursor: cursor };
    }, [actorId, home]);
    const secure = useSecureResource<ActivityPage>(actorId, loadInitial);
    const [pages, setPages] = useState<{
        source: ActivityPage | null;
        items: ActivityPage['items'];
        next: string | null;
    } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const displayed = pages?.source === secure.data ? pages.items : secure.data?.items ?? [];
    const next = pages?.source === secure.data ? pages.next : secure.data?.nextCursor;
    async function load() {
        if (!next || busy) return;
        setBusy(true);
        setError('');
        try {
            const token = await secure.authorize();
            const requested = displayed.length + 20;
            const items: ActivityPage['items'] = [];
            let cursor: string | null = null;
            do {
                const page: ActivityPage = await api<ActivityPage>('activity?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, actorId);
                if (!secure.isCurrent(token)) return;
                items.push(...page.items);
                cursor = page.nextCursor;
            } while (cursor && items.length < requested);
            const current = await refreshLearningItems(items, actorId);
            await secure.authorize();
            if (secure.isCurrent(token)) { navigationBuffer(actorId, currentRoute(), 'activity-count').write(Math.min(200, current.length)); setPages({
                source: secure.data,
                items: current,
                next: cursor
            }); }
        } catch (e) {
            setError(e instanceof Error ? e.message : '未能加载更多，请重试。');
        } finally {
            setBusy(false);
        }
    }
    return <section className={home ? 'section activity-feed' : 'activity-feed'} aria-label={home ? undefined : '动态列表'}>
        {home && <div className="section-heading"><h2>队内动态</h2><Link href="/activity">查看全部动态</Link></div>}
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />

        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && displayed.map(item => {
                const { label, Icon } = activityKinds[item.kind];
                const Heading = home ? 'h3' : 'h2';
                return <article className="panel activity-card" key={item.id}>
                    <div className="activity-card-meta">
                        <span className="quick-icon"><Icon size={17} aria-hidden="true" /></span>
                        <span>{label}</span>
                        <time dateTime={item.publishedAt}>{item.publishedAt.slice(0, 10)}</time>
                    </div>
                    <Heading><Link href={item.href}>{item.title || label}<ChevronRight size={17} aria-hidden="true" /></Link></Heading>
                    {item.kind === 'video' && item.publisherName && <p className="small">发布者 {item.publisherName}</p>}
                    {item.updatedAt > item.publishedAt && <p className="small">更新于 <time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time></p>}
                </article>;
            })}
            {secure.data && displayed.length === 0 && <p className="panel">还没有可读动态。训练与成长历史可从相应入口查看。</p>}
            {!home && next && <button className="secondary" disabled={busy} onClick={() => void load()}>{busy ? '正在加载…' : '加载更多'}</button>}
            {error && <p role="alert">{error}</p>}
        </div>

    </section>;
}
export function AnnouncementRead({
    actorId,
    id
}: {
    actorId: string;
    id: string;
}) {
    const secure = useSecureResource<Announcement>(actorId, `announcements/${id}`);
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && <article className="reflection-paper">
                <div className="account-card-heading detail-meta">
                    <span className="status-label">{secure.data.status === 'published' ? '队伍公告' : '管理员草稿'}</span>
                    <span>更新于 <time dateTime={secure.data.updatedAt}>{secure.data.updatedAt.slice(0, 10)}</time></span>
                </div>
                <h2 className="detail-title">{secure.data.title}</h2>
                <p id="body" className="preserve reflection-body">{secure.data.text}</p>
            </article>}
        </div>
    </>;
}
export function AnnouncementAdmin({
    actorId
}: {
    actorId: string;
}) {
    const secure = useSecureResource<Announcement[]>(actorId, 'announcements');
    const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div className="account-stack" data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && <>
                {feedback && <p className={feedback.error ? 'notice error' : 'notice success'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
                <details className="panel announcement-card">
                    <summary>创建公告</summary>
                    <AnnouncementForm
                        actorId={actorId}
                        onFeedback={setFeedback}
                        refresh={secure.verify}
                        authorize={secure.authorize}
                        isCurrent={secure.isCurrent}
                    />
                </details>
                {secure.data.length === 0 && <section className="panel"><h2>还没有公告</h2><p>创建后先保存为草稿，确认发布才会出现在队内动态。</p></section>}
                {secure.data.map(a => <details className="panel announcement-card" key={a.id}>
                    <summary><span>{a.title}</span><span className="status-label">{a.status === 'published' ? '已发布' : '草稿'}</span></summary>

                    <AnnouncementForm
                        key={`${a.version}-${secure.authorizationStamp}`}
                        actorId={actorId}
                        item={a}
                        onFeedback={setFeedback}
                        refresh={secure.verify}
                        authorize={secure.authorize}
                        isCurrent={secure.isCurrent}
                    />

                </details>)}
            </>}
        </div>
    </>;
}
function AnnouncementForm({
    actorId,
    item,
    onFeedback,
    refresh,
    authorize,
    isCurrent
}: {
    actorId: string;
    item?: Announcement;
    onFeedback: (feedback: { text: string; error: boolean } | null) => void;
    refresh: () => Promise<void>;
    authorize: () => Promise<number>;
    isCurrent: (token: number) => boolean;
}) {
    const key = useRef(createRequestKey());
    const submitting = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const formRef = useRef<HTMLFormElement>(null);
    async function save(status: string) {
        if (submitting.current || !formRef.current) return;
        if (status !== 'deleted' && !formRef.current.reportValidity()) return;
        const form = new FormData(formRef.current);
        const body = {
            title: String(form.get('title')),
            text: String(form.get('text')),
            status,
            ...(item ? {
                expectedVersion: item.version
            } : {})
        };
        if (status === 'published' && !window.confirm('确认将公告发布到队内动态？')) return;
        if (item?.status === 'published' && status === 'draft' && !window.confirm('撤回这条公告？队内动态与阅读入口将停止展示。')) return;
        if (status === 'deleted' && !window.confirm('删除这条公告？各阅读入口将立即停止展示。')) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        onFeedback(null);
        try {
            const token = await authorize();
            await api(
                item ? `announcements/${item.id}` : 'announcements',
                {
                    actorId,
                    method: item ? 'PATCH' : 'POST',
                    body,
                    key: key.current(actorId, body)
                }
            );
            if (!isCurrent(token)) return;
            acknowledgeMutation(actorId, item ? 'PATCH' : 'POST', item ? `announcements/${item.id}` : 'announcements', body);
            clearFormUI(actorId, item?.id ?? 'announcement-new');
            if (!item) formRef.current?.reset();
            onFeedback({ text: '公告变更已确认。', error: false });
            await refresh();
        } catch (e) {
            const text = e instanceof Error ? e.message : '公告未能保存。';
            if (e instanceof ApiError && ['VERSION_CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(e.code)) {
                onFeedback({ text, error: true });
                await refresh();
            } else setError(text);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    return <form data-buffer-id={item?.id ?? 'announcement-new'} aria-busy={busy}
        ref={formRef}
        onSubmit={e => {
            e.preventDefault();
            void save(item?.status ?? 'draft');
        }}
    >

        <label>公告标题
            <input required name="title" maxLength={80} defaultValue={item?.title ?? ''} disabled={busy} />
        </label>

        <label>公告正文
            <textarea
                required
                name="text"
                rows={5}
                maxLength={5000}
                defaultValue={item?.text ?? ''}
                disabled={busy}
            />
        </label>

        <div className="actions">
            <button disabled={busy}>{busy ? '正在保存…' : item?.status === 'published' ? '保存已发布公告修改' : '保存草稿'}</button>

            <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void save(item?.status === 'published' ? 'draft' : 'published')}
            >{item?.status === 'published' ? '撤回公告' : '发布公告'}</button>

            {item && <button type="button" className="secondary" disabled={busy} onClick={() => void save('deleted')}>删除公告</button>}

        </div>

        {error && <p role="alert" className="form-error">{error}</p>}

    </form>;
}
