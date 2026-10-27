'use client';
import { useCallback } from 'react';
import Link from 'next/link';
import type { ReflectionAuthor } from '../../lib/contracts/reflections';
import type { Collection } from '../../lib/contracts/training';
import { api } from '../../lib/client/api';
import { AccountBoundary } from './secure-resource';
import { useNavigationField } from '../../lib/client/navigation-state';
import { CollectionCard } from './collections';
import { DateGroup, RecordRow } from './presentation';

type GrowthRows = { reflections: ReflectionAuthor[]; collections: Collection[] };
export function GrowthContent({ actorId }: { actorId: string }) {
    const load = useCallback(async (_account: unknown, signal: AbortSignal) => {
        const [reflections, collections] = await Promise.all([
            api<ReflectionAuthor[]>('reflections', undefined, actorId, signal),
            api<Collection[]>('collections', undefined, actorId, signal),
        ]);
        return { reflections, collections };
    }, [actorId]);
    return <AccountBoundary<GrowthRows> actorId={actorId} load={load}>{data => <Tabs actorId={actorId} data={data} />}</AccountBoundary>;
}
function Tabs({ actorId, data }: { actorId: string; data: GrowthRows }) {
    const [tab, setTab] = useNavigationField<'all' | 'reflections' | 'collections'>(actorId, 'growth-tab', 'all');
    const rows = [
        ...data.reflections.map(item => ({ kind: 'reflection' as const, date: item.date, item })),
        ...data.collections.map(item => ({ kind: 'collection' as const, date: item.createdAt, item })),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const visible = rows.filter(row => tab === 'all' || (tab === 'reflections' ? row.kind === 'reflection' : row.kind === 'collection'));
    return <>
        <div className="filter-tabs" aria-label="成长内容筛选">
            {([['all', '全部'], ['reflections', '复盘'], ['collections', '收藏']] as const).map(([value, label]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
        </div>
        {rows.map(row => {
            const index = visible.indexOf(row);
            return <div key={`${row.kind}:${row.item.id}`} hidden={index < 0}>
            {index >= 0 && (index === 0 || visible[index - 1].date.slice(0, 7) !== row.date.slice(0, 7)) && <DateGroup date={row.date} />}
            {row.kind === 'reflection' ? <div className="panel">
                <RecordRow date={row.date} href={`/reflections/${row.item.id}`} title={row.item.title.trim() || Array.from(row.item.text.trim()).slice(0, 80).join('') || '训练复盘'} detail={`复盘 · ${row.item.scope === 'team' ? '全队可读' : '仅自己'}`} />
            </div> : <CollectionCard actorId={actorId} item={row.item} />}
        </div>;
        })}
        {!visible.length && <section className="panel">
            <h2>{tab === 'collections' ? '还没有收藏' : tab === 'reflections' ? '还没有复盘' : '还没有成长记录'}</h2>
            <p>{tab === 'collections' ? '回看训练时，收藏视频或讨论，留下自己的备注。' : '从一段想法开始，保存后再决定是否分享。'}</p>
            <Link className="button secondary" href={tab === 'collections' ? '/trainings' : '/reflections/new'}>{tab === 'collections' ? '去看训练' : '写复盘'}</Link>
        </section>}
    </>;
}
