import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { HOSTED_MEDIA_POLICY } from '../../lib/contracts/media.ts';
import { safeReturnTo } from '../../lib/server/domain.ts';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'FormData', 'File', 'localStorage']) {
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
const { createRoot } = await import('react-dom/client');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { CollectionList } = await import('../../app/components/collections.tsx');
const { AccountBoundary, useAccountSession } = await import('../../app/components/secure-resource.tsx');
const { TrainingForm, VideoEditForm, AddVideoForm, UploadCleanup } = await import('../../app/components/training-forms.tsx');
const { ProfileEditor: MyScreen } = await import('../../app/components/profile-editor.tsx');
const { HomeScreen, TrainingsScreen, TrainingScreen, InviteScreen, JoinScreen, BootstrapScreen } = await import('../../app/components/legacy-screens.tsx');
const { navigation } = await import('../helpers/next-stubs.mjs');
const h = React.createElement;
const me = { user: { id: 'user-A', status: 'active' }, profile: { discName: 'private A name', jerseyNumber: '07', version: 1 }, membership: { id: 'm', teamId: 't', status: 'active', role: 'admin', epoch: 1, version: 1 }, team: { id: 't', name: 'private team', description: 'private description' } };
const bootstrap = { siteUserId: 'A', initialized: true, canBootstrap: false, me };
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
        if (path === 'uploads' && options.method === 'POST') { const value = JSON.parse(options.body); state.uploadManifest = value.manifest; state.uploadBytes = value.bytes; }
        if (override) { const result = await override(path, options); if (result) return result; }
        const data = path === 'uploads/policy' ? HOSTED_MEDIA_POLICY : path === 'uploads/u' ? { id: 'u', bytes: state.uploadBytes, status: state.uploadStatus ?? 'receiving', cleanupState: 'none', protocol: 2, receivedParts: state.receivedParts ?? 0, nextPart: (state.receivedParts ?? 0) + 1, manifest: state.uploadManifest, policy: HOSTED_MEDIA_POLICY } : path === 'bootstrap' ? state.bootstrap : path === 'me' ? state.me : path === 'videos/v' ? state.video : path === 'videos/v/comments' ? state.comments : path === 'collections' ? state.items : path === 'trainings' ? [training] : path === 'trainings/t' ? { ...training, videos: [video] } : path === 'uploads' ? {items:[],nextCursor:null} : [];
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
    const button = [...document.querySelectorAll('button')].find(x => x.textContent.includes(text));
    assert.ok(button, `button ${text}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await flush();
}
async function input(node, value) {
    const prototype = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
        node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
}
async function submit(form) { await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); await flush(); }
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
            let confirmations = 0;
            window.confirm = text => { confirmations += 1; assert.match(text, /private training/); return false; };
            await submit(document.querySelector('form'));
            assert.equal(confirmations, 1);
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
test('final C1/I4 new official subject can join and current paused/left receipt is honest', async () => {
    for (const status of ['paused', 'left', 'active']) {
        try {
            await mount(h(JoinScreen, { actorId: 'A', token: 'valid-synthetic-token', returnTo: '/reflections/r' }));
            state.bootstrap = { ...bootstrap, me: { user: null, profile: null, membership: null, team: null } };
            await lifecycle('focus');
            assert.ok(!hidden(document.querySelector('form')));
            await input(document.querySelector('[name=discName]'), 'new member');
            await input(document.querySelector('[name=jerseyNumber]'), '07');
            override = path => path === 'join' ? response({ me: { ...me, membership: { ...me.membership, status } }, returnTo: '/reflections/r' }) : null;
            await submit(document.querySelector('form'));
            const heading = document.querySelector('h2').textContent;
            assert.equal(heading === '已加入队伍', status === 'active');
            assert.equal(calls.filter(c => c.path === 'join').length, 1);
            assert.equal(document.querySelector('a').getAttribute('href'), status === 'active' ? '/reflections/r' : '/me');
        } finally { await unmount(); }
    }
});
test('final C1 bootstrap permits only fresh new-subject eligibility; disabled My/join remain locked', async () => {
    try {
        await mount(h(BootstrapScreen, { actorId: 'A' }));
        state.bootstrap = { ...bootstrap, initialized: false, canBootstrap: true, me: { user: null, profile: null, membership: null, team: null } };
        await lifecycle('focus');
        assert.ok(document.querySelector('form'));
        assert.ok(!hidden(document.querySelector('form')));
        override = path => path === 'internal/bootstrap' ? response({ me, inviteToken: 'new-private-token', inviteId: 'i', expiresAt: '2026-10-23' }) : null;
        await submit(document.querySelector('form'));
        assert.match(document.body.textContent, /合成队伍已初始化/);
    } finally { await unmount(); }
    for (const component of [MyScreen, JoinScreen, BootstrapScreen]) {
        try {
            await mount(h(component, { actorId: 'A', token: 'token-for-disabled', returnTo: '/' }));
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
        [InviteScreen, {}], [JoinScreen, { token: 'private-invite-value', returnTo: '/' }], [BootstrapScreen, {}],
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
            assert.ok(!document.body.textContent.includes('private-invite-value'));
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
        assert.match(document.body.textContent, /回复 private A name/);
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

test('final C1 late profile/join/invite/bootstrap/training/video responses cannot expose or navigate after end', async () => {
    const cases = [
        { screen: () => h(MyScreen, { actorId: 'A' }), path: 'me', result: { me }, prepare: async () => {} },
        { screen: () => h(JoinScreen, { actorId: 'A', token: 'valid-synthetic-token', returnTo: '/reflections/r' }), path: 'join', result: { me, returnTo: '/reflections/r' }, prepare: async () => {
            await input(document.querySelector('[name=discName]'), 'A'); await input(document.querySelector('[name=jerseyNumber]'), '07');
        } },
        { screen: () => h(InviteScreen, { actorId: 'A' }), path: 'admin/invites', result: { inviteToken: 'late-secret-token', inviteId: 'i', expiresAt: '2026-10-23' }, prepare: async () => {} },
        { screen: () => h(BootstrapScreen, { actorId: 'A' }), path: 'internal/bootstrap', result: { me, inviteToken: 'late-secret-token', inviteId: 'i', expiresAt: '2026-10-23' }, prepare: async () => {
            state.bootstrap = { ...bootstrap, initialized: false, canBootstrap: true, me: { user: null, profile: null, membership: null, team: null } }; await lifecycle('focus');
        } },
        { screen: () => boundary(h(TrainingForm, { actorId: 'A' })), path: 'trainings', result: { ...training, id: 'late-target', status: 'draft' }, prepare: async () => {
            await input(document.querySelector('[name=title]'), 'late private draft');
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
            assert.equal(typeof finish, 'function', c.path);
            await signal('kapok-account-changed');
            await act(async () => finish(response(c.result)));
            await lifecycle('focus');
            assert.equal(document.querySelector('form'), null, c.path);
            assert.equal(document.querySelector('input'), null, c.path);
            assert.ok(!document.body.textContent.includes('late-secret-token'));
            assert.deepEqual(navigation, []);
        } finally { await unmount(); }
    }
});
test('final C1 late upload reservation never transfers/completes/attaches after session end', async () => {
    const OriginalXHR = globalThis.XMLHttpRequest;
    let transfers = 0;
    globalThis.XMLHttpRequest = class { constructor() { transfers += 1; } };
    try {
        await mount(boundary(h(AddVideoForm, { actorId: 'A', trainingId: 't' })));
        const select = document.querySelector('select');
        await act(async () => { select.value = 'upload'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        const fileInput = document.querySelector('[name=file]');
        const file = new File(['synthetic'], 'synthetic.mp4', { type: 'video/mp4' });
        const NativeFormData = globalThis.FormData;
        // JSDOM does not serialize programmatically assigned FileList in FormData; only that transport is supplied.
        globalThis.FormData = class extends NativeFormData { get(name) { return name === 'file' ? file : super.get(name); } };
        let finish;
        override = (path, options) => path === 'uploads' && options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : null;
        try {
            assert.ok(fileInput);
            await submit(document.querySelector('form'));
            assert.equal(typeof finish, 'function');
            await signal('kapok-account-changed');
            await act(async () => finish(response({ id: 'late-reservation' })));
            assert.equal(transfers, 0);
            assert.equal(calls.filter(c => /complete|content|trainings\/t\/videos/.test(c.path)).length, 0);
            assert.equal(document.querySelector('form'), null);
        } finally { globalThis.FormData = NativeFormData; }
    } finally { globalThis.XMLHttpRequest = OriginalXHR; await unmount(); }
});
test('final C1 background aborts active upload and late XHR success cannot complete or attach', async () => {
    const OriginalXHR = globalThis.XMLHttpRequest;
    const NativeFormData = globalThis.FormData;
    const transfers = [];
    class ControlledXHR {
        upload = {};
        status = 200;
        responseText = '{"data":{"id":"u"}}';
        aborted = false;
        constructor() { transfers.push(this); }
        open() {}
        setRequestHeader() {}
        getResponseHeader() { return 'A'; }
        send() {}
        abort() { this.aborted = true; this.onabort?.(); }
    }
    globalThis.XMLHttpRequest = ControlledXHR;
    try {
        await mount(boundary(h(AddVideoForm, { actorId: 'A', trainingId: 't' })));
        const select = document.querySelector('select');
        await act(async () => { select.value = 'upload'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        const file = new File(['synthetic'], 'synthetic.mp4', { type: 'video/mp4' });
        globalThis.FormData = class extends NativeFormData { get(name) { return name === 'file' ? file : super.get(name); } };
        override = (path, options) => path === 'uploads' && options.method === 'POST' ? response({ id: 'u' }) : null;
        await submit(document.querySelector('form'));
        const transfer = transfers.at(-1);
        assert.ok(transfer);
        await lifecycle('blur');
        assert.equal(transfer.aborted, true);
        await act(async () => transfer.onload());
        assert.equal(calls.filter(c => /complete|trainings\/t\/videos/.test(c.path)).length, 0);
        assert.ok(hidden(document.querySelector('form')));
        await signal('kapok-account-changed');
    } finally { globalThis.FormData = NativeFormData; globalThis.XMLHttpRequest = OriginalXHR; await unmount(); }
});
test('final I7 consequential transitions confirm object and effect; metadata-only save skips prompt', async () => {
    for (const status of ['published', 'archived', 'hidden', 'deleted']) {
        try {
            await mount(boundary(h(TrainingForm, { actorId: 'A', training: { ...training, status: 'draft' } })));
            let count = 0;
            window.confirm = text => { count += 1; assert.match(text, /训练「private training」/); assert.match(text, /发布|归档|隐藏|删除/); return true; };
            document.querySelector('select').value = status;
            override = (path, options) => path === 'trainings/t' && options.method === 'PATCH' ? response({ ...training, status }) : null;
            await submit(document.querySelector('form'));
            assert.equal(count, 1);
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
test('final C1 signout network/storage failure leaves all actual profile and invite surfaces locked', async () => {
    const { SignOut } = await import('../../app/components/signout.tsx');
    try {
        await mount(h(React.Fragment, null, h(MyScreen, { actorId: 'A' }), h(InviteScreen, { actorId: 'A' }), h(SignOut, { actorId: 'A', href: '/signout' })));
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
        await mount(h(React.Fragment, null, h(MyScreen, { actorId: 'A' }), h(InviteScreen, { actorId: 'A' }), h(SignOut, { actorId: 'A', href: '/signout' })));
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
        state.bootstrap = { ...bootstrap, siteUserId: 'B', me: { ...me, user: { ...me.user, id: 'user-B' }, profile: { ...me.profile, discName: 'B profile' } } };
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

test('final C1 changed membership between verification receipts cannot reveal old admin invite', async () => {
    try {
        await mount(h(InviteScreen, { actorId: 'A' }));
        override = (path, options) => path === 'admin/invites' && options.method === 'POST' ? response({ inviteToken: 'protected-invite-secret', inviteId: 'i', expiresAt: '2026-10-23' }) : null;
        await submit(document.querySelector('form'));
        assert.match(document.querySelector('input').value, /protected-invite-secret/);
        let checks = 0;
        override = path => {
            if (path !== 'bootstrap') return null;
            checks += 1;
            return response(checks === 1 ? bootstrap : { ...bootstrap, me: { ...me, membership: { ...me.membership, role: 'member', version: 2 } } });
        };
        await lifecycle('focus');
        assert.ok(!document.querySelector('input') || hidden(document.querySelector('input')));
        assert.match(document.body.textContent, /成员权限在确认期间已变化/);
        state.bootstrap = { ...bootstrap, me: { ...me, membership: { ...me.membership, role: 'member', version: 2 } } };
        override = null;
        await lifecycle('focus');
        assert.ok(!document.querySelector('input') || hidden(document.querySelector('input')));
    } finally { await unmount(); }
});

test('final M1 server profile and invite errors are adjacent, associated and focus the affected field', async () => {
    for (const kind of ['profile', 'invite']) {
        try {
            await mount(kind === 'profile' ? h(MyScreen, { actorId: 'A' }) : h(JoinScreen, { actorId: 'A', token: 'valid-synthetic-token', returnTo: '/' }));
            if (kind === 'invite') {
                await input(document.querySelector('[name=discName]'), 'new member');
                await input(document.querySelector('[name=jerseyNumber]'), '07');
            }
            override = (path, options) => options.method === 'GET' ? null : new Response(JSON.stringify({ error: { code: kind === 'profile' ? 'INVALID_INPUT' : 'INVITE_UNAVAILABLE', message: 'synthetic field error', retryable: false } }), { status: 400, headers: { 'X-Kapok-Actor': 'A' } });
            await submit(document.querySelector('form'));
            const field = document.querySelector(kind === 'profile' ? '[name=discName]' : '[name=token]');
            assert.equal(field.getAttribute('aria-invalid'), 'true');
            assert.equal(document.activeElement, field);
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
        await mount(h(TrainingScreen, { actorId: 'A', id: 't' }));
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

test('R1 actual direct verify invalidates and hides before active upload subscriber, including abort failure', async () => {
    const OriginalXHR = globalThis.XMLHttpRequest;
    const NativeFormData = globalThis.FormData;
    for (const abortThrows of [false, true]) {
        const transfers = [];
        let session;
        let oldToken;
        let refreshing = false;
        let loadedAfterStop = 0;
        function DirectVerifyControl() {
            const current = useAccountSession();
            React.useEffect(() => { session = current; }, [current]);
            return h('button', { type: 'button', onClick: () => { refreshing = true; void current.verify(); } }, 'direct verify');
        }
        class ControlledXHR {
            upload = {};
            status = 200;
            responseText = '{"data":{"id":"u"}}';
            aborted = false;
            constructor() { transfers.push(this); }
            open() {}
            setRequestHeader() {}
            getResponseHeader() { return 'A'; }
            send() {}
            abort() {
                this.aborted = true;
                assert.ok(hidden(document.querySelector('form')));
                assert.equal(session.isCurrent(oldToken), false);
                if (abortThrows) throw new Error('abort denied');
                this.onabort?.();
            }
        }
        globalThis.XMLHttpRequest = ControlledXHR;
        try {
            await mount(boundary(h(React.Fragment, null, h(AddVideoForm, { actorId: 'A', trainingId: 't' }), h(DirectVerifyControl))));
            const select = document.querySelector('select');
            await act(async () => {
                select.value = 'upload';
                select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
            });
            const file = new File(['synthetic'], 'synthetic.mp4', { type: 'video/mp4' });
            // Supply only the FileList serialization JSDOM cannot provide; production handlers stay real.
            globalThis.FormData = class extends NativeFormData { get(name) { return name === 'file' ? file : super.get(name); } };
            override = (path, options) => {
                if (path === 'uploads' && options.method === 'POST') return response({ id: 'u' });
                if (refreshing && path === 'bootstrap') {
                    loadedAfterStop += 1;
                    assert.equal(transfers.at(-1).aborted, true);
                }
                return null;
            };
            await submit(document.querySelector('form'));
            await act(async () => { oldToken = await session.authorize(); });
            assert.equal(session.isCurrent(oldToken), true);
            const transfer = transfers.at(-1);
            assert.ok(transfer);

            await click('direct verify');

            assert.equal(transfer.aborted, true);
            assert.equal(session.isCurrent(oldToken), false);
            assert.equal(loadedAfterStop > 0, !abortThrows);
            assert.equal(hidden(document.querySelector('form')), abortThrows);
            if (abortThrows) assert.match(document.body.textContent, /未能完成内容清理/);
            await act(async () => transfer.onload());
            assert.equal(calls.filter(c => /complete|trainings\/t\/videos/.test(c.path)).length, 0);
        } finally {
            globalThis.FormData = NativeFormData;
            globalThis.XMLHttpRequest = OriginalXHR;
            await unmount();
        }
    }
});

test('media unknown transport queries status and retries same reservation and completion key without duplicate creation', async () => {
    const OriginalXHR = globalThis.XMLHttpRequest, NativeFormData = globalThis.FormData;
    const requests = [];
    class ControlledXHR {
        upload = {}; status = 200; responseText = '{"data":{"id":"u"}}'; headers = {};
        constructor() { requests.push(this); }
        open() {} setRequestHeader(key, value) { this.headers[key] = value; }
        getResponseHeader() { return 'A'; } send() {} abort() { this.onabort?.(); }
    }
    globalThis.XMLHttpRequest = ControlledXHR;
    try {
        await mount(boundary(h(AddVideoForm, { actorId: 'A', trainingId: 't' })));
        const select = document.querySelector('select');
        await act(async () => { select.value = 'upload'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        const file = new File(['synthetic'], 'synthetic.mp4', { type: 'video/mp4' });
        globalThis.FormData = class extends NativeFormData { get(name) { return name === 'file' ? file : super.get(name); } };
        let status = 'receiving', loseComplete = true;
        override = (path, options) => {
            if (path === 'uploads') return options.method === 'POST' ? response({ id: 'u' }) : response({items:[{ id: 'u', status, cleanupState: 'none' }],nextCursor:null});
            if (path === 'uploads/u/complete') { status = 'ready'; state.uploadStatus = 'ready'; state.receivedParts = 1; if (loseComplete) { loseComplete = false; throw new Error('synthetic completion response lost'); } return response({ id: 'u', mime: 'video/mp4', durationSec: 3 }); }
            return null;
        };
        const form = document.querySelector('form');
        await submit(form); assert.equal(requests.length, 1);
        await act(async () => requests[0].onerror()); await flush();
        assert.ok(calls.some(c => c.path === 'uploads/u' && c.options.method === 'GET'));
        assert.match(document.querySelector('[role=alert]').textContent, /暂时无法确认/);
        await submit(form); assert.equal(requests.length, 2);
        assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
        state.receivedParts = 1; await act(async () => requests[1].onload()); await flush();
        assert.equal(calls.filter(c => c.path === 'uploads/u/complete').length, 1);
        await submit(form);
        assert.equal(requests.length, 2, 'ready reservation never retransfers');
        const completions = calls.filter(c => c.path === 'uploads/u/complete');
        assert.equal(completions.length, 2);
        assert.equal(completions[0].options.headers['Idempotency-Key'], completions[1].options.headers['Idempotency-Key']);
        assert.equal(calls.filter(c => c.path === 'uploads' && c.options.method === 'POST').length, 1);
        assert.equal(calls.filter(c => c.path === 'trainings/t/videos').length, 1);
    } finally { globalThis.FormData = NativeFormData; globalThis.XMLHttpRequest = OriginalXHR; await unmount(); }
});

test('long upload refresh requires full same-file reselect and sends only missing part; changed same-name bytes are rejected',async()=>{
 const OriginalXHR=globalThis.XMLHttpRequest,NativeFormData=globalThis.FormData;const {hashUploadFile}=await import('../../lib/client/upload.ts');const {MEDIA_PART_BYTES}=await import('../../lib/contracts/media.ts');
 const file=new File([new Uint8Array(MEDIA_PART_BYTES),new Uint8Array([1])],'same.mp4',{lastModified:1});const manifest=await hashUploadFile(file,()=>true);
 for(const changed of [true,false]){
  const requests=[];globalThis.XMLHttpRequest=class{upload={};headers={};constructor(){requests.push(this);}open(){}setRequestHeader(k,v){this.headers[k]=v;}getResponseHeader(){return'A';}send(blob){this.blob=blob;}abort(){this.onabort?.();}};
  try{
   await mount(boundary(h(AddVideoForm,{actorId:'A',trainingId:'t'})));
   override=(path)=>path==='uploads'?response({items:[{id:'recover',bytes:file.size,status:'receiving',cleanupState:'none',protocol:2}],nextCursor:null}):path==='uploads/recover'?response({id:'recover',bytes:file.size,status:'receiving',cleanupState:'none',protocol:2,receivedParts:1,nextPart:2,manifest,policy:HOSTED_MEDIA_POLICY}):null;
   const source=document.querySelector('select');await act(async()=>{source.value='upload';source.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   const select=[...document.querySelectorAll('select')][1];assert.ok(select);await act(async()=>{select.value='recover';select.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   const selected=changed?new File([new Uint8Array(MEDIA_PART_BYTES),new Uint8Array([2])],'same.mp4',{lastModified:1}):file;
   globalThis.FormData=class extends NativeFormData{get(name){return name==='file'?selected:super.get(name);}};
   await submit(document.querySelector('form'));
   if(changed){assert.equal(requests.length,0);assert.match(document.querySelector('[role=alert]').textContent,/原文件不一致/);assert.equal(document.querySelector('[name=file]').disabled,false);}
   else{assert.equal(requests.length,1);assert.equal(requests[0].headers['X-Kapok-Part'],'2');assert.equal(requests[0].blob.size,1);await lifecycle('blur');}
   assert.equal(calls.filter(c=>c.path==='uploads'&&c.options.method==='POST').length,0,'refresh must reuse the server reservation');
  }finally{globalThis.FormData=NativeFormData;await unmount();}
 }
 globalThis.XMLHttpRequest=OriginalXHR;
});
test('received and legacy ready reservations continue without a file; query failure never creates another upload and native errors stay Chinese',async()=>{
 for(const mode of ['received','legacy-ready','query-fails']){
  try{
   await mount(boundary(h(AddVideoForm,{actorId:'A',trainingId:'t'})));
   override=path=>path==='uploads'?response({items:[{id:'recover',bytes:10,status:mode==='legacy-ready'?'ready':'received',cleanupState:'none',protocol:mode==='legacy-ready'?1:2}],nextCursor:null}):path==='uploads/recover'?response({id:'recover',bytes:10,status:mode==='legacy-ready'?'ready':'received',cleanupState:'none',protocol:mode==='legacy-ready'?1:2,receivedParts:1,nextPart:2,manifest:null,policy:HOSTED_MEDIA_POLICY}):path==='uploads/recover/complete'?response({id:'recover',status:'ready',mime:'video/mp4',durationSec:3}):null;
   const source=document.querySelector('select');await act(async()=>{source.value='upload';source.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   const select=[...document.querySelectorAll('select')][1];await act(async()=>{select.value='recover';select.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   assert.equal(document.querySelector('[name=file]'),null);
   if(mode==='query-fails'){const prior=override;override=(path,...args)=>{if(path==='uploads/recover')throw new TypeError('Failed to fetch');return prior(path,...args);};}
   await submit(document.querySelector('form'));
   assert.equal(calls.filter(c=>c.path==='uploads'&&c.options.method==='POST').length,0);
   if(mode==='query-fails'){assert.match(document.querySelector('[role=alert]').textContent,/暂时无法确认/);assert.ok(!document.body.textContent.includes('Failed to fetch'));}
   else{assert.equal(calls.filter(c=>c.path==='trainings/t/videos').length,1);assert.match(document.body.textContent,/视频已添加到训练/);}
  }finally{await unmount();}
 }
});

test('R1 I2 both resume and cleanup can explicitly reach an upload beyond the first 50 without accumulating pages',async()=>{
 const {hashUploadFile}=await import('../../lib/client/upload.ts');const file=new File(['synthetic-page'],'same.mp4'),manifest=await hashUploadFile(file,()=>true);
 const rows=Array.from({length:50},(_,n)=>({id:'new-'+n,bytes:file.size,status:'pending',cleanupState:'none',createdAt:'2026-10-17',protocol:2,receivedParts:0}));const oldest={...rows[0],id:'oldest-51',createdAt:'2026-10-16'};
 const OriginalXHR=globalThis.XMLHttpRequest,NativeFormData=globalThis.FormData,confirm=window.confirm;const requests=[];
 globalThis.XMLHttpRequest=class{upload={};headers={};constructor(){requests.push(this);}open(){}setRequestHeader(k,v){this.headers[k]=v;}getResponseHeader(){return'A';}send(blob){this.blob=blob;}abort(){this.onabort?.();}};
 try{
  await mount(boundary(h(AddVideoForm,{actorId:'A',trainingId:'t'})));
  override=path=>path==='uploads'?response({items:rows,nextCursor:'older'}):path==='uploads?cursor=older'?response({items:[oldest],nextCursor:null}):path==='uploads/oldest-51'?response({id:oldest.id,bytes:file.size,status:'pending',cleanupState:'none',protocol:2,receivedParts:0,nextPart:1,manifest,policy:HOSTED_MEDIA_POLICY}):null;
  const source=document.querySelector('select');await act(async()=>{source.value='upload';source.dispatchEvent(new Event('change',{bubbles:true}));});await flush();await click('查看更早的本人上传');
  const select=[...document.querySelectorAll('select')][1];assert.equal(select.options.length,2,'one replacement page plus new-upload choice');await act(async()=>{select.value=oldest.id;select.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
  globalThis.FormData=class extends NativeFormData{get(name){return name==='file'?file:super.get(name);}};await submit(document.querySelector('form'));assert.equal(requests.length,1);assert.equal(requests[0].headers['X-Kapok-Part'],'1');await lifecycle('blur');await unmount();
  globalThis.FormData=NativeFormData;await mount(boundary(h(UploadCleanup,{actorId:'A',initial:{items:rows,nextCursor:'older'}})));
  override=(path,options)=>path==='uploads?cursor=older'?response({items:[oldest],nextCursor:null}):path==='uploads/oldest-51/cancel'&&options.method==='POST'?response({id:oldest.id,status:'cancelled'}):null;window.confirm=()=>true;
  await click('查看更早的未挂载上传');assert.equal(document.querySelectorAll('.discussion').length,1);await click('取消并清理');assert.equal(calls.filter(c=>c.path==='uploads/oldest-51/cancel').length,1);assert.match(document.body.textContent,/这次上传已取消并清理/);
 }finally{globalThis.FormData=NativeFormData;globalThis.XMLHttpRequest=OriginalXHR;window.confirm=confirm;await unmount();}
});
test('R1 M2 repeat confirmation preserves codec or format rejection and explicit cleanup guidance in the real form',async()=>{
 for(const code of ['UNSUPPORTED_CODEC','UNSUPPORTED_MEDIA']){
  try{
   await mount(boundary(h(AddVideoForm,{actorId:'A',trainingId:'t'})));let rejected=false;
   const reason=(code==='UNSUPPORTED_CODEC'?'当前暂不支持它的编码。':'文件未通过视频格式检查。')+'请先取消并清理这次上传，再选择新文件。';
   override=path=>path==='uploads'?response({items:[{id:'bad',bytes:10,status:'received',cleanupState:'none',protocol:2,receivedParts:1}],nextCursor:null}):path==='uploads/bad'?response({id:'bad',bytes:10,status:'received',cleanupState:rejected?'pending':'none',protocol:2,receivedParts:1,nextPart:2,manifest:null,policy:HOSTED_MEDIA_POLICY,rejection:rejected?{code,message:reason}:null}):path==='uploads/bad/complete'?(rejected=true,new Response(JSON.stringify({error:{code,message:reason,retryable:false}}),{status:415,headers:{'X-Kapok-Actor':'A'}})):null;
   const source=document.querySelector('select');await act(async()=>{source.value='upload';source.dispatchEvent(new Event('change',{bubbles:true}));});await flush();const select=[...document.querySelectorAll('select')][1];await act(async()=>{select.value='bad';select.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   const form=document.querySelector('form');await submit(form);assert.equal(document.querySelector('[role=alert]').textContent,reason);await submit(form);assert.equal(document.querySelector('[role=alert]').textContent,reason);assert.equal(calls.filter(c=>c.path==='uploads/bad/complete').length,1);assert.ok([...document.querySelectorAll('button')].some(b=>b.textContent==='取消并清理上传'&&!b.disabled));
  }finally{await unmount();}
 }
});
