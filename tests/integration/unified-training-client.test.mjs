import '../helpers/react-loader.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { safeReturnTo } from '../../lib/server/return-to.ts';
import { controlledBackSource, clearNavigationActor } from '../../lib/client/navigation-state.ts';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/trainings/t', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
const { createRoot } = await import('react-dom/client');
const { TrainingWatch } = await import('../../app/components/training-watch.tsx');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const h = React.createElement;
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 12)); });
const training = { id: 't', title: '训练名称', date: '2026-11-08', status: 'published', description: '训练简介' };
const videos = ['a', 'b', 'c', 'd'].map(id => ({ id, trainingId: 't', title: '合成视频 ' + id, status: 'active', source: 'bilibili', durationSec: null, url: 'https://www.bilibili.com/video/BV1KapokTest/?p=2' }));
const videosWithHidden = [...videos, { ...videos[0], id: 'hidden', title: '隐藏片名', status: 'hidden' }];
const response = (data, actor = 'A') => new Response(JSON.stringify({ data }), { headers: { 'X-Kapok-Actor': actor } });
const missing = actor => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '隐藏资源', retryable: false } }), { status: 404, headers: { 'X-Kapok-Actor': actor } });
let root, calls, role, visible, record, override, currentActor;
function setup(path = '/trainings/t') {
    window.history.replaceState({}, '', path);
    calls = [];
    role = 'member';
    visible = videos;
    record = training;
    override = null;
    globalThis.fetch = async (url, options) => {
        const route = String(url).replace('/api/v1/', '');
        const actor = options.headers['X-Kapok-Actor'] ?? currentActor;
        calls.push({ route, options });
        const injected = override?.(route, options, actor);
        if (injected) return injected;
        if (route === 'bootstrap') return response({ actorId: actor, me: { user: { id: 'user-' + actor, status: 'active' }, membership: { id: 'team', role, status: 'active', epoch: 1 } } }, actor);
        if (route === 'trainings/t' || route === 'trainings/t?view=member') return response({ ...record, videos: visible }, actor);
        const id = route.split('/')[1];
        const video = visible.find(v => v.id === id && v.status === 'active');
        if (!video) return missing(actor);
        if (route.endsWith('/comments')) return response([], actor);
        return response({ ...video, training: record }, actor);
    };
}
async function mount(props = {}) {
    currentActor = props.actorId ?? 'A';
    root ??= createRoot(document.getElementById('root'));
    await act(async () => root.render(h(TrainingWatch, { actorId: 'A', ...props })));
    await pause();
    await pause();
}
async function unmount() { await act(async () => root.unmount()); root = null; }
const cards = () => [...document.querySelectorAll('button[aria-pressed]')];
const picked = () => cards().find(card => card.getAttribute('aria-pressed') === 'true');
const reflection = () => document.querySelector('.video-content a[href^="/reflections/new"]')?.getAttribute('href');
const stage = () => document.querySelector('section[aria-label="视频播放器"]');
const youtubeAction = () => document.querySelector('.training-title-youtube');

test('training route opens watching directly and zero, one and four videos only expose applicable controls', async () => {
    for (const size of [0, 1, 4]) {
        setup();
        visible = videos.slice(0, size);
        try {
            await mount({ trainingId: 't' });
            assert.match(document.body.textContent, /训练名称.*训练简介/s);
            assert.equal(cards().length, size === 4 ? 4 : 0);
            assert.equal(!!document.querySelector('.discussion-composer'), size > 0);
            assert.equal(reflection(), '/reflections/new?training=t' + (size ? '&video=a' : ''));
            assert.equal(calls.some(call => call.route.includes('view=member')), false);
        } finally { await unmount(); }
    }
});

