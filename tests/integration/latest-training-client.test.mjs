import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { safeReturnTo } from '../../lib/server/return-to.ts';
import { confirmNavigationActor, controlledBackSource } from '../../lib/client/navigation-state.ts';
import { navigation } from '../helpers/next-stubs.mjs';

const h = React.createElement;
const actorId = 'A';
const training = { id: 't', title: '合成训练', date: '2026-11-08', description: '', status: 'published', version: 1 };
const video = { id: 'v', title: '合成视频', position: 0, source: 'bilibili', status: 'active', version: 1 };
const admin = { user: { id: 'u', status: 'active' }, profile: { discName: '合成管理员' }, membership: { id: 'm', teamId: 't', role: 'admin', status: 'active', epoch: 1 } };
const member = { ...admin, membership: { ...admin.membership, role: 'member' } };
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/admin/trainings/new', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'FormData', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { createRoot } = await import('react-dom/client');

const response = (data, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status, headers: { 'X-Kapok-Actor': actorId } });
let root;
let calls;
let override;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
function setup(path = '/admin/trainings/new', me = admin) {
    window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId }));
    window.history.replaceState({}, '', path);
    document.body.innerHTML = '<div id="root"></div>';
    navigation.length = 0;
    calls = [];
    override = null;
    globalThis.fetch = async (url, options) => {
        const path = String(url).replace('/api/v1/', '');
        calls.push({ path, options });
        const result = override?.(path, options);
        if (result) return result;
        if (path === 'bootstrap') return response({ actorId, me });
        if (path === 'me') return response(me);
        if (path === 'trainings') return response([training, { ...training, id: 'draft', status: 'draft', title: '管理员草稿' }]);
        if (path === 'uploads') return response({ items: [], nextCursor: null });
        if (path === 'trainings/t?view=member') return response({ ...training, videos: [video] });
        if (path === 'trainings/t') return response({ ...training, videos: [video, { ...video, id: 'hidden', status: 'hidden', title: '隐藏视频' }] });
        throw new Error('unexpected path ' + path);
    };
}
async function render(node) {
    root ??= createRoot(document.getElementById('root'));
    await act(async () => root.render(node));
    await flush();
}
async function unmount() { if (root) { await act(async () => root.unmount()); root = null; } }
const field = name => document.querySelector(`[name="${name}"]`);
async function input(name, value) {
    const element = field(name);
    await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function submit() {
    await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
}
const posts = () => calls.filter(call => call.options.method === 'POST');
const management = () => import('../../app/components/training-management.tsx');

test('publication validates required and partial optional video fields, preserves input and reports video errors', async () => {
    setup();
    const { TrainingManagement } = await management();
    try {
        await render(h(TrainingManagement, { actorId, mode: 'new' }));
        assert.equal(document.querySelector('select'), null);
        await submit();
        assert.equal(document.activeElement, field('title'));
        assert.equal(field('title').getAttribute('aria-invalid'), 'true');
        assert.match(document.getElementById(field('title').getAttribute('aria-describedby')).textContent, /训练名称/);
        await input('title', '我的训练');
        await submit();
        assert.equal(document.activeElement, field('date'));
        await input('date', '2026-11-08');
        await input('description', '输入仍应保留');
        await input('videoTitle', '我的视频');
        await submit();
        assert.equal(document.activeElement, field('videoLink'));
        assert.match(document.getElementById(field('videoLink').getAttribute('aria-describedby')).textContent, /B 站/);
        assert.equal(field('description').value, '输入仍应保留');
        await input('videoTitle', '');
        await input('videoLink', 'BV1xx411c7mD');
        await submit();
        assert.equal(document.activeElement, field('videoTitle'));
        assert.equal(posts().length, 0);
        await input('videoTitle', '我的视频');
        await input('videoLink', '无效链接');
        const error = '请填写BV号或B站视频地址。';
        override = path => path === 'trainings/publish' ? response({ error: { code: 'INVALID_INPUT', message: error, retryable: false } }, 400) : null;
        await submit();
        assert.equal(document.activeElement, field('videoLink'));
        assert.equal(document.getElementById(field('videoLink').getAttribute('aria-describedby')).textContent, error);
        assert.equal(field('videoLink').value, '无效链接');
    } finally { await unmount(); }
});

test('publication prevents duplicate submit, retries an unknown result after remount and focuses management heading', async () => {
    setup();
    const { TrainingManagement } = await management();
    try {
        await render(h(TrainingManagement, { actorId, mode: 'new' }));
        await input('title', '同页训练');
        await input('date', '2026-11-08');
        await input('videoLink', '【测试】 https://b23.tv/abc');
        await input('videoTitle', '同页视频');
        let fail;
        override = path => path === 'trainings/publish' ? new Promise((_, reject) => { fail = reject; }) : null;
        await submit();
        await submit();
        assert.equal(posts().length, 1);
        assert.equal(document.querySelector('button[type=submit]').disabled, true);
        await act(async () => fail(new Error('unknown result')));
        assert.match(document.querySelector('[role=alert]').textContent, /请求结果尚未确认/);
        await unmount();
        await render(h(TrainingManagement, { actorId, mode: 'new' }));
        assert.equal(field('videoTitle').value, '同页视频');
        override = path => path === 'trainings/publish' ? response({ training, video }) : null;
        await submit();
        const [first, retry] = posts();
        assert.deepEqual(JSON.parse(first.options.body), { title: '同页训练', date: '2026-11-08', description: '', video: { title: '同页视频', url: '【测试】 https://b23.tv/abc' } });
        assert.equal(retry.options.body, first.options.body);
        assert.equal(retry.options.headers['Idempotency-Key'], first.options.headers['Idempotency-Key']);
        assert.equal(navigation.at(-1), '/admin/trainings/t');
        await unmount();
        window.history.replaceState({}, '', '/admin/trainings/t');
        await render(h(TrainingManagement, { actorId, mode: 'detail', id: 't' }));
        assert.equal(document.activeElement, document.querySelector('#managed-training-title'));
        assert.match(document.querySelector('[role=status]').textContent, /训练已发布/);
    } finally { await unmount(); }
});

test('publication without video is atomic and a late success after account change cannot navigate', async () => {
    setup();
    const { TrainingManagement } = await management();
    try {
        await render(h(TrainingManagement, { actorId, mode: 'new' }));
        await input('title', '无视频');
        await input('date', '2026-11-08');
        let complete;
        override = path => path === 'trainings/publish' ? new Promise(resolve => { complete = resolve; }) : null;
        await submit();
        assert.deepEqual(JSON.parse(posts()[0].options.body), { title: '无视频', date: '2026-11-08', description: '' });
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
        await act(async () => complete(response({ training, video: null })));
        assert.equal(document.querySelector('form'), null);
        assert.deepEqual(navigation, []);
    } finally { await unmount(); }
});

test('member preview requests only the filtered training and never loads uploads', async () => {
    setup('/trainings/t?view=member');
    const { TrainingScreen } = await import('../../app/components/legacy-screens.tsx');
    try {
        await render(h(TrainingScreen, { actorId, id: 't', memberView: true }));
        assert.ok(calls.some(call => call.path === 'trainings/t?view=member'));
        assert.ok(!calls.some(call => call.path === 'trainings/t' || call.path === 'uploads'));
        assert.match(document.body.textContent, /队员视角预览/);
        assert.match(document.body.textContent, /合成视频/);
        assert.doesNotMatch(document.body.textContent, /隐藏视频/);
        assert.equal(document.querySelector('form'), null);
    } finally { await unmount(); }
});

test('return paths accept only explicit management routes and the exact training member view', () => {
    for (const path of ['/admin/trainings', '/admin/trainings/new', '/admin/trainings/t', '/admin/trainings/t/edit', '/trainings/t?view=member']) {
        assert.equal(safeReturnTo(path), path);
    }
    for (const path of ['/admin/trainings/new/edit', '/admin/trainings/t/remove', '/admin/trainings/t?view=member', '/trainings?view=member', '/trainings/t?view=admin', '/trainings/t?view=member&view=member', '/trainings/t?view=member&next=/me', '/trainings/t/extra?view=member']) {
        assert.equal(safeReturnTo(path), '/', path);
    }
});


test('client back source preserves only a canonical member-preview query', () => {
    setup('/trainings/t?view=member');
    confirmNavigationActor(actorId, 'route-stamp');
    const link = document.createElement('a');
    link.href = '/videos/v';
    link.addEventListener('click', e => e.preventDefault());
    document.body.append(link);
    for (const [source, expected] of [
        ['/trainings/t?view=member', '/trainings/t?view=member'],
        ['/trainings/t?view=member&view=member', '/trainings/t'],
        ['/trainings/t?view=member&extra=x', '/trainings/t'],
        ['/trainings/t?view=admin', '/trainings/t'],
        ['/trainings?view=member', '/trainings'],
        ['/admin/trainings/t?view=member', '/admin/trainings/t'],
    ]) {
        window.history.replaceState({}, '', source);
        link.click();
        window.history.replaceState({}, '', '/videos/v');
        assert.equal(controlledBackSource(), expected);
    }
});


test('actual admin list and My links are role-gated and the member library keeps date filtering', async () => {
    const { TrainingManagement } = await management();
    const { MyScreen, TrainingsScreen } = await import('../../app/components/legacy-screens.tsx');
    try {
        setup('/admin/trainings');
        await render(h(TrainingManagement, { actorId, mode: 'list' }));
        assert.ok(document.querySelector('a[href="/admin/trainings/new"]'));
        assert.match(document.querySelector('a[href="/admin/trainings/draft"]').textContent, /管理员草稿.*草稿/);
        await unmount();
        setup('/trainings');
        await render(h(TrainingsScreen, { actorId }));
        assert.ok(document.querySelector('a[href="/admin/trainings"]'));
        assert.ok(document.querySelector('a[href="/trainings/t"]'));
        assert.equal(document.querySelector('a[href="/trainings/draft"]'), null);
        await input('training-date', '2026-11-09');
        assert.match(document.body.textContent, /这一天还没有训练/);
        await unmount();
        for (const me of [admin, member]) {
            setup('/me', me);
            await render(h(MyScreen, { actorId }));
            assert.equal(!!document.querySelector('a[href="/admin/trainings"]'), me === admin);
            await unmount();
        }
        setup('/admin/trainings/t', member);
        await render(h(TrainingManagement, { actorId, mode: 'detail', id: 't' }));
        assert.match(document.querySelector('[role=alert]').textContent, /仅管理员/);
        assert.ok(!calls.some(call => call.path === 'trainings/t' || call.path === 'uploads'));
    } finally { await unmount(); }
});

test('managed archived training remains previewable and metadata edits return to management', async () => {
    const { TrainingManagement } = await management();
    const archived = { ...training, status: 'archived', videos: [video] };
    try {
        setup('/admin/trainings/t');
        override = path => path === 'trainings/t' ? response(archived) : null;
        await render(h(TrainingManagement, { actorId, mode: 'detail', id: 't' }));
        assert.equal(document.querySelector('button[aria-label="添加视频"]'), null);
        assert.equal(document.querySelector('.training-video-order form'), null);
        assert.ok(document.querySelector('a[href="/trainings/t?view=member"]'));
        assert.ok(document.querySelector('a[href="/admin/trainings/t/edit"]'));
        await unmount();
        setup('/admin/trainings/t/edit');
        override = (path, options) => path === 'trainings/t' ? response(options.method === 'PATCH' ? { ...archived, title: '改名', version: 2 } : archived) : null;
        await render(h(TrainingManagement, { actorId, mode: 'edit', id: 't' }));
        assert.equal(field('title').value, training.title);
        await input('title', '改名');
        await submit();
        const edit = calls.find(call => call.options.method === 'PATCH');
        assert.deepEqual(JSON.parse(edit.options.body), { title: '改名', date: training.date, description: '', status: 'archived', expectedVersion: 1 });
        assert.equal(navigation.at(-1), '/admin/trainings/t');
        assert.ok(!calls.some(call => call.path === 'uploads'));
    } finally { await unmount(); }
});
