const bv = /^BV[A-Za-z0-9]{10}$/;
const youtubeId = /^[\w-]{11}$/;
const shareLink = /https?:\/\/[^\s<>「」【】“”"'，。！？）)]+/gi;

export function parseVideo(text) {
  const value = text.trim();
  if (!value) return null;
  if (bv.test(value)) return bili(value, 1);
  const links = value.match(shareLink) ?? [];
  if (links.length !== 1) throw new Error('请粘贴一条 B 站或 YouTube 视频链接，也可以填写 BV 号。');
  let url;
  try {
    url = new URL(links[0]);
  } catch {
    throw new Error('请检查视频链接是否完整。');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password)
    throw new Error('请使用平台的 HTTPS 分享链接。');
  const host = url.hostname;
  if (host === 'b23.tv' && /^\/[A-Za-z0-9]{1,32}\/?$/.test(url.pathname)) {
    return { platform: 'short', url: url.origin + url.pathname };
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'player.bilibili.com'].includes(host)) {
    const player = host === 'player.bilibili.com';
    const id =
      player && url.pathname === '/player.html'
        ? url.searchParams.get('bvid')
        : url.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/)?.[1];
    const page = Number(
      url.searchParams.get('p') ?? (player ? url.searchParams.get('page') : null) ?? 1,
    );
    if (id && bv.test(id) && Number.isSafeInteger(page) && page >= 1 && page <= 1000)
      return bili(id, page);
  }
  const yt =
    host === 'youtu.be'
      ? url.pathname.slice(1)
      : ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)
        ? url.pathname === '/watch'
          ? url.searchParams.get('v')
          : url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)\/?$/)?.[1]
        : null;
  if (yt && youtubeId.test(yt)) {
    const input = url.searchParams.get('t') ?? url.searchParams.get('start') ?? '0';
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(input);
    const start = /^\d+$/.test(input) ? Number(input) : parts ? Number(parts[1] || 0)*3600 + Number(parts[2] || 0)*60 + Number(parts[3] || 0) : NaN;
    if (!Number.isSafeInteger(start) || start>604800) throw Error('请检查视频开始时间。');
    return {
      platform: 'YouTube',
      url: 'https://www.youtube.com/watch?v=' + yt + '&t=' + start + 's',
      embed: 'https://www.youtube-nocookie.com/embed/' + yt + (start ? '?start=' + start : ''),
    };
  }
  throw new Error('未识别这条视频地址。请使用完整的 B 站视频页或 YouTube 链接。');
}

function bili(id, page) {
  return {
    platform: 'B 站',
    url: 'https://www.bilibili.com/video/' + id + '/' + (page > 1 ? '?p=' + page : ''),
    embed: 'https://player.bilibili.com/player.html?bvid=' + id + '&page=' + page + '&autoplay=0&danmaku=0',
  };
}

export function videoAt(source, seconds, embedded = false) {
  const base = embedded ? source.embed : source.url;
  if (seconds == null) return base;
  const url = new URL(base);
  url.searchParams.set(embedded && source.platform === 'YouTube' ? 'start' : 't', String(seconds));
  if (embedded) url.searchParams.set('autoplay', '1');
  return url.href;
}

export function linkedTime(text) {
  const addresses = text.match(shareLink);
  if (addresses?.length !== 1) return null;
  try {
    if (!parseVideo(addresses[0])) return null;
    const url = new URL(addresses[0]);
    const value = url.searchParams.get('t') || url.searchParams.get('start') || new URLSearchParams(url.hash.slice(1)).get('t');
    if (!value) return null;
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Math.floor(Number(value))
      : parts ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0) : NaN;
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 359999 ? seconds : null;
  } catch { return null; }
}
