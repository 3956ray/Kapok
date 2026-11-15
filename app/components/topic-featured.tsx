'use client';

import Link from 'next/link';
import { ArrowRight, BookOpen } from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, ApiError } from '../../lib/client/api';
import type { BootstrapStatus } from '../../lib/contracts';
import type { FeaturedTopicAdmin, FeaturedTopics, TopicCollection } from '../../lib/contracts/topic-collections';
import { learningEpoch } from './learning-controls';
import { AccountBoundary } from './secure-resource';
import { topicPath, topicsTab } from './topic-paths';
import { TopicSummary } from './topic-collections';
import { moveTopicRow, TopicOrder, TopicWriteStatus, topicsEndpoint, useTopicWrite } from './topic-controls';

const featuredEndpoint = 'learning/featured';
export function HomeFeaturedTopics({ actorId }: { actorId: string }) {
    return <AccountBoundary<FeaturedTopics> actorId={actorId} load={featuredEndpoint}>{({ collections }) => {
        const readable = collections.filter(collection => collection.items.length > 0);
        return readable.length ? <section className="topic-home-featured">
            <div className="section-heading"><h2>首页精选</h2><Link href={topicsTab}>查看全部合集 <ArrowRight size={15} aria-hidden="true" /></Link></div>
            <div className="topic-featured-grid">{readable.map(collection => <Link href={topicPath(collection.id)} className="topic-featured-card" key={collection.id}>
                <span className="topic-art" aria-hidden="true"><BookOpen size={31} /></span>
                <TopicSummary collection={collection} />
                <ArrowRight size={17} aria-hidden="true" />
            </Link>)}</div>
        </section> : null;
    }}</AccountBoundary>;
}

function FeaturedEditor({ actorId, epoch, featured, choices }: {
    actorId: string; epoch: string; featured: FeaturedTopicAdmin; choices: TopicCollection[];
}) {
    const [override, setOverride] = useState<{ base: FeaturedTopicAdmin; value: FeaturedTopicAdmin } | null>(null);
    const [input, setInput] = useState<{ ids: string[]; version: number } | null>(null);
    const [status, setStatus] = useState('');
    const action = useTopicWrite(actorId, epoch, 'featured');
    const current = override?.base === featured ? override.value : featured;
    const eligible = choices.filter(collection => collection.items.length > 0);
    const available = new Map([...current.collections, ...choices].map(collection => [collection.id, collection]));
    const ids = input?.ids ?? current.collections.map(collection => collection.id);
    const missingCount = ids.filter(id => !available.has(id)).length;
    const stale = !!input && input.version !== current.version;
    const blocked = action.busy || !!action.pending || action.needsRefresh;
    function change(next: string[]) {
        setInput({ ids: next, version: input?.version ?? current.version });
        setStatus('');
    }
    function apply(result: FeaturedTopicAdmin) {
        setOverride({ base: featured, value: result });
        setInput(null);
        setStatus('首页精选已保存。');
    }
    return <section className="panel learning-form learning-editor">
        <p>从已发布且有可读条目的合集里选择，首页最多显示 {current.maxFeatured} 个。</p>
        <fieldset disabled={blocked}>
            <legend>可选合集</legend>
            {eligible.length ? <ul className="learning-list">{eligible.map(collection => {
                const selected = ids.includes(collection.id);
                return <li key={collection.id}><label className="topic-choice">
                    <input type="checkbox" checked={selected} disabled={!selected && ids.length >= current.maxFeatured}
                        onChange={() => change(selected ? ids.filter(id => id !== collection.id) : [...ids, collection.id])} />
                    <TopicSummary collection={collection} />
                </label></li>;
            })}</ul> : <p>当前没有可精选的合集。</p>}
        </fieldset>
        <h2>首页展示顺序</h2>
        {ids.length ? <TopicOrder items={ids.map(id => {
            const collection = available.get(id);
            return { key: id, label: collection?.title ?? '不可用合集',
                content: <div className="learning-row-text">{collection ? <>
                    <TopicSummary collection={collection} />
                    {!collection.items.length && <small>暂无可读条目，首页将隐藏这项</small>}
                </> : '此合集已不可用'}</div> };
        })} disabled={blocked} move={(from, to) => change(moveTopicRow(ids, from, to))} remove={index => change(ids.filter((_, i) => i !== index))} />
            : <p>首页将隐藏精选区，学习库入口仍可使用。</p>}
        {ids.length >= current.maxFeatured && <p className="muted" role="status">已选满 {current.maxFeatured} 个合集。</p>}
        {missingCount > 0 && <p className="notice" role="status">请先移除不可用的合集。</p>}
        {stale && <div className="notice" role="status"><p>其他操作已更新首页精选，请查看最新设置后重新选择。</p>
            <button type="button" className="secondary" disabled={blocked} onClick={() => setInput(null)}>使用最新设置</button></div>}
        <div className="learning-actions">
            <button type="button" disabled={blocked || !input || stale || !!missingCount} onClick={() => {
                setStatus('');
                action.write<FeaturedTopicAdmin>({ path: featuredEndpoint, method: 'PATCH', body: { expectedVersion: current.version, collectionIds: ids } }, apply);
            }}>保存首页精选</button>
        </div>
        {status && <p className="notice" role="status">{status}</p>}
        <TopicWriteStatus action={action} retry={() => action.write<FeaturedTopicAdmin>(null, apply)} />
    </section>;
}

export function ManageFeaturedTopics({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        if (account.me.membership?.status !== 'active' || account.me.membership.role !== 'admin') {
            throw new ApiError({ error: { code: 'FORBIDDEN', message: '此页面仅管理员可访问。', retryable: false }, requestId: '' });
        }
        const [featured, choices] = await Promise.all([
            api<FeaturedTopicAdmin>(featuredEndpoint + '?view=admin', undefined, actorId, signal),
            api<TopicCollection[]>(topicsEndpoint, undefined, actorId, signal),
        ]);
        return { featured, choices, epoch: learningEpoch(account) };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{data => <FeaturedEditor actorId={actorId} {...data} />}</AccountBoundary>;
}
