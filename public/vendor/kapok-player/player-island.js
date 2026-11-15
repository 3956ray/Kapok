// Copyright 2026 Kapok contributors. See NOTICE.txt.
// Kapok adapter for the official YouTube IFrame Player API.
const apiURL = 'https://www.youtube.com/iframe_api';
const pollInterval = 200;
let apiRequest;

function loadAPI() {
    if (apiRequest) return apiRequest;
    if (window.YT?.Player) return Promise.resolve(window.YT);

    const script = document.createElement('script');
    script.src = apiURL;
    script.async = true;
    const previous = window.onYouTubeIframeAPIReady;

    apiRequest = new Promise((resolve, reject) => {
        function finish(api) {
            clearTimeout(timeout);
            script.removeEventListener('error', failed);
            if (window.onYouTubeIframeAPIReady === ready) {
                if (previous === undefined) delete window.onYouTubeIframeAPIReady;
                else window.onYouTubeIframeAPIReady = previous;
            }
            if (api) {
                resolve(api);
            } else {
                apiRequest = undefined;
                script.remove();
                reject(new Error('YouTube IFrame API unavailable'));
            }
        }
        function ready() {
            if (window.YT?.Player) finish(window.YT);
            previous?.call(window);
        }
        function failed() { finish(); }
        const timeout = setTimeout(failed, 12_000);
        window.onYouTubeIframeAPIReady = ready;
        script.addEventListener('error', failed, { once: true });
        document.head.append(script);
    });
    return apiRequest;
}

export function mount(slot, source, handlers) {
    const embed = new URL(source);
    if (embed.origin !== 'https://www.youtube-nocookie.com' || !/^\/embed\/[\w-]{11}$/.test(embed.pathname)) {
        throw new Error('Invalid YouTube embed URL');
    }
    const start = /^(\d+)s$/.exec(embed.searchParams.get('t') ?? '')?.[1] ?? '0';
    embed.search = new URLSearchParams({
        enablejsapi: '1',
        origin: window.location.origin,
        playsinline: '1',
        start,
    }).toString();
    embed.hash = '';

    const element = document.createElement('youtube-video');
    const shadow = element.attachShadow({ mode: 'open' });
    element.style.width = '100%';
    element.style.height = '100%';
    const frame = document.createElement('iframe');
    frame.title = 'YouTube 播放器';
    frame.dataset.kapokPlayer = 'youtube';
    frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    frame.allowFullscreen = true;
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0';

    let player;
    let callbacks = handlers;
    let polling;
    let disposed = false;
    let ready = false;
    let error = null;
    let target = null;
    let pauseAfterSeek = false;
    const live = () => !disposed && element.isConnected;

    // The IFrame API reports transport readiness before duration can be read.
    const duration = () => {
        const value = ready ? player.getDuration() : 0;
        return Number.isFinite(value) && value > 0 ? value : NaN;
    };
    Object.defineProperties(element, {
        duration: { get: duration },
        readyState: { get: () => Number.isFinite(duration()) ? 1 : 0 },
        currentTime: {
            get: () => ready ? player.getCurrentTime() : NaN,
            set: seconds => {
                if (!ready || !live() || (target === null && Math.abs(player.getCurrentTime() - seconds) <= 0.5)) return;
                const state = player.getPlayerState();
                target = seconds;
                // seekTo preserves paused playback; cued and ended players can start.
                pauseAfterSeek = state === -1 || state === 0 || state === 5;
                player.seekTo(seconds, true);
            },
        },
        seeking: { get: () => target !== null },
        error: { get: () => error },
    });

    function update() {
        if (!live() || !ready) return;
        const state = player.getPlayerState();
        const time = player.getCurrentTime();
        if (target !== null && state !== 3 && Number.isFinite(time) && Math.abs(time - target) <= 0.5) {
            target = null;
            if (pauseAfterSeek && state === 1) player.pauseVideo();
            pauseAfterSeek = false;
            element.dispatchEvent(new Event('seeked'));
        }
        callbacks?.time(element);
    }
    function fail(code) {
        if (!live()) return;
        if (Number.isInteger(code)) error = { code };
        callbacks?.error(element);
    }
    const frameError = () => fail();
    frame.addEventListener('error', frameError);
    slot.append(element);

    void loadAPI().then(api => {
        if (!live()) return;
        frame.src = embed.href;
        shadow.append(frame);
        const created = new api.Player(frame, {
            events: {
                onReady({ target: connectedPlayer }) {
                    if (!live() || ready) return;
                    player = connectedPlayer;
                    ready = true;
                    polling = setInterval(update, pollInterval);
                    callbacks?.ready(element);
                },
                onStateChange({ data }) {
                    update();
                    if (data === 1 && live() && ready) callbacks?.playing(element);
                },
                onError({ data }) { fail(data); },
            },
        });
        if (!disposed) player = created;
        else if (player !== created) created.destroy();
    }).catch(() => fail());

    return {
        get element() { return disposed ? null : element; },
        destroy() {
            if (disposed) return;
            disposed = true;
            ready = false;
            target = null;
            callbacks = null;
            clearInterval(polling);
            frame.removeEventListener('error', frameError);
            try { player?.destroy(); }
            finally { element.remove(); }
        },
    };
}
