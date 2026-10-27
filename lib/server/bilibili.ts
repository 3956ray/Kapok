import { DomainError } from './domain.ts';

function canonicalVideo(value: string) {
    let bv = '';
    let page = 1;
    if(/^BV[a-zA-Z0-9]{10}$/.test(value))
        bv = value;
    else {
        let u: URL;
        try {
            u = new URL(value);
        }
        catch {
            throw new DomainError('INVALID_INPUT', '请填写BV号或B站视频地址。');
        }
        if(u.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(u.hostname) || u.username || u.password || u.port)
            throw new DomainError('INVALID_INPUT', '请使用B站原站HTTPS视频地址。');
        const match = u.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})\/?$/);
        if(!match)
            throw new DomainError('INVALID_INPUT', '请填写完整BV视频地址。');
        bv = match[1];
        if(u.searchParams.has('p')) {
            page = Number(u.searchParams.get('p'));
            if(!Number.isSafeInteger(page) || page < 1 || page > 1000)
                throw new DomainError('INVALID_INPUT', '分P需为1–1000。');
        }
    }
    return `https://www.bilibili.com/video/${bv}/${page > 1 ? '?p=' + page : ''}`;
}

function shareLink(input: unknown): string {
    if (typeof input !== 'string' || !input.trim() || input.length > 2000)
        throw new DomainError('INVALID_INPUT', '请粘贴B站分享内容、视频链接或BV号（最多2000字）。');
    const value = input.trim();
    if (/^BV[a-zA-Z0-9]{10}$/.test(value)) return value;
    // URL boundaries include the punctuation surrounding mobile share text.
    const links = value.match(/https?:\/\/[^\s<>「」『』【】“”"'，。！？）)]+/g) ?? [];
    if (links.length !== 1) throw new DomainError('INVALID_INPUT', '请只粘贴一条B站视频的分享内容或链接。');
    return links[0];
}
function shortLink(value: string): URL | null {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'b23.tv' || url.username || url.password || url.port || !/^\/[a-zA-Z0-9]{1,32}\/?$/.test(url.pathname)) return null;
    // Tracking fields are unnecessary to expand an official short-link code.
    url.search = ''; url.hash = '';
    return url;
}
export async function resolveBilibiliShare(input: unknown, request: typeof fetch = fetch): Promise<string> {
    let link = shareLink(input);
    if (!shortLink(link)) return canonicalVideo(link);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const visited = new Set<string>();
        for (let hop = 0; hop < 3; hop++) {
            const url = shortLink(link);
            if (!url) return canonicalVideo(link);
            if (visited.has(url.href)) break;
            visited.add(url.href);
            // Never follow a redirect implicitly: only b23.tv is fetched, and only
            // a validated Bilibili video destination can be stored/embedded.
            const response = await request(url.href, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (response.status === 429 || response.status >= 500) throw new DomainError('UPSTREAM_UNAVAILABLE', 'B站暂时繁忙，请保留输入稍后重试。', 503, true);
            if (![301,302,303,307,308].includes(response.status) || !location) break;
            link = new URL(location, url).href;
            if (!shortLink(link)) return canonicalVideo(link);
        }
    } catch (error) {
        if (error instanceof DomainError && error.retryable) throw error;
        throw new DomainError('UPSTREAM_UNAVAILABLE', 'B站短链接暂时未能解析，请保留输入稍后重试，或复制浏览器中的完整视频地址。', 503, true);
    } finally { clearTimeout(timer); }
    throw new DomainError('UPSTREAM_UNAVAILABLE', '暂未确认这条B站短链接对应的视频，请保留输入重试，或使用完整视频地址。', 503, true);
}
