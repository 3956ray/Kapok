'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import type { ActivityPage, Announcement, PublicMember, PublicProfile } from '../../lib/contracts/reflections';
import { acknowledgeMutation, clearFormUI, navigationBuffer, currentRoute, useNavigationField } from '../../lib/client/navigation-state';
import { api, createRequestKey } from '../../lib/client/api';
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
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {members && <label>查找盘名或背号
                <input type="search" value={query} placeholder="输入盘名或背号" onChange={e => setQuery(e.target.value)} />
            </label>}
            {members && <section className="panel">
                {members.filter(m => m.discName.includes(query) || m.jerseyNumber.includes(query)).map(m => <Link className="row-link" key={m.id} href={`/members/${m.id}`}>
                    <span className="profile-summary"><span className="default-avatar" aria-label="默认头像">{Array.from(m.discName)[0] || '队'}</span><span>{m.discName}<small>背号 {m.jerseyNumber} · {m.role === 'coach' ? '教练' : m.role === 'admin' ? '管理员' : '队员'}</small></span></span><span aria-hidden="true">→</span>
                </Link>)}
                {!members.length ? <p>队伍暂时没有成员。</p> : !members.some(m => m.discName.includes(query) || m.jerseyNumber.includes(query)) && <p>没有匹配的成员。可以修改盘名或背号搜索。</p>}
            </section>}
            {profile && <>
                <section className="panel"><ProfileSummary name={profile.discName} number={profile.jerseyNumber} role={profile.role === 'coach' ? '教练' : profile.role === 'admin' ? '管理员' : '队员'} /></section>
                <h2 className="section">分享给全队的复盘</h2>
                <section className="panel">{profile.reflections.length ? profile.reflections.map(r => <RecordRow key={r.id} date={r.date} href={`/reflections/${r.id}`} title={r.title || '训练复盘'} detail="全队可读" />) : <p>当前没有全队可读复盘。</p>}</section>
            </>}
        </div>
    </>;
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
        return { items, nextCursor: cursor };
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
            await secure.authorize();
            if (secure.isCurrent(token)) { navigationBuffer(actorId, currentRoute(), 'activity-count').write(Math.min(200, items.length)); setPages({
                source: secure.data,
                items,
                next: cursor
            }); }
        } catch (e) {
            setError(e instanceof Error ? e.message : '未能加载更多，请重试。');
        } finally {
            setBusy(false);
        }
    }
    return <section className="section">

        <div className="section-heading">
            {home && <h2>队内动态</h2>}
            {home && <Link href="/activity">查看全部动态</Link>}
        </div>

        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />

        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && displayed.map(item => <article className="panel" key={item.id}>

                <p className="muted">{item.kind === 'reflection' ? '主动发布的复盘' : item.kind === 'video' ? '新视频' : '队伍公告'} · {item.publishedAt.slice(0, 10)}</p>

                <h2>
                    <Link href={item.href}>{item.title || '训练复盘'}</Link>
                </h2>

                {item.updatedAt > item.publishedAt && <p className="muted">更新于 {item.updatedAt.slice(0, 10)}</p>}

            </article>)}
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
            {secure.data && <article className="panel">
                <h2>{secure.data.title}</h2>
                <p>更新于 {secure.data.updatedAt.slice(0, 10)}</p>
                <p className="preserve reflection-body">{secure.data.text}</p>
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
    return <>
        <SecureStatus locked={secure.locked} error={secure.error} checking={secure.checking} retry={() => void secure.verify()} />
        <div data-kapok-sensitive ref={node => secure.attach(node)} hidden={secure.locked}>
            {secure.data && <>
                <details className="panel">
                    <summary>创建公告</summary>
                    <AnnouncementForm
                        actorId={actorId}
                        refresh={secure.verify}
                        authorize={secure.authorize}
                        isCurrent={secure.isCurrent}
                    />
                </details>
                {secure.data.length === 0 && <section className="panel"><h2>还没有公告</h2><p>创建后先保存为草稿，确认发布才会出现在队内动态。</p></section>}
                {secure.data.map(a => <details className="panel" key={a.id}>
                    <summary>{a.title} · {a.status === 'published' ? '已发布' : '草稿'}</summary>

                    <AnnouncementForm
                        key={`${a.version}-${secure.authorizationStamp}`}
                        actorId={actorId}
                        item={a}
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
    refresh,
    authorize,
    isCurrent
}: {
    actorId: string;
    item?: Announcement;
    refresh: () => Promise<void>;
    authorize: () => Promise<number>;
    isCurrent: (token: number) => boolean;
}) {
    const key = useRef(createRequestKey());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const formRef = useRef<HTMLFormElement>(null);
    async function save(status: string) {
        if (busy || !formRef.current) return;
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
        setBusy(true);
        setError('');
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
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : '公告未能保存。');
        } finally {
            setBusy(false);
        }
    }
    return <form data-buffer-id={item?.id ?? 'announcement-new'}
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
