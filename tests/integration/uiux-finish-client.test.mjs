import '../helpers/react-loader.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
// Only the framework's pathname is supplied; all product components and session guards remain real.
registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return { shortCircuit: true, url: 'data:text/javascript,export function usePathname(){return globalThis.testPathname ?? "/"};export function useRouter(){return {push(){}}}' };
    return next(specifier, context);
} });
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
dom.window.HTMLMediaElement.prototype.pause = function () {};
const { createRoot } = await import('react-dom/client');
const { ReflectionSharing, ReflectionRead, ReflectionEditor } = await import('../../app/components/reflections.tsx');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { Navigation } = await import('../../app/components/navigation.tsx');
const h = React.createElement;
const bootstrap = { siteUserId: 'A', me: { user: { id: 'user-A', status: 'active' }, membership: { status: 'active', role: 'admin', epoch: 1 } } };
const reflection = { id: 'r', title: '合成复盘', text: '原始正文', date: '2026-10-16', isAuthor: true, author: { id: 'user-A', discName: '合成作者', jerseyNumber: '07' }, version: 1, sharingVersion: 1, generation: 1, scope: 'private', published: false, trainingId: null, videoId: null, link: null };
const training = { id: 't', title: '合成训练', date: '2026-10-16', status: 'published' };
const video = { id: 'v', title: '合成短片', trainingId: 't', source: 'upload', status: 'active', durationSec: 60, training };
const comment = { id: 'c', authorId: 'user-A', authorName: '合成作者', text: '合成讨论', rootId: null, timestampSec: 4, status: 'active', version: 1, createdAt: '2026-10-16' };
let root, calls, override, data;
const response = value => new Response(JSON.stringify({ data: value }), { headers: { 'X-Kapok-Actor': 'A' } });
function setup() {
    window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' }));
    localStorage.clear(); calls = []; override = null;
    data = { bootstrap, 'reflections/r/edit': reflection, 'reflections/r': reflection, 'videos/v': video, 'videos/v/comments': [comment] };
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('/api/v1/', ''); calls.push({ path, options });
        const result = await override?.(path, options);
        return result ?? response(data[path] ?? []);
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    window.confirm = () => true;
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function mount(node) { document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')); await act(async () => root.render(node)); await flush(); }
async function unmount() { await act(async () => root?.unmount()); root = null; }
const buttons = text => [...document.querySelectorAll('button')].filter(b => b.textContent.includes(text));
async function click(text) { const b = buttons(text)[0]; assert.ok(b, text); await act(async () => b.click()); await flush(); }
async function selectScope(value) { const node = document.querySelector(`input[type=radio][value=${value}]`); assert.ok(node); await act(async () => node.click()); await flush(); }
async function input(node, value) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function lifecycle(name) { await act(async () => window.dispatchEvent(new Event(name))); await flush(); }
const writes = () => calls.filter(c => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.options.method));

test('two-scope UI offers only private/team, cancels without write and keeps publication independent', async () => {
    setup();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        assert.equal(document.querySelector('.status-label').textContent, '仅自己');
        assert.deepEqual([...document.querySelectorAll('input[type=radio]')].map(x => x.value), ['private', 'team']);
        assert.equal(calls.some(c => c.path === 'coaches'), false);
        await selectScope('team');
        let confirmation;
        window.confirm = text => { confirmation = text; return false; };
        await click('确认阅读范围');
        assert.match(confirmation, /全队.*不会进入首页动态/);
        assert.equal(writes().length, 0);
        assert.equal(document.querySelector('input[type=radio]:checked').value, 'team');
        window.confirm = () => true;
        override = (path, options) => {
            if (path !== 'reflections/r/grants' || options.method !== 'PUT') return null;
            assert.deepEqual(JSON.parse(options.body), { expectedVersion: 1, expectedSharingVersion: 1, expectedGeneration: 1, scope: 'team' });
            data['reflections/r/edit'] = { ...reflection, scope: 'team', sharingVersion: 2 };
            return response(data['reflections/r/edit']);
        };
        await click('确认阅读范围');
        assert.equal(writes().length, 1);
        assert.match(document.querySelector('.status-label').textContent, /全队可读.*未发布/);
        assert.equal(buttons('发布到动态').length, 1);
        assert.equal(calls.some(c => c.path.endsWith('/publication')), false);
        assert.equal(calls.some(c => c.path === 'coaches'), false);
    } finally { await unmount(); }
});
test('two-scope author reads and session revalidation never request a coaches list', async () => {
    setup();
    try {
        await mount(h(ReflectionRead, { actorId: 'A', id: 'r', saved: false }));
        await lifecycle('blur'); await lifecycle('focus');
        assert.equal(calls.some(c => c.path === 'coaches'), false);
        assert.equal(document.body.textContent.includes('指定教练'), false);
    } finally { await unmount(); }
});
test('UIUX nonauthor never requests coaches; author copy progress, success and rejection have matching semantics', async () => {
    setup(); data['reflections/r'] = { ...reflection, isAuthor: false };
    try { await mount(h(ReflectionRead, { actorId: 'A', id: 'r', saved: false })); assert.equal(calls.some(c => c.path === 'coaches'), false); } finally { await unmount(); }
    setup(); let finish;
    navigator.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
    try {
        await mount(h(ReflectionRead, { actorId: 'A', id: 'r', saved: false }));
        await click('复制阅读链接');
        let notice = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('复制'));
        assert.ok(notice); assert.ok(!notice.classList.contains('success'));
        await act(async () => finish()); await flush();
        notice = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('链接已复制'));
        assert.ok(notice?.classList.contains('success'));
        navigator.clipboard.writeText = async () => { throw new Error('denied'); };
        await click('复制阅读链接');
        assert.match(document.querySelector('[role=alert]').textContent, /未能复制/);
        assert.ok(!document.body.textContent.includes('链接已复制'));
    } finally { await unmount(); }
});
test('UIUX seek is neutral until seeked, failures alert, and comment secondary actions use native named disclosure', async () => {
    setup();
    try {
        await mount(h(VideoDiscussion, { actorId: 'A', videoId: 'v' }));
        await click('讨论时间点');
        let feedback = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('未就绪'));
        assert.ok(feedback); assert.ok(!feedback.classList.contains('success'));
        const media = document.querySelector('video');
        Object.defineProperty(media, 'readyState', { configurable: true, value: 1 });
        Object.defineProperty(media, 'duration', { configurable: true, value: 60 });
        await act(async () => media.dispatchEvent(new Event('canplay')));
        await click('讨论时间点');
        feedback = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('正在定位'));
        assert.ok(feedback); assert.ok(!feedback.classList.contains('success'));
        await act(async () => media.dispatchEvent(new Event('seeked')));
        feedback = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('播放器已定位'));
        assert.ok(feedback?.classList.contains('success'));
        Object.defineProperty(media, 'currentTime', { configurable: true, get: () => 4, set() { throw new Error('seek failed'); } });
        await click('讨论时间点');
        assert.match(document.querySelector('[role=alert]').textContent, /未能跳转/);
        assert.ok(!document.body.textContent.includes('播放器已定位'));
        const article = document.querySelector('.discussion');
        const details = article.querySelector('details'); assert.ok(details); assert.equal(details.open, false);
        assert.match(details.querySelector('summary').textContent, /更多操作/);
        for (const label of ['编辑本人讨论', '删除', '举报', '管理员隐藏']) assert.ok([...details.querySelectorAll('button')].some(b => b.textContent.includes(label)));
        assert.equal(buttons('回复')[0].closest('details'), null);
        assert.equal(buttons('加入成长')[0].closest('details'), null);
    } finally { await unmount(); }
});
test('UIUX Bilibili copy progress and rejection do not retain earlier success', async () => {
    setup(); data['videos/v'] = { ...video, source: 'bilibili', url: 'https://www.bilibili.com/video/BV1synthetic' };
    let finish; navigator.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
    try {
        await mount(h(VideoDiscussion, { actorId: 'A', videoId: 'v' })); await click('复制地址');
        assert.ok([...document.querySelectorAll('[role=status]')].some(n => /复制/.test(n.textContent) && !n.classList.contains('success')));
        await act(async () => finish()); await flush();
        assert.ok([...document.querySelectorAll('[role=status]')].some(n => /地址已复制/.test(n.textContent) && n.classList.contains('success')));
        navigator.clipboard.writeText = async () => { throw new Error('denied'); }; await click('复制地址');
        assert.match(document.querySelector('[role=alert]').textContent, /复制未成功/);
        assert.ok(!document.body.textContent.includes('地址已复制'));
    } finally { await unmount(); }
});
test('UIUX video and reflection reading select their owning primary nav with aria-current', async () => {
    for (const [path, expected] of [['/videos/v', '/trainings'], ['/reflections/r', '/growth'], ['/trainings/t', '/trainings'], ['/growth', '/growth'], ['/me/data', '/me'], ['/members', '/'], ['/members/u', '/'], ['/activity', '/'], ['/announcements/a', '/'], ['/', '/']]) {
        setup(); globalThis.testPathname = path;
        try {
            await mount(h(Navigation));
            assert.equal(document.querySelector('[aria-current=page]')?.getAttribute('href'), expected);
            assert.equal(document.querySelectorAll('.selected').length, 1);
            assert.ok(document.querySelector('[aria-current=page]').classList.contains('selected'));
        } finally { await unmount(); }
    }
});
test('B in-form save prevents duplicate submits while preserving later input', async () => {
    for (const activation of ['click', 'submit']) {
        setup(); data['reflections/r/edit'] = { ...reflection, scope: 'private' };
        let finish;
        override = (path, options) => path === 'reflections/r' && options.method === 'PATCH' ? new Promise(resolve => { finish = resolve; }) : null;
        try {
            await mount(h(ReflectionEditor, { actorId: 'A', id: 'r' }));
            const saves = buttons('保存记录'); assert.equal(saves.length, 1);
            await input(document.querySelector('textarea'), '当前输入');
            // Rapid activation and native form submission must share the same in-flight guard.
            await act(async () => { saves[0].click(); if (activation === 'click') saves[0].click(); else saves[0].form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); }); await flush();
            assert.equal(writes().length, 1);
            assert.ok(saves.every(b => b.disabled));
            await input(document.querySelector('textarea'), '保存期间的后续输入');
            const body = JSON.parse(writes()[0].options.body);
            await act(async () => finish(response({ ...reflection, ...body, version: 2, scope: 'private' })));
            await flush();
            assert.equal(document.querySelector('textarea').value, '保存期间的后续输入');
            assert.match(document.body.textContent, /当前输入仍未上云/);
            assert.ok(buttons('保存记录').every(b => !b.disabled));
        } finally { await unmount(); }
    }
});