test('selection query restores an authorized ID, keeps the rail node focused on activation and ignores hidden IDs', async () => {
    setup('/trainings/t?video=b&view=member');
    role = 'admin';
    visible = videosWithHidden;
    try {
        await mount({ trainingId: 't', selectedVideoId: 'b', memberView: true });
        assert.match(picked().textContent, /合成视频 b/);
        assert.equal(cards().length, 4);
        assert.doesNotMatch(document.body.textContent, /隐藏片名/);
        assert.ok(calls.some(call => call.route === 'trainings/t?view=member'));
        const selected = cards()[2];
        selected.focus();
        await act(async () => selected.click());
        await pause();
        assert.equal(picked(), selected);
        assert.equal(document.activeElement, selected);
        assert.equal(window.location.search, '?view=member&video=c');
        assert.equal(reflection(), '/reflections/new?training=t&video=c');
    } finally { await unmount(); }
    setup('/trainings/t?video=hidden');
    visible = videosWithHidden;
    try {
        await mount({ trainingId: 't', selectedVideoId: 'hidden' });
        assert.match(picked().textContent, /合成视频 a/);
        assert.doesNotMatch(document.body.textContent, /隐藏片名/);
        assert.equal(calls.some(call => call.route.startsWith('videos/hidden')), false);
        assert.equal(window.location.search, '?video=a');
    } finally { await unmount(); }
});

test('selected rail label and authorized waiting stage follow the full video name and provider', async () => {
    setup();
    const title = '合成训练长标题'.repeat(12);
    const youtube = 'https://www.youtube.com/watch?v=abcdefghijk&t=0s';
    visible = [videos[0], { ...videos[1], title, source: 'youtube', url: youtube }, videosWithHidden.at(-1)];
    try {
        await mount({ trainingId: 't' });
        assert.equal(picked().querySelector('.training-rail-index').textContent, '01');
        assert.equal(stage().querySelector('strong').textContent, videos[0].title);
        assert.match(stage().textContent, /B 站/);
        assert.equal(document.querySelector('.video-source-disclosure').open, false);
        const next = cards()[1];
        assert.equal(next.tagName, 'BUTTON');
        assert.equal(next.title, title);
        assert.equal(next.getAttribute('aria-label'), '2. ' + title);
        await act(async () => next.click());
        await pause();
        assert.equal(picked().querySelector('.training-rail-index').textContent, '02');
        assert.ok(picked() === next);
        assert.equal(stage().querySelector('strong').textContent, title);
        assert.match(stage().textContent, /YouTube/);
        assert.equal(stage().querySelector('strong').closest('[hidden]'), null);
        assert.equal(stage().querySelector('a'), null);
        assert.equal(youtubeAction().href, youtube);
        assert.equal(button('载入 YouTube 视频').getAttribute('aria-label'), '载入 YouTube 视频：' + title);
        assert.doesNotMatch(document.body.textContent, /隐藏片名/);
    } finally { await unmount(); }
});

test('Bilibili keeps one original-site link and restores the waiting identity on iframe error', async () => {
    setup();
    function originalLink() {
        const links = stage().querySelectorAll('a');
        assert.equal(links.length, 1);
        assert.equal(links[0].href, videos[0].url);
        assert.equal(links[0].target, '_blank');
        assert.equal(links[0].closest('[hidden]'), null);
    }
    try {
        await mount({ trainingId: 't' });
        originalLink();
        await act(async () => button('载入 B 站视频').click());
        const frame = stage().querySelector('iframe');
        assert.ok(frame);
        assert.ok(!stage().querySelector('strong'));
        originalLink();
        await act(async () => frame.dispatchEvent(new Event('error')));
        assert.ok(!stage().querySelector('iframe'));
        assert.match(stage().querySelector('[role="alert"]').textContent, /B 站播放器加载失败/);
        assert.equal(stage().querySelector('strong').textContent, videos[0].title);
        originalLink();
        await act(async () => button('载入 B 站视频').click());
        assert.ok(stage().querySelector('iframe'));
        assert.ok(!stage().querySelector('strong'));
    } finally { await unmount(); }
});

