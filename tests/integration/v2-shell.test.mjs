import '../helpers/react-loader.mjs';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { navigation } from '../helpers/next-stubs.mjs';

registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
        const stub = new URL('../helpers/next-stubs.mjs', import.meta.url).href;
        const source = `export { redirect, useRouter } from ${JSON.stringify(stub)};export const usePathname=()=>window.location.pathname;`;
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) };
    }
    return next(specifier, context);
} });

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/home', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { createRoot } = await import('react-dom/client');
const { Shell } = await import('../../app/components/shell.tsx');
const { ControlledBack } = await import('../../app/components/navigation.tsx');
const { ReflectionEditor } = await import('../../app/components/reflections.tsx');
const { HomeScreen, TrainingsScreen } = await import('../../app/components/legacy-screens.tsx');
const { GrowthContent } = await import('../../app/components/growth-content.tsx');
const { Activity, MemberDirectory } = await import('../../app/components/community.tsx');
const { confirmNavigationActor, clearNavigationActor } = await import('../../lib/client/navigation-state.ts');
const { draftKey } = await import('../../lib/client/session-guard.ts');
const h = React.createElement;
const actorId = 'A';
const me = { user: { id: 'u', status: 'active' }, membership: { id: 'm', status: 'active', role: 'member', epoch: 1 }, team: { id: 't', name: 'Kapok', description: '真实队伍简介' } };
const bootstrap = { actorId, me };
const response = data => new Response(JSON.stringify({ data }), { headers: { 'X-Kapok-Actor': actorId } });
const rootNode = document.querySelector('#root');
const query = selector => rootNode.querySelector(selector);
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 5)));

function setup(t, path, resources = {}) {
    window.history.replaceState(null, '', path);
    clearNavigationActor(actorId);
    localStorage.clear();
    const calls = [];
    const data = {
        bootstrap, trainings: [], reflections: [], collections: [], members: [],
        'activity?limit=3': { items: [], nextCursor: null },
        'activity?limit=20': { items: [], nextCursor: null },
        ...resources,
    };
    globalThis.fetch = async url => {
        const key = String(url).replace('/api/v1/', '');
        calls.push(key);
        if (key === 'growth') return response({value:{reflections:data.reflections,collections:data.collections},after:data.bootstrap});
        const fixture = key === 'trainings?view=featured' ? 'trainings' : key;
        const resource = data[fixture];
        assert.ok(Object.hasOwn(data, fixture), 'unexpected request ' + key);
        return typeof resource === 'function' ? resource() : response(resource);
    };
    const root = createRoot(rootNode);
    t.after(async () => { await act(async () => root.unmount()); });
    async function render(node) {
        await act(async () => root.render(node));
        await flush();
    }
    return { data, calls, render };
}

test('V2 shell preserves five mobile destinations and selects a single desktop destination, even when collapsed', async t => {
    const { render } = setup(t, '/home');
    const shell = key => h(Shell, { title: '训练', key, canCompose: true }, '内容');
    const current = nav => query(nav + ' [aria-current=page]')?.getAttribute('href');
    await render(shell('home'));
    assert.equal(query('.topbar').textContent, 'Kapok. / 队伍工作区');
    assert.equal(query('.topbar-account').getAttribute('href'), '/me');
    assert.deepEqual([...rootNode.querySelectorAll('.bottom-nav a')].map(a => a.getAttribute('href')), ['/home', '/trainings', '/reflections/new', '/growth', '/me']);
    assert.equal(current('.bottom-nav'), '/home');
    assert.equal(current('.workspace-sidebar'), '/home');
    const toggle = query('.workspace-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    toggle.focus();
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), '展开侧栏');
    assert.equal(document.activeElement, toggle);
    assert.equal(query('.workspace-sidebar').dataset.collapsed, 'true');
    assert.equal(query('.workspace-nav a[href="/home"]').getAttribute('aria-label'), '首页');
    for (const [path, mobile, desktop] of [
        ['/videos/v', '/trainings', '/trainings'],
        ['/reflections/r', '/growth', '/growth'],
        ['/reflections/new', '/reflections/new', '/growth'],
        ['/reflections/r/edit', '/growth', '/growth'],
        ['/reflections/r/sharing', '/growth', '/growth'],
        ['/members/p', '/home', '/home'],
        ['/announcements/a', '/home', '/activity'],
        ['/me/data', '/me', '/me'],
    ]) {
        window.history.pushState(null, '', path);
        await render(shell(path));
        assert.equal(current('.bottom-nav'), mobile);
        assert.equal(current('.workspace-sidebar'), desktop);
        assert.equal(rootNode.querySelectorAll('.workspace-sidebar [aria-current=page]').length, 1);
        assert.equal(query('.workspace-sidebar').dataset.collapsed, 'true');
    }
    await act(async () => query('.workspace-toggle').click());
    assert.equal(query('.workspace-toggle').getAttribute('aria-expanded'), 'true');
    await render(h(Shell, { title: '编辑', nav: false, back: '/growth' }, '内容'));
    assert.equal(query('.workspace-sidebar,.bottom-nav'), null);
    assert.equal(query('main').tabIndex, -1);
});

