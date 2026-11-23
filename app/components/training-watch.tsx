'use client';
import { TextLinks } from './learning-text';
import { ReflectionIcon } from './reflection-icon';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { BootstrapStatus } from '../../lib/contracts';
import type { Training, Video } from '../../lib/contracts/training';
import { api, ApiError } from '../../lib/client/api';
import { clearNavigationRoute, clearTrainingVideoUI, navigationBuffer, transferNavigationSource } from '../../lib/client/navigation-state';
import { AccountBoundary, supportsPageReads, useAccountSession } from './secure-resource';
import { VideoDiscussion, useVideoViewport } from './video-discussion';

type WatchProps = {
    actorId: string;
    memberView?: boolean;
    environmentNote?: ReactNode;
} & ({ trainingId: string; selectedVideoId?: string; legacyVideoId?: never; initialSeconds?: never } |
    { legacyVideoId: string; initialSeconds?: number; trainingId?: never; selectedVideoId?: never });

type WatchData = { training: Training; videos: Video[]; admin: boolean };
const unavailable = () => new ApiError({ error: { code: 'NOT_FOUND', message: '本次训练当前不可用。', retryable: false }, requestId: '' });
const accessError = (error: unknown) => error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code);

export function TrainingWatch(props: WatchProps) {
    const { actorId, trainingId, legacyVideoId, memberView } = props;
    return <TrainingWatchResource key={JSON.stringify([actorId, trainingId, legacyVideoId, memberView ?? false])} {...props} />;
}

function TrainingWatchResource(props: WatchProps) {
    const { actorId, trainingId, legacyVideoId, memberView } = props;
    const boundary = useRef<HTMLDivElement>(null);
    const locatedTraining = useRef(trainingId);
    useVideoViewport(boundary);
    const load = useCallback(async (account: BootstrapStatus, signal: AbortSignal): Promise<WatchData> => {
        const membership = account.me.membership;
        const admin = membership?.role === 'admin';
        if (membership?.status !== 'active' || (memberView && !admin)) throw unavailable();
        try {
            const resolved = locatedTraining.current ?? (await api<Video>('videos/' + encodeURIComponent(legacyVideoId!), undefined, actorId, signal)).trainingId;
            const { videos: returnedVideos, ...training } = await api<Training & { videos: Video[] }>('trainings/' + encodeURIComponent(resolved) + (admin ? '?view=member' : ''), undefined, actorId, signal);
            if (!['published', 'archived'].includes(training.status)) throw unavailable();
            const videos = returnedVideos.filter(video => video.status === 'active' && video.trainingId === training.id);
            if (!locatedTraining.current && !videos.some(video => video.id === legacyVideoId)) throw unavailable();
            locatedTraining.current = resolved;
            return { training, videos, admin };
        } catch (error) {
            if (accessError(error)) {
                if (locatedTraining.current && legacyVideoId) clearNavigationRoute(actorId, '/trainings/' + locatedTraining.current);
                throw unavailable();
            }
            throw error;
        }
    }, [actorId, legacyVideoId, memberView]);

    const read = useMemo(() => ({ confirmedPath: 'watch/' + encodeURIComponent(trainingId ?? '') + (memberView ? '?view=member' : '') }), [trainingId, memberView]);
    return <div className="video-discussion-boundary training-watch" ref={boundary}>
        <AccountBoundary<WatchData> actorId={actorId} load={trainingId && supportsPageReads() ? read : load}>{data =>
            <WatchContent key={data.training.id} {...props} {...data} />
        }</AccountBoundary>
    </div>;
}

