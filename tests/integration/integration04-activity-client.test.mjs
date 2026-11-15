import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/learn', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} postMessage() {} };
const { createRoot } = await import('react-dom/client');
const { LearningReading } = await import('../../app/components/learning-posts.tsx');
const { Activity } = await import('../../app/components/community.tsx');
const h = React.createElement;
const actorId = 'synthetic-learning-activity';
const author = { id: 'author', discName: '作者', jerseyNumber: '01' };
const stamp = '2026-11-15T00:00:00.000Z';
const first = '570b0cf6-bee4-4893-b6a7-7d53a1ceb665';
const second = '49587af1-82da-4ad0-bcf5-c502d1a564ef';
const publication = (id, isAuthor = true) => ({ id, isAuthor, kind: 'article', title: '资料 ' + id, body: '合成正文', category: '战术',
    author, video: null, images: [], publishedVersion: 2, version: 2, membershipEpoch: 1 });
const bootstrap = { actorId, me: { user: { id: author.id, status: 'active' },
    membership: { id: 'm', teamId: 't', role: 'member', status: 'active', epoch: 1 } } };
const succeed = data => Response.json({ data }, { headers: { 'X-Kapok-Actor': actorId } });
const reject = (code, status, retryable) => Response.json({ error: { code, retryable, message: '动态待确认' } }, {
    status, headers: { 'X-Kapok-Actor': actorId },
});
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const button = name => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === name);
const tick = () => new Promise(resolve => setTimeout(resolve, 8));
async function click(name) {
    const element = button(name);
    assert.ok(element, name);
    assert.equal(element.disabled, false, name);
    await act(async () => { element.click(); await tick(); });
}
function setup(t, fetch) {
    const root = createRoot(document.querySelector('#root'));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    t.after(async () => {
        await act(async () => root.unmount());
        globalThis.fetch = previousFetch;
        localStorage.clear();
        window.history.replaceState({}, '', '/learn');
    });
    return (component, path) => act(async () => {
        window.history.replaceState({}, '', path);
        root.render(component);
        await tick();
    });
}

test('author activity controls keep the original pending request, reconcile current status, and isolate source changes', async t => {
    const attempts = [];
    let activity = { publishedVersion: 2, lastEventId: null, event: null };
    let late = deferred();
    const render = setup(t, async (input, options) => {
        const path = input.replace('/api/v1/', '');
        if (path === 'bootstrap') return succeed(bootstrap);
        if (['learning/collections/editable', 'collections'].includes(path) || path.endsWith('/comments')) return succeed([]);
        if (path === 'learning/posts/p?view=draft' || path === 'learning/posts/p') return succeed(publication('p'));
        if (path === 'learning/posts/q') return succeed(publication('q', false));
        if (path === 'learning/posts/p/activity' && options.method === 'GET') return succeed(activity);
        if (path !== 'learning/posts/p/activity') throw new Error('Unexpected endpoint ' + path);
        const request = { key: options.headers['Idempotency-Key'], method: options.method, input: JSON.parse(options.body) };
        attempts.push(request);
        if (attempts.length === 1 || attempts.length === 4) return late.promise;
        if (request.method === 'DELETE') {
            activity = { ...activity, event: null };
            return succeed(activity);
        }
        return succeed(activity);
    });
    const show = id => render(h(LearningReading, { id, actorId }), '/learn/posts/' + id);
    await show('p');
    await click('分享到队内动态');
    assert.equal(button('正在确认动态…').disabled, true);
    assert.doesNotMatch(document.body.textContent, /已分享到队内动态/);
    activity = { ...activity, lastEventId: first, event: { id: first, sharedAt: stamp } };
    await act(async () => { late.resolve(reject('RESULT_UNKNOWN', 503, true)); await tick(); });
    assert.match(document.body.textContent, /动态操作结果待确认/);
    await render(null, '/learn/posts/p');
    await show('p');
    assert.doesNotMatch(document.body.textContent, /已分享到队内动态/);
    await click('确认动态操作结果');
    assert.deepEqual(attempts[1], attempts[0]);
    assert.match(document.body.textContent, /已分享到队内动态/);
    await click('撤回动态');
    assert.deepEqual(attempts[2].input, { expectedPublishedVersion: 2, expectedMembershipEpoch: 1, expectedEventId: first });

    late = deferred();
    await click('分享到队内动态');
    assert.equal(attempts[3].input.expectedEventId, first);
    const secondState = { ...activity, lastEventId: second, event: { id: second, sharedAt: stamp } };
    await show('q');
    await act(async () => { late.resolve(succeed(secondState)); await tick(); });
    assert.match(document.body.textContent, /资料 q/);
    assert.doesNotMatch(document.body.textContent, /队内动态/);
    activity = secondState;
    await show('p');
    await click('确认动态操作结果');
    assert.deepEqual(attempts[4], attempts[3]);
    assert.match(document.body.textContent, /已分享到队内动态/);
});

test('activity resolves late old cycles against current visibility before displaying them', async t => {
    const late = deferred();
    const oldCard = { id: 'learning:' + first, kind: 'learning', title: '旧资料', href: '/learn/posts/p', publishedAt: stamp, updatedAt: stamp };
    const newCard = { ...oldCard, id: 'learning:' + second, title: '当前资料' };
    const queried = [];
    const render = setup(t, async input => {
        const path = input.replace('/api/v1/', '');
        if (path === 'bootstrap') return succeed(bootstrap);
        if (path === 'activity?limit=20') return late.promise;
        if (path === 'activity/learning?ids=' + first + ',' + second) { queried.push(path); return succeed([newCard]); }
        throw new Error('Unexpected endpoint ' + path);
    });
    await render(h(Activity, { actorId }), '/activity');
    await act(async () => { late.resolve(succeed({ items: [oldCard, { ...newCard, title: '待更新标题' }], nextCursor: null })); await tick(); });
    assert.equal(queried.length, 1);
    assert.doesNotMatch(document.body.textContent, /旧资料|待更新标题/);
    const link = [...document.querySelectorAll('a')].find(node => node.textContent === '当前资料');
    assert.equal(link.getAttribute('href'), '/learn/posts/p');
});
