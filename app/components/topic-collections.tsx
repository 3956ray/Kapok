'use client';
import { LearningBookmark } from './collections';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, BookOpen, FileText, Film, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/client/api';
import { learningRecovery, type LearningMutation } from '../../lib/client/learning-images';
import { useNavigationField } from '../../lib/client/navigation-state';
import type { BootstrapStatus } from '../../lib/contracts';
import { topicDefaults, type TopicAddResult, type TopicChoice, type TopicCollection, type TopicDraft, type TopicReference, type TopicSource } from '../../lib/contracts/topic-collections';
import { LearningConfirm, LearningImageView, learningEpoch } from './learning-controls';
import { manageFeatured, newTopic, topicPath, topicsTab } from './topic-paths';
import { AccountBoundary } from './secure-resource';
import {
    moveTopicRow, sourcePath, TopicDialog, TopicOrder, TopicPicker, TopicSourceLabel, TopicWriteStatus,
    topicAddFeedback, topicKey, topicRef, topicsEndpoint, topicStatus, useTopicWrite,
} from './topic-controls';

export function TopicSummary({ collection }: { collection: TopicCollection }) {
    return <span className="learning-row-text">
        <strong>{collection.title}</strong>
        <small>{collection.author.discName} 整理 · {collection.items.length} 条</small>
        {collection.summary && <span>{collection.summary}</span>}
    </span>;
}

export function TopicBrowseRows({ collections, actorId }: { collections: TopicCollection[]; actorId: string }) {
    const [search, setSearch] = useNavigationField(actorId, 'topic-search', '');
    const keyword = search.trim().toLowerCase();
    const visible = collections.filter(collection => collection.title.toLowerCase().includes(keyword));
    return <>
        <div className="learning-filters" data-own-buffer><label>搜索合集标题
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} />
        </label></div>
        {visible.length ? <>
            <p role="status" className="muted">{visible.length} 个合集</p>
            <div className="learning-list">{visible.map(collection => <Link className="learning-row" key={collection.id} href={topicPath(collection.id)}>
                <span className="learning-thumb"><BookOpen aria-hidden="true" /></span>
                <TopicSummary collection={collection} /><ArrowRight size={18} aria-hidden="true" />
            </Link>)}</div>
        </> : <section className="panel learning-empty">
            <h2>{collections.length ? '没有符合条件的结果' : '还没有已发布的合集'}</h2>
            {collections.length ? <button type="button" className="secondary" onClick={() => setSearch('')}>清除筛选</button>
                : <Link href={newTopic}>新建第一个合集</Link>}
        </section>}
    </>;
}

export function TopicMine({ actorId }: { actorId: string }) {
    return <AccountBoundary<TopicChoice[]> actorId={actorId} load={topicsEndpoint + '/editable'}>{collections => <>
        <div className="learning-actions learning-top"><h2>我整理的合集</h2><Link className="button" href={newTopic}>新建合集</Link></div>
        {collections.length ? <div className="learning-list">{collections.map(collection => <article className="learning-row" key={collection.id}>
            <span className="learning-thumb"><BookOpen aria-hidden="true" /></span>
            <div className="learning-row-text"><strong>{collection.title}</strong><small>{topicStatus[collection.status]}</small></div>
            <div className="learning-actions">
                {collection.status === 'published' && <Link href={topicPath(collection.id)}>查看</Link>}
                <Link className="button secondary" href={topicPath(collection.id) + '/edit'}>{collection.status === 'withdrawn' ? '编辑并重新发布' : '继续编辑'}</Link>
            </div>
        </article>)}</div> : <section className="panel learning-empty">
            <h2>还没有整理合集</h2><p>保存后的合集草稿会出现在这里。</p>
        </section>}
    </>}</AccountBoundary>;
}