test('YouTube restores waiting identity on error, then shows the provider slot after retry', async () => {
    setup();
    const youtube = 'https://www.youtube.com/watch?v=abcdefghijk&t=0s';
    visible = [{ ...videos[0], source: 'youtube', url: youtube }];
    const mounts = [];
    globalThis.mountTrainingTestYouTube = (slot, source, handlers) => {
        const element = document.createElement('video');
        slot.append(element);
        mounts.push({ element, source, handlers });
        return { element, destroy() {} };
    };
    const loader = registerHooks({
        resolve(specifier, context, next) {
            if (specifier.startsWith('/vendor/kapok-player/player-island.js?')) {
                return { url: 'data:text/javascript,export const mount = globalThis.mountTrainingTestYouTube', shortCircuit: true };
            }
            return next(specifier, context);
        }
    });
    function originalLink() {
        assert.equal(stage().querySelector('a'), null);
        const link = youtubeAction();
        assert.ok(link instanceof window.HTMLAnchorElement);
        assert.equal(link.href, youtube);
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
        assert.equal(link.closest('[hidden]'), null);
        assert.deepEqual([...document.querySelectorAll('.training-title-action')].map(action => action.getAttribute('aria-label')),
            ['在 YouTube 打开（新标签）', '收藏与备注', '写复盘']);
    }
    try {
        await mount({ trainingId: 't' });
        assert.equal(stage().querySelector('strong').textContent, videos[0].title);
        originalLink();
        await act(async () => button('载入 YouTube 视频').click());
        await pause();
        assert.ok(!stage().querySelector('strong'));
        assert.match(stage().querySelector('[role="status"]').textContent, /正在连接 YouTube/);
        assert.equal(mounts.length, 1);
        originalLink();

        await act(async () => mounts[0].handlers.error(null));
        assert.match(stage().querySelector('[role="alert"]').textContent, /连接 YouTube 失败/);
        assert.equal(mounts[0].element.isConnected, false);
        assert.equal(stage().querySelector('strong').textContent, videos[0].title);
        originalLink();
        await act(async () => button('重试 YouTube 视频').click());
        await pause();
        assert.equal(mounts.length, 2);
        assert.match(mounts[1].source, /^https:\/\/www\.youtube-nocookie\.com\/embed\//);
        await act(async () => mounts[1].handlers.ready(mounts[1].element));
        assert.equal(mounts[1].element.closest('[hidden]'), null);
        assert.ok(!stage().querySelector('strong'));
        assert.match(stage().querySelector('[role="status"]').textContent, /播放器已就绪/);
        originalLink();
    } finally {
        await unmount();
        loader.deregister();
        delete globalThis.mountTrainingTestYouTube;
    }
});

test('legacy deep link keeps comment anchor and second zero, and archived discussion is read-only', async () => {
    setup('/videos/b?t=0#comment-root');
    record = { ...training, status: 'archived' };
    override = (route, options, actor) => route === 'videos/b/comments' && response([{
        id: 'root', videoId: 'b', rootId: null, authorName: '队友', text: '历史讨论', status: 'active', timestampSec: 0, createdAt: '2026-11-08T02:24:00Z'
    }, comment('b'), { ...comment('b'), id: 'reply', rootId: 'root' }], actor);
    try {
        await mount({ legacyVideoId: 'b', initialSeconds: 0 });
        assert.match(picked().textContent, /合成视频 b/);
        assert.equal(window.location.hash, '#comment-root');
        assert.equal(document.activeElement.id, 'comment-root');
        const threadRows = document.querySelector('.training-discussion-threads').children;
        assert.equal(threadRows.length, 2);
        assert.ok(threadRows[0].querySelector('.discussion-replies #comment-reply'));
        assert.match(threadRows[0].querySelector('.video-time-chip').textContent, /00:00/);
        assert.ok(document.querySelector('.discussion-composer').hidden);
        await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '载入 B 站视频').click());
        assert.match(document.querySelector('iframe').src, /[?&]t=0(?:&|$)/);
    } finally { await unmount(); }
    setup('/videos/hidden');
    visible = videosWithHidden;
    try {
        await mount({ legacyVideoId: 'hidden' });
        assert.match(document.body.textContent, /当前不可用/);
        assert.doesNotMatch(document.body.textContent, /隐藏片名|训练名称/);
    } finally { await unmount(); }
});

test('return targets allow only bounded selected IDs and the existing validated deep links', () => {
    assert.equal(safeReturnTo('/trainings/t?view=member&video=b'), '/trainings/t?view=member&video=b');
    assert.equal(safeReturnTo('/trainings/t?video=b&video=c'), '/');
    assert.equal(safeReturnTo('/trainings/t?video=%2Fadmin'), '/');
    assert.equal(safeReturnTo('/trainings?video=b'), '/');
    assert.equal(safeReturnTo('/videos/b?t=0#comment-root'), '/videos/b?t=0#comment-root');
});

const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
const activeComposer = () => document.getElementById('comment-input');
async function type(node, value) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function pick(id) {
    const card = cards().find(card => card.textContent.endsWith(' ' + id));
    assert.ok(card);
    await act(async () => card.click());
    await pause();
}
const comment = id => ({ id: 'root-' + id, videoId: id, rootId: null, authorName: '队友', text: '讨论 ' + id, status: 'active', timestampSec: null, createdAt: '2026-11-08T02:24:00Z' });

