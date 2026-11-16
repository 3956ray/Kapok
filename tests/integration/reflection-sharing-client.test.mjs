import '../helpers/react-loader.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { actorKey } from '../helpers/identity-fixture.mjs';
import { createSharingFixture, principals, syntheticContent } from '../helpers/sharing-browser-fixture.mjs';
import { dispatchApi } from '../../lib/server/http.ts';
// Only the framework's pathname is supplied; all product components and session guards remain real.
registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return { shortCircuit: true, url: 'data:text/javascript,export function usePathname(){return globalThis.testPathname ?? "/"};export function useRouter(){return {push(){}}}' };
    return next(specifier, context);
} });
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDialogElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
dom.window.HTMLMediaElement.prototype.pause = function () {};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
const { createRoot } = await import('react-dom/client');
const { ReflectionRead, ReflectionSharing } = await import('../../app/components/reflections.tsx');
const h = React.createElement;
const bootstrap = { actorId: 'A', siteUserId: 'A', me: { user: { id: 'user-A', status: 'active' }, membership: { status: 'active', role: 'admin', epoch: 1 } } };
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
const buttons = text => [...document.querySelectorAll('button')].filter(b => b.textContent === text);
async function click(text) { const b = buttons(text).find(b => b.closest('dialog[open]')) ?? buttons(text)[0]; assert.ok(b, text); await act(async () => b.click()); await flush(); }
async function selectScope(value) { const node = document.querySelector(`input[type=radio][value=${value}]`); assert.ok(node); await act(async () => node.click()); await flush(); }
async function lifecycle(name) { await act(async () => window.dispatchEvent(Object.assign(new Event(name), name === 'pageshow' ? { persisted: true } : {}))); await flush(); }
const activityLink = () => document.querySelector('[role=status] a[href="/activity"]');
const writes = () => calls.filter(c => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.options.method));

test('sharing confirmed summary stays private while dirty choice disables publication and cancel writes nothing', async () => {
    setup();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己/);
        assert.equal(buttons('确认全队可读').length, 0);
        await selectScope('team');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己/);
        assert.equal(buttons('发布到动态')[0].disabled, true);
        await click('确认全队可读');
        assert.equal(document.querySelector('dialog').open, true);
        assert.equal(document.activeElement.textContent, '取消');
        await click('取消');
        assert.equal(document.querySelector('dialog').open, false);
        assert.equal(document.querySelector('input:checked').value, 'team');
        assert.equal(document.activeElement.textContent, '确认全队可读');
        await click('取消修改');
        assert.equal(document.querySelector('input:checked').value, 'private');
        assert.equal(buttons('确认全队可读').length, 0);
        assert.equal(writes().length, 0);
        assert.equal(buttons('删除记录').length, 0);
    } finally { await unmount(); }
});

