'use client';
import { LearningBookmark } from './collections';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { ArrowRight, FileText, Film } from 'lucide-react';
import { api, ApiError } from '../../lib/client/api';
import { useNavigationField } from '../../lib/client/navigation-state';
import { confirmedRejection, learningMutation, learningRecovery, sendLearning, type LearningMutation } from '../../lib/client/learning-images';
import { learningCategories, type LearningDraft, type LearningDraftOverview, type LearningPost, type LearningPostOverview } from '../../lib/contracts/learning';
import type { LearningAssociation, TopicCollection } from '../../lib/contracts/topic-collections';
import type { LearningActivityInput, LearningActivityStatus, LearningComment } from '../../lib/contracts/learning-social';
import { LearningDiscussion } from './learning-discussion';
import type { YouTubeControls } from './youtube-player';
import type { BootstrapStatus } from '../../lib/contracts';
import { AccountBoundary } from './secure-resource';
import { AddPostToTopic, TopicBrowseRows, TopicMine } from './topic-collections';
import { manageFeatured, newTopic, topicsTab } from './topic-paths';
import { topicsEndpoint } from './topic-controls';
import { LearningConfirm, LearningImageView, LearningMedia, learningEpoch, useLearningAction } from './learning-controls';

export const learningStatus = { draft: '私人草稿', published: '已发布', withdrawn: '已撤回', hidden: '已隐藏' };
const kinds = { article: '图文', video: '视频' };
const emptyFilters = { search: '', kind: '', category: '' };
const endpoint = 'learning/posts';
const newPost = '/learn/posts/new';

function BrowseRows({ posts, actorId }: { posts: LearningPostOverview[]; actorId: string }) {
    const [filters, setFilters] = useNavigationField(actorId, 'learning-filters', emptyFilters);
    const visible = posts.filter(post => post.title.toLowerCase().includes(filters.search.trim().toLowerCase()) &&
        (!filters.kind || filters.kind === post.kind) && (!filters.category || filters.category === post.category));
    return <>
        <div className="learning-filters" data-own-buffer>
            <label>搜索标题<input type="search" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} /></label>
            <label>类型<select value={filters.kind} onChange={e => setFilters({ ...filters, kind: e.target.value })}>
                <option value="">全部</option><option value="article">图文</option><option value="video">视频</option>
            </select></label>
        </div>
        <div className="learning-actions learning-chips" role="group" aria-label="主题筛选">
            {['', ...learningCategories].map(category => <button key={category} type="button" className="secondary"
                aria-pressed={filters.category === category} onClick={() => setFilters({ ...filters, category })}>{category || '全部'}</button>)}
        </div>
        {visible.length > 0 ? <>
            <p className="muted" role="status">{visible.length} 条内容</p>
            <div className="learning-list">
                {visible.map(post => <Link key={post.id} href={'/learn/posts/' + post.id} className="learning-row">
                    <span className="learning-thumb">{post.images[0] ? <LearningImageView image={post.images[0]} cover /> : post.kind === 'video' ? <Film aria-hidden="true" /> : <FileText aria-hidden="true" />}</span>
                    <span className="learning-row-text"><strong>{post.title}</strong>
                        <small>{kinds[post.kind]} · {post.category} · {post.author.discName}</small>
                        {post.summary && <span>{post.summary}</span>}</span>
                    <ArrowRight size={18} aria-hidden="true" />
                </Link>)}
            </div>
        </> : <section className="panel learning-empty">
            <h2>{posts.length ? '没有符合条件的结果' : '学习库还没有内容'}</h2>
            {posts.length ? <button className="secondary" onClick={() => setFilters(emptyFilters)}>清除筛选</button>
                : <Link href={newPost}>发布第一条资料</Link>}
        </section>}
    </>;
}
export function LearningBrowse({ actorId, tab = 'contents' }: { actorId: string; tab?: 'contents' | 'collections' }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        const admin = account.me.membership?.role === 'admin';
        if (tab === 'collections') return { admin, collections: await api<TopicCollection[]>(topicsEndpoint, undefined, actorId, signal) };
        return { admin, posts: await api<LearningPostOverview[]>(endpoint, undefined, actorId, signal) };
    }, [actorId, tab]);
    return <AccountBoundary actorId={actorId} load={load}>{({ admin, collections, posts }) => <>
        <div className="learning-actions learning-top">
            <nav className="learning-tabs" aria-label="学习库视图">
                <Link href="/learn?tab=contents" aria-current={tab === 'contents' ? 'page' : undefined}>内容</Link>
                <Link href={topicsTab} aria-current={tab === 'collections' ? 'page' : undefined}>合集</Link>
            </nav>
            <Link href="/learn/mine">我的创作</Link>
            {admin && <Link href={manageFeatured}>精选管理</Link>}
            <Link className="button" href={tab === 'collections' ? newTopic : newPost}>{tab === 'collections' ? '新建合集' : '发布内容'}</Link>
        </div>
        {collections ? <TopicBrowseRows collections={collections} actorId={actorId} /> : <BrowseRows posts={posts ?? []} actorId={actorId} />}
    </>}</AccountBoundary>;
}
export function LearningMine({ actorId }: { actorId: string }) {
    return <AccountBoundary<LearningDraftOverview[]> actorId={actorId} load="learning/mine">
        {posts => <MineGroups actorId={actorId} posts={posts} />}
    </AccountBoundary>;
}
function MineGroups({ actorId, posts }: { actorId: string; posts: LearningDraftOverview[] }) {
    const [group, setGroup] = useNavigationField<'posts' | 'collections'>(actorId, 'learning-mine-group', 'posts');
    return <>
        <div className="learning-actions learning-chips" role="group" aria-label="创作分组">
            <button type="button" className="secondary" aria-pressed={group === 'posts'} onClick={() => setGroup('posts')}>我发布的</button>
            <button type="button" className="secondary" aria-pressed={group === 'collections'} onClick={() => setGroup('collections')}>我整理的</button>
        </div>
        {group === 'posts' ? <MinePosts posts={posts} /> : <TopicMine actorId={actorId} />}
    </>;
}
function MinePosts({ posts }: { posts: LearningDraftOverview[] }) {
    return <>
        <div className="learning-actions learning-top"><h2>我发布的</h2><Link className="button" href={newPost}>发布内容</Link></div>
        {posts.length ? <div className="learning-list">{posts.map(post => <article className="learning-row" key={post.id}>
            <span className="learning-thumb"><FileText aria-hidden="true" /></span>
            <div className="learning-row-text"><strong>{post.title}</strong><small>{learningStatus[post.status]}</small></div>
            <div className="learning-actions">
                {post.publishedVersion !== null && <Link href={'/learn/posts/' + post.id}>查看</Link>}
                <Link className="button secondary" href={'/learn/posts/' + post.id + '/edit'}>{post.status === 'withdrawn' ? '编辑并重新发布' : '继续编辑'}</Link>
            </div>
        </article>)}</div> : <section className="panel learning-empty"><h2>还没有创作</h2><p>保存后的资料草稿会出现在这里。</p></section>}
    </>;
}

