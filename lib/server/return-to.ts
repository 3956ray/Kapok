import { isLearningSourceKind } from '../contracts/reflections.ts';
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || /[\\\u0000-\u001f\u007f]/.test(value) || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://kapok.local');
    if (/%(?:2f|5c)/i.test(url.pathname) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return '/';
    const path = decodeURIComponent(url.pathname);
    const allowed = /^\/(?:$|trainings(?:\/[a-zA-Z0-9_-]+)?|videos\/[a-zA-Z0-9_-]+|growth|learn(?:\/(?:mine|(?:posts|collections)\/(?:new|(?!new(?:\/|$))[a-zA-Z0-9_-]{1,80}(?:\/edit)?)|featured\/manage))?|me(?:\/(?:data|recycle|edit|preview))?|members(?:\/[a-zA-Z0-9_-]+)?|reflections\/(?:new|[a-zA-Z0-9_-]+(?:\/(?:edit|sharing))?)|announcements\/[a-zA-Z0-9_-]+|activity|admin\/(?:announcements|members|trainings(?:\/(?:new|(?!new(?:\/|$))[a-zA-Z0-9_-]{1,80}(?:\/edit)?))?))$/;
    if (url.origin !== 'https://kapok.local' || !allowed.test(path)) return '/';
    const params = url.searchParams;
    const id = /^[a-zA-Z0-9_-]{1,80}$/;
    const queryKeys = path.startsWith('/videos/') ? ['t'] : path === '/reflections/new' ? ['collection', 'training', 'video', 'sourceKind', 'sourceId'] : path === '/growth' ? ['filter'] : path === '/learn' ? ['tab'] : path === '/activity' ? ['cursor'] : /^\/trainings\/[a-zA-Z0-9_-]{1,80}$/.test(path) ? ['view', 'video'] : [];
    if ([...params.keys()].some(key => !queryKeys.includes(key) || params.getAll(key).length !== 1)) return '/';
    if (path === '/reflections/new' && params.has('collection') && (params.has('training') || params.has('video'))) return '/';
    for (const [key, value] of params) {
      if (key === 'sourceKind' ? !isLearningSourceKind(value) : key === 't' ? !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) : key === 'cursor' ? !/^[a-zA-Z0-9_+=/-]{1,512}$/.test(value) : key === 'filter' ? !['reflections', 'bookmarks'].includes(value) : key === 'tab' ? !['contents', 'collections'].includes(value) : key === 'view' ? value !== 'member' : !id.test(value)) return '/';
    }
    if (path === '/reflections/new' && (params.has('sourceKind') || params.has('sourceId')) &&
        (!params.has('sourceKind') || !params.has('sourceId') || params.size !== 2)) return '/';
    if (url.hash && !(path.startsWith('/videos/') && /^#comment-[a-zA-Z0-9_-]{1,80}$/.test(url.hash)) && !(path.startsWith('/announcements/') && url.hash === '#body')) return '/';
    return `${path}${url.search}${url.hash}`;
  } catch { return '/'; }
}
