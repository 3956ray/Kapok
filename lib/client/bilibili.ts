/** Only embed the official player, never an arbitrary URL supplied by a visitor. */
export function bilibiliPlayerUrl(value: string | null, seconds?: number): string | null {
    if (!value) return null;
    try {
        const source = new URL(value);
        const match = source.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})\/?$/);
        if (source.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(source.hostname) || source.username || source.password || source.port || !match) return null;
        const page = Number(source.searchParams.get('p') ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return null;
        const player = new URL('https://player.bilibili.com/player.html');
        player.search = new URLSearchParams({ bvid: match[1], p: String(page), autoplay: '0', danmaku: '0', t: String(Number.isSafeInteger(seconds) && seconds! >= 0 ? seconds : 0) }).toString();
        return player.href;
    } catch { return null; }
}