async function confirmIntent(trigger, confirm) { await click(trigger); await click(confirm); }
function mutations() {
    override = (path, options) => {
        if (options.method !== 'PUT') return null;
        const body = JSON.parse(options.body);
        const old = data['reflections/r/edit'];
        const next = { ...old, scope: body.scope ?? old.scope, published: body.scope === 'private' ? false : body.published ?? old.published, sharingVersion: old.sharingVersion + 1 };
        data['reflections/r/edit'] = next;
        return response(next);
    };
}
for (const scope of ['team', 'private']) {
    test(`sharing completed ${scope} scope change focuses the next action or returns to the title`, async () => {
        setup(); mutations();
        if (scope === 'private') data['reflections/r/edit'] = { ...reflection, scope: 'team', published: true };
        const grant = scope === 'team';
        const trigger = grant ? '确认全队可读' : '收回阅读权限';
        try {
            await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
            await selectScope(scope);
            const button = buttons(trigger)[0];
            await confirmIntent(trigger, grant ? '允许全队阅读' : trigger);
            assert.equal(document.querySelector('dialog').open, false);
            assert.equal(button.isConnected, false);
            if (grant) {
                const publish = buttons('发布到动态')[0];
                assert.equal(publish.disabled, false);
                assert.ok(document.activeElement === publish, 'a verified grant leads to a separate publication action');
                assert.match(document.getElementById(publish.getAttribute('aria-describedby')).textContent, /尚未发布/);
            } else {
                assert.ok(document.activeElement.matches('.sharing-title'), 'focus moves to the visible title');
            }
            assert.equal(document.activeElement.closest('[hidden]'), null);
        } finally { await unmount(); }
    });
}
test('author with a team-readable unpublished reflection has an explicit publication entry', async () => {
    setup(); data['reflections/r'] = { ...reflection, scope: 'team' };
    try {
        await mount(h(ReflectionRead, { actorId: 'A', id: 'r', saved: false }));
        const link = [...document.querySelectorAll('a')].find(node => node.textContent === '发布到队内动态');
        assert.ok(link);
        assert.equal(link.getAttribute('href'), '/reflections/r/sharing');
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});
test('sharing grant publish withdraw revoke uses one dialog per intent and verified success messages', async () => {
    setup(); mutations();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team'); await confirmIntent('确认全队可读', '允许全队阅读');
        assert.match(document.body.textContent, /全队已可阅读，尚未发布到动态。/);
        assert.equal(activityLink(), null);
        assert.equal(writes().length, 1);
        assert.equal(writes()[0].path, 'reflections/r/grants');
        const publicationTrigger = buttons('发布到动态')[0];
        await confirmIntent('发布到动态', '发布到动态');
        assert.equal(publicationTrigger.disabled, false);
        assert.ok(document.activeElement === publicationTrigger, 'focus returns to the enabled publication trigger');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：全队动态：已发布/);
        assert.match(document.body.textContent, /已发布到队内动态。/);
        assert.equal(activityLink()?.textContent, '查看动态');
        await confirmIntent('撤回动态', '撤回动态');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：全队动态：未发布/);
        assert.match(document.body.textContent, /动态已撤回，全队仍可阅读。/);
        assert.equal(activityLink(), null);
        await selectScope('private'); await confirmIntent('收回阅读权限', '收回阅读权限');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己动态：未发布/);
        assert.match(document.body.textContent, /已收回阅读权限，现在仅自己可读。/);
        assert.equal(writes().length, 4);
    } finally { await unmount(); }
});
test('sharing UI publishes against real D1 and safely reconciles a lost response', async t => {
    setup();
    const { service, db, dispose } = await createSharingFixture();
    t.after(dispose);
    const author = await actorKey(principals.author);
    const r = await service.saveReflection(principals.author, null, syntheticContent, 'ui-create');
    const path = `reflections/${r.id}`;
    const publishPath = `${path}/publication`;
    const origin = 'https://kapok.local';
    const dispatch = (principal, endpoint, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set('Origin', origin);
        return dispatchApi(new Request(`${origin}/api/v1/${endpoint}`, { ...options, headers }), endpoint.split('/'), principal, service);
    };
    let loseResponse = true;
    override = async (endpoint, options) => {
        const result = await dispatch(principals.author, endpoint, options);
        if (loseResponse && endpoint === publishPath) {
            assert.ok(result.ok);
            loseResponse = false;
            throw new Error('synthetic transport loss after D1 commit');
        }
        return result;
    };
    async function waitFor(condition) {
        const deadline = performance.now() + 5000;
        while (!condition() && performance.now() < deadline) await flush();
        assert.ok(condition());
    }
    const stored = () => db.prepare('SELECT scope, published_at FROM reflections WHERE id=?').bind(r.id).first();
    const member = endpoint => dispatch(principals.member, endpoint);
    const activity = async () => (await (await member('activity')).json()).data.items;
    try {
        await mount(h(ReflectionSharing, { actorId: author, id: r.id }));
        await waitFor(() => document.querySelector('.sharing-summary'));
        await selectScope('team'); await confirmIntent('确认全队可读', '允许全队阅读');
        await waitFor(() => document.querySelector('[role=status].success'));
        assert.ok(document.activeElement === buttons('发布到动态')[0]);
        assert.deepEqual(writes().map(write => write.path), [`${path}/grants`]);
        assert.deepEqual(await stored(), { scope: 'team', published_at: null });
        assert.deepEqual(await activity(), []);

        await confirmIntent('发布到动态', '发布到动态');
        await waitFor(() => buttons('核对结果').some(button => !button.disabled));
        assert.match(document.querySelector('[role=alert]').textContent, /暂未确认操作结果/);
        assert.equal(document.querySelector('[role=status].success'), null);
        assert.equal(activityLink(), null);
        const committed = await stored();
        assert.equal(committed.scope, 'team');
        assert.ok(committed.published_at);
        const [item] = await activity();
        assert.equal(item.href, `/${path}`);
        assert.equal(item.publishedAt, committed.published_at);
        assert.equal((await (await member(item.href.slice(1))).json()).data.text, syntheticContent.text);
        assert.deepEqual(await activity(), [item]);

        await click('核对结果');
        await waitFor(() => document.querySelector('[role=status].success'));
        assert.match(document.querySelector('[role=status].success').textContent, /已发布到队内动态/);
        const link = activityLink();
        assert.ok(link);
        assert.equal(link.textContent, '查看动态');
        const linkedActivity = await member(link.getAttribute('href').slice(1));
        assert.equal(linkedActivity.status, 200);
        assert.deepEqual((await linkedActivity.json()).data.items, [item]);
        const [first, retry] = writes().filter(write => write.path === publishPath);
        assert.equal(retry.options.body, first.options.body);
        assert.equal(retry.options.headers['Idempotency-Key'], first.options.headers['Idempotency-Key']);
        assert.deepEqual(await stored(), committed);
        assert.deepEqual(await activity(), [item]);

        await confirmIntent('撤回动态', '撤回动态');
        await waitFor(() => document.querySelector('[role=status].success'));
        assert.deepEqual(await activity(), []);
        assert.equal((await member(path)).status, 200);
        assert.deepEqual(await stored(), { scope: 'team', published_at: null });

        await selectScope('private'); await confirmIntent('收回阅读权限', '收回阅读权限');
        await waitFor(() => document.querySelector('[role=status].success'));
        assert.equal((await member(path)).status, 404);
        assert.deepEqual(await stored(), { scope: 'private', published_at: null });
    } finally { await unmount(); }
});
test('sharing committed receipt with failed read retains immutable body and key and blocks other payloads across navigation', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let readsFail = false;
    override = (path, options) => {
        if (path.endsWith('/publication') && options.method === 'PUT') {
            data['reflections/r/edit'] = { ...reflection, scope: 'team', published: true, sharingVersion: 2 };
            readsFail = true;
            return response(data['reflections/r/edit']);
        }
        if (path.endsWith('/edit') && readsFail) throw new Error('synthetic lost read');
        return null;
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        assert.match(document.querySelector('.sharing-summary').textContent, /动态：未发布/);
        assert.match(document.querySelector('[role=alert]').textContent, /暂未确认操作结果/);
        assert.ok([...document.querySelectorAll('input[type=radio]')].every(n => n.matches(':disabled')));
        assert.ok(document.activeElement === buttons('核对结果')[0], 'focus moves to the reconciliation action');
        assert.equal(document.activeElement.disabled, false);
        const original = writes()[0];
        await unmount(); readsFail = false;
        override = (path, options) => path.endsWith('/publication') && options.method === 'PUT' ? response(data['reflections/r/edit']) : null;
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        assert.ok(buttons('核对结果')[0]);
        await click('核对结果');
        assert.equal(writes().length, 2);
        assert.equal(writes()[1].options.body, original.options.body);
        assert.equal(writes()[1].options.headers['Idempotency-Key'], original.options.headers['Idempotency-Key']);
        assert.match(document.body.textContent, /已发布到队内动态。/);
        assert.equal(buttons('核对结果').length, 0);
        assert.ok(document.activeElement.matches('.sharing-title'), 'completed reconciliation focuses the title');
    } finally { await unmount(); }
});
test('sharing unknown transport replay after external revoke shows actual private state without false success', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let fail = true;
    override = (path, options) => {
        if (!path.endsWith('/publication') || options.method !== 'PUT') return null;
        if (fail) throw new Error('synthetic lost response');
        return response(data['reflections/r/edit']);
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        data['reflections/r/edit'] = { ...reflection, sharingVersion: 3 }; fail = false;
        await click('核对结果');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己/);
        assert.match(document.querySelector('[role=alert]').textContent, /分享状态已变化/);
        assert.ok(!document.body.textContent.includes('已发布到队内动态。'));
        assert.equal(writes()[0].options.body, writes()[1].options.body);
    } finally { await unmount(); }
});
test('sharing explicit conflict reconciles current state and read failure never retries the refused mutation', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let failRead = false;
    override = (path, options) => {
        if (path.endsWith('/publication') && options.method === 'PUT') {
            data['reflections/r/edit'] = { ...reflection, sharingVersion: 3 }; failRead = true;
            return new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'changed', retryable: false } }), { status: 409, headers: { 'X-Kapok-Actor': 'A' } });
        }
        if (path.endsWith('/edit') && failRead) throw new Error('read unavailable');
        return null;
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        failRead = false; await click('核对结果');
        assert.equal(writes().length, 1);
        assert.match(document.querySelector('[role=alert]').textContent, /分享状态已变化/);
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己/);
        assert.equal(activityLink(), null);
    } finally { await unmount(); }
});
test('sharing dialog Escape restores trigger and temporary lock closes top layer synchronously', async () => {
    setup();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team'); await click('确认全队可读');
        const dialog = document.querySelector('dialog');
        await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
        assert.equal(dialog.open, false);
        assert.equal(document.activeElement.textContent, '确认全队可读');
        await click('确认全队可读');
        await act(async () => window.dispatchEvent(new Event('pagehide')));
        assert.equal(dialog.open, false); assert.equal(dialog.hidden, true);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.equal(writes().length, 0);
        await lifecycle('pageshow');
        assert.equal(document.querySelector('input:checked').value, 'team');
    } finally { await unmount(); }
});
test('sharing account switch while submitting aborts late response and removes title and dialog', async () => {
    setup();
    let finish;
    override = (path, options) => path.endsWith('/grants') && options.method === 'PUT' ? new Promise(resolve => { finish = resolve; }) : null;
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team'); await confirmIntent('确认全队可读', '允许全队阅读');
        const modal = document.querySelector('dialog');
        assert.equal(modal.open, true);
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' })));
        assert.equal(modal.open, false); assert.equal(modal.hidden, true);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        await act(async () => finish(response({ ...reflection, scope: 'team', sharingVersion: 2 })));
        await flush();
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.ok(!document.body.textContent.includes('全队已可阅读'));
        assert.equal(document.querySelector('.sharing-title'), null);
        assert.ok(!document.activeElement.closest('[hidden], dialog:not([open])'), 'focus stays outside concealed sharing content');
    } finally { await unmount(); }
});
test('sharing changed permission while dialog open prevents mutation and reveals no success', async () => {
    setup();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team'); await click('确认全队可读');
        data.bootstrap = { ...bootstrap, me: { ...bootstrap.me, membership: { ...bootstrap.me.membership, epoch: 2 } } };
        await click('允许全队阅读');
        assert.equal(writes().length, 0);
        assert.equal(document.querySelector('dialog'), null);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
    } finally { await unmount(); }
});
test('sharing invalid private published snapshot disables writes and exposes recheck', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, published: true };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        assert.match(document.querySelector('.sharing-summary').textContent, /正在核对分享状态/);
        assert.equal(buttons('撤回动态')[0].disabled, true);
        assert.ok([...document.querySelectorAll('input[type=radio]')].every(n => n.matches(':disabled')));
        assert.ok(buttons('核对分享状态')[0]);
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});
test('sharing external verified snapshot discards stale radio buffer after lifecycle refresh', async () => {
    setup();
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team');
        data['reflections/r/edit'] = { ...reflection, sharingVersion: 3 };
        await lifecycle('pageshow');
        assert.equal(document.querySelector('input:checked').value, 'private');
        assert.equal(buttons('确认全队可读').length, 0);
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});

