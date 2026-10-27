'use client';
import { useState } from 'react';

// Browser-only, ephemeral UI buffers. No server resource snapshots are stored here.
// 30 minutes, 80 entries, 32KiB per entry; clearing advances an epoch to fence late callbacks.
type Entry = { value: unknown; at: number };
type Store = { actor: string; stamp: string; epoch: number; entries: Map<string, Entry>; sources: Map<string, string>; pending: Map<string, string> };
const slot = '__kapokNavigationState' as const;
type Host = Window & { [slot]?: Store };
function store(): Store | null {
    if (typeof window === 'undefined') return null;
    const host = window as Host;
    if (!host[slot]) {
        host[slot] = { actor: '', stamp: '', epoch: 0, entries: new Map(), sources: new Map(), pending: new Map() };
        const ended = (actor: string) => { if (host[slot]?.actor === actor) clearNavigationActor(actor); };
        window.addEventListener('kapok-account-changed', e => ended((e as CustomEvent<string>).detail));
        const channel = new BroadcastChannel('kapok-session');
        channel.onmessage = e => { if (e.data?.kind === 'ended') ended(e.data.actorId); };
        document.addEventListener('click', e => {
            const link = (e.target as Element | null)?.closest('a[href]');
            const state = host[slot];
            if (!link || link.classList.contains('back-link') || !state?.actor || e.defaultPrevented) return;
            const target = new URL(link.getAttribute('href')!, window.location.href);
            if (target.origin !== window.location.origin || !validPath(target.pathname) || target.pathname === window.location.pathname) return;
            state.sources.set(target.pathname, sourceHref());
            if (state.sources.size > 80) state.sources.delete(state.sources.keys().next().value!);
        }, true);
    }
    return host[slot]!;
}
function validPath(path: string) { return /^\/(?:$|trainings(?:\/[\w-]+)?|videos\/[\w-]+|growth|me(?:\/(?:edit|data|recycle))?|members(?:\/[\w-]+)?|reflections\/(?:new|[\w-]+(?:\/(?:edit|sharing))?)|announcements\/[\w-]+|activity|admin\/(?:invites|announcements|members)|login|join(?:\/[\w-]+)?|internal\/bootstrap)$/.test(path); }
function sourceHref() {
    const url = new URL(window.location.href);
    const allowed = url.pathname.startsWith('/videos/') ? ['t'] : url.pathname === '/reflections/new' ? ['collection', 'training', 'video'] : url.pathname === '/activity' ? ['cursor'] : [];
    for (const key of [...url.searchParams.keys()]) {
        const value = url.searchParams.get(key)!;
        if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1 || (key === 't' ? !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) : key === 'cursor' ? !/^[a-zA-Z0-9_+=/-]{1,512}$/.test(value) : !/^[a-zA-Z0-9_-]{1,80}$/.test(value))) url.searchParams.delete(key);
    }
    if (url.pathname === '/reflections/new' && url.searchParams.has('collection')) { url.searchParams.delete('training'); url.searchParams.delete('video'); }
    if (!(url.pathname.startsWith('/videos/') && /^#comment-[a-zA-Z0-9_-]{1,80}$/.test(url.hash)) && !(url.pathname.startsWith('/announcements/') && url.hash === '#body')) url.hash = '';
    return url.pathname + url.search + url.hash;
}
export function confirmNavigationActor(actor: string, stamp: string) {
    const state = store(); if (!state) return;
    if (state.actor !== actor || state.stamp !== stamp) { state.entries.clear(); state.sources.clear(); state.pending.clear(); state.epoch++; }
    state.actor = actor; state.stamp = stamp;
}
export function clearNavigationActor(actor: string) {
    const state = store(); if (!state || state.actor !== actor) return;
    state.entries.clear(); state.sources.clear(); state.pending.clear(); state.epoch++; state.actor = ''; state.stamp = '';
}
export function navigationBuffer(actor: string, route: string, entity: string) {
    const state = store();
    const epoch = state?.epoch;
    const key = `${route}:${entity}`;
    const current = () => state && state.actor === actor && state.epoch === epoch;
    return {
        read<T>(): T | null {
            if (!current()) return null;
            const entry = state!.entries.get(key);
            if (!entry || Date.now() - entry.at > 30 * 60_000) { state!.entries.delete(key); return null; }
            return JSON.parse(JSON.stringify(entry.value)) as T;
        },
        write(value: unknown) {
            const serialized = JSON.stringify(value);
            if (!current() || new TextEncoder().encode(serialized).byteLength > 32_768) return;
            state!.entries.delete(key); state!.entries.set(key, { value: JSON.parse(serialized), at: Date.now() });
            while (state!.entries.size > 80) state!.entries.delete(state!.entries.keys().next().value!);
        },
        clear() { if (current()) state!.entries.delete(key); }
    };
}
export function clearNavigationRoute(actor: string, route: string) {
    const state = store(); if (state?.actor !== actor) return;
    for (const key of state.entries.keys()) if (key.startsWith(route + ':')) state.entries.delete(key);
    for (const key of state.pending.keys()) if (JSON.parse(key)[0] === route) state.pending.delete(key);
    state.sources.delete(route);
    state.epoch++; // Old route callbacks cannot refill a cleared buffer.
}
export function currentRoute() { return typeof window === 'undefined' ? '/' : window.location.pathname; }
export function controlledBackSource() { const source = store()?.sources.get(currentRoute()); return source && validPath(source.split(/[?#]/)[0]) ? source : null; }

// Save only fields changed by the user; fresh source values are never a cache authority.
// Reflection editors retain their existing separate draft protocol.
export function retainRouteUI(actor: string, surface: HTMLElement) {
    const route = currentRoute();
    const buffer = navigationBuffer(actor, route, 'ui');
    const value = buffer.read<{ fields: Record<string, string>; details: number[]; scroll: number }>() ?? { fields: {}, details: [], scroll: 0 };
    const fields = () => [...surface.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea,select[data-retain-ui]')].filter(node => !node.closest('[data-own-buffer]') && !node.readOnly && !['file','password','hidden','checkbox','radio','button','submit'].includes((node as HTMLInputElement).type));
    const key = (node: Element) => { const form = node.closest('form'); const within = form ? [...form.querySelectorAll('input,textarea,select[data-retain-ui]')] : fields(); return `${form?.getAttribute('data-buffer-id') ?? 'page'}:${node.getAttribute('name') ?? within.indexOf(node as HTMLInputElement)}`; };
    const changed = (event: Event) => {
        const node = event.target;
        if (!(node instanceof HTMLElement) || !fields().includes(node as HTMLInputElement)) return;
        if (/^\/reflections\/(?:new|[^/]+\/edit)$/.test(route)) return;
        Object.assign(value, buffer.read() ?? {});
        value.fields[key(node)] = (node as HTMLInputElement).value;
        buffer.write(value);
    };
    const savePosition = () => { Object.assign(value, buffer.read() ?? {}); value.scroll = window.scrollY; buffer.write(value); };
    const navigating = (event: Event) => {
        const link = (event.target as Element | null)?.closest('a[href]');
        if (!link || new URL(link.getAttribute('href')!, window.location.href).origin !== window.location.origin) return;
        savePosition(); window.removeEventListener('scroll', savePosition);
    };
    const toggle = () => { Object.assign(value, buffer.read() ?? {}); value.details = [...surface.querySelectorAll('details')].flatMap((node, i) => node.open ? [i] : []); buffer.write(value); };
    for (const node of fields()) {
        const saved = value.fields[key(node)];
        if (saved === undefined) continue;
        const prototype = Object.getPrototypeOf(node);
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, saved);
        node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
    [...surface.querySelectorAll('details')].forEach((node, i) => { if (value.details.includes(i)) node.open = true; });
    if (value.scroll) window.scrollTo(0, value.scroll);
    surface.addEventListener('click', navigating, true); surface.addEventListener('input', changed); surface.addEventListener('change', changed); surface.addEventListener('toggle', toggle, true);
    window.addEventListener('scroll', savePosition, { passive: true });
    return () => { surface.removeEventListener('click', navigating, true); surface.removeEventListener('input', changed); surface.removeEventListener('change', changed); surface.removeEventListener('toggle', toggle, true); window.removeEventListener('scroll', savePosition); };
}

const mutationPaths = /^(?:me|join|internal\/bootstrap|admin\/invites|collections(?:\/[\w-]+)?|trainings(?:\/[\w-]+(?:\/videos)?)?|videos\/[\w-]+(?:\/comments(?:\/[\w-]+)?)?|comments\/[\w-]+\/moderation|announcements(?:\/[\w-]+)?)$/;
function mutationId(method: string, path: string, body: unknown) { return JSON.stringify([currentRoute(), method, path, body]); }
export function pendingMutationKey(actor: string, method: string, path: string, body: unknown, candidate: string) {
    const state = store();
    if (!state || state.actor !== actor || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !mutationPaths.test(path)) return candidate;
    const id = mutationId(method, path, body);
    const existing = state.pending.get(id); if (existing) return existing;
    if (state.pending.size >= 20 || new TextEncoder().encode(id).byteLength > 32_768) throw new Error('尚有未确认的提交，请先回到原页面确认结果，再继续保存。');
    const key = crypto.randomUUID(); state.pending.set(id, key); return key;
}
export function acknowledgeMutation(actor: string, method: string, path: string, body: unknown) {
    const state = store(); if (state?.actor === actor) state.pending.delete(mutationId(method, path, body));
}

export function useNavigationField<T>(actor: string, entity: string, initial: T): [T, (value: T) => void] {
    const epoch = store()?.epoch;
    const buffer = navigationBuffer(actor, currentRoute(), entity);
    const [local, setLocal] = useState(() => ({ epoch, value: buffer.read<T>() ?? initial }));
    const value = local.epoch === epoch ? local.value : buffer.read<T>() ?? initial;
    return [value, next => { buffer.write(next); setLocal({ epoch, value: next }); }];
}
export function clearFormUI(actor: string, id: string) {
    const buffer = navigationBuffer(actor, currentRoute(), 'ui');
    const value = buffer.read<{ fields: Record<string, string>; details: number[]; scroll: number }>();
    if (!value) return;
    for (const key of Object.keys(value.fields)) if (key.startsWith(id + ':')) delete value.fields[key];
    buffer.write(value);
}


export function rejectMutationKey(actor: string, method: string, path: string, body: unknown, requestKey: string, code: string) {
    if (!['INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'READ_ONLY'].includes(code)) return;
    const state = store(); if (state?.actor !== actor || !mutationPaths.test(path)) return;
    const id = mutationId(method, path, body);
    if (state.pending.get(id) === requestKey) state.pending.delete(id);
}

export function transferNavigationSource(actor: string, to: string) {
    const state = store(); if (state?.actor !== actor || !validPath(to)) return;
    let source = state.sources.get(currentRoute());
    const visited = new Set([currentRoute()]);
    while (source && [to, to + '/edit', to + '/sharing'].includes(source.split(/[?#]/)[0])) {
        const path = source.split(/[?#]/)[0];
        if (visited.has(path)) { source = undefined; break; }
        visited.add(path); source = state.sources.get(path);
    }
    if (source) state.sources.set(to, source);
}