type TopicFields = { title: string; summary: string; version: number };
function TopicEditor({ actorId, epoch, draft }: { actorId: string; epoch: string; draft: TopicDraft | null }) {
    const router = useRouter();
    const identity = draft?.id ?? 'new';
    const endpoint = draft ? topicsEndpoint + '/' + draft.id : topicsEndpoint;
    const recovery = learningRecovery<TopicFields>(actorId, 'topic:' + identity + ':fields', epoch);
    const [fields, setFields] = useState(() => recovery.read());
    const [acknowledged, setAcknowledged] = useState<{ base: TopicDraft | null; draft: TopicDraft } | null>(null);
    const [status, setStatus] = useState('');
    const [inputError, setInputError] = useState('');
    const action = useTopicWrite(actorId, epoch, identity + ':write');
    const latest = acknowledged?.base === draft ? acknowledged.draft : draft;
    const form = fields ?? { title: latest?.title ?? '', summary: latest?.summary ?? '', version: latest?.version ?? 0 };
    const dirty = form.title.trim() !== (latest?.title ?? '') || form.summary.trim() !== (latest?.summary ?? '');
    const stale = !!fields && dirty && form.version !== (latest?.version ?? 0);
    const blocked = action.busy || !!action.pending || action.needsRefresh;
    const items = latest?.items ?? [];

    function remember(next: TopicFields | null) {
        setFields(next);
        try { if (next) recovery.write(next); else recovery.clear(); }
        catch { setInputError('无法在此设备恢复输入。当前页面仍保留所填内容。'); }
    }
    function apply(result: TopicDraft | TopicAddResult, request: LearningMutation) {
        const updated = 'collection' in result ? result.collection : result;
        setAcknowledged({ base: draft, draft: updated });
        if (request.path === endpoint) {
            remember(null);
            setStatus('草稿已保存。');
            if (!draft) router.replace(topicPath(updated.id) + '/edit');
        } else {
            if (fields && latest && form.version === latest.version) {
                // Item operations may replay against a concurrently edited draft. Keep the input,
                // but require an explicit rebase if the returned metadata changed underneath it.
                if (latest.title === updated.title && latest.summary === updated.summary) remember({ ...fields, version: updated.version });
            }
            setStatus('outcomes' in result ? topicAddFeedback(result) : request.path.endsWith('/publish') ? '合集已发布。'
                : request.path.endsWith('/withdraw') ? '合集已撤回。' : request.method === 'DELETE' ? '已从合集草稿移除。' : '草稿顺序已保存。');
        }
    }
    function write(path: string, method: LearningMutation['method'], body: unknown) {
        setStatus('');
        setInputError('');
        action.write<TopicDraft | TopicAddResult>({ path, method, body }, apply);
    }
    function add(selected: TopicReference[]) {
        if (latest) write(endpoint + '/items', 'POST', { expectedVersion: latest.version, items: selected });
    }
    function order(from: number, to: number) {
        if (latest) write(endpoint + '/items/order', 'PATCH', { expectedVersion: latest.version, items: moveTopicRow(items, from, to).map(topicRef) });
    }
    function remove(index: number) {
        if (latest) write(endpoint + '/items', 'DELETE', { expectedVersion: latest.version, item: topicRef(items[index]) });
    }
    function publish() {
        if (latest && !dirty) write(endpoint + '/publish', 'POST', { expectedVersion: latest.version, expectedMembershipEpoch: latest.membershipEpoch });
    }
    return <div className="panel learning-form learning-editor" data-own-buffer>
        <form onSubmit={event => {
            event.preventDefault();
            if (blocked || stale || !dirty || !form.title.trim() || (!draft && latest)) return;
            write(endpoint, draft ? 'PATCH' : 'POST', { title: form.title.trim(), summary: form.summary.trim(), ...(draft && latest ? { expectedVersion: latest.version } : {}) });
        }}>
            <fieldset disabled={blocked || (!draft && !!latest)}>
                <label>合集名称<input name="title" required maxLength={topicDefaults.maxTitle} value={form.title}
                    onChange={event => remember({ ...form, title: event.target.value })} /></label>
                <label>简介（选填）<textarea name="summary" rows={3} maxLength={topicDefaults.maxSummary} value={form.summary}
                    onChange={event => remember({ ...form, summary: event.target.value })} /></label>
            </fieldset>
            <div className="learning-actions">
                <button type="submit" className="secondary" disabled={blocked || stale || !dirty || !form.title.trim() || (!draft && !!latest)}>保存草稿</button>
                {stale && <button className="secondary" type="button" disabled={blocked}
                    onClick={() => remember({ ...form, version: latest?.version ?? 0 })}>保留输入并采用最新版本</button>}
            </div>
        </form>
        {stale && <p className="notice" role="status">服务上的草稿版本已变化。保存保留的输入前，请确认使用最新版本。</p>}
        <section className="topic-editor-directory">
            <div className="learning-top"><h2>目录</h2>
                {draft && <TopicDialog title="添加资料" label="添加资料" disabled={blocked}>
                    {close => <AccountBoundary<TopicSource[]> actorId={actorId} load={topicsEndpoint + '/sources'}>
                        {sources => <TopicPicker sources={sources} existing={items} apply={add} close={close} />}
                    </AccountBoundary>}
                </TopicDialog>}
            </div>
            {!draft ? <p className="muted">先保存草稿，再添加已有资料。</p> : items.length ? <>
                <p className="muted">拖动或使用上移、下移调整顺序。移除只影响本合集。</p>
                <TopicOrder disabled={blocked} items={items.map(item => ({
                    key: topicKey(item), label: item.title, content: <TopicSourceLabel item={item} />,
                }))} move={order} remove={remove} />
            </> : <p className="muted">目录是空的，可添加队内可读的资料。</p>}
        </section>
        {inputError && <p className="notice error" role="alert">{inputError}</p>}
        {status && <p className="notice" role="status">{status}</p>}
        <TopicWriteStatus action={action} retry={() => action.write<TopicDraft | TopicAddResult>(null, apply)} />
        {draft && latest && <>
            {dirty && <p className="muted">先保存名称和简介的改动，再发布合集。</p>}
            <div className="learning-actions">
                <LearningConfirm label={latest.publishedVersion === null ? '发布合集' : '发布更新'} title="发布到队内？" confirm="确认发布"
                    disabled={blocked || dirty} onConfirm={publish}><p>有效队员可阅读这份合集。发布会使用当前已保存的草稿。</p></LearningConfirm>
                {latest.publishedVersion !== null && <Link href={topicPath(latest.id)}>查看发布版本</Link>}
            </div>
        </>}
    </div>;
}