test('sharing page departure while request is held closes modal, retains exact unresolved request, and rejects late success', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let finish;
    override = (path, options) => path.endsWith('/publication') && options.method === 'PUT' ? new Promise(resolve => { finish = resolve; }) : null;
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        const original = writes()[0];
        const surface = document.querySelector('[data-kapok-sensitive]');
        let concealedFocus = 0;
        surface.addEventListener('focusin', () => { if (surface.hidden) concealedFocus += 1; });
        await lifecycle('pagehide');
        assert.equal(surface.hidden, true);
        assert.equal(document.querySelector('dialog').open, false);
        // The JSDOM dialog stub does not move focus when it closes.
        const retry = buttons('重新确认')[0];
        assert.ok(retry);
        retry.focus();
        assert.ok(document.activeElement === retry);
        await act(async () => finish(response({ ...reflection, scope: 'team', published: true, sharingVersion: 2 })));
        assert.ok(document.activeElement === retry, 'a late response does not steal focus from the lock controls');
        assert.equal(concealedFocus, 0);
        override = (path, options) => path.endsWith('/publication') && options.method === 'PUT' ? response(data['reflections/r/edit']) : null;
        await lifecycle('pageshow');
        assert.ok(buttons('核对结果')[0]);
        assert.ok(!document.body.textContent.includes('已发布到队内动态。'));
        data['reflections/r/edit'] = { ...reflection, scope: 'team', published: true, sharingVersion: 2 };
        await click('核对结果');
        assert.equal(writes()[1].options.body, original.options.body);
        assert.equal(writes()[1].options.headers['Idempotency-Key'], original.options.headers['Idempotency-Key']);
        assert.match(document.body.textContent, /已发布到队内动态。/);
    } finally { await unmount(); }
});
test('sharing read denial after a receipt conceals previously verified title and cannot report success', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let deny = false;
    override = (path, options) => {
        if (path.endsWith('/publication') && options.method === 'PUT') { deny = true; return response({ ...reflection, scope: 'team', published: true, sharingVersion: 2 }); }
        if (path.endsWith('/edit') && deny) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unavailable', retryable: false } }), { status: 404, headers: { 'X-Kapok-Actor': 'A' } });
        return null;
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.equal(document.querySelector('.sharing-title'), null);
        assert.ok(!document.body.textContent.includes('已发布到队内动态。'));
    } finally { await unmount(); }
});

