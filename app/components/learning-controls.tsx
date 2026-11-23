'use client';

import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Play } from 'lucide-react';
import { WatchMediaIdentity } from './video-discussion';
import { useAccountSession } from './secure-resource';
import type { BootstrapStatus } from '../../lib/contracts';
import type { LearningImage, LearningVideo } from '../../lib/contracts/learning';
import { bilibiliPlayerUrl } from '../../lib/client/bilibili';
import { parseYouTubeSource } from '../../lib/video-source';
import { YouTubePlayer, type YouTubeControls } from './youtube-player';

export function learningEpoch(account: BootstrapStatus) {
    const member = account.me.membership;
    return JSON.stringify([account.me.user?.id, member?.teamId, member?.epoch]);
}

export function useLearningAction(onLock?: (ended: boolean) => void) {
    const session = useAccountSession();
    const active = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false);
    useLayoutEffect(() => session.subscribe(ended => {
        active.current?.abort();
        active.current = null;
        setBusy(false);
        onLock?.(ended);
    }), [session, onLock]);
    useLayoutEffect(() => () => { active.current?.abort(); active.current = null; }, []);

    async function run(work: (signal: AbortSignal, current: () => boolean) => Promise<void>, failed: (error: unknown) => void) {
        if (active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        let token: number | null = null;
        const current = () => active.current === controller && !controller.signal.aborted && token !== null && session.isCurrent(token);
        try {
            token = await session.authorize();
            if (current()) await work(controller.signal, current);
        } catch (error) {
            if (current() || (!controller.signal.aborted && token === null)) failed(error);
        } finally {
            if (active.current === controller) {
                active.current = null;
                setBusy(false);
            }
        }
    }
    return { busy, run, session };
}

// The existing in-page confirmation pattern shares the production dialog styling.
export function LearningConfirm({ label, title, confirm, children, onConfirm, disabled, icon, compact }: {
    label: string; title: string; confirm: string; children: ReactNode; onConfirm: () => void; disabled?: boolean; icon?: ReactNode; compact?: boolean;
}) {
    const id = useId();
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const session = useAccountSession();
    useLayoutEffect(() => session.subscribe(() => dialog.current?.close()), [session]);
    return <>
        <button ref={trigger} className={compact ? "secondary content-action content-action-warning" : "secondary"} type="button" aria-haspopup="dialog" disabled={disabled}
            onClick={() => dialog.current?.showModal()}>{icon}{label}</button>
        <dialog ref={dialog} className="add-video-dialog" aria-labelledby={id} onClose={() => {
            if (!trigger.current?.closest('[hidden]')) trigger.current?.focus();
        }}>
            <h2 id={id}>{title}</h2>
            <div>{children}</div>
            <div className="learning-actions">
                <button className="secondary" type="button" autoFocus onClick={() => dialog.current?.close()}>取消</button>
                <button type="button" disabled={disabled} onClick={() => {
                    dialog.current?.close();
                    onConfirm();
                }}>{confirm}</button>
            </div>
        </dialog>
    </>;
}

const ignorePlayable = () => {};
export function LearningMedia({ video, title, player, watch = false }: { video: LearningVideo; title: string; player?: Ref<YouTubeControls>; watch?: boolean }) {
    const account = useAccountSession();
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(false);
    const frame = useRef<HTMLIFrameElement>(null);
    useLayoutEffect(() => account.subscribe(() => {
        frame.current?.removeAttribute('src');
        setLoaded(false);
        setError(false);
    }), [account]);
    if (video.source === 'upload') return <video controls playsInline preload="metadata" src={video.url} aria-label={title} />;
    const embed = video.source === 'bilibili' ? bilibiliPlayerUrl(video.url) : null;
    const waitingIdentity = watch ? <WatchMediaIdentity source={video.source} title={title} /> : undefined;
    if (video.source === 'youtube') return parseYouTubeSource(video.url)
        ? <YouTubePlayer url={video.url} waitingTitle={title} waitingIdentity={waitingIdentity} hideExternalLink={watch} setPlayable={ignorePlayable} ref={player ?? null} />
        : <p className="muted">保存时确认 YouTube 来源，之后可载入播放器。</p>;
    const loadLabel = error ? '重新载入 B 站视频' : '载入 B 站视频';
    return <div className={watch ? 'external-video-player' : 'learning-media'}>
        {loaded && embed ? <iframe ref={frame} data-kapok-player="bilibili" className={watch ? "video-player bilibili-player" : undefined} title={title + ' · B 站播放器'} src={embed} allowFullScreen
            referrerPolicy="no-referrer" allow="fullscreen; picture-in-picture; encrypted-media"
            onError={() => { if (!frame.current?.closest('[hidden]')) { setLoaded(false); setError(true); } }} />
            : embed ? <>
                {waitingIdentity}
                <button type="button" className={watch ? 'training-stage-play' : 'secondary'}
                    aria-label={watch ? `${loadLabel}：${title}` : undefined} onClick={() => setLoaded(true)}>
                    {watch && <span className="training-stage-play-icon"><Play size={21} aria-hidden="true" /></span>}
                    {loadLabel}
                </button>
            </>
            : <p className="muted">保存时确认 B 站来源，之后可载入播放器。</p>}
        {embed && !watch && <a href={video.url} target="_blank" rel="noreferrer">在 B 站打开</a>}
    </div>;
}

export function LearningImageView({ image, cover = false }: { image: LearningImage; cover?: boolean }) {
    // Serve exactly the authorized private href. Framework image optimization would proxy/copy the bytes.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image.href} width={image.width} height={image.height} alt={cover || image.decorative ? '' : image.alt} loading="lazy" />;
}

export function LearningLocalImage({ file, alt }: { file: File; alt: string }) {
    const element = useRef<HTMLImageElement>(null);
    const account = useAccountSession();
    useLayoutEffect(() => {
        const node = element.current;
        let href = '';
        const revoke = () => {
            if (!href) return;
            node?.removeAttribute('src');
            URL.revokeObjectURL(href);
            href = '';
        };
        if (node && !node.closest('[hidden]')) {
            href = URL.createObjectURL(file);
            node.src = href;
        }
        // Keep selected bytes for recovery, but release their preview on every lock.
        const unsubscribe = account.subscribe(revoke);
        return () => { revoke(); unsubscribe(); };
    }, [account, file]);
    // eslint-disable-next-line @next/next/no-img-element
    return <img ref={element} alt={alt} />;
}