test('controlled Back uses the verified homepage alias as the real click source and resets to fallback on another route', async t => {
    const { render } = setup(t, '/home');
    await render(h('a', { href: '/members' }, '队伍成员'));
    confirmNavigationActor(actorId, 'same-actor-membership');
    // Prevent the simulated browser from leaving the document after the app records the click.
    query('a').addEventListener('click', event => event.preventDefault());
    await act(async () => query('a').click());
    window.history.pushState(null, '', '/members');
    await render(h(ControlledBack, { fallback: '/' }));
    assert.equal(query('a').getAttribute('href'), '/home');
    assert.equal(query('a').textContent, '返回 · 首页');
    window.history.pushState(null, '', '/reflections/r');
    await render(h(ControlledBack, { fallback: '/growth' }));
    assert.equal(query('a').getAttribute('href'), '/growth');
});

test('video uses the standard workspace header and navigation with a compact back link', async t => {
    const { render } = setup(t, '/videos/v');
    await render(h(Shell, { surface: 'video', title: '视频与讨论', back: '/trainings', canCompose: true }, '视频内容'));
    assert.equal(query('.app-shell').classList.contains('video-workspace'), true);
    assert.equal(query('.topbar h1').textContent, '视频与讨论');
    assert.equal(query('.topbar .wordmark').getAttribute('href'), '/home');
    assert.equal(query('.topbar .topbar-account').getAttribute('href'), '/me');
    assert.equal(query('.topbar .video-back').getAttribute('href'), '/trainings');
    assert.equal(query('.topbar .video-back').getAttribute('aria-label'), '返回 · 训练列表');
    assert.equal(query('.shell-heading'), null);
    assert.equal(query('.workspace-nav [aria-current=page]').getAttribute('href'), '/trainings');
    assert.equal(query('.bottom-nav [aria-current=page]').getAttribute('href'), '/trainings');
    assert.equal(query('main').textContent, '视频内容');
    confirmNavigationActor(actorId, 'same-actor-membership');
    const back = query('.video-back');
    back.addEventListener('click', event => event.preventDefault());
    await act(async () => back.click());
    window.history.pushState(null, '', '/trainings');
    await render(h(ControlledBack, { fallback: '/' }));
    assert.equal(query('.back-link').getAttribute('href'), '/', 'video back must not replace the previous source of the destination');
    await render(h(Shell, { title: '训练记录', surface: 'index' }, '训练内容'));
    assert.equal(query('.video-workspace,.video-topbar-heading'), null);
    assert.equal(query('.shell-heading h1').textContent, '训练记录');
});

