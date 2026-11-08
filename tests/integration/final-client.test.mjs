import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { safeReturnTo } from '../../lib/server/domain.ts';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'FormData', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class Channel {
    static items = new Set();
    constructor() { Channel.items.add(this); }
    postMessage(data) { for (const c of Channel.items) if (c !== this) c.onmessage?.({ data }); }
    close() { Channel.items.delete(this); }
}
globalThis.BroadcastChannel = Channel;
let pauses = 0;
let plays = 0;
dom.window.HTMLMediaElement.prototype.pause = function () { pauses += 1; };
dom.window.HTMLMediaElement.prototype.play = function () { plays += 1; return Promise.resolve(); };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
const { createRoot } = await import('react-dom/client');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { CollectionList } = await import('../../app/components/collections.tsx');
const { AccountBoundary, useAccountSession } = await import('../../app/components/secure-resource.tsx');
const { TrainingForm, VideoEditForm, AddVideoDialog, UploadCleanup } = await import('../../app/components/training-forms.tsx');
const { ProfileEditor: MyScreen } = await import('../../app/components/profile-editor.tsx');
const { MemberManagement, PersonalData, ReflectionRecycle } = await import('../../app/components/data-rights.tsx');
const { HomeScreen, TrainingsScreen, TrainingScreen, JoinScreen, MyScreen: AccountScreen } = await import('../../app/components/legacy-screens.tsx');
const { TrainingManagement } = await import('../../app/components/training-management.tsx');
const { navigation } = await import('../helpers/next-stubs.mjs');
const h = React.createElement;
const me = { user: { id: 'user-A', status: 'active' }, profile: { discName: 'private A name', jerseyNumber: '07', version: 1 }, membership: { id: 'm', teamId: 't', status: 'active', role: 'admin', epoch: 1, version: 1 }, team: { id: 't', name: 'private team', description: 'private description' } };
const bootstrap = { actorId: 'A', siteUserId: 'A', initialized: true, canBootstrap: false, me };
const training = { id: 't', title: 'private training', date: '2026-10-16', description: 'private training body', status: 'published', version: 1, videos: [] };
const video = { id: 'v', title: 'private video', trainingId: 't', source: 'upload', status: 'active', version: 1, position: 0, durationSec: 60, training };
const comment = { id: 'c', videoId: 'v', authorId: 'user-A', authorName: 'private A name', text: 'withdrawn body', rootId: null, timestampSec: 4, status: 'active', version: 1, createdAt: '2026-10-16' };
const item = { id: 'b', sourceId: 'v', sourceKind: 'video', privateNote: 'saved note', timestampSec: 4, version: 1, createdAt: '2026-10-16', source: { title: 'source', href: '/videos/v' } };
const videoProps = { actorId: 'A', videoId: 'v', userId: 'user-A', admin: true, video, initialComments: [comment] };
let root;
let calls;
let state;
let override;
const response = (data, actor = 'A', status = 200) => new Response(JSON.stringify(status === 200 ? { data } : { error: { code: 'UNAUTHENTICATED', message: 'expired', retryable: true } }), { status, headers: actor ? { 'X-Kapok-Actor': actor } : {} });
function resetNetwork() {
    window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' }));
    window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'B' }));
    calls = []; navigation.length = 0; state = { bootstrap, me, video, comments: [comment], items: [item] }; override = null;
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('/api/v1/', '');
        calls.push({ path, options });
        if (override) { const result = await override(path, options); if (result) return result; }
        const data = path === 'bootstrap' ? state.bootstrap : path === 'me' ? state.me : path === 'videos/v' ? state.video : path === 'videos/v/comments' ? state.comments : path === 'collections' ? state.items : path === 'trainings' ? [training] : path === 'trainings/t' ? { ...training, videos: [video] } : path === 'uploads' ? {items:[],nextCursor:null} : [];
        return response(data);
    };
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function mount(node) {
    resetNetwork();
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById('root'));
    await act(async () => { root.render(node); });
    await flush();
}
async function unmount() { if (root) { await act(async () => root.unmount()); root = null; } }
async function click(text) {
    const button = [...document.querySelectorAll('button')].find(x => x.textContent.includes(text) || x.getAttribute('aria-label') === text);
    assert.ok(button, `button ${text}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await flush();
}
async function input(node, value) {
    assert.ok(node, 'input must exist before editing');
    const prototype = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
        node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
}
async function submit(form) { assert.ok(form, 'form must exist before submitting'); await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await flush(); }
async function signal(type, actor = 'A') { await act(async () => window.dispatchEvent(new CustomEvent(type, { detail: actor }))); await flush(); }
async function lifecycle(type) { await act(async () => window.dispatchEvent(new dom.window.Event(type))); await flush(); }
function hidden(node) { return !!node.closest('[hidden]'); }
function boundary(child) { return h(AccountBoundary, { actorId: 'A', load: 'me' }, () => child); }

test('final I2 video focus installs current comments/training metadata and denies writes', async () => {
    try {
        await mount(h(VideoDiscussion, videoProps));
        assert.match(document.body.textContent, /withdrawn body/);
        await lifecycle('blur');
        state.video = { ...video, title: 'fresh title', training: { ...training, status: 'archived' } };
        state.comments = [{ ...comment, text: null, status: 'hidden' }];
        await lifecycle('focus');
        assert.ok(!document.body.textContent.includes('withdrawn body'));
        assert.match(document.body.textContent, /fresh title/);
        assert.equal(document.querySelector('#comment-input')?.closest('form')?.hidden ?? true, true);
        assert.ok(calls.filter(x => x.path === 'videos/v/comments').length >= 2);
    } finally { await unmount(); }
});
test('final I3 collection unsent input survives temporary failure and same A expiry but ends for B', async () => {
    try {
        await mount(h(CollectionList, { actorId: 'A', initial: [item] }));
        await click('编辑私人备注');
        const note = document.querySelector('textarea');
        await input(note, 'exact unsent note');
        await lifecycle('blur');
        override = path => path === 'bootstrap' ? Promise.reject(new Error('offline')) : null;
        await lifecycle('focus');
        assert.equal(document.querySelector('textarea')?.value, 'exact unsent note');
        assert.ok(hidden(note));
        override = null;
        await signal('kapok-session-expired');
        await click('重新确认');
        assert.equal(document.querySelector('textarea').value, 'exact unsent note');
        assert.ok(!hidden(document.querySelector('textarea')));
        await signal('kapok-account-changed', 'other');
        assert.equal(document.querySelector('textarea').value, 'exact unsent note');
        await signal('kapok-account-changed');
        assert.equal(document.querySelector('textarea'), null);
        await lifecycle('focus');
        assert.equal(document.querySelector('textarea'), null);
    } finally { await unmount(); }
});
test('final I7 actual training/video status cancel has no write and retains values', async () => {
    for (const status of ['published', 'archived', 'hidden', 'deleted']) {
        try {
            await mount(boundary(h(TrainingForm, { actorId: 'A', training: { ...training, status: 'draft' } })));
            document.querySelector('select').value = status;
            await submit(document.querySelector('form'));
            const dialog = document.querySelector('dialog[open]');
            assert.ok(dialog);
            assert.match(dialog.textContent, /private training/);
            await click('取消');
            assert.equal(dialog.open, false);
            assert.equal(calls.filter(x => x.options.method === 'PATCH').length, 0);
            assert.equal(document.querySelector('select').value, status);
            assert.equal(document.querySelector('[name=title]').value, training.title);
        } finally { await unmount(); }
    }
    for (const status of ['hidden', 'deleted']) {
        try {
            await mount(boundary(h(VideoEditForm, { actorId: 'A', video })));
            document.querySelector('select').value = status;
            let confirmations = 0;
            window.confirm = () => { confirmations += 1; return false; };
            await submit(document.querySelector('form'));
            assert.equal(confirmations, 1);
            assert.equal(calls.filter(x => x.options.method === 'PATCH').length, 0);
            assert.equal(document.querySelector('select').value, status);
        } finally { await unmount(); }
    }
});
test('final I6 safe new routes preserve query/hash and reject unsafe shapes', () => {
    for (const path of ['/reflections/new?training=t', '/reflections/r/edit', '/reflections/r/sharing', '/announcements/a#body', '/activity?cursor=x', '/me/recycle', '/admin/announcements']) assert.equal(safeReturnTo(path), path);
    for (const path of ['/videos/x%2Fy', '/reflections/r%5cfoo', '/activity%0a', '//evil', '/auth', '/me/unimplemented', '/reflections/r/unknown']) assert.equal(safeReturnTo(path), '/');
});

test('final I4 mounted profile replay reports differing current truth and retains visible X', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        const name = document.querySelector('[name=discName]');
        await input(name, 'X');
        let patchCalls = 0;
        override = (path, options) => {
            if (path === 'me' && options.method === 'PATCH') {
                patchCalls += 1;
                if (patchCalls === 1) throw new Error('lost response');
                return response({ me: { ...me, profile: { ...me.profile, discName: 'Y', version: 3 } } });
            }
            return null;
        };
        await submit(name.closest('form'));
        const newer = { ...me, profile: { ...me.profile, discName: 'Y', version: 3 } };
        state.me = newer;
        state.bootstrap = { ...bootstrap, me: newer };
        await lifecycle('focus');
        await submit(name.closest('form'));
        assert.equal(name.value, 'X');
        assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
        assert.match(document.body.textContent, /上方输入.*仍未保存/);
        assert.match(document.body.textContent, /Y \/ 07/);
        const writes = calls.filter(c => c.options.method === 'PATCH');
        assert.equal(writes.length, 2);
        assert.equal(writes[0].options.headers['Idempotency-Key'], writes[1].options.headers['Idempotency-Key']);
        assert.equal(writes[0].options.body, writes[1].options.body);
    } finally { await unmount(); }
});
test('final I4 mounted profile edit during request never claims new buffer saved', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        let finish;
        override = (path, options) => path === 'me' && options.method === 'PATCH' ? new Promise(resolve => { finish = resolve; }) : null;
        const name = document.querySelector('[name=discName]');
        await input(name, 'X');
        await submit(name.closest('form'));
        await input(name, 'new unsent buffer');
        await act(async () => finish(response({ me: { ...me, profile: { ...me.profile, discName: 'X', version: 2 } } })));
        assert.equal(name.value, 'new unsent buffer');
        assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
        assert.match(document.body.textContent, /尚未保存/);
    } finally { await unmount(); }
});
test('final C1 deleted My and onboarding accounts remain locked', async () => {
    for (const component of [MyScreen, JoinScreen]) {
        try {
            await mount(h(component, { actorId: 'A', returnTo: '/' }));
            state.bootstrap = { ...bootstrap, me: { user: { id: 'user-A', status: 'deleted' }, profile: null, membership: null, team: null } };
            await lifecycle('focus');
            assert.ok([...document.querySelectorAll('[data-kapok-sensitive]')].every(node => node.hidden));
            const count = calls.length;
            if (document.querySelector('form')) await submit(document.querySelector('form'));
            assert.equal(calls.slice(count).filter(c => c.options.method && c.options.method !== 'GET').length, 0);
        } finally { await unmount(); }
    }
});
test('final M1 whitespace rejection maps field errors, stable ids and first invalid focus', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        override = (path, options) => path === 'me' && options.method === 'PATCH' ? new Response(JSON.stringify({ error: { code: 'INVALID_INPUT', message: '盘名需为1–20字。', retryable: false } }), { status: 400, headers: { 'X-Kapok-Actor': 'A' } }) : null;
        const name = document.querySelector('[name=discName]');
        const id = name.id;
        await input(name, '   ');
        await submit(name.closest('form'));
        assert.equal(name.id, id);
        assert.equal(name.getAttribute('aria-invalid'), 'true');
        const errorId = name.getAttribute('aria-describedby').split(' ').at(-1);
        assert.match(document.getElementById(errorId).textContent, /1–20/);
        assert.equal(document.activeElement, name);
        assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 0);
    } finally { await unmount(); }
});
test('final C1 all delivered legacy mounted screens synchronously conceal and permanently end', async () => {
    const cases = [
        [HomeScreen, {}], [TrainingsScreen, {}], [TrainingScreen, { id: 't' }], [MyScreen, {}],
        [JoinScreen, { returnTo: '/' }],
        [VideoDiscussion, videoProps]
    ];
    for (const [component, props] of cases) {
        try {
            await mount(h(component, { actorId: 'A', ...props }));
            const surfaces = [...document.querySelectorAll('[data-kapok-sensitive]')];
            assert.ok(surfaces.length);
            await act(async () => {
                window.dispatchEvent(new dom.window.Event('pagehide'));
                assert.ok(surfaces.every(node => node.hidden));
            });
            await lifecycle('pageshow');
            assert.ok(!document.querySelector('[data-kapok-sensitive]').hidden);
            await act(async () => {
                window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' }));
                assert.ok(surfaces.every(node => node.hidden));
            });
            await lifecycle('focus');
            assert.ok([...document.querySelectorAll('[data-kapok-sensitive]')].every(node => node.hidden));
            assert.ok(!document.body.textContent.includes('private A name'));
        } finally { await unmount(); }
    }
});
test('final C1 B between verified bootstrap and resource never installs payload or reopens A', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        await input(document.querySelector('[name=discName]'), 'unsent A secret');
        override = path => path === 'me' ? response({ ...me, profile: { ...me.profile, discName: 'B secret' } }, 'B') : null;
        await lifecycle('focus');
        assert.equal(document.querySelector('input'), null);
        assert.ok(!document.body.textContent.includes('B secret'));
        override = null;
        await lifecycle('focus');
        assert.equal(document.querySelector('input'), null);
    } finally { await unmount(); }
});
test('final C1 older success after a newer verification failure cannot reveal', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        let finish;
        let requests = 0;
        override = path => {
            if (path !== 'me') return null;
            requests += 1;
            return requests === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.reject(new Error('newer failure'));
        };
        await lifecycle('focus');
        await lifecycle('focus');
        await act(async () => finish(response(me)));
        await flush();
        assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
        assert.match(document.body.textContent, /newer failure/);
    } finally { await unmount(); }
});
test('final C1 cleanup getter/removal failures still hide actual My and old callback stays ended', async () => {
    for (const mode of ['getter', 'remove']) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        try {
            await mount(h(MyScreen, { actorId: 'A' }));
            let finish;
            override = (path, options) => path === 'me' && options.method === 'PATCH' ? new Promise(resolve => { finish = resolve; }) : null;
            await submit(document.querySelector('form'));
            Object.defineProperty(globalThis, 'localStorage', {
                configurable: true,
                get() {
                    assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
                    if (mode === 'getter') throw new Error('storage denied');
                    return { length: 1, key: () => 'kapok:reflection-draft:A:d', removeItem() { throw new Error('remove denied'); } };
                }
            });
            await signal('kapok-account-changed');
            await act(async () => finish(response({ me })));
            await lifecycle('focus');
            assert.equal(document.querySelector('input'), null);
            assert.match(document.body.textContent, /未确认清理成功/);
        } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); await unmount(); }
    }
});
test('final I3 video exact comment/reply/edit/note/second and actual position survive scoped temporary locks', async () => {
    try {
        await mount(h(VideoDiscussion, videoProps));
        await click('回复');
        const text = document.querySelector('#comment-input');
        await input(text, 'unsent reply');
        await input(document.querySelector('input[type=number]'), '17');
        await click('加入成长');
        const note = document.querySelector('textarea[name=note]');
        await input(note, 'unsent collection note');
        const media = document.querySelector('video');
        media.currentTime = 28.5;
        const previousPauses = pauses;
        override = path => path === 'bootstrap' ? response(null, null, 401) : null;
        await lifecycle('focus');
        assert.ok(hidden(text));
        assert.equal(text.value, 'unsent reply');
        assert.equal(note.value, 'unsent collection note');
        assert.ok(pauses > previousPauses);
        override = null;
        await click('重新确认');
        assert.equal(document.querySelector('#comment-input'), text);
        assert.equal(text.value, 'unsent reply');
        assert.equal(note.value, 'unsent collection note');
        assert.equal(document.querySelector('input[type=number]').value, '17');
        assert.match(document.body.textContent, /正在回复 自己/);
        assert.equal(document.querySelector('video'), media);
        assert.equal(media.currentTime, 28.5);
        assert.equal(plays, 0);
        const channel = new Channel();
        await act(async () => channel.postMessage({ actorId: 'other', kind: 'ended' }));
        await flush();
        channel.close();
        assert.equal(text.value, 'unsent reply');
        await click('编辑本人讨论');
        await input(text, 'unsent edit');
        await signal('kapok-session-expired');
        await click('重新确认');
        assert.equal(text.value, 'unsent edit');
        assert.match(document.body.textContent, /正在编辑本人讨论/);
        await signal('kapok-account-changed');
        assert.equal(document.querySelector('#comment-input'), null);
        assert.equal(document.querySelector('video'), null);
        await lifecycle('focus');
        assert.equal(document.querySelector('textarea'), null);
    } finally { await unmount(); }
});

test('final C1 late profile/join/training/video responses cannot expose or navigate after end', async () => {
    const cases = [
        { screen: () => h(MyScreen, { actorId: 'A' }), path: 'me', result: { me }, prepare: async () => {} },
        { screen: () => h(JoinScreen, { actorId: 'A', returnTo: '/reflections/r' }), path: 'join', result: { me, returnTo: '/reflections/r' }, prepare: async () => {
            state.bootstrap = { ...bootstrap, me: { user: null, profile: null, membership: null, team: null } };
            await lifecycle('focus');
            navigation.length = 0;
            await input(document.querySelector('[name=discName]'), 'A'); await input(document.querySelector('[name=jerseyNumber]'), '07');
        } },
        { screen: () => h(TrainingManagement, { actorId: 'A', mode: 'new' }), path: 'trainings/publish', result: { training: { ...training, id: 'late-target' }, video: null }, prepare: async () => {
            await input(document.querySelector('[name=title]'), 'late private training');
            await input(document.querySelector('[name=date]'), '2026-11-08');
        } },
        { screen: () => boundary(h(VideoEditForm, { actorId: 'A', video })), path: 'videos/v', result: { id: 'v' }, prepare: async () => {} }
    ];
    for (const c of cases) {
        try {
            await mount(c.screen());
            await c.prepare();
            let finish;
            override = (path, options) => path === c.path && options.method !== 'GET' ? new Promise(resolve => { finish = resolve; }) : null;
            await submit(document.querySelector('form'));
            if (c.path === 'join') await click('确认提交');
            assert.equal(typeof finish, 'function', c.path);
            await signal('kapok-account-changed');
            await act(async () => finish(response(c.result)));
            await lifecycle('focus');
            assert.equal(document.querySelector('form'), null, c.path);
            assert.equal(document.querySelector('input'), null, c.path);
            assert.deepEqual(navigation, []);
        } finally { await unmount(); }
    }
});
const linkTitle = '合成B站视频';
const linkShare = '【合成B站视频】 https://b23.tv/Example01';
const linkPath = 'trainings/t/videos';
const linkPosts = () => calls.filter(call => call.path === linkPath && call.options.method === 'POST');

async function openVideoForm() {
    await click('添加视频');
    const dialog = document.querySelector('dialog[open]');
    assert.ok(dialog);
    const form = dialog.querySelector('form');
    assert.equal(form.querySelector('select, input[type=file]'), null);
    await input(form.elements.namedItem('title'), linkTitle);
    await input(form.elements.namedItem('url'), linkShare);
    return { dialog, form };
}

for (const interruption of ['session end', 'actor replacement', 'blur', 'visible revalidation', 'direct verification']) {
    test(`final C1 late Bilibili add cannot reveal success after ${interruption}`, async () => {
        let finish;
        let session;
        function DirectVerifyControl() {
            session = useAccountSession();
            return h('button', { type: 'button', onClick: () => void session.verify() }, 'direct verify');
        }
        const content = h(React.Fragment, null, h(AddVideoDialog, { actorId: 'A', trainingId: 't', nextPosition: 0 }), h(DirectVerifyControl));
        try {
            await mount(boundary(content));
            const { dialog, form } = await openVideoForm();
            override = (path, options) => path === linkPath && options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : null;
            await submit(form);
            assert.equal(typeof finish, 'function');
            assert.equal(linkPosts().length, 1);
            let oldToken;
            await act(async () => { oldToken = await session.authorize(); });

            if (interruption === 'session end') await signal('kapok-account-changed');
            else if (interruption === 'actor replacement') {
                override = (path, options) => options.method === 'GET' ? response(path === 'bootstrap' ? { ...bootstrap, actorId: 'B', siteUserId: 'B' } : me, 'B') : null;
                await act(async () => root.render(h(AccountBoundary, { actorId: 'B', load: 'me' }, () => h('p', null, 'current B surface'))));
                await flush();
                assert.match(document.body.textContent, /current B surface/);
            } else if (interruption === 'blur') await lifecycle('blur');
            else if (interruption === 'visible revalidation') {
                await act(async () => document.dispatchEvent(new Event('visibilitychange')));
                await flush();
            } else {
                const oldSession = session;
                const surface = document.querySelector('[data-kapok-sensitive]');
                assert.equal(oldSession.isCurrent(oldToken), true);
                let firstBootstrap;
                override = path => {
                    if (path !== 'bootstrap') return null;
                    firstBootstrap ??= { hidden: surface.hidden, oldTokenCurrent: oldSession.isCurrent(oldToken) };
                    return response(bootstrap);
                };
                await click('direct verify');
                assert.deepEqual(firstBootstrap, { hidden: true, oldTokenCurrent: false });
            }
            if (dialog.isConnected) assert.equal(dialog.open, false);
            const requestsBeforeLateResponse = calls.length;
            await act(async () => finish(response({ id: 'late-video' })));
            await flush();
            assert.equal(calls.length, requestsBeforeLateResponse);
            assert.equal(linkPosts().length, 1);
            assert.ok(!document.body.textContent.includes('视频已添加'));
            assert.ok(!document.body.textContent.includes('late-video'));
            assert.ok(!calls.some(call => call.path.startsWith('uploads')));
            assert.deepEqual(navigation, []);
        } finally { await unmount(); }
    });
}

test('final I7 consequential transitions confirm object and effect; metadata-only save skips prompt', async () => {
    for (const status of ['published', 'archived', 'hidden', 'deleted']) {
        try {
            await mount(boundary(h(TrainingForm, { actorId: 'A', training: { ...training, status: 'draft' } })));
            document.querySelector('select').value = status;
            override = (path, options) => path === 'trainings/t' && options.method === 'PATCH' ? response({ ...training, status }) : null;
            await submit(document.querySelector('form'));
            const dialog = document.querySelector('dialog[open]');
            assert.ok(dialog);
            assert.match(dialog.textContent, /训练「private training」/);
            assert.match(dialog.textContent, /发布|归档|隐藏|删除/);
            assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 0);
            await click('确认并保存');
            assert.equal(dialog.open, false);
            assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
        } finally { await unmount(); }
    }
    for (const status of ['hidden', 'deleted', 'active']) {
        try {
            await mount(boundary(h(VideoEditForm, { actorId: 'A', video })));
            let count = 0;
            window.confirm = text => { count += 1; assert.match(text, /视频「private video」/); return true; };
            document.querySelector('select').value = status;
            override = (path, options) => path === 'videos/v' && options.method === 'PATCH' ? response({ id: 'v' }) : null;
            await submit(document.querySelector('form'));
            assert.equal(count, status === 'active' ? 0 : 1);
            assert.equal(calls.filter(c => c.options.method === 'PATCH').length, 1);
        } finally { await unmount(); }
    }
});
test('final C1 signout network/storage failure leaves the actual profile surface locked', async () => {
    const { SignOut } = await import('../../app/components/signout.tsx');
    try {
        await mount(h(React.Fragment, null, h(MyScreen, { actorId: 'A' }), h(MemberManagement, { actorId: 'A' }), h(SignOut, { actorId: 'A', href: '/signout' })));
        window.confirm = () => true;
        override = path => path === 'bootstrap' ? Promise.reject(new Error('offline')) : null;
        const link = [...document.querySelectorAll('a')].find(x => x.textContent.includes('退出当前登录'));
        await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
        assert.ok([...document.querySelectorAll('[data-kapok-sensitive]')].every(node => node.hidden));
        assert.match(document.body.textContent, /offline/);
        override = null;
        await lifecycle('focus');
        assert.ok(!document.querySelector('[data-kapok-sensitive]').hidden);
    } finally { await unmount(); }
});

test('final C1 cross-tab expiry preserves same A profile, cross-tab end clears, visibility locks first', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        await input(document.querySelector('[name=discName]'), 'cross-tab unsent');
        const channel = new Channel();
        await act(async () => channel.postMessage({ actorId: 'A', kind: 'expired' }));
        assert.ok(hidden(document.querySelector('form')));
        await click('重新确认');
        assert.equal(document.querySelector('[name=discName]').value, 'cross-tab unsent');
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        await act(async () => {
            document.dispatchEvent(new dom.window.Event('visibilitychange'));
            assert.ok(hidden(document.querySelector('form')));
        });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
        await flush();
        assert.equal(document.querySelector('[name=discName]').value, 'cross-tab unsent');
        await act(async () => channel.postMessage({ actorId: 'A', kind: 'ended' }));
        channel.close();
        assert.equal(document.querySelector('form'), null);
        await lifecycle('pageshow');
        assert.equal(document.querySelector('form'), null);
    } finally { await unmount(); }
});
test('final C1 actual signout storage failure ends all marked consumers with explicit failure', async () => {
    const { SignOut } = await import('../../app/components/signout.tsx');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        await mount(h(React.Fragment, null, h(MyScreen, { actorId: 'A' }), h(MemberManagement, { actorId: 'A' }), h(SignOut, { actorId: 'A', href: '/signout' })));
        window.confirm = () => true;
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
        const link = [...document.querySelectorAll('a')].find(x => x.textContent.includes('退出当前登录'));
        await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
        assert.ok([...document.querySelectorAll('[data-kapok-sensitive]')].every(node => node.hidden));
        assert.match(document.body.textContent, /未确认退出成功/);
        await lifecycle('focus');
        assert.equal(document.querySelector('form'), null);
    } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); await unmount(); }
});

test('final C1 actor prop replacement immediately drops A buffers and rejects A late receipt', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        let finish;
        override = (path, options) => path === 'me' && options.method === 'PATCH' ? new Promise(resolve => { finish = resolve; }) : null;
        await input(document.querySelector('[name=discName]'), 'A unsent secret');
        await submit(document.querySelector('form'));
        state.bootstrap = { ...bootstrap, actorId: 'B', siteUserId: 'B', me: { ...me, user: { ...me.user, id: 'user-B' }, profile: { ...me.profile, discName: 'B profile' } } };
        state.me = state.bootstrap.me;
        override = (path, options) => options.method === 'GET' ? response(path === 'bootstrap' ? state.bootstrap : state.me, 'B') : null;
        await act(async () => root.render(h(MyScreen, { actorId: 'B' })));
        await flush();
        assert.equal(document.querySelector('[name=discName]').value, 'B profile');
        await act(async () => finish(response({ me })));
        assert.equal(document.querySelector('[name=discName]').value, 'B profile');
        assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
    } finally { await unmount(); }
});
test('final I2 failed and late video revalidation keeps old body concealed until a fresh snapshot', async () => {
    try {
        await mount(h(VideoDiscussion, videoProps));
        let finish;
        let count = 0;
        override = path => {
            if (path !== 'videos/v/comments') return null;
            count += 1;
            return count === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.reject(new Error('comments unavailable'));
        };
        await lifecycle('focus');
        await lifecycle('focus');
        await act(async () => finish(response([comment])));
        await flush();
        assert.ok(hidden(document.querySelector('video')));
        assert.match(document.body.textContent, /comments unavailable/);
        override = null;
        state.comments = [{ ...comment, text: null, status: 'deleted' }];
        await lifecycle('focus');
        assert.ok(!document.body.textContent.includes('withdrawn body'));
        assert.match(document.body.textContent, /原讨论已删除/);
    } finally { await unmount(); }
});
test('final C1 StrictMode replay still verifies and hides actual My consumer', async () => {
    try {
        await mount(h(React.StrictMode, null, h(MyScreen, { actorId: 'A' })));
        assert.equal(document.querySelector('[name=discName]').value, me.profile.discName);
        assert.ok(!hidden(document.querySelector('form')));
        await lifecycle('blur');
        assert.ok(hidden(document.querySelector('form')));
        await lifecycle('focus');
        assert.ok(!hidden(document.querySelector('form')));
    } finally { await unmount(); }
});

test('final C1 changed role during verification conceals the former admin member list', async () => {
    try {
        await mount(h(MemberManagement, { actorId: 'A' }));
        const demoted = { ...bootstrap, me: { ...me, membership: { ...me.membership, role: 'member', version: 2 } } };
        const privateList = [{ id: 'managed-member', userId: 'user-managed', discName: 'protected-member-name', jerseyNumber: '07', version: 1, epoch: 1, role: 'member', status: 'active' }];
        override = path => path === 'admin/members' ? response(privateList) : null;
        await lifecycle('focus');
        assert.match(document.querySelector('[data-kapok-sensitive]').textContent, /protected-member-name/);
        let checks = 0;
        override = path => path === 'bootstrap' ? response(++checks === 1 ? bootstrap : demoted) : path === 'admin/members' ? response(privateList) : null;
        await lifecycle('focus');
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.match(document.body.textContent, /成员权限在确认期间已变化/);
    } finally { await unmount(); }
});

test('V2 account hides management links when the same account loses its role', async () => {
    try {
        await mount(h(AccountScreen, { actorId: 'A' }));
        assert.ok(document.querySelector('a[href="/admin/members"]'));
        assert.ok(document.querySelector('a[href="/admin/announcements"]'));
        assert.match(document.querySelector('.account-profile').textContent, /背号 07/);
        state.me = { ...me, membership: { ...me.membership, role: 'member', version: 2 } };
        state.bootstrap = { ...bootstrap, me: state.me };
        await lifecycle('focus');
        assert.equal(document.querySelector('a[href^="/admin/"]'), null);
        assert.ok(document.querySelector('a[href="/me/data"]'));
    } finally { await unmount(); }
});

test('V2 export failure offers a retry and last-admin leave requires explicit confirmation', async () => {
    try {
        await mount(h(PersonalData, { actorId: 'A' }));
        override = (path, options) => {
            const error = path === 'me/export'
                ? { code: 'SERVICE_UNAVAILABLE', message: '导出服务暂不可用。', retryable: true }
                : path === 'me/leave' && options.method === 'POST'
                    ? { code: 'MEMBERSHIP_CONFLICT', message: '请先保留另一位有效管理员。', retryable: false }
                    : null;
            return error && Response.json({ error }, { status: error.retryable ? 503 : 409, headers: { 'X-Kapok-Actor': 'A' } });
        };
        await click('下载本人 JSON');
        const exportError = document.querySelector('[role=alert]');
        assert.match(exportError.textContent, /没有生成可下载文件/);
        assert.doesNotMatch(document.body.textContent, /已请求浏览器下载/);
        assert.ok([...exportError.closest('section').querySelectorAll('button')].some(button => button.textContent === '重新导出'));
        const leave = document.querySelector('.account-leave button');
        const checkbox = document.querySelector('.account-leave input');
        assert.equal(leave.disabled, true);
        assert.equal(calls.filter(c => c.path === 'me/leave').length, 0);
        await act(async () => checkbox.click());
        await click('确认退出队伍');
        assert.equal(calls.filter(c => c.path === 'me/leave' && c.options.method === 'POST').length, 1);
        assert.match(document.querySelector('.account-leave [role=alert]').textContent, /另一位有效管理员/);
        assert.match(document.querySelector('.account-leave .status-label').textContent, /有效成员/);
        assert.equal(leave.disabled, true);
        assert.doesNotMatch(document.body.textContent, /已确认退出队伍/);
    } finally { await unmount(); }
});

test('V2 recycle can confirm a lost restore response with the original request after the row disappears', async () => {
    const deleted = { id: 'r', title: '复盘标题', text: '本人原稿', date: '2026-11-07', recoverUntil: '2026-11-14T00:00:00Z', version: 3, sharingVersion: 4, generation: 5 };
    try {
        await mount(h(ReflectionRecycle, { actorId: 'A' }));
        let restored = false;
        override = (path, options) => {
            if (path === 'me/recycle') return response(restored ? [] : [deleted]);
            if (path !== 'reflections/r/restore' || options.method !== 'POST') return null;
            if (restored) return response({ ...deleted, scope: 'private', published: false });
            restored = true;
            return Promise.reject(new Error('恢复响应暂未确认。'));
        };
        await lifecycle('focus');
        await click('仅恢复为私密原稿');
        assert.doesNotMatch(document.body.textContent, /已恢复为私密复盘/);
        await lifecycle('focus');
        assert.doesNotMatch(document.body.textContent, /本人原稿/);
        await click('重新确认上次恢复请求');
        assert.match(document.body.textContent, /已恢复为私密复盘/);
        const writes = calls.filter(c => c.options.method === 'POST');
        assert.equal(writes.length, 2);
        assert.equal(writes[0].options.headers['Idempotency-Key'], writes[1].options.headers['Idempotency-Key']);
        assert.deepEqual(JSON.parse(writes[1].options.body), { expectedVersion: 3, expectedSharingVersion: 4, expectedGeneration: 5 });
    } finally { await unmount(); }
});

test('V2 explicit signout clears only the current account drafts after confirmation', async () => {
    const { SignOut } = await import('../../app/components/signout.tsx');
    const { draftKey } = await import('../../lib/client/session-guard.ts');
    const { registrationDraft } = await import('../../lib/client/registration-draft.ts');
    try {
        await mount(h(SignOut, { actorId: 'A', href: '/#signed-out' }));
        localStorage.setItem(draftKey('A', 'record'), 'A draft');
        localStorage.setItem(draftKey('B', 'record'), 'B draft');
        registrationDraft('A').write({ fields: { discName: 'A draft', jerseyNumber: '07' }, pending: null });
        const control = document.querySelector('a[href="/#signed-out"]');
        window.confirm = () => false;
        await act(async () => control.click());
        assert.equal(calls.length, 0);
        assert.ok(registrationDraft('A').read());
        assert.equal(localStorage.getItem(draftKey('A', 'record')), 'A draft');
        window.confirm = () => true;
        await act(async () => control.click());
        assert.equal(calls.filter(c => c.path === 'bootstrap').length, 1);
        assert.equal(window.location.hash, '#signed-out');
        assert.equal(registrationDraft('A').read(), null);
        assert.equal(localStorage.getItem(draftKey('A', 'record')), null);
        assert.equal(localStorage.getItem(draftKey('B', 'record')), 'B draft');
    } finally {
        window.history.replaceState(null, '', '/');
        localStorage.removeItem(draftKey('A', 'record'));
        localStorage.removeItem(draftKey('B', 'record'));
        registrationDraft('A').clear();
        await unmount();
    }
});

test('V2 signout prompts for a reload when the bootstrap response identifies another account', async () => {
    const { SignOut } = await import('../../app/components/signout.tsx');
    const { draftKey } = await import('../../lib/client/session-guard.ts');
    const { registrationDraft } = await import('../../lib/client/registration-draft.ts');
    const actorADraft = draftKey('A', 'record');
    const actorBDraft = draftKey('B', 'record');
    const actorBRegistration = { fields: { discName: 'B draft', jerseyNumber: '07' }, pending: null };
    try {
        await mount(h(SignOut, { actorId: 'A', href: '/#signed-out' }));
        localStorage.setItem(actorADraft, 'A draft');
        localStorage.setItem(actorBDraft, 'B draft');
        registrationDraft('B').write(actorBRegistration);
        window.confirm = () => true;
        override = path => {
            assert.equal(path, 'bootstrap');
            return response({ ...bootstrap, actorId: 'B', siteUserId: 'B' }, 'B');
        };
        const control = document.querySelector('a[href="/#signed-out"]');
        await act(async () => control.click());
        assert.equal(window.location.hash, '');
        assert.equal(control.getAttribute('aria-busy'), 'false');
        assert.equal(localStorage.getItem(actorADraft), 'A draft');
        assert.equal(localStorage.getItem(actorBDraft), 'B draft');
        assert.deepEqual(registrationDraft('B').read(), actorBRegistration);
        assert.match(document.querySelector('[role=alert]')?.textContent ?? '', /登录账号已变化，请重新加载/);
        const reload = [...document.querySelectorAll('button')].find(button => button.textContent === '重新加载页面');
        assert.ok(reload && !reload.disabled, 'reload is available after verification stops');
    } finally {
        window.history.replaceState(null, '', '/');
        localStorage.removeItem(actorADraft);
        localStorage.removeItem(actorBDraft);
        registrationDraft('B').clear();
        await unmount();
    }
});

for (const interruption of ['account-changed', 'cross-tab ended', 'pagehide']) {
    test(`V2 signout ignores a late response after ${interruption}`, async () => {
        const { SignOut } = await import('../../app/components/signout.tsx');
        const { draftKey } = await import('../../lib/client/session-guard.ts');
        const { registrationDraft } = await import('../../lib/client/registration-draft.ts');
        const actorADraft = draftKey('A', 'record');
        const actorBDraft = draftKey('B', 'record');
        const actorBRegistration = { fields: { discName: 'B draft', jerseyNumber: '07' }, pending: null };
        const channel = new Channel();
        try {
            await mount(h(SignOut, { actorId: 'A', href: '/#signed-out' }));
            localStorage.setItem(actorADraft, 'A draft');
            window.confirm = () => true;
            let release;
            let requestSignal;
            const oldResponse = response(bootstrap);
            override = (path, options) => {
                assert.equal(path, 'bootstrap');
                requestSignal = options.signal;
                return new Promise(resolve => { release = resolve; });
            };
            await act(async () => document.querySelector('a[href="/#signed-out"]').click());
            assert.ok(release, 'A started verification');
            localStorage.setItem(actorBDraft, 'B draft');
            registrationDraft('B').write(actorBRegistration);
            state.bootstrap = { ...bootstrap, actorId: 'B', siteUserId: 'B' };
            await act(async () => {
                if (interruption === 'cross-tab ended') channel.postMessage({ kind: 'ended', actorId: 'A' });
                else if (interruption === 'account-changed') window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' }));
                else window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }));
            });
            await act(async () => release(oldResponse));
            await flush();
            assert.deepEqual({
                aborted: requestSignal.aborted,
                hash: window.location.hash,
                actorADraft: localStorage.getItem(actorADraft),
                actorBDraft: localStorage.getItem(actorBDraft),
                registration: registrationDraft('B').read(),
            }, {
                aborted: true, hash: '', actorADraft: 'A draft', actorBDraft: 'B draft', registration: actorBRegistration,
            });
            if (interruption === 'pagehide') assert.equal(document.querySelector('[role=alert]'), null);
        } finally {
            channel.close();
            window.history.replaceState(null, '', '/');
            localStorage.removeItem(actorADraft);
            localStorage.removeItem(actorBDraft);
            registrationDraft('B').clear();
            await unmount();
        }
    });
}

test('final M1 server profile and registration errors are adjacent, associated and focus the affected field', async () => {
    for (const kind of ['profile', 'join']) {
        try {
            await mount(kind === 'profile' ? h(MyScreen, { actorId: 'A' }) : h(JoinScreen, { actorId: 'A', returnTo: '/' }));
            if (kind === 'join') {
                state.bootstrap = { ...bootstrap, me: { user: null, profile: null, membership: null, team: null } };
                await lifecycle('focus');
                await input(document.querySelector('[name=discName]'), 'new member');
                await input(document.querySelector('[name=jerseyNumber]'), '07');
            }
            override = (path, options) => options.method === 'GET' ? null : new Response(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'synthetic field error', retryable: false } }), { status: 400, headers: { 'X-Kapok-Actor': 'A' } });
            await submit(document.querySelector('form'));
            if (kind === 'join') await click('确认提交');
            const field = document.querySelector('[name=discName]');
            assert.equal(field.getAttribute('aria-invalid'), 'true');
            assert.ok(document.activeElement === field, `expected focus on ${field.name}, found ${document.activeElement?.getAttribute('name') ?? document.activeElement?.tagName}`);
            const errorId = field.getAttribute('aria-describedby').split(' ').at(-1);
            assert.equal(document.getElementById(errorId).textContent, 'synthetic field error');
        } finally { await unmount(); }
    }
});

test('final I5 active-left My retains legal own profile while team management disappears', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        const left = { ...me, membership: { ...me.membership, status: 'left', version: 2 }, team: null };
        state.me = left;
        state.bootstrap = { ...bootstrap, me: left };
        await lifecycle('focus');
        assert.equal(document.querySelector('[name=discName]').value, me.profile.discName);
        assert.ok(!hidden(document.querySelector('form')));
        assert.match(document.body.textContent, /当前不在有效队伍中/);
        assert.equal(document.querySelector('a[href="/admin/invites"]'), null);
    } finally { await unmount(); }
});

test('final C1 training consumer installs the fresh upload cleanup list after a guarded mutation', async () => {
    try {
        await mount(h(TrainingManagement, { actorId: 'A', mode: 'detail', id: 't' }));
        let pending = [{ id: 'u', bytes: 1024, status: 'pending', cleanupState: 'none', createdAt: '2026-10-16' }];
        override = (path, options) => {
            if (path === 'uploads/u/cancel' && options.method === 'POST') { pending = []; return response({ id: 'u' }); }
            return path === 'uploads' ? response({items:pending,nextCursor:null}) : null;
        };
        await lifecycle('focus');
        assert.match(document.body.textContent, /本人未挂载上传/);
        await click('取消并清理');
        assert.ok(!document.body.textContent.includes('本人未挂载上传'));
    } finally { await unmount(); }
});

test('final I4 fresh profile snapshot changes saved truth while retaining visible owner buffer', async () => {
    try {
        await mount(h(MyScreen, { actorId: 'A' }));
        override = (path, options) => path === 'me' && options.method === 'PATCH' ? response({ me }) : null;
        await submit(document.querySelector('form'));
        assert.match(document.body.textContent, /资料已保存到账号。/);
        const newer = { ...me, profile: { ...me.profile, discName: 'newer Y', version: 3 } };
        state.me = newer;
        state.bootstrap = { ...bootstrap, me: newer };
        override = null;
        await lifecycle('focus');
        assert.equal(document.querySelector('[name=discName]'), null);
        assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
        assert.match(document.body.textContent, /newer Y/);
    } finally { await unmount(); }
});


test('R1 actual comment-success refresh pauses and conceals on disabled or denied revalidation', async () => {
    for (const failure of ['disabled', 'denied']) {
        try {
            await mount(h(VideoDiscussion, videoProps));
            const media = document.querySelector('video');
            await input(document.querySelector('#comment-input'), 'comment before access changed');
            media.currentTime = 20;
            const pausesBefore = pauses;
            let posts = 0;
            const nativeTime = Object.getOwnPropertyDescriptor(dom.window.HTMLMediaElement.prototype, 'currentTime');
            const pause = media.pause;
            Object.defineProperty(media, 'currentTime', {
                configurable: true,
                get() {
                    if (posts) assert.ok(hidden(media), 'hide before capturing currentTime');
                    return nativeTime.get.call(media);
                },
                set(value) { nativeTime.set.call(media, value); }
            });
            media.pause = () => {
                if (posts) assert.ok(hidden(media), 'hide before pausing');
                pause.call(media);
            };
            override = (path, options) => {
                if (path === 'videos/v/comments' && options.method === 'POST') {
                    posts += 1;
                    if (failure === 'disabled') {
                        state.bootstrap = { ...bootstrap, me: { user: { id: 'user-A', status: 'deleted' }, profile: null, membership: null, team: null } };
                    }
                    return response({ id: 'new-comment' });
                }
                if (posts && failure === 'denied' && path === 'videos/v/comments') {
                    return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'source denied', retryable: false } }), {
                        status: 403, headers: { 'X-Kapok-Actor': 'A' }
                    });
                }
                return null;
            };

            await submit(document.querySelector('#comment-input').closest('form'));

            assert.equal(posts, 1);
            assert.equal(document.querySelector('video'), null);
            assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
            assert.ok(pauses - pausesBefore >= 2, failure + ': verification entry and failure must both stop subscribers');
            assert.match(document.body.textContent, failure === 'disabled' ? /当前账号暂不可用/ : /source denied/);
        } finally { await unmount(); }
    }
});

test('R1 actual prior 2-second recovery then comment refresh retains current 20 without autoplay', async () => {
    try {
        await mount(h(VideoDiscussion, videoProps));
        const media = document.querySelector('video');
        media.currentTime = 2;
        await lifecycle('blur');
        await lifecycle('focus');
        assert.equal(media.currentTime, 2);
        await input(document.querySelector('#comment-input'), 'comment at current position');
        media.currentTime = 20;
        const pausesBefore = pauses;
        const playsBefore = plays;
        let posts = 0;
        override = (path, options) => {
            if (path === 'videos/v/comments' && options.method === 'POST') {
                posts += 1;
                return response({ id: 'new-comment' });
            }
            return null;
        };

        await submit(document.querySelector('#comment-input').closest('form'));

        assert.equal(posts, 1);
        assert.ok(!hidden(media));
        assert.equal(media.currentTime, 20);
        assert.ok(pauses > pausesBefore);
        assert.equal(plays, playsBefore);
    } finally { await unmount(); }
});

test('final Bilibili add retries an unknown commit with the same body and key', async () => {
    try {
        await mount(boundary(h(AddVideoDialog, { actorId: 'A', trainingId: 't', nextPosition: 3 })));
        const { dialog, form } = await openVideoForm();
        let loseResponse;
        const committed = new Map();
        override = (path, options) => {
            if (path !== linkPath || options.method !== 'POST') return null;
            const key = options.headers['Idempotency-Key'];
            if (committed.has(key)) return response(committed.get(key));
            committed.set(key, { id: 'added-video' });
            return new Promise((_, reject) => { loseResponse = reject; });
        };
        await submit(form);
        assert.equal(typeof loseResponse, 'function');
        await submit(form);
        assert.equal(linkPosts().length, 1, 'submit while busy does not send another request');
        await act(async () => loseResponse(new Error('合成响应丢失')));
        await flush();
        assert.equal(dialog.open, true);
        assert.match(dialog.querySelector('[role=alert]').textContent, /合成响应丢失/);
        assert.equal(form.elements.namedItem('url').value, linkShare);
        assert.equal(form.elements.namedItem('title').value, linkTitle);
        const original = linkPosts()[0];
        assert.deepEqual(JSON.parse(original.options.body), { title: linkTitle, position: 3, source: 'bilibili', url: linkShare });
        assert.ok(original.options.headers['Idempotency-Key']);

        await submit(form);
        const [first, retry] = linkPosts();
        assert.equal(linkPosts().length, 2);
        assert.equal(retry.options.body, first.options.body);
        assert.equal(retry.options.headers['Idempotency-Key'], first.options.headers['Idempotency-Key']);
        assert.equal(committed.size, 1);
        assert.equal(dialog.open, false);
        assert.match(document.body.textContent, /视频已添加到下方列表/);
        assert.ok(!calls.some(call => call.path.startsWith('uploads')));
    } finally { await unmount(); }
});

test('final Bilibili malformed share stays editable and reports the server error on each submission', async () => {
    try {
        await mount(boundary(h(AddVideoDialog, { actorId: 'A', trainingId: 't', nextPosition: 0 })));
        const { dialog, form } = await openVideoForm();
        const url = form.elements.namedItem('url');
        const malformed = '合成错误分享';
        const message = '请填写BV号或B站视频地址。';
        await input(url, malformed);
        override = (path, options) => path === linkPath && options.method === 'POST' ? new Response(JSON.stringify({
            error: { code: 'INVALID_INPUT', message, retryable: false }
        }), { status: 400, headers: { 'X-Kapok-Actor': 'A' } }) : null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await submit(form);
            assert.equal(linkPosts().length, attempt);
            assert.equal(JSON.parse(linkPosts().at(-1).options.body).url, malformed);
            assert.equal(dialog.open, true);
            assert.equal(dialog.querySelector('[role=alert]').textContent, message);
            assert.equal(url.value, malformed);
            assert.equal(url.disabled, false);
            assert.equal(form.elements.namedItem('title').value, linkTitle);
            assert.ok(!document.body.textContent.includes('视频已添加'));
        }
        assert.ok(!calls.some(call => call.path.startsWith('uploads')));
    } finally { await unmount(); }
});

test('R1 I2 legacy cleanup replaces the current page and can clear an upload beyond the first 50', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
        id: 'new-' + index, bytes: 1024, status: 'pending', cleanupState: 'none', createdAt: '2026-10-17'
    }));
    const oldest = { ...rows[0], id: 'oldest-51', createdAt: '2026-10-16' };
    const confirm = window.confirm;
    try {
        await mount(boundary(h(UploadCleanup, { actorId: 'A', initial: { items: rows, nextCursor: 'older' } })));
        override = (path, options) => {
            if (path === 'uploads?cursor=older') return response({ items: [oldest], nextCursor: null });
            if (path === 'uploads/oldest-51/cancel' && options.method === 'POST') return response({ id: oldest.id, status: 'cancelled' });
            return null;
        };
        window.confirm = () => true;
        assert.equal(document.querySelectorAll('.discussion').length, 50);
        await click('查看更早的未挂载上传');
        assert.equal(document.querySelectorAll('.discussion').length, 1);
        assert.match(document.querySelector('.discussion').textContent, /2026-10-16/);
        await click('取消并清理');
        assert.equal(calls.filter(call => call.path === 'uploads/oldest-51/cancel').length, 1);
        assert.match(document.body.textContent, /这次上传已取消并清理/);
    } finally { window.confirm = confirm; await unmount(); }
});
