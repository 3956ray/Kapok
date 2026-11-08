'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight, Play, Plus } from 'lucide-react';
import type { BootstrapStatus } from '../../lib/contracts';
import type { Training, Video } from '../../lib/contracts/training';
import type { UploadPage } from '../../lib/contracts/media';
import { api, ApiError } from '../../lib/client/api';
import { navigationBuffer } from '../../lib/client/navigation-state';
import { AccountBoundary } from './secure-resource';
import { AddVideoDialog, TrainingForm, UploadCleanup, VideoEditForm } from './training-forms';

const statusText: Record<string, string> = { draft: '草稿', published: '已发布', archived: '已归档', hidden: '已隐藏' };
const basePath = '/admin/trainings';
type TrainingDetail = Training & { videos: Video[] };
type ManagementProps = { actorId: string } & (
    { mode: 'list' | 'new'; id?: never } | { mode: 'detail' | 'edit'; id: string }
);

export function TrainingAdminBar({ title, back }: { title: string; back: string }) {
    return <div className="training-admin-bar">
        <Link href={back} aria-label="返回"><ChevronLeft size={18} aria-hidden="true" /></Link>
        <span>{title}</span>
    </div>;
}

export function TrainingManagement({ actorId, mode, id }: ManagementProps) {
    const load = useCallback(async ({ me }: BootstrapStatus, signal: AbortSignal) => {
        if (me.user?.status !== 'active' || me.membership?.status !== 'active' || me.membership.role !== 'admin') {
            throw new ApiError({ error: { code: 'FORBIDDEN', message: '此页面仅管理员可访问。', retryable: false }, requestId: '' });
        }
        if (mode === 'list') return { mode, items: await api<Training[]>('trainings', undefined, actorId, signal) };
        if (mode === 'new') return { mode };
        const training = await api<TrainingDetail>('trainings/' + encodeURIComponent(id!), undefined, actorId, signal);
        if (mode === 'edit') return { mode, training };
        return { mode, training, uploads: await api<UploadPage>('uploads', undefined, actorId, signal) };
    }, [actorId, mode, id]);

    return <div className="training-workspace">
        <AccountBoundary key={mode + ':' + (id ?? '')} actorId={actorId} load={load}>{data => {
            if (data.mode === 'list') return <TrainingManagementList items={data.items} />;
            if (data.mode === 'detail') return <ManagedTraining actorId={actorId} training={data.training} uploads={data.uploads} />;
            return <>
                <p className="workspace-overline">TRAINING DETAILS</p>
                <h1>{data.mode === 'new' ? '新建训练' : '编辑训练'}</h1>
                <p className="training-subheading">{data.mode === 'new' ? '填写训练信息，准备好就可以发布。' : '更新队员看到的训练信息。'}</p>
                <TrainingForm actorId={actorId} training={data.mode === 'edit' ? data.training : undefined} />
            </>;
        }}</AccountBoundary>
    </div>;
}

function TrainingManagementList({ items }: { items: Training[] }) {
    return <>
        <div className="training-heading">
            <div>
                <span className="status-label">管理员</span>
                <h1>训练管理</h1>
                <p className="training-subheading">新建训练，或管理已发布的训练和视频。</p>
            </div>
            <Link className="button" href={basePath + '/new'}><Plus size={17} aria-hidden="true" />新建训练</Link>
        </div>
        <section className="section" aria-labelledby="all-trainings">
            <h2 id="all-trainings">全部训练</h2>
            <div className="panel training-surface training-admin-list">
                {items.length ? items.map(t => <Link className="row-link" key={t.id} href={basePath + '/' + t.id}>
                    <span className="detail-tile"><CalendarDays size={18} aria-hidden="true" /></span>
                    <span><strong>{t.title}</strong><small><time dateTime={t.date}>{t.date}</time> · {statusText[t.status]}</small></span>
                    <ChevronRight size={17} aria-hidden="true" />
                </Link>) : <p>还没有训练。新建后可在这里管理。</p>}
            </div>
        </section>
        <Link className="training-inline" href="/trainings">返回训练记录 <ChevronRight size={16} aria-hidden="true" /></Link>
    </>;
}

function ManagedTraining({ actorId, training, uploads }: { actorId: string; training: TrainingDetail; uploads: UploadPage }) {
    const heading = useRef<HTMLHeadingElement>(null);
    const path = basePath + '/' + training.id;
    const [justPublished] = useState(() => navigationBuffer(actorId, path, 'training-published').read<boolean>() === true);
    useEffect(() => {
        if (!justPublished) return;
        navigationBuffer(actorId, path, 'training-published').clear();
        heading.current?.focus({ preventScroll: true });
    }, [actorId, path, justPublished]);
    const visibleToMembers = ['published', 'archived'].includes(training.status);
    const writable = ['draft', 'published'].includes(training.status);
    const videos = training.videos;
    return <>
        <p className="workspace-overline">TRAINING MANAGEMENT</p>
        <div className="training-heading">
            <div>
                <span className="status-label">{statusText[training.status]}</span>
                <h1 ref={heading} id="managed-training-title" tabIndex={-1}>{training.title}</h1>
                <p className="training-subheading"><time dateTime={training.date}>{training.date}</time> · {visibleToMembers ? '队员可查看' : '仅管理员可查看'}</p>
            </div>
        </div>
        {justPublished && training.status === 'published' && <p className="notice success" role="status">训练已发布 · 全队可见</p>}
        <section className="panel training-surface">
            <div className="section-heading"><h2>训练信息</h2><Link href={path + '/edit'}>编辑信息</Link></div>
            <p className="preserve">{training.description || '暂无训练简介。'}</p>
        </section>
        {writable ? <AddVideoDialog actorId={actorId} trainingId={training.id}
            nextPosition={Math.min(10000, Math.max(-1, ...videos.map(v => v.position)) + 1)}
            memberVisible={training.status === 'published'} /> : <div className="section-heading"><h2>训练视频</h2></div>}
        <div className="panel training-surface">
            {videos.length ? <ol className="training-video-order">{videos.map(v => <li key={v.id}>
                <div className="training-video-summary">
                    <span className="detail-tile"><Play size={18} aria-hidden="true" /></span>
                    <div>
                        {v.status === 'active' ? <h3><Link href={'/videos/' + v.id}>{v.title}</Link></h3> : <h3>{v.title}</h3>}
                        <small>{v.source === 'upload' ? '私有短片' : 'B站'} · 排序 {v.position}{v.status === 'hidden' && ' · 已隐藏'}</small>
                    </div>
                </div>
                {writable && <details><summary>管理顺序与视频</summary><VideoEditForm actorId={actorId} video={v} /></details>}
            </li>)}</ol> : <div className="training-empty">
                <span className="detail-tile"><Play size={18} aria-hidden="true" /></span>
                <h3>还没有训练视频</h3>
                {writable && <p>随时可以补加 B 站视频。</p>}
            </div>}
            {training.status === 'archived' && <p className="muted">训练已归档，可回看历史视频。</p>}
        </div>
        <div className="training-actions">
            {visibleToMembers && <Link className="button" href={'/trainings/' + training.id + '?view=member'}>查看队员页面 <ChevronRight size={17} aria-hidden="true" /></Link>}
            <Link className="button secondary" href={basePath}>返回管理列表</Link>
        </div>
        <UploadCleanup actorId={actorId} initial={uploads} />
    </>;
}