function WatchContent({ actorId, legacyVideoId, selectedVideoId, initialSeconds, memberView, environmentNote, training, videos, admin }: WatchProps & WatchData) {
    const session = useAccountSession();
    const verify = session.verify;
    const [choice, setChoice] = useState<string>();
    const requested = choice ?? selectedVideoId ?? legacyVideoId;
    const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set());
    const readable = videos.filter(video => !rejected.has(video.id));
    const selected = readable.find(video => video.id === requested) ?? readable[0];
    const selectedId = selected?.id;
    const [stage, setStage] = useState<HTMLDivElement | null>(null);
    const [note, setNote] = useState<HTMLDivElement | null>(null);
    const [providerLink, setProviderLink] = useState<HTMLSpanElement | null>(null);
    const [noteTrigger, setNoteTrigger] = useState<HTMLSpanElement | null>(null);
    const [dock, setDock] = useState<HTMLDivElement | null>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const reflection = useRef<HTMLAnchorElement>(null);
    const path = '/trainings/' + encodeURIComponent(training.id);
    const watchPosition = useMemo(() => navigationBuffer(actorId, path, 'watch-position'), [actorId, path]);
    const previous = useRef(videos);
    useLayoutEffect(() => {
        for (const video of previous.current) {
            if (!videos.some(current => current.id === video.id)) clearTrainingVideoUI(actorId, training.id, video.id);
        }
        previous.current = videos;
    }, [actorId, training.id, videos]);
    const onUnavailable = useCallback((id: string, scope: 'video' | 'training') => {
        clearTrainingVideoUI(actorId, training.id, id);
        setRejected(current => new Set([...current, id]));
        void verify(scope === 'training' ? '正在确认本次训练是否可访问…' : '正在确认当前可观看的视频…');
    }, [actorId, training.id, verify]);

    const fromLegacy = !choice && legacyVideoId !== undefined && legacyVideoId === selectedId;
    useLayoutEffect(() => {
        if (fromLegacy) return;
        const url = new URL(window.location.href);
        if (url.pathname !== path && url.pathname !== '/videos/' + legacyVideoId) return;
        const query = new URLSearchParams();
        if (memberView) query.set('view', 'member');
        if (selectedId) query.set('video', selectedId);
        const href = path + (query.size ? '?' + query.toString() : '');
        if (href === url.pathname + url.search + url.hash) return;
        if (path !== url.pathname) transferNavigationSource(actorId, path);
        window.history.replaceState(window.history.state, '', href);
    }, [actorId, path, selectedId, memberView, fromLegacy, legacyVideoId]);

    function rememberReflection() {
        watchPosition.write({ top: scroll.current?.scrollTop ?? 0 });
    }
    const [initialPosition] = useState(() => watchPosition.read<{ top: number }>());
    const savedPosition = useRef(initialPosition);
    const restorePosition = useCallback(() => {
        const saved = savedPosition.current;
        if (!saved || !scroll.current || !reflection.current || reflection.current.closest('[hidden]')) return;
        scroll.current.scrollTop = saved.top;
        reflection.current.focus({ preventScroll: true });
        watchPosition.clear();
        savedPosition.current = null;
    }, [watchPosition]);
    useLayoutEffect(() => {
        if (!selectedId) restorePosition();
    }, [selectedId, restorePosition]);

    const slots = useMemo(() => stage && note && providerLink && noteTrigger && dock
        ? { stage, note, providerLink, noteTrigger, dock, isLegacyVideo: fromLegacy }
        : undefined, [stage, note, providerLink, noteTrigger, dock, fromLegacy]);
    return <div className="video-discussion-layout training-watch-layout">
        <div ref={scroll} className="video-discussion-scroll" role="region" aria-label="训练观看与讨论" tabIndex={0}>
            <div className="video-content">
                {memberView && <p className="notice training-preview-banner"><strong>队员视角预览</strong></p>}
                {selected && <div className="training-watch-stage"><div ref={setStage} hidden /></div>}
                {readable.length > 1 && <VideoRail videos={readable} selectedId={selectedId!} onSelect={setChoice} />}
                <section className="training-watch-info" aria-labelledby="training-watch-title">
                    <div className="training-watch-title">
                        <div>
                            <h2 id="training-watch-title">{training.title}</h2>
                            <time dateTime={training.date}>{training.date}</time>
                        </div>
                        <div className="training-title-actions">
                            {selected && <>
                                <span ref={setProviderLink} className="training-title-provider" hidden />
                                <span ref={setNoteTrigger} hidden />
                            </>}
                            <ReflectionLink linkRef={reflection} trainingId={training.id} videoId={selectedId} onClick={rememberReflection} />
                        </div>
                    </div>
                    {training.description && <p className="preserve"><TextLinks text={training.description}/></p>}
                    {selected && <div ref={setNote} hidden />}
                    {training.status === 'archived' && <p className="notice">已归档。历史视频与讨论仍可回看，不能新增视频或讨论。</p>}
                    {requested && requested !== selectedId && <p className="notice" role="status">所选视频当前不可用。{selected ? '已切换到可观看的视频。' : ''}</p>}
                    {admin && !memberView && <Link className="training-inline" href={'/admin/trainings/' + encodeURIComponent(training.id)}>管理本次训练 <ChevronRight size={16} aria-hidden="true" /></Link>}
                </section>
                {selected ? slots && <VideoDiscussion key={selectedId} actorId={actorId} videoId={selected.id} trainingId={training.id}
                    memberView={memberView} slots={slots} initialSeconds={fromLegacy ? initialSeconds : undefined}
                    environmentNote={environmentNote} onUnavailable={onUnavailable} onReady={restorePosition} /> :
                    <p className="notice">本次训练暂无视频。</p>}
            </div>
        </div>
        <div className="video-discussion-dock" ref={setDock} hidden />
    </div>;
}

