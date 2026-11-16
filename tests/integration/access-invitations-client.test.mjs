// Fixed-team client tests supersede the former invitation management and token recovery tests.
import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { navigation } from '../helpers/next-stubs.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/videos/sample?t=14#comment-note', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { createRoot } = await import('react-dom/client');
const { JoinScreen } = await import('../../app/components/legacy-screens.tsx');
const { AccountBoundary } = await import('../../app/components/secure-resource.tsx');
const { default: Growth } = await import('../../app/growth/page.tsx');
const { default: Continue } = await import('../../app/auth/continue/page.tsx');
const { default: RegistrationProfile } = await import('../../app/register/profile/page.tsx');
const { setServerMe } = await import('../helpers/server-stubs.mjs');
const { runWithAccessIdentity } = await import('../../lib/server/request-identity.ts');
const { actorKey } = await import('../../lib/server/identity.ts');
const { clearNavigationActor } = await import('../../lib/client/navigation-state.ts');
const me = {
    user: { id: 'owner', status: 'active' },
    profile: { discName: 'Synthetic', jerseyNumber: '07', version: 1 },
    membership: { id: 'membership', teamId: 'kapok', role: 'admin', status: 'active', epoch: 1, version: 1 },
    team: null,
};
const empty = { user: null, profile: null, membership: null, team: null };
const response = (data, actor = 'A') => new Response(JSON.stringify({ data }), { headers: { 'X-Kapok-Actor': actor } });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
async function input(name, value) {
    const field = document.querySelector(`input[name="${name}"]`);
    assert.ok(field);
    await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(field, value);
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
}
async function click(label) {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
    assert.ok(button, label);
    await act(async () => button.click());
    await settle();
}
async function submit() {
    await act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await settle();
}

const target = '/videos/sample?t=14';
const active = { ...me, membership: { ...me.membership, role: 'member' } };
const cases = ['unknown-then-retry', 'committed-lost', 'late-revoked', 'late-account'];
for (const [index, scenario] of cases.entries()) {
    test('KPark client fixed-team form handles ' + scenario, async () => {
        navigation.length = 0;
        const actor = 'A' + index;
        let root = createRoot(document.getElementById('root'));
        const posts = [];
        let account = empty;
        let expired = false;
        let release;
        globalThis.fetch = async (url, init) => {
            const path = String(url).replace('/api/v1/', '');
            if (expired) return new Response(null, { status: 401 });
            if (path === 'bootstrap') return response({ actorId: actor, me: account }, actor);
            if (path === 'me') return response(account, actor);
            assert.equal(path, 'join');
            posts.push({ key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) });
            const receipt = { operationId: 'registered', me: active, returnTo: posts[0].body.returnTo };
            if (scenario === 'unknown-then-retry' && posts.length === 1) throw new Error('connection lost before commit');
            if (scenario === 'committed-lost') { account = active; throw new Error('connection lost after commit'); }
            if (scenario === 'late-revoked' || scenario === 'late-account') return new Promise(resolve => { release = () => resolve(response(receipt, actor)); });
            account = active;
            return response(receipt, actor);
        };
        try {
            await act(async () => root.render(React.createElement(JoinScreen, { actorId: actor, returnTo: target })));
            await settle();
            assert.deepEqual([...document.querySelectorAll('input')].map(field => field.name), ['discName', 'jerseyNumber']);
            await input('discName', 'Synthetic');
            await input('jerseyNumber', '07');
            await submit();
            assert.ok(document.querySelector('dialog').open);
            assert.match(document.querySelector('dialog').textContent, /Synthetic.*07.*Kapok/);
            assert.equal(posts.length, 0);
            await click('返回修改');
            assert.equal(document.querySelector('dialog').open, false);
            assert.equal(document.activeElement.textContent, '保存资料并加入');
            assert.equal(posts.length, 0);
            await submit();
            await click('确认提交');
            assert.deepEqual(posts[0].body, { discName: 'Synthetic', jerseyNumber: '07', intent: 'register', confirmed: true, returnTo: target + '#comment-note' });
            if (scenario === 'unknown-then-retry') {
                assert.equal(document.querySelector('[name=discName]').value, 'Synthetic');
                assert.equal(document.querySelector('[name=jerseyNumber]').value, '07');
                assert.match(document.body.textContent, /核对上次入队请求/);
                assert.equal(navigation.length, 0);
                expired = true;
                await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
                await settle();
                assert.match(document.body.textContent, /登录已过期/);
                await act(async () => root.unmount());
                clearNavigationActor(actor);
                root = createRoot(document.getElementById('root'));
                expired = false;
                await act(async () => root.render(React.createElement(JoinScreen, { actorId: actor, returnTo: target })));
                await settle();
                assert.equal(document.querySelector('[name=jerseyNumber]').value, '07');
                assert.match(document.body.textContent, /核对上次入队请求/);
                await submit();
                assert.deepEqual(posts[1], posts[0]);
                assert.deepEqual(navigation, ['refresh']);
            } else if (scenario === 'committed-lost') {
                assert.equal(posts.length, 1);
                assert.deepEqual(navigation, []);
                assert.match(document.body.textContent, /该账号已完成注册/);
                assert.equal(document.querySelector('a').getAttribute('href'), target);
            } else {
                if (scenario === 'late-account') await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actor })));
                else account = { ...active, membership: { ...active.membership, status: 'paused', version: 2 } };
                await act(async () => release());
                await settle();
                assert.equal(posts.length, 1);
                assert.equal(navigation.length, 0);
                assert.doesNotMatch(document.body.textContent, /已确认 Kapok 成员资格|该账号已完成注册/);
                assert.equal(document.querySelector('form'), null);
            }
        } finally { await act(async () => root.unmount()); }
    });
}