test('legacy and canonical URLs share video-scoped top-level/reply drafts; late A read and B write cannot change C', async () => {
    setup('/videos/a?t=0');
    let finishRead, finishWrite, writing;
    override = (route, options, actor) => {
        if (/^videos\/./.test(route) && route.endsWith('/comments')) {
            const id = route.split('/')[1];
            if (id === 'b' && options.method === 'POST') {
                writing = options.signal;
                return new Promise(resolve => { finishWrite = () => resolve(response({}, actor)); });
            }
            if (id === 'a' && finishRead === true) return new Promise(resolve => { finishRead = () => resolve(response([comment(id)], actor)); });
            return response([comment(id)], actor);
        }
    };
    try {
        await mount({ legacyVideoId: 'a', initialSeconds: 0 });
        await type(activeComposer(), 'A 顶层');
        await act(async () => button('回复').click());
        await type(activeComposer(), 'A 回复');
        await pick('b');
        assert.equal(window.location.pathname, '/trainings/t');
        assert.equal(activeComposer().value, '');
        await type(activeComposer(), 'B 顶层');
        await act(async () => button('回复').click());
        await type(activeComposer(), 'B 回复');
        await act(async () => activeComposer().form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await pause();
        assert.ok(finishWrite);
        finishRead = true;
        await pick('a');
        assert.equal(typeof finishRead, 'function');
        assert.equal(writing.aborted, true);
        await pick('c');
        await type(activeComposer(), 'C 顶层');
        await act(async () => { finishRead(); finishWrite(); });
        await pause();
        assert.equal(activeComposer().value, 'C 顶层');
        assert.doesNotMatch(document.body.textContent, /回复已发送|讨论 a|讨论 b/);
        await pick('b');
        assert.equal(activeComposer().value, 'B 回复');
        await act(async () => button('取消回复').click());
        assert.equal(activeComposer().value, 'B 顶层');
        await pick('a');
        assert.equal(activeComposer().value, 'A 回复');
        assert.equal(window.location.hash, '');
        await act(async () => button('取消回复').click());
        assert.equal(activeComposer().value, 'A 顶层');
    } finally { await unmount(); }
});

test('private note save, failure, cancel, selection and account switches keep values in their own scope', async () => {
    setup();
    let saved = null, fail = false;
    let late, lateSignal;
    override = (route, options, actor) => {
        if (route === 'collections' && options.method === 'GET') return response(saved && actor === 'A' ? [saved] : [], actor);
        if (route === 'collections' || route === 'collections/saved') {
            if (fail) return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: '保存失败', retryable: true } }), { status: 503, headers: { 'X-Kapok-Actor': actor } });
            const body = JSON.parse(options.body);
            if (body.privateNote === 'A 迟到') {
                lateSignal = options.signal;
                return new Promise(resolve => { late = () => resolve(response({ id: 'saved' }, actor)); });
            }
            saved = { id: 'saved', sourceId: 'a', sourceKind: 'video', privateNote: body.privateNote, version: (saved?.version ?? 0) + 1 };
            return response({ id: 'saved' }, actor);
        }
    };
    const note = () => document.querySelector('.private-note textarea');
    const bookmark = () => document.querySelector('.training-title-bookmark');
    async function openNote(label, fill) {
        const trigger = bookmark();
        assert.equal(trigger.getAttribute('aria-label'), label);
        assert.equal(trigger.querySelector('svg').getAttribute('fill'), fill);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        await act(async () => trigger.click());
        assert.ok(!document.getElementById(trigger.getAttribute('aria-controls')).hidden);
    }
    try {
        await mount({ trainingId: 't' });
        await openNote('收藏与备注', 'none');
        await type(note(), 'A 已保存');
        await act(async () => button('保存私人备注').click());
        await pause();
        assert.match(document.querySelector('.private-note').textContent, /A 已保存/);
        assert.equal(bookmark().getAttribute('aria-label'), '已收藏，编辑备注');
        assert.equal(bookmark().querySelector('svg').getAttribute('fill'), 'currentColor');
        await act(async () => button('编辑已收藏备注').click());
        await type(note(), 'A 未保存');
        await act(async () => button('取消').click());
        assert.match(document.querySelector('.private-note').textContent, /A 已保存/);
        await act(async () => button('编辑已收藏备注').click());
        await type(note(), 'A 失败保留');
        fail = true;
        await act(async () => button('保存备注').click());
        await pause();
        assert.equal(note().value, 'A 失败保留');
        assert.match(document.querySelector('.private-note').textContent, /保存失败/);
        fail = false;
        await type(note(), 'A 迟到');
        await act(async () => button('保存备注').click());
        await pause();
        assert.ok(late);
        await pick('b');
        await openNote('收藏与备注', 'none');
        assert.equal(lateSignal.aborted, true);
        assert.equal(note().value, '');
        await type(note(), 'B 未保存');
        await act(async () => late());
        await pause();
        assert.equal(note().value, 'B 未保存');
        await pick('a');
        await openNote('已收藏，编辑备注', 'currentColor');
        assert.equal(note().value, 'A 迟到');
        await mount({ trainingId: 't', actorId: 'B' });
        await openNote('收藏与备注', 'none');
        assert.equal(note().value, '');
        assert.doesNotMatch(document.body.textContent, /A 迟到|A 已保存|B 未保存/);
    } finally { await unmount(); }
});

