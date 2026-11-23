'use client';

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/client/api';
import { confirmedRejection, learningMutation, learningRecovery, sendLearning, type LearningMutation } from '../../lib/client/learning-images';
import { topicDefaults, type TopicAddResult, type TopicReference, type TopicSource } from '../../lib/contracts/topic-collections';
import { useLearningAction } from './learning-controls';
import { useAccountSession } from './secure-resource';

export const topicsEndpoint = 'learning/collections';
export const topicKey = (item: TopicReference) => item.kind + ':' + item.id;
export const topicRef = ({ kind, id }: TopicReference) => ({ kind, id });
export const sourcePath = (item: TopicSource) => (item.kind === 'post' ? '/learn/posts/' : item.kind === 'training' ? '/trainings/' : '/videos/') + item.id;
export const topicStatus = { draft: '私人草稿', published: '已发布', withdrawn: '已撤回' };

type WriteInput = Omit<LearningMutation, 'key'>;

export function useTopicWrite(actorId: string, epoch: string, scope: string) {
    const recovery = learningRecovery<LearningMutation>(actorId, 'topic:' + scope, epoch);
    const [pending, setPending] = useState(() => recovery.read());
    const [error, setError] = useState('');
    const [needsRefresh, setNeedsRefresh] = useState(false);
    const { busy, run, session } = useLearningAction();
    function write<T>(next: WriteInput | ((signal: AbortSignal) => Promise<WriteInput>) | null,
        apply: (result: T, request: LearningMutation) => void) {
        if (next ? pending || needsRefresh : !pending) return;
        void run(async (signal, current) => {
            setError('');
            let result: T;
            let request = pending;
            try {
                if (!request && next) {
                    const input = typeof next === 'function' ? await next(signal) : next;
                    if (!current()) return;
                    request = learningMutation(input.path, input.method, input.body);
                }
                if (!request) return;
                recovery.write(request);
                setPending(request);
                result = await sendLearning<T>(request, actorId, signal);
            } catch (err) {
                if (!current()) return;
                if (confirmedRejection(err)) {
                    try { recovery.clear(); } catch { /* The original key remains safe to replay. */ }
                    setPending(null);
                    setNeedsRefresh(err instanceof ApiError && ['VERSION_CONFLICT', 'NOT_FOUND'].includes(err.code));
                }
                throw err;
            }
            if (!current()) return;
            try { recovery.clear(); } catch { /* The original key remains safe to replay. */ }
            setPending(null);
            apply(result, request);
        }, err => setError(err instanceof Error ? err.message : '暂未确认操作结果。'));
    }
    async function refresh() {
        await session.verify();
        setNeedsRefresh(false);
        setError('');
    }
    return { pending, busy, error, needsRefresh, write, refresh };
}

export function TopicWriteStatus({ action, retry }: { action: ReturnType<typeof useTopicWrite>; retry: () => void }) {
    return <>
        {action.error && <p className="notice error" role="alert">{action.error}</p>}
        {action.pending && <div className="notice" role="status">
            <p>{action.busy ? '正在提交…' : '上次操作结果待确认。重试会沿用原请求。'}</p>
            <button className="secondary" type="button" disabled={action.busy} onClick={retry}>重试原请求</button>
        </div>}
        {action.needsRefresh && <button className="secondary" type="button" onClick={() => void action.refresh()}>重新载入最新状态</button>}
    </>;
}

export function TopicDialog({ title, label, disabled, icon, children }: {
    title: string; label: string; disabled?: boolean; icon?: ReactNode;
    children: (close: () => void) => ReactNode;
}) {
    const id = useId();
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const [opened, setOpened] = useState(false);
    const session = useAccountSession();
    const close = () => setOpened(false);
    useLayoutEffect(() => {
        if (!opened && dialog.current?.open) dialog.current.close();
    }, [opened]);
    useLayoutEffect(() => session.subscribe(() => {
        dialog.current?.close();
        setOpened(false);
    }), [session]);
    return <>
        <button className={icon ? "training-title-action" : "secondary"} type="button" ref={trigger} aria-haspopup="dialog"
            aria-label={icon ? label : undefined} title={icon ? label : undefined} disabled={disabled} onClick={() => {
                setOpened(true);
                dialog.current?.showModal();
            }}>{icon ?? label}</button>
        <dialog className="add-video-dialog topic-dialog" ref={dialog} aria-labelledby={id} onClose={() => {
            setOpened(false);
            if (!trigger.current?.closest('[hidden]')) trigger.current?.focus();
        }}>
            <h2 id={id}>{title}</h2>
            {opened && children(close)}
        </dialog>
    </>;
}