test('sharing unresolved operation survives an authorization read failure before immutable replay', async () => {
    setup(); data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    let phase = 'lost';
    override = (path, options) => {
        if (phase === 'auth-failure' && path === 'bootstrap') return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'synthetic unavailable', retryable: true } }), { status: 503, headers: { 'X-Kapok-Actor': 'A' } });
        if (!path.endsWith('/publication') || options.method !== 'PUT') return null;
        if (phase === 'lost') throw new Error('synthetic lost response');
        data['reflections/r/edit'] = { ...reflection, scope: 'team', published: true, sharingVersion: 2 };
        return response(data['reflections/r/edit']);
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await confirmIntent('发布到动态', '发布到动态');
        phase = 'auth-failure'; await click('核对结果');
        assert.ok(buttons('核对结果')[0]);
        assert.equal(writes().length, 1);
        phase = 'recover'; await click('核对结果');
        assert.equal(writes().length, 2);
        assert.equal(writes()[0].options.body, writes()[1].options.body);
        assert.equal(writes()[0].options.headers['Idempotency-Key'], writes()[1].options.headers['Idempotency-Key']);
        assert.match(document.body.textContent, /已发布到队内动态。/);
    } finally { await unmount(); }
});

test('sharing first authorization failure preserves dirty scope without mutation and permits explicit retry', async () => {
    setup();
    let failAuthorization = false;
    override = (path, options) => {
        if (path === 'bootstrap' && failAuthorization) return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'synthetic authorization unavailable', retryable: true } }), { status: 503, headers: { 'X-Kapok-Actor': 'A' } });
        if (path.endsWith('/grants') && options.method === 'PUT') {
            data['reflections/r/edit'] = { ...reflection, scope: 'team', sharingVersion: 2 };
            return response(data['reflections/r/edit']);
        }
        return null;
    };
    try {
        await mount(h(ReflectionSharing, { actorId: 'A', id: 'r' }));
        await selectScope('team'); await click('确认全队可读');
        failAuthorization = true; await click('允许全队阅读');
        assert.equal(writes().length, 0);
        assert.equal(document.querySelector('input:checked').value, 'team');
        assert.match(document.querySelector('.sharing-summary').textContent, /阅读：仅自己动态：未发布/);
        assert.match(document.querySelector('[role=alert]').textContent, /尚未确认账号与权限/);
        assert.equal(document.querySelector('dialog').open, false);
        assert.equal(buttons('核对结果').length, 0);
        assert.equal(buttons('发布到动态')[0].disabled, true);
        assert.ok(document.activeElement === buttons('确认全队可读')[0], 'a refused initial authorization restores the enabled trigger');
        failAuthorization = false;
        await confirmIntent('确认全队可读', '允许全队阅读');
        assert.equal(writes().length, 1);
        assert.deepEqual(JSON.parse(writes()[0].options.body), { expectedVersion: 1, expectedSharingVersion: 1, expectedGeneration: 1, scope: 'team' });
        assert.match(document.body.textContent, /全队已可阅读，尚未发布到动态。/);
    } finally { await unmount(); }
});