test('reflection workspace navigation retains a local draft and the timestamped video return through save', async t => {
    const source = '/videos/v?t=12#comment-c';
    const editorPath = '/reflections/new?training=t&video=v';
    const draftStorage = draftKey(actorId, 'new');
    const { calls, render } = setup(t, source, {
        reflections: () => response({ ...JSON.parse(localStorage.getItem(draftStorage)).pending.body, id: 'saved', version: 1, sharingVersion: 1, generation: 1 }),
    });
    navigation.length = 0;
    const editor = () => h(Shell, { title: '想和写', back: '/growth' },
        h(ReflectionEditor, { actorId, trainingId: 't', videoId: 'v' }));
    const linkToEditor = () => h('a', { href: editorPath }, '想和写');
    const follow = async (selector, path) => {
        const link = query(selector);
        assert.equal(link.getAttribute('href'), path);
        link.addEventListener('click', event => event.preventDefault());
        await act(async () => link.click());
        window.history.pushState(null, '', path);
    };
    await render(linkToEditor());
    confirmNavigationActor(actorId, JSON.stringify([me.user.id, me.membership]));
    await follow('a', editorPath);
    await render(editor());
    assert.equal(query('.back-link').getAttribute('href'), source);
    const input = query('.reflection-editor textarea');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '先观察接盘空间');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const stored = localStorage.getItem(draftStorage);
    assert.equal(JSON.parse(stored).text, '先观察接盘空间');
    window.confirm = () => false;
    const discard = [...rootNode.querySelectorAll('button')].find(button => button.textContent === '放弃编辑');
    await act(async () => discard.click());
    assert.equal(localStorage.getItem(draftStorage), stored);

    await follow('.bottom-nav a[href="/growth"]', '/growth');
    await render(h('p', null, '成长'));
    assert.equal(localStorage.getItem(draftStorage), stored);
    window.history.back();
    await new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    await render(editor());
    assert.equal(query('.reflection-editor textarea').value, '先观察接盘空间');
    assert.equal(query('.back-link').getAttribute('href'), source);
    await act(async () => query('.reflection-editor').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(calls.filter(path => path === 'reflections').length, 1);
    assert.equal(localStorage.getItem(draftStorage), null);
    assert.deepEqual(navigation, ['/reflections/saved?saved=1']);
    window.history.pushState(null, '', navigation[0]);
    await render(h(ControlledBack, { fallback: '/growth' }));
    assert.equal(query('.back-link').getAttribute('href'), source);
});

test('home waits for actor confirmation and features the newest published training even for an administrator', async t => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const training = { id: 'real-training', title: '已验证训练', date: '2026-10-16', description: '来自服务端的说明', status: 'published' };
    const { data, calls, render } = setup(t, '/home', {
        bootstrap: () => waiting,
        trainings: [
            { id: 'hidden', title: '不可展示的隐藏训练', date: '2026-10-19', status: 'hidden' },
            { id: 'draft', title: '不可展示的训练草稿', date: '2026-10-18', status: 'draft' },
            { id: 'archived', title: '不可展示的归档训练', date: '2026-10-17', status: 'archived' },
            training,
            { id: 'older', title: '更早的训练', date: '2026-10-15', status: 'published' },
        ],
        'activity?limit=3': { items: [{ id: 'event', kind: 'video', title: '新片段', href: '/videos/v', publishedAt: '2026-10-17T04:00:00Z', updatedAt: '2026-10-17T04:00:00Z' }], nextCursor: null },
    });
    await render(h(HomeScreen, { actorId }));
    assert.equal(query('[data-kapok-sensitive]').hidden, true);
    assert.equal(query('[role=status]').getAttribute('aria-busy'), 'true');
    assert.deepEqual(calls, ['bootstrap']);
    assert.ok(query('.writing-link'));
    assert.equal(query('.training-feature'), null);
    data.bootstrap = { actorId, me: { ...me, membership: { ...me.membership, role: 'admin' } } };
    await act(async () => release(response(data.bootstrap)));
    await flush();
    assert.equal(query('.training-feature').getAttribute('href'), '/trainings/real-training');
    assert.equal(query('.training-feature time').dateTime, training.date);
    assert.match(query('.training-feature').textContent, /已验证训练.*来自服务端的说明/);
    assert.doesNotMatch(rootNode.textContent, /不可展示|更早的训练/);
    assert.equal(query('.activity-card time').dateTime, '2026-10-17T04:00:00Z');
    assert.equal(query('.activity-card a').getAttribute('href'), '/videos/v');
    assert.equal(query('.writing-link').getAttribute('href'), '/reflections/new');
    await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
    assert.equal(query('[data-kapok-sensitive]').hidden, true);
    assert.equal(query('.training-feature,.activity-card'), null);
});