export function TopicSourceLabel({ item }: { item: TopicSource }) {
    return <span className="learning-row-text"><strong>{item.title}</strong>
        <small>{[item.mediaKind === 'article' ? '图文' : item.mediaKind === 'training' ? '训练' : '视频', item.category, item.author?.discName].filter(Boolean).join(' · ')}</small>
        {item.summary && <span>{item.summary}</span>}
    </span>;
}

export function TopicPicker({ sources, existing, apply, close }: {
    sources: TopicSource[]; existing: TopicSource[]; apply: (items: TopicReference[]) => void; close: () => void;
}) {
    const searchField = useRef<HTMLInputElement>(null);
    const [search, setSearch] = useState('');
    const [kind, setKind] = useState('');
    const [selected, setSelected] = useState<TopicReference[]>([]);
    useLayoutEffect(() => searchField.current?.focus(), []);
    const included = new Set(existing.map(topicKey));
    const selectedKeys = new Set(selected.map(topicKey));
    const visible = sources.filter(source => source.title.toLowerCase().includes(search.trim().toLowerCase())
        && (!kind || source.mediaKind === kind));
    return <>
        <div className="learning-filters" data-own-buffer>
            <label>搜索资料<input ref={searchField} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label>类型<select value={kind} onChange={event => setKind(event.target.value)}>
                <option value="">全部</option><option value="article">图文</option><option value="video">视频</option>
            </select></label>
        </div>
        <p className="muted" role="status">已选 {selected.length} / {topicDefaults.maxBatch}　{selected.length === topicDefaults.maxBatch && '已达到单次选择上限'}</p>
        {visible.length ? <ul className="learning-list">{visible.map(item => {
            const key = topicKey(item);
            const duplicate = included.has(key);
            const checked = duplicate || selectedKeys.has(key);
            return <li key={key}><label className="topic-choice">
                <input type="checkbox" checked={checked} disabled={duplicate || (!checked && selected.length >= topicDefaults.maxBatch)}
                    onChange={() => setSelected(checked ? selected.filter(current => topicKey(current) !== key) : [...selected, topicRef(item)])} />
                <TopicSourceLabel item={item} />
                {duplicate && <small>已在合集中</small>}
            </label></li>;
        })}</ul> : <p>{sources.length ? '没有符合条件的资料。' : '暂没有可收录的资料。'}</p>}
        <div className="learning-actions">
            <button className="secondary" type="button" onClick={close}>取消</button>
            <button type="button" disabled={!selected.length} onClick={() => { close(); apply(selected); }}>添加所选资料</button>
        </div>
    </>;
}

export function TopicOrder({ items, move, remove, disabled }: {
    items: { key: string; label: string; content: ReactNode }[];
    move: (from: number, to: number) => void;
    remove: (index: number) => void;
    disabled?: boolean;
}) {
    const dragged = useRef<string | null>(null);
    const list = useRef<HTMLOListElement>(null);
    return <ol className="learning-list topic-order" aria-label="条目顺序" tabIndex={-1} ref={list}>
        {items.map((item, index) => <li className="learning-row" key={item.key}
            draggable={!disabled && items.length > 1}
            onDragStart={event => { dragged.current = item.key; event.dataTransfer.setData('text/plain', String(index + 1)); }}
            onDragEnd={() => { dragged.current = null; }}
            onDragOver={event => { if (!disabled && dragged.current) event.preventDefault(); }}
            onDrop={event => {
                if (disabled || !dragged.current) return;
                event.preventDefault();
                const from = items.findIndex(row => row.key === dragged.current);
                dragged.current = null;
                if (from >= 0 && from !== index) move(from, index);
            }}>
            <span aria-hidden="true">{index + 1}</span>
            {item.content}
            <div className="learning-actions">
                <button type="button" className="secondary" disabled={disabled || index === 0}
                    aria-label={'上移 ' + item.label} onClick={() => { list.current?.focus(); move(index, index - 1); }}>上移</button>
                <button type="button" className="secondary" disabled={disabled || index === items.length - 1}
                    aria-label={'下移 ' + item.label} onClick={() => { list.current?.focus(); move(index, index + 1); }}>下移</button>
                <button type="button" className="secondary" disabled={disabled}
                    aria-label={'移除 ' + item.label} onClick={() => { list.current?.focus(); remove(index); }}>移除</button>
            </div>
        </li>)}
    </ol>;
}

export function moveTopicRow<T>(items: T[], from: number, to: number) {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function topicAddFeedback({ outcomes }: TopicAddResult) {
    const labels = { added: '已加入合集草稿', duplicate: '已在合集中', unavailable: '来源已不可用', limit: '超出合集容量' };
    return (Object.keys(labels) as (keyof typeof labels)[]).flatMap(status => {
        const count = outcomes.filter(outcome => outcome.status === status).length;
        return count ? [labels[status] + ' ' + count + ' 项'] : [];
    }).join('；') + '。';
}