test('editing shared reflection requires confirmation, Escape preserves the draft, and an unknown save replays the same request', async () => {
    setup();
    const { ReflectionEditor } = await import('../../app/components/reflections.tsx');
    const { draftKey } = await import('../../lib/client/session-guard.ts');
    const stored = draftKey('A', 'r');
    const shared = { ...reflection, scope: 'team', published: true, sharingVersion: 2 };
    data['reflections/r/edit'] = shared;
    try {
        await mount(h(ReflectionEditor, { actorId: 'A', id: 'r' }));
        const editor = document.querySelector('textarea');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, '尚未提交的修改');
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const before = localStorage.getItem(stored);
        await click('保存记录');
        const dialog = document.querySelector('dialog[open]');
        assert.ok(dialog);
        assert.match(dialog.textContent, /仅自己可读.*动态也会撤回/);
        assert.equal(document.activeElement.textContent, '取消');
        await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
        assert.equal(document.activeElement.textContent, '保存并收回分享');
        await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
        assert.equal(document.activeElement.textContent, '取消');
        assert.equal(writes().length, 0);
        await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
        assert.equal(dialog.open, false);
        assert.equal(document.activeElement, buttons('保存记录')[0]);
        assert.equal(localStorage.getItem(stored), before);
        assert.equal(editor.value, '尚未提交的修改');
        assert.equal(writes().length, 0);
        assert.deepEqual(data['reflections/r/edit'], shared);

        override = (_path, options) => {
            if (options.method !== 'PATCH') return null;
            throw new Error('connection lost');
        };
        await click('保存记录');
        await click('保存并收回分享');
        const [first] = writes();
        assert.equal(first.path, 'reflections/r');
        assert.equal(JSON.parse(first.options.body).expectedSharingVersion, 2);
        assert.equal(JSON.parse(first.options.body).text, '尚未提交的修改');
        assert.ok(JSON.parse(localStorage.getItem(stored)).pending);
        assert.equal(document.activeElement, buttons('确认上次云保存结果')[0]);
        await click('确认上次云保存结果');
        assert.equal(writes().length, 1);
        override = (path, options) => {
            if (path !== 'reflections/r' || options.method !== 'PATCH') return null;
            const saved = { ...shared, text: JSON.parse(options.body).text, version: 2, sharingVersion: 3, scope: 'private', published: false };
            data['reflections/r/edit'] = saved;
            return response(saved);
        };
        await click('保存并收回分享');
        const second = writes()[1];
        assert.equal(second.options.body, first.options.body);
        assert.equal(second.options.headers['Idempotency-Key'], first.options.headers['Idempotency-Key']);
        assert.equal(localStorage.getItem(stored), null);
        assert.match(document.querySelector('.privacy-line').textContent, /仅自己可读/);
    } finally { await unmount(); }
});

