'use client';
import { ReflectionIcon } from './reflection-icon';
import { Bookmark, Layers, LockKeyhole } from 'lucide-react';
import { memo, useMemo } from 'react';
import Link from 'next/link';
import type { ReflectionAuthor } from '../../lib/contracts/reflections';
import type { Collection } from '../../lib/contracts/training';
import { api } from '../../lib/client/api';
import { AccountBoundary } from './secure-resource';
import { useNavigationField } from '../../lib/client/navigation-state';
import { CollectionCard } from './collections';
import { DateGroup, RecordRow } from './presentation';

// Keep cards mounted so filtering never discards an in-progress private note.
const GrowthCollectionCard = memo(CollectionCard);
const GrowthRecordRow = memo(RecordRow);

type GrowthRows = { reflections: ReflectionAuthor[]; collections: Collection[] };
export function GrowthContent({ actorId, initialFilter = 'all' }: { actorId: string; initialFilter?: 'all' | 'reflections' | 'collections' }) {
    const load = useMemo(() => ({ read: async (signal: AbortSignal) => {
        const [reflections, collections] = await Promise.all([
            api<ReflectionAuthor[]>('reflections', undefined, actorId, signal),
            api<Collection[]>('collections', undefined, actorId, signal),
        ]);
        return { reflections, collections };
    } }), [actorId]);
    return <AccountBoundary<GrowthRows> actorId={actorId} load={load}>{data => <Tabs key={initialFilter} actorId={actorId} data={data} initialFilter={initialFilter} />}</AccountBoundary>;
}
function Tabs({ actorId, data, initialFilter }: { actorId: string; data: GrowthRows; initialFilter: 'all' | 'reflections' | 'collections' }) {
    const [tab, setTab] = useNavigationField<'all' | 'reflections' | 'collections'>(actorId, 'growth-tab:' + initialFilter, initialFilter);
    const rows = useMemo(() => [
        ...data.reflections.map(item => ({ kind: 'reflection' as const, date: item.date, item })),
        ...data.collections.map(item => ({ kind: 'collection' as const, date: item.createdAt, item })),
    ].sort((a, b) => b.date.localeCompare(a.date)), [data]);
    const visible = useMemo(() => rows.filter(row => tab === 'all' || (tab === 'reflections' ? row.kind === 'reflection' : row.kind === 'collection')), [rows, tab]);
    const positions = useMemo(() => new Map(visible.map((row, index) => [row, index])), [visible]);
    const filters = [
        { value: 'all', label: '全部', Icon: Layers, count: rows.length },
        { value: 'collections', label: '收藏', Icon: Bookmark, count: data.collections.length },
        { value: 'reflections', label: '复盘', Icon: ReflectionIcon, count: data.reflections.length },
    ] as const;
    return <div className="growth-library">
        <div className="growth-toolbar">
            <div className="growth-filters" role="group" aria-label="成长内容筛选">
                {filters.map(({ value, label, Icon, count }) => <button key={value} type="button" aria-label={label} aria-pressed={tab === value} onClick={() => setTab(value)}>
                    <Icon size={16} aria-hidden="true" /><span>{label}</span><span className="growth-filter-count" aria-hidden="true">{count}</span>
                </button>)}
            </div>
            <span className="growth-sort" hidden={!visible.length}>最近记录优先</span>
        </div>
        <p className="sr-only" role="status">{filters.find(filter => filter.value === tab)?.label} · {visible.length ? `共 ${visible.length} 条记录` : '暂无记录'}</p>
        <div className="growth-records">
        {rows.map(row => {
            const index = positions.get(row) ?? -1;
            return <div key={`${row.kind}:${row.item.id}`} hidden={index < 0}>
            {index >= 0 && (index === 0 || visible[index - 1].date.slice(0, 7) !== row.date.slice(0, 7)) && <DateGroup date={row.date} />}
            {row.kind === 'reflection' ? <div className="panel growth-reflection-row">
                <GrowthRecordRow prefetch={false} date={row.date} href={`/reflections/${row.item.id}`} title={row.item.title.trim() || Array.from(row.item.text.trim()).slice(0, 80).join('') || '训练复盘'} detail={`复盘 · ${row.item.scope === 'team' ? '全队可读' : '仅自己'}`} />
            </div> : <GrowthCollectionCard actorId={actorId} item={row.item} />}
        </div>;
        })}
        {!visible.length && <section className="growth-empty">
            <span className="growth-empty-icon" aria-hidden="true">{tab === 'collections' ? <Bookmark size={30} /> : <ReflectionIcon size={30} />}</span>
            <h2>{tab === 'collections' ? '还没有收藏' : tab === 'reflections' ? '还没有复盘' : '还没有成长记录'}</h2>
            <p>{tab === 'collections' ? '收藏训练视频、学习资料或合集，方便之后回看。' : tab === 'reflections' ? '记下训练中的发现，以及下次想练的动作。' : '写下第一篇复盘，或从训练和学习资料里添加收藏。'}</p>
            <Link prefetch={false} className="button" href={tab === 'collections' ? '/trainings' : '/reflections/new'}>{tab !== 'collections' && <ReflectionIcon size={16} aria-hidden="true" />}{tab === 'collections' ? '去看训练' : '写复盘'}</Link>
            <p className="growth-privacy"><LockKeyhole size={14} aria-hidden="true" />私人备注仅自己可见，复盘由你决定是否分享。</p>
        </section>}
        </div>
    </div>;
}