test('two-scope sharing failure preserves selection and permits same-key retry without publishing', async () => {
    setup();
    let attempts = 0;
    override = (path, options) => {
        if (path !== 'reflections/r/grants' || options.method !== 'PUT') return null;
        attempts++;
        if (attempts === 1) return new Response(JSON.stringify({ error: { code: 'RESULT_UNKNOWN', message: '合成保存暂不可用' } }), { status: 503, headers: { 'X-Kapok-Actor': 'A' } });
        data['reflections/r/edit'] = { ...reflection, scope: 'team', sharingVersion: 2 };
        return response(data['reflections/r/edit']);
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team');
        await click('确认阅读范围');
        assert.match(document.querySelector('[role=alert]').textContent, /保存暂不可用/);
        assert.equal(document.querySelector('input[type=radio]:checked').value, 'team');
        await click('确认阅读范围');
        assert.equal(attempts, 2);
        assert.equal(writes()[0].options.headers['Idempotency-Key'], writes()[1].options.headers['Idempotency-Key']);
        assert.match(document.querySelector('.status-label').textContent, /全队可读.*未发布/);
        assert.equal(calls.some(c => c.path === 'coaches' || c.path.endsWith('/publication')), false);
    } finally { await unmount(); }
});
test('UIUX native comment disclosures preserve member, author, admin and archived action permissions', async () => {
    for (const [role, own, status, archived] of [['member', false, 'active', false], ['member', true, 'active', false], ['admin', false, 'hidden', false], ['admin', true, 'active', true]]) {
        setup();
        data.bootstrap = { ...bootstrap, me: { ...bootstrap.me, membership: { ...bootstrap.me.membership, role } } };
        data['videos/v/comments'] = [{ ...comment, authorId: own ? 'user-A' : 'user-other', status, text: status === 'hidden' ? null : comment.text }];
        if (archived) data['videos/v'] = { ...video, training: { ...training, status: 'archived' } };
        try {
            await mount(h(VideoDiscussion, { actorId: 'A', videoId: 'v' }));
            const article = document.querySelector('.discussion');
            const labels = [...article.querySelectorAll('details button')].map(b => b.textContent.trim());
            assert.equal(labels.includes('编辑本人讨论'), own && !archived && status === 'active');
            assert.equal(labels.includes('删除'), own && !archived && status === 'active');
            assert.equal(labels.includes('管理员隐藏'), role === 'admin' && status === 'active');
            assert.equal(labels.includes('管理员恢复'), role === 'admin' && status === 'hidden');
            if (labels.includes('删除')) {
                window.confirm = () => false;
                const details = article.querySelector('details');
                await act(async () => { details.open = true; });
                await click('删除');
                assert.equal(writes().length, 0);
            }
            assert.equal(article.querySelector('summary').getAttribute('role'), null, 'retain native disclosure semantics');
        } finally { await unmount(); }
    }
});