export function LearningAssociationStatus({ association, retry, busy }: { association: LearningAssociation; retry: () => void; busy: boolean }) {
    return association.status === 'pending' ? <section className="notice learning-association" aria-label="合集收录结果">
        <strong>内容已发布，加入合集尚未完成</strong>
        <p>可以单独重试加入合集，已发布的内容会保留。</p>
        <button type="button" className="secondary" disabled={busy} onClick={retry}>{busy ? '正在确认…' : '重试加入合集'}</button>
    </section> : <p className="notice" role="status">{association.status === 'added-draft' ? '内容已发布，已加入合集草稿。' : '内容已发布，已加入已发布合集。'}</p>;
}

function ActivityControls({ post, initial, actorId, epoch, membershipEpoch, disabled }: {
    post: LearningPost; initial: LearningActivityStatus; actorId: string; epoch: string;
    membershipEpoch: number; disabled: boolean;
}) {
    const path = endpoint + '/' + post.id + '/activity';
    const recovery = learningRecovery<LearningMutation>(actorId, 'activity:' + post.id, epoch);
    const [pending, setPending] = useState(() => recovery.read());
    const [confirmed, setConfirmed] = useState<{ initial: LearningActivityStatus; status: LearningActivityStatus } | null>(null);
    const [error, setError] = useState('');
    const { busy, run, session } = useLearningAction();
    const status = confirmed?.initial === initial ? confirmed.status : initial;
    const outdated = status.publishedVersion !== post.publishedVersion;
    const shared = status.event !== null;

    function change() {
        if (disabled || (outdated && !pending)) return;
        const input: LearningActivityInput = {
            expectedPublishedVersion: status.publishedVersion,
            expectedMembershipEpoch: membershipEpoch,
            expectedEventId: status.lastEventId,
        };
        const request = pending ?? learningMutation(path, shared ? 'DELETE' : 'POST', input);
        void run(async (signal, current) => {
            recovery.write(request);
            setPending(request);
            setError('');
            try {
                await sendLearning<LearningActivityStatus>(request, actorId, signal);
                if (!current()) return;
                // Confirm current state even if a successful write response arrived after another device changed it.
                const latest = await api<LearningActivityStatus>(path, undefined, actorId, signal);
                if (!current()) return;
                setConfirmed({ initial, status: latest });
                setPending(null);
                recovery.clear();
            } catch (failure) {
                if (!current()) return;
                if (confirmedRejection(failure)) {
                    recovery.clear();
                    setPending(null);
                    if (failure instanceof ApiError && failure.code === 'NOT_FOUND') {
                        void session.verify();
                        return;
                    }
                }
                throw failure;
            }
        }, failure => setError(failure instanceof Error ? failure.message : '动态操作暂未完成。'));
    }

    return <section className="learning-actions" aria-label="队内动态分享">
        <button className="secondary" type="button" disabled={disabled || busy || (outdated && !pending)} onClick={change}>
            {busy ? '正在确认动态…' : pending ? '确认动态操作结果' : shared ? '撤回动态' : '分享到队内动态'}
        </button>
        {busy || pending ? <span role="status">{busy ? '正在确认队内动态状态。' : '动态操作结果待确认，重试沿用原请求。'}</span> :
            shared && <span role="status">已分享到队内动态</span>}
        {!pending && (outdated || error) && <button className="secondary" type="button" onClick={() => { setError(''); void session.verify(); }}>重新确认动态状态</button>}
        {error && <p role="alert">{error}</p>}
    </section>;
}

