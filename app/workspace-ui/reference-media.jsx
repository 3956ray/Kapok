import { useCallback, useEffect, useRef, useState } from 'react';

import { useData } from './store';

export function useReferenceMedia(media, source, nativeDuration, reloadNative) {
  const { ctx } = useData();
  const [request, setRequest] = useState(null);
  const [result, setResult] = useState(null);
  const attempt = request?.media === media ? request.attempt : 0;
  const measured = result?.media === media ? result : null;
  const duration = source ? measured?.duration || 0 : nativeDuration;
  const report = useCallback((seconds) => {
    if (Number.isFinite(seconds) && seconds > 0) setResult((old) =>
      old?.media === media && old.duration === seconds ? old : { media, duration: seconds });
  }, [media]);
  const failed = useCallback(() => setResult((old) =>
    old?.media === media && old.duration ? old : { media, failed: true }), [media]);

  useEffect(() => {
    if (!attempt || duration > 0) return;
    const controller = new AbortController();
    const timeout = setTimeout(failed, 9500);
    if (source?.platform === 'B 站') {
      ctx.read('media/bilibili-duration?url=' + encodeURIComponent(media), controller.signal)
        .then((data) => {
          if (!Number.isFinite(data.duration) || data.duration <= 0) throw new Error();
          if (!controller.signal.aborted) report(data.duration);
        }).catch(() => { if (!controller.signal.aborted) failed(); });
    }
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [ctx, attempt, duration, media, source?.platform, report, failed]);

  function read(retry = false) {
    if (duration > 0 || (attempt && !retry)) return;
    if (retry) {
      setResult(null);
      if (!source) reloadNative();
    }
    setRequest({ media, attempt: attempt + 1 });
  }
  return { duration, attempt, read, report, failed, unavailable: !duration && measured?.failed };
}

let youtubeAPI;
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeAPI) {
    youtubeAPI = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const previous = window.onYouTubeIframeAPIReady;
      const finish = () => {
        clearTimeout(timer);
        if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
      };
      const ready = () => { finish(); resolve(window.YT); previous?.(); };
      const error = () => { finish(); script.remove(); reject(new Error('播放器未就绪')); };
      const timer = setTimeout(error, 8500);
      window.onYouTubeIframeAPIReady = ready;
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = error;
      document.head.append(script);
    }).catch((error) => { youtubeAPI = null; throw error; });
  }
  return youtubeAPI;
}

// The API observes the visible player, including videos that are already running.
export function YouTubeFrame({ src, title, report, failed }) {
  const host = useRef(null);
  useEffect(() => {
    const iframe = document.createElement('iframe');
    const url = new URL(src);
    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set('origin', location.origin);
    iframe.title = title;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = url.href;
    host.current.append(iframe);
    let active = true, player;
    function read(event) {
      // YouTube reports whole display seconds when cued and a fractional
      // duration after playback. Keep its visible end timestamp stable.
      if (active) report(Math.ceil(event.target.getDuration()));
    }
    loadYouTubeAPI().then((api) => {
      if (active) player = new api.Player(iframe, { events: {
        onReady: read, onStateChange: read, onError: () => { if (active) failed(); },
      } });
    }).catch(() => { if (active) failed(); });
    return () => { active = false; player?.destroy(); iframe.remove(); };
  }, [src, title, report, failed]);
  return <div className="youtube-frame" ref={host} />;
}
