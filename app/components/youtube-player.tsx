'use client';

import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Play } from 'lucide-react';
import { parseYouTubeSource } from '../../lib/video-source';
import { createVideoSeek } from '../../lib/client/video-seek';
import { useAccountSession } from './secure-resource';

type PlayerElement = HTMLElement & Pick<HTMLVideoElement, 'currentTime' | 'readyState' | 'duration' | 'seeking' | 'error'>;
type PlayerStatus = { kind: 'neutral' | 'error' | 'success'; text: string };
export type YouTubeControls = { currentTime: () => number | undefined; seekTo: (seconds: number) => void };
type PlayerIsland = {
    mount(slot: HTMLElement, source: string, handlers: Record<'ready' | 'playing' | 'time' | 'error', (element: PlayerElement | null) => void>):
        { readonly element: PlayerElement | null; destroy(): void };
};

let island: Promise<PlayerIsland> | undefined;
let importAttempt = 0;
function loadIsland() {
    if (!island) {
        // Failed ESM fetches are cached by URL. Share one import until it fails.
        const url = '/vendor/kapok-player/player-island.js?attempt=' + importAttempt++;
        island = (import(/* @vite-ignore */ url) as Promise<PlayerIsland>).catch(error => {
            island = undefined;
            throw error;
        });
    }
    return island;
}

type YouTubePlayerProps = {
    url: string | null; initialSeconds?: number; setPlayable: (ready: boolean) => void; ref: Ref<YouTubeControls>;
    waitingIdentity?: ReactNode; waitingTitle?: string; hideExternalLink?: boolean;
};

export function YouTubePlayer({ url, ...props }: YouTubePlayerProps) {
    const source = url ? parseYouTubeSource(url) : null;
    return <YouTubePlayerSession key={source?.url} source={source} {...props} />;
}

