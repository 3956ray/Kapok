import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { signalAccountChange } from '../../lib/client/session-guard.ts';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/learn', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} postMessage() {} };
const { createRoot } = await import('react-dom/client');
const { LearningReading } = await import('../../app/components/learning-posts.tsx');
const h = React.createElement;
const actor = 'synthetic-discussion-actor';
const otherActor = 'synthetic-other-actor';
const member = { id: 'm', teamId: 't', role: 'member', status: 'active', epoch: 1 };
const author = { id: 'author', discName: '作者', jerseyNumber: '01' };
const reader = { id: 'reader', discName: '队友', jerseyNumber: '02' };
const comment = (id, by, text, rootId = null, replyToId = null) => ({
    id, postId: 'p', rootId, replyToId, author: by, replyTarget: null, text, status: 'active',
    version: 1, edited: false, timestampSec: null, mediaUrl: null, matchesCurrentMedia: false, createdAt: '2026-11-15T00:00:00Z',
});
const initial = [comment('root-a', author, '资料根串'), comment('target-b', reader, '队友的回复', 'root-a', 'root-a')];
const surface = () => document.querySelector('[data-kapok-sensitive]');
const composer = () => surface().querySelector('.discussion-composer');
const textarea = () => composer().querySelector('textarea');
const button = label => [...surface().querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent.trim() === label);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 8)); });
async function click(label) {
    const element = button(label);
    assert.ok(element, label);
    assert.equal(element.disabled, false, label);
    await act(async () => element.click());
    await settle();
}
const write = value => act(async () => {
    const area = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
});

test('learning discussion isolates drafts by direct target, post and account and confirms uncertain writes with the original key', async t => {
    const root = createRoot(document.querySelector('#root'));
    const previousFetch = globalThis.fetch;
    t.after(async () => {
        await act(async () => root.unmount());
        globalThis.fetch = previousFetch;
        localStorage.clear();
    });
    const requests = [];
    let comments = [...initial];
    const known = new Set();
    let resolveLate;
    let late = false;
    let currentActor = actor;
    async function render(id, actorId = actor) {
        currentActor = actorId;
        window.history.replaceState({}, '', '/learn/posts/' + id);
        await act(async () => root.render(h(LearningReading, { id, actorId })));
        await settle();
    }
    globalThis.fetch = async (input, options) => {
        const path = input.replace('/api/v1/', '');
        const requestActor = options.headers['X-Kapok-Actor'] ?? currentActor;
        const respond = (data, code = 200) => Response.json(code < 400 ? { data } : { error: data, requestId: 'synthetic' }, {
            status: code, headers: { 'X-Kapok-Actor': requestActor },
        });
        if (path === 'bootstrap') return respond({ actorId: requestActor, me: { user: { id: requestActor === actor ? 'reader' : 'other', status: 'active' }, membership: member } });
        if (path === 'learning/collections/editable') return respond([]);
        const match = path.match(/^learning\/posts\/(p|q)(\/comments)?$/);
        if (!match) throw new Error('Unexpected endpoint ' + path);
        const [, id, route] = match;
        if (!route) return respond({ id, kind: 'article', title: '合成资料', body: '合成正文', category: '战术', author, video: null, images: [], publishedVersion: 1 });
        if (options.method === 'GET') return respond(id === 'p' && requestActor === actor ? comments : initial);
        const body = JSON.parse(options.body);
        const key = options.headers['Idempotency-Key'];
        requests.push({ id, body, key });
        if (late) return new Promise(resolve => { resolveLate = () => resolve(respond({ id: 'late' })); });
        if (body.text === '根串输入') return respond({ code: 'INVALID_INPUT', message: '合成已知拒绝。', retryable: false }, 400);
        if (!known.has(key)) {
            known.add(key);
            comments = [...comments, { ...comment('saved', reader, body.text, body.rootId, body.replyToId), replyTarget: { id: 'target-b', authorName: '队友' } }];
            return respond({ code: 'RESULT_UNKNOWN', message: '尚未确认讨论操作结果。', retryable: true }, 503);
        }
        return respond({ id: 'saved' });
    };

    await render('p');
    await write('独立根输入');
    await click('回复 作者');
    await write('根串输入');
    await click('发送回复');
    assert.equal(textarea().value, '根串输入');
    assert.match(composer().textContent, /合成已知拒绝/);
    assert.ok(button('发送回复'));
    await click('回复 队友');
    assert.equal(textarea().value, '');
    await write('直接对象输入');
    await click('返回根讨论');
    assert.equal(textarea().value, '独立根输入');
    await click('回复 作者');
    assert.equal(textarea().value, '根串输入');
    await click('回复 队友');
    assert.equal(textarea().value, '直接对象输入');
    await click('发送回复');
    assert.equal(textarea().value, '直接对象输入');
    assert.equal(textarea().disabled, true);
    assert.match(composer().textContent, /上次操作结果待确认/);
    assert.doesNotMatch(surface().textContent, /讨论已发送/);
    await click('确认上次结果');
    assert.deepEqual(requests[1], requests[2]);
    assert.deepEqual(requests[2].body, { text: '直接对象输入', rootId: 'root-a', replyToId: 'target-b' });
    assert.equal([...surface().querySelectorAll('.discussion-text')].filter(node => node.textContent === '直接对象输入').length, 1);
    assert.equal(textarea().value, '独立根输入');

    await render('q');
    assert.equal(textarea().value, '');
    await write('其他资料输入');
    await render('p');
    assert.equal(textarea().value, '独立根输入');
    late = true;
    await click('发送讨论');
    assert.equal(typeof resolveLate, 'function');
    await act(async () => {
        signalAccountChange(actor);
        assert.equal(surface().hidden, true);
    });
    await render('p', otherActor);
    await act(async () => resolveLate());
    assert.equal(textarea().value, '');
    assert.doesNotMatch(surface().textContent, /独立根输入|讨论已发送/);
    assert.ok(!Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some(key => key.includes(actor)));
});
