import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
const { InitialVideosImport } = await import('../../app/components/initial-videos-import.tsx');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://kapok.party/admin/trainings/import', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'FormData', 'localStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
const { createRoot } = await import('react-dom/client');
const actorId = 'actor_' + 'a'.repeat(64);
const me = { user: { id: 'admin', status: 'active' }, team: { id: 'team' }, profile: { discName: '合成管理员' }, membership: { id: 'member', teamId: 'team', role: 'admin', status: 'active', epoch: 1 } };
const response = data => new Response(JSON.stringify({ data, requestId: 'synthetic' }), { headers: { 'X-Kapok-Actor': actorId, 'Content-Type': 'application/json' } });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text));
test('actual import UI previews precise binding, durable ledger, approval gate and account cleanup; storage failure stops writes', async () => {
    const writes = [];
    globalThis.fetch = async (url, init) => {
        assert.equal(init.credentials, 'same-origin');
        assert.equal(init.headers.Cookie, undefined);
        const path = String(url).slice('/api/v1/'.length);
        if (init.method === 'POST') { writes.push(path); throw new Error('No writes expected'); }
        if (path === 'bootstrap') return response({ actorId, me: { ...me, profile: null, team: null } });
        if (path === 'me') return response(me);
        if (path === 'trainings/import-inventory') return response({ trainings: [], videos: [] });
        throw new Error(path);
    };
    const root = createRoot(document.getElementById('root'));
    try {
        await act(async () => root.render(React.createElement(InitialVideosImport, { actorId })));
        await flush();
        assert.match(document.body.textContent, /合成管理员/);
        await act(async () => button('核对账号').click()); await flush();
        assert.equal(button('按已核对').disabled, true);
        assert.match(document.querySelector('pre').textContent, /"epoch": 1/);
        assert.match(document.querySelector('pre').textContent, /2026-11-07/);
        assert.equal(localStorage.length, 1);
        const storage = dom.window.Storage.prototype.setItem;
        dom.window.Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
        await act(async () => button('核对账号').click()); await flush();
        assert.match(document.body.textContent, /storage unavailable/);
        dom.window.Storage.prototype.setItem = storage;
        assert.equal(writes.length, 0);
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
        assert.equal(localStorage.length, 0);
        assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
    } finally { await act(async () => root.unmount()); }
});

test('browser transport rejects competing pending key and late response after actor fence closes', async () => {
    const { importTransport } = await import('../../lib/client/initial-videos-import.ts');
    const { confirmNavigationActor, pendingMutationKey } = await import('../../lib/client/navigation-state.ts');
    confirmNavigationActor(actorId, 'synthetic');
    const payload = { title: 'synthetic', date: '2026-11-01', description: '' };
    pendingMutationKey(actorId, 'POST', 'trainings/publish', payload, 'original-key');
    let count = 0; globalThis.fetch = async () => { count++; return response({}); };
    const transport = importTransport(actorId, new AbortController().signal, () => true);
    await assert.rejects(transport('trainings/publish', { actor: actorId, key: 'different-key', payload }), /未确认操作/);
    assert.equal(count, 0);
    let current = true;
    globalThis.fetch = async () => { current = false; return response(me); };
    await assert.rejects(importTransport(actorId, new AbortController().signal, () => current)('me'), /账号确认已失效/);
});

test('affirmative UI apply sends pinned approval binding and completes four publications then zero-add retry', async () => {
    localStorage.clear();
    const trainings = []; const videos = []; let writes = 0;
    globalThis.fetch = async (url, init) => {
        const path = String(url).slice('/api/v1/'.length);
        if (path === 'bootstrap') return response({ actorId, me: { ...me, profile: null, team: null } });
        if (path === 'me') return response(me);
        if (path === 'trainings/import-inventory') return response({ trainings, videos });
        if (path === 'trainings/publish' && init.method === 'POST') {
            const binding = JSON.parse(init.headers['X-Kapok-Import']);
            assert.deepEqual(binding, { actor: actorId, userId: 'admin', teamId: 'team', membershipId: 'member', epoch: 1, trainingDate: JSON.parse(init.body).date, trainingId: null });
            const body = JSON.parse(init.body); writes++;
            const training = { id: 'training' + writes, title: body.title, date: body.date, status: 'published' };
            const video = { id: 'video' + writes, trainingId: training.id, title: body.video.title, url: body.video.url, source: 'bilibili', position: 0, status: 'active', publisherId: 'admin' };
            trainings.push(training); videos.push(video);
            return response({ training, video });
        }
        throw new Error(path);
    };
    document.body.innerHTML = '<div id="root"></div>';
    const root = createRoot(document.getElementById('root'));
    try {
        await act(async () => root.render(React.createElement(InitialVideosImport, { actorId }))); await flush();
        await act(async () => button('核对账号').click()); await flush();
        await act(async () => document.querySelector('input[type=checkbox]').click());
        assert.equal(button('按已核对').disabled, false);
        await act(async () => button('按已核对').click()); await flush();
        assert.equal(writes, 4);
        assert.equal(document.querySelector('[role=alert]'), null);
        await act(async () => button('核对账号').click()); await flush();
        await act(async () => document.querySelector('input[type=checkbox]').click());
        await act(async () => button('按已核对').click()); await flush();
        assert.equal(writes, 4);
    } finally { await act(async () => root.unmount()); }
});

test('browser releases only the dedicated no-commit result, retaining generic conflict keys', async () => {
    const { importTransport } = await import('../../lib/client/initial-videos-import.ts');
    const { confirmNavigationActor, pendingMutationKey } = await import('../../lib/client/navigation-state.ts');
    const payload = { title: 'synthetic recovery', date: '2026-11-03', description: '' };
    const transport = importTransport(actorId, new AbortController().signal, () => true);
    for (const code of ['VERSION_CONFLICT', 'IMPORT_MAPPING_REJECTED_NO_COMMIT']) {
        confirmNavigationActor(actorId, code);
        globalThis.fetch = async () => new Response(JSON.stringify({ error: { code, message: 'synthetic rejection', retryable: false }, requestId: 'synthetic' }), { status: 409, headers: { 'X-Kapok-Actor': actorId } });
        await assert.rejects(transport('trainings/publish', { actor: actorId, payload, key: 'original' }), /synthetic rejection/);
        assert.equal(pendingMutationKey(actorId, 'POST', 'trainings/publish', payload, 'new'), code === 'VERSION_CONFLICT' ? 'original' : 'new');
    }
});

test('Access null bootstrap loads me abortably and discards its late profile after account changes', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    let complete; let signal; let reads = 0;
    globalThis.fetch = async (url, init) => {
        const path = String(url).slice('/api/v1/'.length);
        if (path === 'bootstrap') return response({ actorId, me: { ...me, profile: null, team: null } });
        if (path === 'me') {
            reads++; signal = init.signal;
            return new Promise(resolve => { complete = resolve; });
        }
        throw new Error(path);
    };
    const root = createRoot(document.getElementById('root'));
    try {
        await act(async () => root.render(React.createElement(InitialVideosImport, { actorId }))); await flush();
        assert.equal(reads, 1); assert.ok(signal); assert.equal(signal.aborted, false);
        assert.doesNotMatch(document.body.textContent, /合成管理员|未填写盘名/);
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
        assert.equal(signal.aborted, true);
        await act(async () => complete(response(me))); await flush();
        assert.doesNotMatch(document.body.textContent, /合成管理员/);
        assert.equal(button('按已核对'), undefined);
        assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
    } finally { await act(async () => root.unmount()); }
});