export function TopicEditing({ actorId, id }: { actorId: string; id?: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        const draft = id ? await api<TopicDraft>(topicsEndpoint + '/' + id + '?view=draft', undefined, actorId, signal) : null;
        return { draft, epoch: learningEpoch(account) };
    }, [actorId, id]);
    return <AccountBoundary actorId={actorId} load={load}>
        {data => <TopicEditor key={id ?? 'new'} actorId={actorId} {...data} />}
    </AccountBoundary>;
}

function TopicShare({ id }: { id: string }) {
    const field = useRef<HTMLInputElement>(null);
    const [status, setStatus] = useState('');
    useLayoutEffect(() => {
        field.current?.focus();
        field.current?.select();
    }, []);
    return <>
        <p>链接仅对登录且有队内访问权限的成员开放。</p>
        <label className="topic-share-field">合集链接<input ref={field} readOnly value={new URL(topicPath(id), window.location.origin).href} /></label>
        <div className="learning-actions">
            <button type="button" onClick={async () => {
                const href = field.current?.value;
                if (!href) return;
                try {
                    await navigator.clipboard.writeText(href);
                    if (field.current) setStatus('链接已复制。');
                } catch {
                    field.current?.focus();
                    field.current?.select();
                    if (field.current) setStatus('可使用系统复制命令复制已选中的链接。');
                }
            }}>复制链接</button>
        </div>
        {status && <p role="status">{status}</p>}
    </>;
}

function TopicReadingContent({ collection, draft, admin, actorId, epoch }: {
    collection: TopicCollection; draft: TopicDraft | null; admin: boolean; actorId: string; epoch: string;
}) {
    const action = useTopicWrite(actorId, epoch, collection.id + ':write');
    const [withdrawn, setWithdrawn] = useState(false);
    const withdrawPath = topicsEndpoint + '/' + collection.id + '/withdraw';
    const pendingWithdraw = action.pending?.path === withdrawPath;
    const retry = () => action.write<TopicDraft>(null, () => setWithdrawn(true));
    function withdraw() {
        if (!draft) return;
        action.write<TopicDraft>({ path: withdrawPath, method: 'POST',
            body: { expectedVersion: draft.version, expectedMembershipEpoch: draft.membershipEpoch } }, () => setWithdrawn(true));
    }
    if (withdrawn) return <section className="panel" role="status"><h2>合集已撤回</h2><Link href="/learn/mine">返回我的创作</Link></section>;
    return <div className="learning-reading topic-reading">
        <section className="panel topic-intro"><div>
            <h2>{collection.title}</h2>
            {collection.summary && <p className="learning-summary">{collection.summary}</p>}
            <p className="learning-byline">{collection.author.discName} 整理 · {collection.items.length} 条 · 有效队员可读</p>
            <div className="learning-actions">
                <TopicDialog title="分享合集" label="分享合集">{close => <>
                    <TopicShare id={collection.id} />
                    <button type="button" className="secondary" onClick={close}>关闭</button>
                </>}</TopicDialog>
                {collection.isAuthor && <Link className="button secondary" href={topicPath(collection.id) + '/edit'}>编辑合集</Link>}
                {draft && <LearningConfirm label="撤回合集" title="撤回这份合集？" confirm="确认撤回"
                    disabled={action.busy || !!action.pending || action.needsRefresh} onConfirm={withdraw}><p>撤回后队内链接暂时不可读。来源资料按原权限继续开放。</p>
                </LearningConfirm>}
                {admin && <Link href={manageFeatured}>管理首页精选</Link>}
            </div>
            {pendingWithdraw || action.error ? <TopicWriteStatus action={action} retry={retry} /> : action.pending &&
                <p className="notice" role="status">草稿操作待确认，请到编辑页继续。</p>}
        </div><div className="topic-art" aria-hidden="true"><BookOpen size={42} /></div></section>
        <LearningBookmark actorId={actorId} sourceKind="topic_collection" sourceId={collection.id} />
        <section>
            <h2>学习目录</h2>
            {collection.items.length ? <ol className="learning-list topic-directory">{collection.items.map((item, index) => <li key={topicKey(item)}>
                <Link className="learning-row" href={sourcePath(item)}><span className="topic-sequence">{index + 1}</span>
                    <TopicSourceLabel item={item} /><span className="learning-thumb">
                        {item.cover ? <LearningImageView image={item.cover} cover /> : item.mediaKind === 'video' ? <Film aria-hidden="true" /> : <FileText aria-hidden="true" />}
                    </span>
                </Link>
            </li>)}</ol> : <div className="panel learning-empty"><p>暂没有可阅读的条目。</p></div>}
        </section>
    </div>;
}

