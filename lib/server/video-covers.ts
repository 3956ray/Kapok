import { parseYouTubeSource } from '../video-source.ts';

const maxImageBytes = 2 * 1024 * 1024;
const defaultCover = '/workspace-assets/media/defense.webp';

function sourceKey(source: string) {
    const youtube = parseYouTubeSource(source);
    if (youtube) return 'youtube/' + youtube.videoId;
    const bili = /^https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9a-zA-Z]{10})\/?(?:\?[^#]*)?$/.exec(source);
    return bili ? 'bilibili/' + bili[1] : null;
}

async function bytesAt(url: string, limit: number, signal: AbortSignal) {
    const response = await fetch(url, { redirect: 'error', signal });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new Error('Cover unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > limit) throw new Error('Cover too large');
            chunks.push(chunk.value);
        }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
}

function biliImage(value: unknown) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value, 'https://www.bilibili.com');
        if (!['http:', 'https:'].includes(url.protocol) || !/^i[0-9]+\.hdslb\.com$/.test(url.hostname) ||
            !url.pathname.startsWith('/bfs/') || url.port || url.username || url.password) return null;
        return 'https://' + url.hostname + url.pathname.split('@', 1)[0] + '@960w.webp';
    } catch { return null; }
}

async function biliCover(id: string, signal: AbortSignal) {
    const decoder = new TextDecoder();
    try {
        const data = JSON.parse(decoder.decode(await bytesAt('https://api.bilibili.com/x/web-interface/view?bvid=' + id, 768 * 1024, signal)));
        const image = data.code === 0 && data.data?.bvid === id && biliImage(data.data.pic);
        if (image) return image;
    } catch { /* Public video pages also expose the uploader's cover. */ }
    const html = decoder.decode(await bytesAt('https://www.bilibili.com/video/' + id + '/', 1024 * 1024, signal));
    const meta = html.match(/<meta\b[^>]*\b(?:property|name)=["']og:image["'][^>]*>/i)?.[0];
    return biliImage(meta?.match(/\bcontent=["']([^"']+)["']/i)?.[1]);
}

function imageType(bytes: Uint8Array) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if ([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return 'image/png';
    if (String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'image/webp';
    return null;
}

// Only platform artwork enters this namespace. Member-uploaded images keep their own authorization and lifecycle.
export async function videoCover(bucket: R2Bucket | undefined, source: string | null): Promise<Response> {
    const key = source && sourceKey(source);
    const fallback = () => new Response(null, { status: 302, headers: { Location: defaultCover, 'Cache-Control': 'private, no-store' } });
    if (!key) return fallback();
    const objectKey = 'platform-covers/v1/' + key;
    const stored = await bucket?.get(objectKey).catch(() => null);
    const headers = (type: string) => ({ 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    const age = stored ? Date.now() - stored.uploaded.getTime() : Infinity;
    if (stored?.size && age < 7 * 86400000) return new Response(stored.body, { headers: headers(stored.httpMetadata?.contentType || 'image/jpeg') });
    if (stored?.size === 0 && age < 300000) { await stored.body.cancel(); return fallback(); }
    try {
        const [provider, id] = key.split('/');
        const signal = AbortSignal.timeout(7000);
        const url = provider === 'youtube' ? 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' : await biliCover(id, signal);
        if (!url) throw new Error('No platform cover');
        const image = await bytesAt(url, maxImageBytes, signal);
        const mime = imageType(image);
        if (!mime) throw new Error('Invalid image');
        await bucket?.put(objectKey, image, { httpMetadata: { contentType: mime } }).catch(()=>{});
        await stored?.body.cancel();
        return new Response(image, { headers: headers(mime) });
    } catch {
        if (stored?.size) return new Response(stored.body, { headers: headers(stored.httpMetadata?.contentType || 'image/jpeg') });
        await stored?.body.cancel();
        await bucket?.put(objectKey, new Uint8Array(), { onlyIf: stored ? { etagMatches: stored.etag } : { etagDoesNotMatch: '*' } }).catch(()=>{});
        return fallback();
    }
}