test('home starts featured training while the Access account detail is still pending', async t => {
    let finishAccount;
    const pendingAccount = new Promise(resolve => { finishAccount = resolve; });
    const { calls, render } = setup(t, '/home', {
        bootstrap: { actorId, me: { ...me, team: null } },
        me: () => pendingAccount,
        trainings: [{ id: 't', title: '首屏训练', date: '2026-11-21', status: 'published' }],
    });
    await render(h(HomeScreen, { actorId }));
    assert.ok(query('.home-quick-links a'));
    assert.deepEqual(calls, ['bootstrap', 'me', 'trainings?view=featured']);
    assert.equal(query('.training-feature'), null);
    await act(async () => finishAccount(response(me)));
    await flush();
    assert.match(query('.training-feature').textContent, /首屏训练/);
});

for (const role of ['admin', 'member']) {
    test(`home recovers from a training error to an honest unpublished empty state for a ${role}`, async t => {
        const { data, render } = setup(t, '/home', {
            bootstrap: { actorId, me: { ...me, membership: { ...me.membership, role } } },
            trainings: () => new Response(JSON.stringify({
                error: { code: 'INTERNAL', message: '训练暂时无法加载', retryable: true },
            }), { status: 503, headers: { 'X-Kapok-Actor': actorId } }),
        });
        await render(h(HomeScreen, { actorId }));
        assert.match(query('[role=alert]').textContent, /训练暂时无法加载/);
        assert.doesNotMatch(rootNode.textContent, /还没有近期训练/);
        data.trainings = [{ id: 'archived', title: '归档训练', date: '2026-10-17', status: 'archived' }];
        if (role === 'admin') data.trainings.unshift({ id: 'draft', title: '训练草稿', date: '2026-10-18', status: 'draft' });
        await act(async () => query('[role=alert] button').click());
        await flush();
        assert.match(rootNode.textContent, /还没有近期训练/);
        assert.equal(query('.training-feature'), null);
        assert.equal(query('a[href="/admin/trainings/new"]')?.textContent, role === 'admin' ? '创建训练' : undefined);
    });
}

test('training index displays a retryable failure, then a member empty state without admin controls', async t => {
    const { data, render } = setup(t, '/trainings', { trainings: () => new Response(
        JSON.stringify({ error: { code: 'INTERNAL', message: '训练暂时无法加载', retryable: true } }),
        { status: 503, headers: { 'X-Kapok-Actor': actorId } },
    ) });
    await render(h(TrainingsScreen, { actorId }));
    assert.match(query('[role=alert]').textContent, /训练暂时无法加载/);
    assert.equal(query('[data-kapok-sensitive]').hidden, true);
    assert.equal(query('.training-filter'), null);
    data.trainings = [];
    await act(async () => query('[role=alert] button').click());
    await flush();
    assert.match(query('[data-kapok-sensitive]').textContent, /还没有已发布训练/);
    assert.equal(query('details'), null);
    assert.ok(query('input[type=date]'));
});