function Reading({ post, draft, actorId, epoch, admin, comments, userId, activity, membershipEpoch }: {
    post: LearningPost; draft: LearningDraft | null; actorId: string; epoch: string; admin: boolean;
    comments: LearningComment[]; userId: string; activity: LearningActivityStatus | null; membershipEpoch: number;
}) {
    const player = useRef<YouTubeControls>(null);
    const playerSurface = useRef<HTMLDivElement>(null);
    const path = endpoint + '/' + post.id;
    const recovery = learningRecovery<LearningMutation>(actorId, `read:${post.id}:${post.publishedVersion}`, epoch);
    const [pending, setPending] = useState(() => recovery.read());
    const [associationOverride, setAssociationOverride] = useState<LearningAssociation | null>(null);
    const [removed, setRemoved] = useState(false);
    const [status, setStatus] = useState('');
    const { busy, run, session } = useLearningAction();
    const association = associationOverride?.status === 'pending' && draft?.association?.status !== 'pending'
        ? draft?.association : associationOverride ?? draft?.association;
    const action = pending?.path.split('/').at(-1);
    function mutate(next: 'withdraw' | 'hide' | 'inclusion-retry') {
        if (pending && action !== next) return;
        if (next === 'withdraw' && !draft) return;
        const body = next === 'inclusion-retry' ? { expectedPublishedVersion: post.publishedVersion } : next === 'hide'
            ? { expectedVersion: post.publishedVersion } : { expectedVersion: draft!.version, expectedMembershipEpoch: draft!.membershipEpoch };
        const request = pending ?? learningMutation(path + '/' + next, 'POST', body);
        void run(async (signal, current) => {
            recovery.write(request);
            setPending(request);
            setStatus('');
            try {
                const result = await sendLearning<LearningAssociation | LearningDraft | { status: 'hidden' }>(request, actorId, signal);
                if (!current()) return;
                setPending(null);
                try { recovery.clear(); } catch { /* A stale key stays scoped to this publication. */ }
                if (next === 'inclusion-retry' && 'targetId' in result) setAssociationOverride(result);
                else if (next !== 'inclusion-retry') setRemoved(true);
            } catch (error) {
                if (!current()) return;
                if (confirmedRejection(error)) {
                    recovery.clear();
                    setPending(null);
                }
                throw error;
            }
        }, error => setStatus((error instanceof Error ? error.message : '请求暂未完成。') + ' 请重新确认当前状态。'));
    }
    if (removed) return <section className="panel" role="status"><h2>此内容已从队内阅读中移除</h2>
        <Link href={post.isAuthor ? '/learn/mine' : '/learn'}>{post.isAuthor ? '返回我的创作' : '返回学习库'}</Link>
    </section>;
    return <div className="learning-reading">
        <div className="learning-top">
            <h2>{post.title}</h2>
            {post.isAuthor && <Link className="button secondary" href={'/learn/posts/' + post.id + '/edit'}>编辑内容</Link>}
        </div>
        <article className="panel learning-article">
            <p className="learning-byline"><span className="default-avatar" aria-hidden="true">{Array.from(post.author.discName)[0]}</span>
                {post.author.discName} · 背号 {post.author.jerseyNumber} · {kinds[post.kind]} · {post.category}</p>
            {post.summary && <p className="learning-summary">{post.summary}</p>}
            {post.video && <div className="learning-discussion-player" ref={playerSurface} tabIndex={-1} aria-label="视频播放器">
                <LearningMedia key={post.video.url} video={post.video} title={post.title} player={player} />
            </div>}
            {post.body && <p className="learning-body">{post.body}</p>}
            {post.images.map(image => <figure key={image.id}><LearningImageView image={image} /></figure>)}
        </article>
        {association && <LearningAssociationStatus association={association} retry={() => mutate('inclusion-retry')} busy={busy || (!!pending && action !== 'inclusion-retry')} />}
        {pending && action === 'inclusion-retry' && association?.status !== 'pending' &&
            <button className="secondary" type="button" disabled={busy} onClick={() => mutate('inclusion-retry')}>确认收录结果</button>}
        {pending && action !== 'inclusion-retry' && <p role="status" className="notice">上次操作结果待确认。重试会沿用原请求。</p>}
        {status && <div className="notice" role="alert"><p>{status}</p><button className="secondary" onClick={() => void session.verify()}>重新确认状态</button></div>}
        <div className="learning-actions">
            {draft && <LearningConfirm label={action === 'withdraw' ? '确认撤回结果' : '撤回内容'} title="撤回这份资料？" confirm="确认撤回"
                disabled={busy || (!!pending && action !== 'withdraw')} onConfirm={() => mutate('withdraw')}>
                <p>队友将无法打开此资料。你可在我的创作中继续编辑并重新发布。</p>
            </LearningConfirm>}
            {admin && <LearningConfirm label={action === 'hide' ? '确认隐藏结果' : '隐藏内容'} title="隐藏这份资料？" confirm="确认隐藏"
                disabled={busy || (!!pending && action !== 'hide')} onConfirm={() => mutate('hide')}>
                <p>隐藏后队友无法阅读，作者仍可编辑私稿。隐藏状态会阻止作者重新发布。</p>
            </LearningConfirm>}
        </div>
        <AddPostToTopic actorId={actorId} epoch={epoch} postId={post.id} disabled={busy || !!pending} />
        <LearningBookmark actorId={actorId} sourceKind="learning_post" sourceId={post.id} />
        <LearningDiscussion actorId={actorId} epoch={epoch} userId={userId} admin={admin}
            postId={post.id} initial={comments} video={post.video} player={player} playerSurface={playerSurface} />
        {activity && <ActivityControls post={post} initial={activity} actorId={actorId} epoch={epoch}
            membershipEpoch={membershipEpoch} disabled={busy || !!pending} />}
    </div>;
}
export function LearningReading({ actorId, id }: { actorId: string; id: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        const path = endpoint + '/' + id;
        const post = await api<LearningPost>(path, undefined, actorId, signal);
        const draft = post.isAuthor ? await api<LearningDraft>(path + '?view=draft', undefined, actorId, signal) : null;
        const comments = await api<LearningComment[]>(path + '/comments', undefined, actorId, signal);
        // Recheck the source after loading author state and comments.
        const current = await api<LearningPost>(path, undefined, actorId, signal);
        const activity = current.isAuthor ? await api<LearningActivityStatus>(path + '/activity', undefined, actorId, signal) : null;
        return { post: current, comments, activity, userId: account.me.user!.id,
            draft: current.publishedVersion === draft?.publishedVersion ? draft : null,
            epoch: learningEpoch(account), membershipEpoch: account.me.membership!.epoch, admin: account.me.membership?.role === 'admin' };
    }, [actorId, id]);
    return <AccountBoundary key={id} actorId={actorId} load={load}>{data => <Reading key={data.post.id + ':' + data.post.publishedVersion} {...data} actorId={actorId} />}</AccountBoundary>;
}