test('registered provider focus remains allowed, outside focus locks and unloads, and account-change rejects late discussion', async () => {
    setup();
    let late, lateSignal;
    override = (route, options, actor) => {
        if (route === 'videos/a/comments' && options.method === 'POST') {
            lateSignal = options.signal;
            return new Promise(resolve => { late = () => resolve(response({}, actor)); });
        }
    };
    try {
        await mount({ trainingId: 't' });
        const bookmark = document.querySelector('.training-title-bookmark');
        const notePanel = document.getElementById(bookmark.getAttribute('aria-controls'));
        await act(async () => bookmark.click());
        await act(async () => button('载入 B 站视频').click());
        const frame = document.querySelector('iframe');
        assert.equal(frame.dataset.kapokPlayer, 'bilibili');
        frame.focus();
        assert.equal(document.activeElement, frame);
        await act(async () => window.dispatchEvent(new Event('blur')));
        assert.ok(!frame.closest('[hidden]'));
        assert.equal(bookmark.closest('[hidden]'), null);
        assert.equal(notePanel.closest('[hidden]'), null);
        assert.match(frame.src, /^https:/);
        cards()[0].focus();
        await act(async () => window.dispatchEvent(new Event('blur')));
        assert.ok(frame.closest('[hidden]') || !frame.isConnected);
        assert.equal(frame.getAttribute('src'), 'about:blank');
        assert.ok(bookmark.closest('[hidden]'));
        assert.ok(notePanel.closest('[hidden]'));
        const waitingTitle = stage()?.querySelector('.training-stage-video-title');
        assert.ok(!waitingTitle || waitingTitle.closest('[hidden]'));

        await act(async () => window.dispatchEvent(new Event('focus')));
        await pause(); await pause();
        await type(activeComposer(), '账号 A 的私文');
        await act(async () => activeComposer().form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await pause();
        assert.ok(late);
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' })));
        assert.equal(lateSignal.aborted, true);
        await act(async () => late());
        await mount({ trainingId: 't', actorId: 'B' });
        assert.equal(activeComposer().value, '');
        assert.doesNotMatch(document.body.textContent, /账号 A 的私文|讨论已发送/);
    } finally { await unmount(); }
});

test('video removal falls back after recheck and clears earlier drafts while discussion network failure leaves authorized training visible', async () => {
    setup();
    let unavailable = false;
    override = (route, options, actor) => {
        if (route === 'videos/a/comments') {
            if (unavailable) return missing(actor);
            return response([comment('a')], actor);
        }
        if (route === 'videos/d/comments') return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: '评论读取失败', retryable: true } }), { status: 503, headers: { 'X-Kapok-Actor': actor } });
    };
    try {
        await mount({ trainingId: 't' });
        await type(activeComposer(), '已隐藏来源的私文');
        await pick('d');
        assert.match(document.body.textContent, /训练名称.*评论读取失败/s);
        assert.ok(picked() && !picked().closest('[hidden]'));
        unavailable = true;
        await pick('a');
        await pause(); await pause();
        assert.ok(!cards().some(card => card.textContent.endsWith(' a')));
        assert.match(picked().textContent, /合成视频 b/);
        assert.doesNotMatch(document.body.textContent, /已隐藏来源的私文/);
        assert.ok(calls.filter(call => call.route === 'trainings/t').length < 4, 'one read per rejected ID');
    } finally { await unmount(); }
});