test('growth filter uses real buttons and leaves other root empty states honest', async t => {
    const { render } = setup(t, '/growth');
    await render(h(GrowthContent, { actorId }));
    const group = query('[role=group][aria-label="成长内容筛选"]');
    assert.deepEqual([...group.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.match(rootNode.textContent, /还没有成长记录/);
    await act(async () => group.querySelector('button[aria-label="收藏"]').click());
    assert.match(rootNode.textContent, /还没有收藏/);
    assert.equal(group.querySelector('[aria-pressed=true]').getAttribute('aria-label'), '收藏');
    assert.equal(group.querySelector('[aria-pressed=true] .growth-filter-count').textContent, '0');
    await render(h(MemberDirectory, { actorId }));
    assert.match(rootNode.textContent, /队伍暂时没有成员/);
    await render(h(Activity, { actorId }));
    assert.match(rootNode.textContent, /还没有可读动态/);
    assert.equal(query('article,button'), null);
});

test('V2 navigation stylesheet retains 44px targets, desktop widths, focus and reduced motion rules', async () => {
    const css = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');
    assert.match(css, /\.bottom-nav a \{[^}]*min-width:44px; min-height:56px/);
    assert.match(css, /\.workspace-sidebar a \{[^}]*min-width:44px; min-height:44px/);
    assert.match(css, /\.workspace-toggle \{[^}]*width:44px; min-height:44px/);
    assert.match(css, /--sidebar-width:224px/);
    assert.match(css, /data-collapsed=true[^{}]*\{ --sidebar-width:76px/);
    assert.match(css, /\.with-nav main \{[^}]*max-width:var\(--workspace-detail-width\)[^}]*padding:var\(--workspace-detail-start\) var\(--workspace-detail-gutter\) var\(--workspace-detail-end\)/);
    assert.match(css, /\.video-content \{[^}]*max-width:var\(--workspace-detail-width,100%\)[^}]*padding:var\(--workspace-detail-start,0px\) var\(--workspace-detail-gutter,0px\) var\(--workspace-detail-end,24px\)/);
    // A previous document scroll position must not move the video frame, including when crossing the desktop breakpoint.
    assert.match(css, /^\.app-shell\.with-nav\.video-workspace \{ position:fixed; inset-inline:0; top:0; \}$/m);
    assert.match(css, /@media\(min-width:900px\) \{\s*\.app-shell\.with-nav\.video-workspace \{ height:var\(--workspace-frame-height\); \}/);
    assert.match(css, /@media\(max-width:899px\) \{\s*\.app-shell\.with-nav\.video-workspace \{\s*top:var\(--video-viewport-top,0px\)/);
    assert.match(css, /\.workspace-sidebar :focus-visible/);
    assert.match(css, /@media\(prefers-reduced-motion:reduce\)[^\n]*transition:none !important/);
    assert.match(css, /\[hidden\] \{ display:none !important/);
});


test('V07 sidebar refresh restores device preference, invalid or blocked storage stays usable', async t => {
    const { render } = setup(t, '/home');
    const { WorkspaceSidebar: First } = await import('../../app/components/navigation.tsx?sidebar-first');
    await render(h(First, { canCompose: true }));
    assert.equal(query('.workspace-sidebar').dataset.collapsed, 'false');
    await act(async () => query('.workspace-toggle').click());
    assert.equal(localStorage.getItem('kapok:sidebar-collapsed'), 'true');
    await render(null);
    // A fresh module models a page reload: no prior in-memory collapsed state survives.
    const { WorkspaceSidebar: Reloaded } = await import('../../app/components/navigation.tsx?sidebar-reloaded');
    const { renderToString } = await import('react-dom/server');
    const serverMarkup = renderToString(h(Reloaded, { canCompose: true }));
    assert.match(serverMarkup, /data-collapsed="false"/);
    await render(h(Reloaded, { canCompose: true }));
    assert.equal(query('.workspace-sidebar').dataset.collapsed, 'true');
    assert.equal(query('.workspace-toggle').getAttribute('aria-expanded'), 'false');
    await act(async () => query('.workspace-toggle').click());
    assert.equal(localStorage.getItem('kapok:sidebar-collapsed'), 'false');
    await render(null);
    localStorage.setItem('kapok:sidebar-collapsed', 'malformed');
    const { WorkspaceSidebar: Invalid } = await import('../../app/components/navigation.tsx?sidebar-invalid');
    await render(h(Invalid, { canCompose: false }));
    assert.equal(query('.workspace-sidebar').dataset.collapsed, 'false');
    await render(null);
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
        const { WorkspaceSidebar: Blocked } = await import('../../app/components/navigation.tsx?sidebar-blocked');
        await render(h(Blocked, { canCompose: false }));
        assert.equal(query('.workspace-sidebar').dataset.collapsed, 'false');
        await act(async () => query('.workspace-toggle').click());
        assert.equal(query('.workspace-sidebar').dataset.collapsed, 'true');
        assert.ok(query('.workspace-nav a[href="/trainings"]'));
    } finally { Object.defineProperty(window, 'localStorage', descriptor); }
});

test('page-read growth rejects a late response after the account changes', async t => {
    document.documentElement.dataset.kapokPageRead = '1';
    t.after(() => { delete document.documentElement.dataset.kapokPageRead; });
    let finish;
    const waiting = new Promise(resolve => { finish = resolve; });
    const { render, calls } = setup(t, '/growth', { 'page-read/growth': () => waiting });
    await render(h(GrowthContent, { actorId }));
    assert.deepEqual(calls, ['page-read/growth']);
    await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
    await act(async () => finish(response({ value: { collections: [], reflections: [] }, after: bootstrap })));
    assert.equal(query('.growth-filters'), null);
    assert.equal(query('[data-kapok-sensitive]').hidden, true);
});