test('verified same actor restores an unsent draft after expiry and reload, but a different actor clears it', async () => {
    window.sessionStorage.clear();
    let actor = 'draft-owner';
    let expired = false;
    let root = createRoot(document.getElementById('root'));
    globalThis.fetch = async (url, options) => {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
        return expired ? new Response(null, { status: 401 }) : response({ actorId: actor, me: empty }, actor);
    };
    async function mount() {
        await act(async () => root.render(React.createElement(JoinScreen, {
            actorId: actor, returnTo: target, reverifyHref: '/auth/continue?intent=register&returnTo=%2Fvideos%2Fsample%3Ft%3D14'
        })));
        await settle();
    }
    try {
        await mount();
        await input('discName', 'Original actor');
        await input('jerseyNumber', '0017');
        expired = true;
        await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
        await settle();
        assert.match(document.body.textContent, /登录已过期/);
        assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
        assert.match(document.querySelector('a').getAttribute('href'), /intent=register/);
        await act(async () => root.unmount());
        root = createRoot(document.getElementById('root'));
        expired = false;
        await mount();
        assert.equal(document.querySelector('[name=discName]').value, 'Original actor');
        assert.equal(document.querySelector('[name=jerseyNumber]').value, '0017');
        actor = 'different-account';
        await mount();
        assert.equal(document.querySelector('[name=discName]').value, '');
        actor = 'draft-owner';
        await mount();
        assert.equal(document.querySelector('[name=discName]').value, '');
    } finally {
        await act(async () => root.unmount());
        window.sessionStorage.clear();
    }
});

const draftStorageKey = 'kapok:registration-draft';
const restricted = { ...active, membership: { ...active.membership, status: 'paused' } };