function ReflectionLink({ linkRef, trainingId, videoId, onClick }: { linkRef: React.RefObject<HTMLAnchorElement | null>; trainingId: string; videoId?: string; onClick: () => void }) {
    const query = new URLSearchParams({ training: trainingId });
    if (videoId) query.set('video', videoId);
    return <Link ref={linkRef} className="video-reflection-link training-title-action" href={'/reflections/new?' + query.toString()} onClick={onClick} aria-label="想和写" title="想和写"><ReflectionIcon size={18} aria-hidden="true" /></Link>;
}

function VideoRail({ videos, selectedId, onSelect }: { videos: Video[]; selectedId: string; onSelect: (id: string) => void }) {
    const railId = useId();
    const track = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ left: false, right: false });
    const measure = useCallback(() => {
        const node = track.current;
        if (!node) return;
        const left = node.scrollLeft > 2;
        const right = node.scrollWidth - node.clientWidth - node.scrollLeft > 2;
        setEdges(current => current.left === left && current.right === right ? current : { left, right });
    }, []);
    useLayoutEffect(() => {
        const node = track.current;
        const card = node?.querySelector('[aria-pressed="true"]');
        if (node && card) {
            const box = card.getBoundingClientRect();
            const frame = node.getBoundingClientRect();
            if (box.left < frame.left + 4) node.scrollLeft += box.left - frame.left - 4;
            else if (box.right > frame.right - 4) node.scrollLeft += box.right - frame.right + 4;
        }
        measure();
    }, [selectedId, videos.length, measure]);
    useEffect(() => {
        if (!track.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(track.current);
        return () => observer.disconnect();
    }, [measure]);

    function move(direction: number) {
        const node = track.current;
        if (!node) return;
        const first = node.firstElementChild;
        if (!first) return;
        node.scrollBy({ left: direction * (first.getBoundingClientRect().width + 10), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    const index = videos.findIndex(video => video.id === selectedId);
    return <section className="training-rail" aria-label="本次训练视频">
        <header>
            <h3>本次训练视频</h3>
            <div className="training-rail-controls">
                <span role="status" aria-atomic="true"><span className="sr-only">当前视频 {videos[index]?.title}，第 {index + 1} 个，共 {videos.length} 个</span><span aria-hidden="true">当前 {String(index + 1).padStart(2, '0')} / {String(videos.length).padStart(2, '0')}</span></span>
                {(edges.left || edges.right) && <>
                    <button type="button" aria-label="向左滚动视频" aria-controls={railId} disabled={!edges.left} onClick={() => move(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
                    <button type="button" aria-label="向右滚动视频" aria-controls={railId} disabled={!edges.right} onClick={() => move(1)}><ChevronRight size={18} aria-hidden="true" /></button>
                </>}
            </div>
        </header>
        <div ref={track} id={railId} className="training-rail-track" role="group" aria-label="训练视频列表" onScroll={measure}>
            {videos.map((video, position) => {
                const selected = video.id === selectedId;
                return <button type="button" key={video.id} aria-pressed={selected} aria-label={`${position + 1}. ${video.title}`} title={video.title}
                    onClick={() => { if (!selected) onSelect(video.id); }}>
                    <span className="training-rail-index" aria-hidden="true">{String(position + 1).padStart(2, '0')}</span>
                    <span className="training-rail-card-title">{video.title}</span>
                </button>;
            })}
        </div>
    </section>;
}