test('ordinary admin viewing keeps management and moderation while explicit member preview keeps ordinary discussion', async () => {
    for (const memberView of [false, true]) {
        setup(memberView ? '/trainings/t?view=member' : '/trainings/t');
        role = 'admin';
        visible = videosWithHidden;
        override = (route, options, actor) => route === 'videos/a/comments' && response([comment('a')], actor);
        try {
            await mount({ trainingId: 't', memberView });
            assert.ok(calls.some(call => call.route === 'trainings/t?view=member'));
            assert.equal(!!button('管理员隐藏'), !memberView);
            assert.equal(!!document.querySelector('a.training-inline'), !memberView);
            assert.ok(button('回复'));
            assert.match(reflection(), /training=t&video=a/);
        } finally { await unmount(); }
    }
});

test('new reflection entries retain their individual authorized video return URLs', async () => {
    setup('/trainings/t?video=a');
    try {
        await mount({ trainingId: 't', selectedVideoId: 'a' });
        const openEditor = async () => {
            const link = document.querySelector('.video-content .video-reflection-link');
            link.addEventListener('click', event => event.preventDefault(), { once: true });
            await act(async () => link.click());
            window.history.pushState({}, '', link.getAttribute('href'));
            return { source: controlledBackSource(), state: window.history.state, href: window.location.href };
        };
        const first = await openEditor();
        assert.equal(first.source, '/trainings/t?video=a');
        window.history.pushState({}, '', '/trainings/t?video=a');
        await pick('b');
        const second = await openEditor();
        assert.equal(second.source, '/trainings/t?video=b');
        window.history.pushState(first.state, '', first.href);
        assert.equal(controlledBackSource(), first.source);
        window.history.pushState(second.state, '', second.href);
        assert.equal(controlledBackSource(), second.source);
        clearNavigationActor('A');
        assert.equal(controlledBackSource(), null);
    } finally { await unmount(); }
});