test('rebase after a concurrent share still requires confirmation before saving', async () => {
    setup();
    const { ReflectionEditor } = await import('../../app/components/reflections.tsx');
    try {
        await mount(h(ReflectionEditor, { actorId: 'A', id: 'r' }));
        override = (path, options) => {
            if (path !== 'reflections/r' || options.method !== 'PATCH') return null;
            data['reflections/r/edit'] = { ...reflection, scope: 'team', sharingVersion: 2 };
            return new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: '分享范围已变化', retryable: false } }), { status: 409, headers: { 'X-Kapok-Actor': 'A' } });
        };
        await click('保存记录');
        assert.equal(writes().length, 1);
        assert.equal(JSON.parse(writes()[0].options.body).expectedSharingVersion, 1);
        assert.equal(buttons('保存记录')[0].disabled, true);
        await click('保留本机输入，基于当前云版本继续');
        await click('保存记录');
        assert.ok(document.querySelector('dialog[open]'));
        assert.equal(writes().length, 1);
        await click('取消');
        assert.equal(data['reflections/r/edit'].scope, 'team');
    } finally { await unmount(); }
});

test('account loss closes shared edit confirmation and fences its actions', async () => {
    setup();
    const { ReflectionEditor } = await import('../../app/components/reflections.tsx');
    data['reflections/r/edit'] = { ...reflection, scope: 'team' };
    try {
        await mount(h(ReflectionEditor, { actorId: 'A', id: 'r' }));
        await click('保存记录');
        const confirm = buttons('保存并收回分享')[0];
        assert.ok(confirm?.closest('dialog[open]'));
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: 'A' })));
        assert.equal(document.querySelector('dialog[open]'), null);
        await act(async () => confirm.click());
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});

