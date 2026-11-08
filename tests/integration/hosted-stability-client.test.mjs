import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
// Media decoding is outside this event/request regression; existing R1 tests instrument pause ordering.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
dom.window.HTMLMediaElement.prototype.pause = function () {};
const { createRoot } = await import('react-dom/client');
const { JoinScreen, HomeScreen } = await import('../../app/components/legacy-screens.tsx');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { AccountBoundary } = await import('../../app/components/secure-resource.tsx');
const { api, createRequestKey } = await import('../../lib/client/api.ts');
const { AccessState } = await import('../../app/components/shell.tsx');
const h = React.createElement;
const emptyMe = { user: null, profile: null, membership: null, team: null };
const eligible = { actorId: 'A', me: emptyMe };
const initialized = { ...eligible, me: { ...emptyMe, user: { id: 'user-A', status: 'active' }, membership: { id: 'm', status: 'active', role: 'admin', epoch: 1 } } };
let root, state, calls, override;
const response = (data, actor = 'A') => new Response(JSON.stringify({ data }), { headers: { 'X-Kapok-Actor': actor } });
async function settle() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); }
async function mount(node = h(JoinScreen, { actorId: 'A', returnTo: '/trainings' })) {
    window.sessionStorage.clear();
    calls = []; state = eligible; override = null;
    globalThis.fetch = async (url, options = {}) => {
        const path = String(url).replace('/api/v1/', ''); calls.push({ path, options });
        return (await override?.(path, options)) ?? response(path === 'bootstrap' ? state : path === 'me' ? state.me : path.startsWith('activity?') ? { items: [], nextCursor: null } : path === 'videos/v' ? { id: 'v', title: 'synthetic video', source: 'upload', status: 'active', durationSec: 30, training: { id: 't', status: 'published' } } : []);
    };
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(node)); await settle();
}
async function unmount() { await act(async () => root?.unmount()); root = null; }
async function lifecycle(name) { await act(async () => window.dispatchEvent(new Event(name))); await settle(); }
async function click(text) { const button = [...document.querySelectorAll('button')].find(node => node.textContent.includes(text)); assert.ok(button, text); await act(async () => button.click()); await settle(); }
const hidden = node => !!node.closest('[hidden]');
const writes = () => calls.filter(call => call.options.method !== 'GET');
async function input(node, value) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function submit() { await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await settle(); }

test('hosted onboarding field focus is stable; passive window blur has honest status and read-only retry', async () => {
    try {
        await mount();
        const name = document.querySelector('[name=discName]');
        await input(name, 'same A unsent');
        const count = calls.length;
        await act(async () => { name.focus(); document.querySelector('[name=jerseyNumber]').focus(); });
        assert.equal(calls.length, count, 'ordinary field focus is not window revalidation');
        assert.equal(hidden(name), false);
        await lifecycle('blur');
        assert.equal(hidden(name), true);
        assert.equal(calls.length, count, 'blur conceals without claiming a live request');
        assert.match(document.querySelector('[role=status]').textContent, /暂时锁定/);
        assert.equal(document.querySelector('[role=status]').getAttribute('aria-busy'), 'false');
        await click('重新确认');
        assert.equal(hidden(name), false);
        assert.equal(name.value, 'same A unsent');
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});

test('hosted onboarding timeout is finite and retry reads current membership', async t => {
    try {
        await mount();
        const name = document.querySelector('[name=discName]');
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let finish;
        override = path => path === 'bootstrap' ? new Promise(resolve => { finish = resolve; }) : null;
        await lifecycle('focus');
        assert.equal(document.querySelector('[role=status]').getAttribute('aria-busy'), 'true');
        await act(async () => t.mock.timers.tick(15_001)); await settle();
        assert.equal(hidden(name), true);
        assert.match(document.querySelector('[role=alert]').textContent, /超时|未能确认/);
        assert.equal(document.querySelector('[role=alert]').getAttribute('aria-busy'), 'false');
        override = null; state = initialized;
        await click('重新确认');
        assert.match(document.body.textContent, /该账号已完成注册/);
        assert.equal(document.querySelector('form'), null);
        await act(async () => finish(response(eligible))); await settle();
        assert.equal(document.querySelector('form'), null, 'late timeout payload cannot reopen onboarding');
        assert.equal(writes().length, 0);
    } finally { t.mock.timers.reset(); await unmount(); }
});

test('hosted superseded bootstrap response cannot end or reopen a newer verified generation', async () => {
    try {
        await mount();
        let finish;
        override = path => path === 'bootstrap' ? new Promise(resolve => { finish = resolve; }) : null;
        await lifecycle('focus');
        const oldSignal = calls.at(-1).options.signal;
        await lifecycle('blur');
        assert.equal(oldSignal?.aborted, true);
        override = null; state = initialized;
        await lifecycle('pageshow');
        await act(async () => finish(response({ ...eligible, actorId: 'B' }, 'B'))); await settle();
        assert.match(document.body.textContent, /该账号已完成注册/);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, false);
        assert.equal(document.querySelector('form'), null);
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});

test('hosted callback resource hang also reaches safe retry; late callback data never reveals', async t => {
    let finish;
    const load = () => new Promise(resolve => { finish = resolve; });
    try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        await mount(h(AccountBoundary, { actorId: 'A', allowUnprofiled: true, load }, data => h('p', null, data)));
        await act(async () => t.mock.timers.tick(15_001)); await settle();
        assert.match(document.querySelector('[role=alert]')?.textContent ?? '', /超时|未能确认/);
        await act(async () => finish('obsolete private payload')); await settle();
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.ok(!document.body.textContent.includes('obsolete private payload'));
    } finally { t.mock.timers.reset(); await unmount(); }
});

