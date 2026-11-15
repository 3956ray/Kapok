export function parseYouTubeSource(input: string): { videoId: string; startSec: number; url: string } | null {
    const value = input.trim();
    if (value.length > 2000 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;

    // Match the written authority before URL normalization strips empty credentials or rewrites host text.
    const authority = /^https:\/\/(youtu\.be|(?:(?:www|m)\.)?youtube\.com)(?::\d+)?(?=[/?#]|$)/i.exec(value);
    if (!authority) return null;
    let u: URL;
    try { u = new URL(value); } catch { return null; }
    const path = value.slice(authority[0].length).split(/[?#]/, 1)[0];
    if (u.port || path !== u.pathname) return null;

    const videos = u.searchParams.getAll('v');
    const times = [...u.searchParams.getAll('t'), ...u.searchParams.getAll('start')];
    if (videos.length > 1 || times.length > 1) return null;

    const shortHost = u.hostname === 'youtu.be';
    const watch = !shortHost && path === '/watch';
    if (!watch && videos.length) return null;
    const videoId = watch ? videos[0] : shortHost
        ? path.slice(1)
        : /^\/shorts\/([^/]+)\/?$/.exec(path)?.[1];
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;

    const time = times[0] ?? '0';
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
    const startSec = /^\d+$/.test(time) ? Number(time) : time && parts
        ? Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)
        : NaN;
    if (!Number.isSafeInteger(startSec) || startSec > 604800) return null;

    return { videoId, startSec, url: `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s` };
}
