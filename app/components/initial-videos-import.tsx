'use client';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/client/api';
import type { Me, BootstrapStatus } from '../../lib/contracts';
import { AccountBoundary, useAccountSession } from './secure-resource';
import { importTransport } from '../../lib/client/initial-videos-import';
import { draftKey } from '../../lib/client/session-guard';
import { prepareBatch, runImport } from '../../lib/import/initial-videos.mjs';
import manifest from '../../lib/import/initial-batch.json' with { type: 'json' };

const plan = prepareBatch(manifest, 'initial_batch');
type Ledger = Parameters<typeof runImport>[0]['ledger'];
export function InitialVideosImport({ actorId }: { actorId: string }) {
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal) => {
        if (account.me.membership?.role !== 'admin') throw new Error('仅管理员可使用。');
        return { ...account, me: await api<Me>('me', undefined, actorId, signal) };
    }, [actorId]);
    return <AccountBoundary actorId={actorId} load={load}>{account => <ImportForm actorId={actorId} account={account} />}</AccountBoundary>;
}
function ImportForm({ actorId, account }: { actorId: string; account: BootstrapStatus }) {
    const session = useAccountSession();
    const sessionRef = useRef(session);
    useLayoutEffect(() => { sessionRef.current = session; });
    const [ledger, setLedger] = useState<Ledger>();
    const [report, setReport] = useState<Awaited<ReturnType<typeof runImport>>>();
    const [approved, setApproved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const controller = useRef<AbortController | null>(null);
    const storageKey = draftKey(actorId, 'initial-videos-ledger-v1');
    useEffect(() => sessionRef.current.subscribe(ended => {
        controller.current?.abort(); setApproved(false); setReport(undefined);
        if (ended) { setLedger(undefined); localStorage.removeItem(storageKey); }
    }), [storageKey]);
    useEffect(() => () => controller.current?.abort(), []);
    async function execute(mode: 'reconcile' | 'apply') {
        if (busy) return;
        setBusy(true); setError('');
        try {
            const token = await session.authorize();
            const current = () => sessionRef.current.isCurrent(token);
            const abort = new AbortController(); controller.current = abort;
            const saved = ledger ?? JSON.parse(localStorage.getItem(storageKey) ?? 'null');
            await runImport({ mode, plan, ledger: saved, approval: mode === 'apply' && approved ? report?.approval : undefined,
                api: importTransport(actorId, abort.signal, current),
                save: async (value: Ledger) => {
                    if (!current()) throw new Error('账号确认已失效。');
                    const serialized = JSON.stringify(value);
                    localStorage.setItem(storageKey, serialized);
                    if (localStorage.getItem(storageKey) !== serialized) throw new Error('无法持久保存账本，已停止。');
                    setLedger(structuredClone(value));
                },
            }).then(value => { if (current()) { setReport(value); setApproved(false); } });
        } catch (e) { if (!controller.current?.signal.aborted) setError(e instanceof Error ? e.message : '已停止，请保留账本。'); }
        finally { setBusy(false); }
    }
    async function restore(file?: File) {
        setError(''); setApproved(false); setReport(undefined);
        try {
            const token = await session.authorize();
            if (!file || file.size > 200000) throw new Error('请选择小于 200KB 的导出账本。');
            const parsed = JSON.parse(await file.text());
            if (!sessionRef.current.isCurrent(token)) return;
            // Never persist an unvalidated file. Reconciliation validates binding, plan and receipts.
            setLedger(parsed);
        } catch (e) { setError(e instanceof Error ? e.message : '无法读取账本。'); }
    }
    function exportLedger() {
        const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'kapok-initial-batch-ledger.json'; anchor.click(); URL.revokeObjectURL(url);
    }
    return <section className="training-workspace" data-own-buffer>
        <h1>首批 4 条视频导入</h1>
        <p>当前发布者：{account.me.profile?.discName ?? '未填写盘名'}（{account.me.user?.id}）。请由 Leader 核对这是否为指定真实管理员。</p>
        <p>另 4 条日期未确认，不在本批。以下视频标题为临时标签；新建训练使用可编辑的日期标题。现有标题与排序不会被覆盖。</p>
        <ul>{plan.rows.map((row: { bvid: string; eventDate: string; video: { title: string } }) => <li key={row.bvid}>{row.eventDate} · {row.video.title}（临时标题）· {row.bvid}</li>)}</ul>
        <label>恢复导出账本<input type="file" accept="application/json" disabled={busy} onChange={e => void restore(e.target.files?.[0])} /></label>
        <button disabled={busy} onClick={() => void execute('reconcile')}>核对账号、日期与冲突 / 恢复重跑</button>
        {error && <p role="alert">{error}</p>}
        {report && <><h2>精确执行预览</h2><p>审批包含以下具体操作和目标训练 ID。归属变化时请重新核对并确认，原审批不会自动转用于新的归属。</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ binding: ledger?.frozen?.binding, plan: ledger?.frozen?.plan, ...report }, null, 2)}</pre>
            <label><input type="checkbox" checked={approved} disabled={busy || report.blockers.length > 0} onChange={e => setApproved(e.target.checked)} />我已核对当前发布者、四条日期、临时标题和以上精确计划及审批哈希</label>
            <button disabled={busy || !approved || report.blockers.length > 0} onClick={() => void execute('apply')}>按已核对账本执行</button></>}
        {ledger && <><button disabled={busy} onClick={exportLedger}>导出账本与回执</button><p>操作前先导出；发生网络中断后重新核对同一本账本。退出账号会清除此账号的本机账本，导出文件可用于恢复。</p></>}
        <Link href="/admin/trainings">返回训练管理</Link>
    </section>;
}