function YouTubePlayerSession({ source, initialSeconds, setPlayable, ref, waitingIdentity, waitingTitle, hideExternalLink = false }: Omit<YouTubePlayerProps, 'url'> & {
    source: ReturnType<typeof parseYouTubeSource>;
}) {
    const session = useAccountSession();
    const slot = useRef<HTMLDivElement>(null);
    const active = useRef<{ element: PlayerElement | null; dispose: () => void } | null>(null);
    const pendingTime = useRef<number | undefined>(undefined);
    const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [status, setStatus] = useState<PlayerStatus | null>(null);
    const [seek] = useState(() => createVideoSeek((kind, text) => setStatus({ kind, text })));
    const subscribe = session.subscribe;
    const videoId = source?.videoId;
    // Subscribe on the current boundary. A lock removes the embedded DOM before any
    // pending import or provider callback can act on a later authorized session.
    useLayoutEffect(() => subscribe(() => {
        active.current?.dispose();
        seek.clear();
        pendingTime.current = undefined;
        setPhase('idle');
        setStatus(null);
        setPlayable(false);
    }), [subscribe, seek, setPlayable]);
    useLayoutEffect(() => () => {
        active.current?.dispose();
        seek.clear();
    }, [seek]);
    useImperativeHandle(ref, () => ({
        currentTime: () => {
            const element = active.current?.element;
            const seconds = element && element.readyState >= 1 ? element.currentTime : NaN;
            return Number.isFinite(seconds) ? seconds : undefined;
        },
        seekTo: seconds => {
            if (slot.current?.parentElement?.closest('[hidden]')) return;
            pendingTime.current = seconds;
            const element = active.current?.element;
            if (!videoId || !element) {
                setStatus({ kind: 'neutral', text: '请先载入 YouTube 视频，将保留此次定位。' });
                return;
            }
            seek.request(videoId, seconds, element);
            // The provider emits no seek event when already at the requested time.
            seek.seeked(videoId, element);
        }
    }), [seek, videoId]);

    async function load() {
        const surface = slot.current;
        if (!source || !surface || surface.parentElement?.closest('[hidden]') || active.current) return;
        const { videoId, startSec } = source;
        const requested = pendingTime.current ?? initialSeconds;
        const start = requested !== undefined && Number.isSafeInteger(requested) && requested >= 0 ? requested : startSec;
        const mountNode = document.createElement('div');
        mountNode.className = 'youtube-player-mount';
        surface.appendChild(mountNode);
        let removeSeekListener: (() => void) | undefined;
        let mounted: ReturnType<PlayerIsland['mount']> | undefined;
        const attempt = { element: null as PlayerElement | null, dispose };
        const valid = () => active.current === attempt && mountNode.isConnected && !surface.parentElement?.closest('[hidden]');
        const timeout = setTimeout(() => fail('连接 YouTube 超时，请重试或在原站打开。'), 20_000);
        function dispose() {
            active.current = null;
            clearTimeout(timeout);
            removeSeekListener?.();
            // Detach before calling the provider so a failed destroy cannot leave a frame.
            mountNode.remove();
            try { mounted?.destroy(); } catch { /* The frame and local player state are already gone. */ }
        }
        function fail(text: string) {
            if (!valid()) return;
            dispose();
            seek.clear();
            setPlayable(false);
            setPhase('error');
            setStatus({ kind: 'error', text });
        }
        active.current = attempt;
        setPhase('loading');
        setStatus({ kind: 'neutral', text: '正在连接 YouTube…' });
        try {
            const { mount } = await loadIsland();
            if (!valid()) return;
            mounted = mount(mountNode, `https://www.youtube-nocookie.com/embed/${videoId}?t=${start}s`, {
                ready(element) {
                    if (!valid() || !element) return;
                    clearTimeout(timeout);
                    attempt.element = element;
                    removeSeekListener?.();
                    const onSeeked = () => { if (valid()) seek.seeked(videoId, element); };
                    element.addEventListener('seeked', onSeeked);
                    removeSeekListener = () => element.removeEventListener('seeked', onSeeked);
                    const frame = element.shadowRoot?.querySelector('iframe');
                    if (frame) frame.dataset.kapokPlayer = 'youtube';
                    setPhase('ready');
                    setPlayable(true);
                    setStatus({ kind: 'neutral', text: 'YouTube 播放器已就绪。' });
                    if (pendingTime.current !== undefined && pendingTime.current !== start) {
                        seek.request(videoId, pendingTime.current, element);
                        seek.seeked(videoId, element);
                    }
                },
                playing(element) {
                    if (valid() && element && attempt.element === element) seek.seeked(videoId, element);
                },
                time(element) {
                    if (valid() && element && attempt.element === element) {
                        seek.ready(videoId, element);
                        seek.seeked(videoId, element);
                    }
                },
                error(element) {
                    const code = element?.error?.code;
                    fail(code ? `YouTube 播放失败（${code}），请重试或在原站打开。` : '连接 YouTube 失败，请重试或在原站打开。');
                }
            });
        } catch {
            fail('YouTube 播放器加载失败，请重试或在原站打开。');
        }
    }

    const canLoad = phase === 'idle' || phase === 'error';
    const loadLabel = phase === 'error' ? '重试 YouTube 视频' : '载入 YouTube 视频';
    return <div className="external-video-player">
        <div ref={slot} className="video-player youtube-player-slot" hidden={phase !== 'loading' && phase !== 'ready'} inert={phase !== 'ready'} />
        {source && canLoad && waitingIdentity}
        {source ? (canLoad || !hideExternalLink) && <div className="actions">
            {canLoad && <button type="button" className={waitingIdentity ? 'training-stage-play' : undefined}
                aria-label={waitingTitle === undefined ? undefined : `${loadLabel}：${waitingTitle}`} onClick={() => void load()}>
                {waitingIdentity && <span className="training-stage-play-icon"><Play size={21} aria-hidden="true" /></span>}
                {loadLabel}
            </button>}
            {!hideExternalLink && <a className="button secondary" href={source.url} target="_blank" rel="noopener noreferrer">在 YouTube 打开（新标签）</a>}
        </div> : <p role="alert">YouTube 播放链接暂不可用。</p>}
        {status && <p className={`notice ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p>}
    </div>;
}