test('hosted API bounds fetch and body waits; write timeout keeps result unknown and stable retry key', async t => {
    const original = globalThis.fetch;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        for (const phase of ['fetch', 'body']) {
            let signal, finish;
            globalThis.fetch = async (_url, options) => {
                signal = options.signal;
                if (phase === 'fetch') return new Promise(resolve => { finish = resolve; });
                return { status: 200, ok: true, headers: new Headers({ 'X-Kapok-Actor': 'A' }), json: () => new Promise(resolve => { finish = resolve; }) };
            };
            const pending = api('bootstrap', undefined, 'A');
            const rejected = assert.rejects(pending, error => error.code === 'REQUEST_TIMEOUT' && error.retryable);
            for (let i = 0; i < 5; i++) await Promise.resolve();
            t.mock.timers.tick(15_001);
            for (let i = 0; i < 10; i++) await Promise.resolve();
            assert.equal(signal?.aborted, true, 'deadline aborts the actual request');
            await rejected;
            assert.equal(signal.aborted, true);
            finish(phase === 'fetch' ? response(eligible, 'B') : { data: eligible });
            await Promise.resolve();
        }
        const key = createRequestKey(); const body = { discName: 'A', jerseyNumber: '01' }; const first = key('A', body);
        globalThis.fetch = async () => new Promise(() => {});
        const write = api('join', { method: 'POST', actorId: 'A', body, key: first });
        const rejected = assert.rejects(write, error => error.code === 'REQUEST_TIMEOUT' && /结果尚未确认/.test(error.message));
        t.mock.timers.tick(15_001);
        let completed = false; rejected.then(() => { completed = true; });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(completed, true, 'write deadline settles the request'); await rejected;
        assert.equal(key('A', body), first);
    } finally { t.mock.timers.reset(); globalThis.fetch = original; }
});

test('hosted lost enrollment response confirms current membership without a second write', async t => {
    try {
        await mount();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let committed = false, finishConfirmation;
        override = (path, options) => {
            if (path === 'join' && options.method === 'POST') { state = initialized; committed = true; return new Promise(() => {}); }
            if (path === 'bootstrap' && committed) { committed = false; return new Promise(resolve => { finishConfirmation = resolve; }); }
            return null;
        };
        await input(document.querySelector('[name=discName]'), '队员');
        await input(document.querySelector('[name=jerseyNumber]'), '07');
        await submit();
        await click('确认提交');
        assert.equal(writes().length, 1);
        await act(async () => t.mock.timers.tick(15_001)); await settle();
        assert.match(document.querySelector('[role=status]').textContent, /正在确认上次资料提交结果/);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        await act(async () => finishConfirmation(response(initialized))); await settle();
        assert.match(document.body.textContent, /该账号已完成注册/);
        assert.equal(document.querySelector('form'), null);
        assert.equal(writes().length, 1);
        assert.equal(document.querySelector('[name=token]'), null);
    } finally { t.mock.timers.reset(); await unmount(); }
});

test('B verified unregistered Access session sees an explicit registration choice on the business entry', async () => {
    try {
        const principal = { provider: 'access', issuer: 'https://example.test', subject: 'A', verifiedEmail: 'a@example.test' };
        await mount(h(AccessState, { context: { user: { userId: 'A', principal }, me: emptyMe, error: null }, returnTo: '/growth' }));
        assert.match(document.body.textContent, /该邮箱尚未注册/);
        assert.ok(document.querySelector('a[href="/register?returnTo=%2Fgrowth"]'));
        assert.equal(document.querySelector('form'), null);
        assert.equal(document.querySelector('[name=token], a[href="/internal/bootstrap"]'), null);
    } finally { await unmount(); }
});