test('the player is immediately above the selector, with live full titles and source details bound below it', async () => {
    setup();
    const longTitle = '这是一段没有空格的长视频标题'.repeat(6).slice(0, 80);
    visible = [
        { ...videos[0], title: longTitle, publisherName: '第一位发布者' },
        { ...videos[1], publisherName: '第二位发布者' },
    ];
    try {
        await mount({ trainingId: 't' });
        const stage = document.querySelector('.training-watch-stage');
        const rail = document.querySelector('.training-rail');
        const metadata = () => document.querySelector('.video-detail-header');
        const status = rail.querySelector('[role="status"]');
        assert.equal(stage.nextElementSibling, rail);
        assert.ok(stage.querySelector('.video-stage'));
        assert.equal(stage.querySelector('.video-detail-header'), null);
        assert.ok(rail.compareDocumentPosition(metadata()) & window.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.match(metadata().textContent, /播放来源.*第一位发布者/s);
        assert.equal(status.querySelector('.sr-only').textContent, '当前视频 ' + longTitle + '，第 1 个，共 2 个');
        assert.match(picked().textContent, new RegExp(longTitle));
        await pick('b');
        assert.match(status.textContent, /当前 02 \/ 02/);
        assert.match(metadata().textContent, /播放来源.*第二位发布者/s);
        assert.doesNotMatch(metadata().textContent, /第一位发布者/);
    } finally { await unmount(); }
});

test('V5.1 groups the title and date beside named circular actions and opens the selected video note below the introduction', async () => {
    setup();
    try {
        await mount({ trainingId: 't' });
        const title = document.querySelector('.training-watch-title');
        const heading = title.querySelector('h2');
        const date = title.querySelector('time');
        assert.equal(heading.parentElement, date.parentElement);
        assert.equal(heading.nextElementSibling, date);
        const [bookmark, reflection] = title.querySelectorAll('.training-title-action');
        assert.ok(bookmark instanceof window.HTMLButtonElement);
        assert.equal(bookmark.getAttribute('aria-label'), '收藏与备注');
        assert.equal(reflection.getAttribute('aria-label'), '写复盘');
        assert.match(reflection.href, /training=t&video=a$/);
        const panel = document.getElementById(bookmark.getAttribute('aria-controls'));
        const intro = document.querySelector('.training-watch-info > .preserve');
        assert.ok(intro.compareDocumentPosition(panel) & window.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.ok(panel.hidden);
        bookmark.focus();
        await act(async () => bookmark.click());
        assert.equal(bookmark.getAttribute('aria-expanded'), 'true');
        assert.equal(document.activeElement, bookmark);
        assert.equal(panel.hidden, false);
        await act(async () => bookmark.click());
        assert.equal(bookmark.getAttribute('aria-expanded'), 'false');
        assert.ok(panel.hidden);
    } finally { await unmount(); }

    setup();
    visible = [];
    try {
        await mount({ trainingId: 't' });
        const actions = [...document.querySelectorAll('.training-watch-title .training-title-action')];
        assert.deepEqual(actions.map(action => action.getAttribute('aria-label')), ['写复盘']);
        assert.equal(actions[0].getAttribute('href'), '/reflections/new?training=t');
        assert.equal(document.querySelector('.private-note'), null);
    } finally { await unmount(); }
});


test('the YouTube title link uses the verified source and follows video switches and the inner lock', async () => {
    setup();
    const first = { ...videos[0], source: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa' };
    const verified = { ...first, title: '已授权的片名', url: 'https://m.youtube.com/shorts/ccccccccccc?start=1m2s' };
    const invalid = { ...videos[2], source: 'youtube', url: 'https://youtube.com.example/watch?v=bbbbbbbbbbb' };
    visible = [first, videos[1], invalid];
    let deferred, finishRead, readSignal, revoked;
    override = (route, options, actor) => {
        if (route !== 'videos/a') return;
        if (revoked) return missing(actor);
        if (!deferred) return response({ ...verified, training: record }, actor);
        readSignal = options.signal;
        return new Promise(resolve => { finishRead = () => resolve(response({ ...verified, training: record }, actor)); });
    };
    try {
        await mount({ trainingId: 't' });
        assert.equal(youtubeAction().href, 'https://www.youtube.com/watch?v=ccccccccccc&t=62s');
        assert.equal(stage().querySelector('strong').textContent, verified.title);
        assert.equal(document.querySelectorAll('a[href*="youtube.com/watch"]').length, 1);

        const link = youtubeAction();
        const providerSlot = link.parentElement;
        await act(async () => window.dispatchEvent(new Event('blur')));
        assert.ok(providerSlot.hidden);
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        assert.equal(link.dispatchEvent(click), false);

        await act(async () => window.dispatchEvent(new Event('focus')));
        await pause();
        assert.equal(youtubeAction().closest('[hidden]'), null);
        await pick('c');
        assert.equal(youtubeAction(), null);
        assert.match(stage().textContent, /YouTube 播放链接暂不可用/);

        deferred = true;
        await pick('a');
        assert.ok(finishRead);
        assert.equal(youtubeAction(), null);
        assert.doesNotMatch(stage()?.textContent ?? '', /已授权的片名/);
        await pick('b');
        assert.equal(readSignal.aborted, true);
        await act(async () => finishRead());
        assert.equal(youtubeAction(), null);
        assert.equal(stage().querySelector('strong').textContent, videos[1].title);

        deferred = false;
        await pick('a');
        assert.ok(youtubeAction());
        revoked = true;
        await act(async () => window.dispatchEvent(new Event('focus')));
        await pause(); await pause();
        assert.equal(youtubeAction(), null);
        assert.equal(stage().querySelector('strong').textContent, videos[1].title);
    } finally { await unmount(); }
});

test('direct video discussion still exposes its original-site YouTube link in the player', async () => {
    setup('/videos/a');
    visible = [{ ...videos[0], source: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa?start=2' }];
    currentActor = 'A';
    root = createRoot(document.getElementById('root'));
    try {
        await act(async () => root.render(h(VideoDiscussion, { actorId: 'A', videoId: 'a' })));
        await pause();
        const link = stage().querySelector('a');
        assert.equal(link?.href, 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=2s');
        assert.equal(link?.getAttribute('target'), '_blank');
        assert.equal(youtubeAction(), null);
    } finally { await unmount(); }
});