test('reader bookmark sits in the title row, opens notes and reflects confirmed collection state', async () => {
    setup();
    data['reflections/r'] = { ...reflection, isAuthor: false, scope: 'team' };
    data.collections = [];
    override = (path, options) => {
        if (path === 'collections' && options.method === 'POST') {
            data.collections = [{ id: 'saved-r', sourceKind: 'reflection', sourceId: 'r', privateNote: '', version: 1, timestampSec: null, source: null }];
            return response({ id: 'saved-r' });
        }
    };
    try {
        await mount(h(ReflectionRead, { actorId: 'A', id: 'r', saved: false }));
        let icon = document.querySelector('.reflection-title-row button[aria-label="收藏复盘"]');
        assert.ok(icon);
        assert.equal(buttons('加入成长').length, 0);
        assert.equal(icon.getAttribute('aria-expanded'), 'false');
        await act(async () => icon.click()); await flush();
        assert.equal(document.querySelector('.reflection-bookmark-panel').hidden, false);
        await click('保存收藏');
        icon = document.querySelector('.reflection-title-row button[aria-label="已收藏，查看私人备注"]');
        assert.ok(icon);
        assert.equal(icon.querySelector('svg').getAttribute('fill'), 'currentColor');
        assert.equal(writes().filter(c => c.path === 'collections').length, 1);
        await act(async () => icon.click()); await flush();
        assert.equal(document.querySelector('.reflection-bookmark-panel').hidden, true);
    } finally { await unmount(); }
});