test('hosted actual Home/Video loader transport and body abort suppress late account/expiry signals', async () => {
    for (const screen of [HomeScreen, VideoDiscussion]) {
        for (const phase of ['fetch', 'body']) {
            let finish, oldSignal, signals = 0;
            const changed = () => { signals += 1; };
            window.addEventListener('kapok-account-changed', changed);
            window.addEventListener('kapok-session-expired', changed);
            try {
                await mount(h(screen, { actorId: 'A', videoId: 'v' }));
                state = initialized;
                const target = screen === HomeScreen ? 'trainings' : 'videos/v/comments';
                override = (path, options) => {
                    if (path !== target) return null;
                    oldSignal = options.signal;
                    if (phase === 'fetch') return new Promise(resolve => { finish = resolve; });
                    return { status: 200, ok: true, headers: new Headers({ 'X-Kapok-Actor': 'A' }), json: () => new Promise(resolve => { finish = resolve; }) };
                };
                await lifecycle('focus');
                assert.ok(finish, 'production callback request reached the selected phase');
                await lifecycle('blur');
                assert.equal(oldSignal?.aborted, true, 'callback fetch/body is canceled with its boundary');
                override = null;
                await lifecycle('pageshow');
                const surface = document.querySelector('[data-kapok-sensitive]');
                assert.equal(surface.hidden, false);
                await act(async () => finish(phase === 'fetch' ? new Response('', { status: 401 }) : { data: ['obsolete'] })); await settle();
                assert.equal(signals, 0, 'obsolete API cannot emit global account or expiry events');
                assert.equal(surface.hidden, false);
                assert.ok(!document.body.textContent.includes('obsolete'));
            } finally {
                window.removeEventListener('kapok-account-changed', changed);
                window.removeEventListener('kapok-session-expired', changed);
                await unmount();
            }
        }
    }
});

test('hosted onboarding double submit issues only one enrollment', async () => {
    try {
        await mount();
        let finish;
        override = (path, options) => path === 'join' && options.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : null;
        await input(document.querySelector('[name=discName]'), '队员');
        await input(document.querySelector('[name=jerseyNumber]'), '07');
        const form = document.querySelector('form');
        await act(async () => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }); await settle();
        assert.equal(writes().length, 0);
        const confirm = [...document.querySelectorAll('dialog button')].find(node => node.textContent === '确认提交');
        await act(async () => { confirm.click(); confirm.click(); }); await settle();
        assert.equal(writes().length, 1);
        state = initialized;
        await act(async () => finish(response({ me: initialized.me, returnTo: '/trainings' }))); await settle();
    } finally { await unmount(); }
});

test('hosted onboarding visibility restore rechecks without flashing or losing same-account inputs', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
        await mount();
        const name = document.querySelector('[name=discName]');
        await input(name, 'retained same A');
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            assert.equal(hidden(name), true, 'hide occurs synchronously during visibility event');
        });
        assert.match(document.querySelector('[role=status]').textContent, /暂时锁定/);
        let finish;
        override = path => path === 'bootstrap' ? new Promise(resolve => { finish = resolve; }) : null;
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
            assert.equal(hidden(name), true, 'visibility return cannot flash old content before verification');
        }); await settle();
        assert.equal(document.querySelector('[role=status]').getAttribute('aria-busy'), 'true');
        override = null;
        await act(async () => finish(response(eligible))); await settle();
        assert.equal(hidden(name), false);
        assert.equal(name.value, 'retained same A');
        await lifecycle('pagehide');
        assert.equal(hidden(name), true);
        await lifecycle('pageshow');
        assert.equal(hidden(name), false);
        assert.equal(writes().length, 0);
    } finally {
        if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
        else delete document.visibilityState;
        await unmount();
    }
});

test('hosted onboarding network failure keeps safe retry actionable across repeated failures', async () => {
    try {
        await mount();
        const name = document.querySelector('[name=discName]');
        override = () => { throw new Error('连接未完成，暂未能确认当前状态。'); };
        await lifecycle('focus');
        for (let i = 0; i < 2; i++) {
            assert.equal(hidden(name), true);
            assert.match(document.querySelector('[role=alert]').textContent, /连接未完成/);
            assert.equal(document.querySelector('[role=alert]').getAttribute('aria-busy'), 'false');
            await click('重新确认');
        }
        override = null;
        await click('重新确认');
        assert.equal(hidden(name), false);
        assert.equal(document.querySelector('[role=alert]'), null);
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});