export function TopicReading({ actorId, id }: { actorId: string; id: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        const path = topicsEndpoint + '/' + id;
        try {
            const collection = await api<TopicCollection>(path, undefined, actorId, signal);
            const draft = collection.isAuthor ? await api<TopicDraft>(path + '?view=draft', undefined, actorId, signal) : null;
            const current = draft ? await api<TopicCollection>(path, undefined, actorId, signal) : collection;
            return { reading: { collection: current, draft: draft?.publishedVersion === current.publishedVersion ? draft : null,
                admin: account.me.membership?.role === 'admin', epoch: learningEpoch(account) } };
        } catch (error) {
            if (error instanceof ApiError && error.code === 'NOT_FOUND') return { reading: null };
            throw error;
        }
    }, [actorId, id]);
    return <AccountBoundary actorId={actorId} load={load}>{({ reading }) => reading
        ? <TopicReadingContent key={`${id}:${reading.collection.publishedVersion}`} {...reading} actorId={actorId} />
        : <section className="panel"><h2>此合集暂不可读</h2><Link href={topicsTab}>返回合集列表</Link></section>}
    </AccountBoundary>;
}

function TopicChoiceForm({ choices, apply, close }: { choices: TopicChoice[]; apply: (id: string) => void; close: () => void }) {
    const [id, setId] = useState('');
    const select = useRef<HTMLSelectElement>(null);
    useLayoutEffect(() => select.current?.focus(), []);
    return <>
        {choices.length ? <>
            <label className="topic-share-field">选择自己的合集<select ref={select} value={id} onChange={event => setId(event.target.value)}>
                <option value="">请选择</option>
                {choices.map(choice => <option value={choice.id} key={choice.id}>{choice.title} · {topicStatus[choice.status]}</option>)}
            </select></label>
            <p className="muted">资料会加入合集草稿，发布合集后队友可见。</p>
        </> : <p>当前没有可编辑的合集。 <Link href={newTopic}>新建合集</Link></p>}
        <div className="learning-actions">
            <button className="secondary" type="button" onClick={close}>取消</button>
            {!!choices.length && <button type="button" disabled={!id || !choices.some(choice => choice.id === id)}
                onClick={() => { close(); apply(id); }}>加入合集草稿</button>}
        </div>
    </>;
}

export function useAddPostToTopic({ actorId, epoch, postId, disabled }: {
    actorId: string; epoch: string; postId: string; disabled?: boolean;
}) {
    const [status, setStatus] = useState('');
    const action = useTopicWrite(actorId, epoch, 'post:' + postId);
    useEffect(() => {
        if (!status) return;
        const timer = window.setTimeout(() => setStatus(''), 3000);
        return () => window.clearTimeout(timer);
    }, [status]);
    function apply(result: TopicAddResult) { setStatus(topicAddFeedback(result)); }
    function add(id: string) {
        setStatus('');
        action.write<TopicAddResult>(async signal => {
            const path = topicsEndpoint + '/' + id;
            const draft = await api<TopicDraft>(path + '?view=draft', undefined, actorId, signal);
            return { path: path + '/items', method: 'POST', body: { expectedVersion: draft.version, items: [{ kind: 'post', id: postId }] } };
        }, apply);
    }
    return {
        trigger: <TopicDialog label="加入合集" title="加入合集" icon={<FolderPlus size={18} aria-hidden="true" />}
            disabled={disabled || action.busy || !!action.pending || action.needsRefresh}>
            {close => <AccountBoundary<TopicChoice[]> actorId={actorId} load={topicsEndpoint + '/editable'}>
                {choices => <TopicChoiceForm choices={choices} apply={add} close={close} />}
            </AccountBoundary>}
        </TopicDialog>,
        feedback: (status || action.error || action.pending || action.needsRefresh) ? <div className="topic-post-add">
            {status && <p className="topic-add-toast" role="status">{status}</p>}
            <TopicWriteStatus action={action} retry={() => action.write<TopicAddResult>(null, apply)} />
        </div> : null,
    };
}