for (const { name, account, intent, page = Continue, expected } of [
    { name: 'registered continuation', account: active, intent: 'register', expected: /你已经是 Kapok 成员/ },
    { name: 'restricted continuation', account: restricted, intent: 'register', expected: /此账号暂不可进入队伍/ },
    { name: 'unregistered login', account: empty, intent: 'login', expected: /该邮箱尚未注册/ },
    { name: 'Access-first business gate', account: empty, intent: 'login', page: Growth, expected: /该邮箱尚未注册/ },
    { name: 'restricted profile', account: restricted, intent: 'register', page: RegistrationProfile, expected: /此账号暂不可进入队伍/ },
    { name: 'registered login redirect into application', account: active, intent: 'login', expected: /B application/ },
]) {
    test('full-page verification as B clears A registration draft on ' + name, async () => {
        window.sessionStorage.clear();
        const actorA = 'registration-owner';
        const principalB = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'different-account', verifiedEmail: 'b@example.test' };
        const actorB = await actorKey(principalB);
        let currentActor = actorA;
        let currentAccount = empty;
        let expired = false;
        let root;
        globalThis.fetch = async (url, options) => {
            const path = String(url).replace('/api/v1/', '');
            if (expired) return new Response(null, { status: 401 });
            if (path === 'bootstrap') return response({ actorId: currentActor, me: currentAccount }, currentActor);
            assert.equal(path, 'join');
            assert.equal(options.method, 'POST');
            throw new Error('registration response lost before commit');
        };
        async function navigate(element) {
            if (root) await act(async () => root.unmount());
            clearNavigationActor(currentActor);
            document.body.innerHTML = '<div id="root"></div>';
            root = createRoot(document.getElementById('root'));
            await act(async () => root.render(element));
            await settle();
        }
        const form = React.createElement(JoinScreen, { actorId: actorA, returnTo: target });
        try {
            await navigate(form);
            await input('discName', 'A private draft');
            await input('jerseyNumber', '0017');
            await submit();
            await click('确认提交');
            const saved = JSON.parse(window.sessionStorage.getItem(draftStorageKey));
            assert.equal(saved.actorId, actorA);
            assert.equal(saved.fields.jerseyNumber, '0017');
            assert.ok(saved.pending.key);
            expired = true;
            await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
            await settle();
            assert.match(document.body.textContent, /登录已过期/);
            assert.ok(window.sessionStorage.getItem(draftStorageKey), 'ordinary expiry preserves the draft');

            // The prior page unloads without an account-change event. B receives
            // a fresh authenticated document in the same browser tab.
            expired = false;
            currentActor = actorB;
            currentAccount = account;
            setServerMe(account);
            const args = { searchParams: Promise.resolve({ intent, returnTo: target }) };
            const verifiedPage = () => runWithAccessIdentity(principalB, () => page(args));
            if (name === 'registered login redirect into application') {
                await assert.rejects(verifiedPage, /redirect \/videos\/sample\?t=14$/);
                await navigate(React.createElement(AccountBoundary, { actorId: actorB, load: 'bootstrap' }, () => 'B application'));
            } else {
                await navigate(await verifiedPage());
            }
            assert.match(document.body.textContent, expected);
            assert.doesNotMatch(document.body.textContent, /A private draft/);
            assert.equal(window.sessionStorage.getItem(draftStorageKey), null);

            currentActor = actorA;
            currentAccount = empty;
            await navigate(form);
            assert.equal(document.querySelector('[name=discName]').value, '');
            assert.equal(document.querySelector('[name=jerseyNumber]').value, '');
            assert.doesNotMatch(document.body.textContent, /核对上次入队请求/);
        } finally {
            if (root) await act(async () => root.unmount());
            window.sessionStorage.clear();
        }
    });
}


test('obsolete auth actor verification cannot clear a newer page draft', async () => {
    window.sessionStorage.clear();
    const actorA = 'current-registration-owner';
    const principalB = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'obsolete-page', verifiedEmail: 'b@example.test' };
    const actorB = await actorKey(principalB);
    const fields = { discName: 'Same tab current draft', jerseyNumber: '0017' };
    const draft = JSON.stringify({ actorId: actorA, fields, pending: null });
    window.sessionStorage.setItem(draftStorageKey, draft);
    let finish;
    let staleSignal;
    let root = createRoot(document.getElementById('root'));
    try {
        globalThis.fetch = (_url, options) => {
            staleSignal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        };
        setServerMe(active);
        const verifiedPage = await runWithAccessIdentity(principalB, () => Continue({
            searchParams: Promise.resolve({ intent: 'register', returnTo: target }),
        }));
        await act(async () => root.render(verifiedPage));
        await settle();
        assert.equal(window.sessionStorage.getItem(draftStorageKey), draft, 'SSR actor alone must not clear a draft');
        assert.equal(typeof finish, 'function');
        await act(async () => root.unmount());
        assert.equal(staleSignal.aborted, true);
        globalThis.fetch = async () => response({ actorId: actorA, me: empty }, actorA);
        root = createRoot(document.getElementById('root'));
        await act(async () => root.render(React.createElement(JoinScreen, { actorId: actorA, returnTo: target })));
        await settle();
        await act(async () => finish(response({ actorId: actorB, me: active }, actorB)));
        await settle();
        assert.equal(window.sessionStorage.getItem(draftStorageKey), draft);
        assert.equal(document.querySelector('[name=discName]').value, fields.discName);
        assert.equal(document.querySelector('[name=jerseyNumber]').value, fields.jerseyNumber);
    } finally {
        await act(async () => root.unmount());
        window.sessionStorage.clear();
    }
});
