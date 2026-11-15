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
    const host = document.querySelector('#root');
    const root = createRoot(host);
    host.className = 'video-workspace';
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const viewport = Object.assign(new window.EventTarget(), { height: 500, scale: 1, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const previousFetch = globalThis.fetch;
    t.after(async () => {
        await act(async () => root.unmount());
        assert.equal(host.hasAttribute('data-video-keyboard'), false);
        assert.equal(host.style.getPropertyValue('--video-viewport-height'), '');
        if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
        else delete window.visualViewport;
        host.removeAttribute('class');
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
        if (path === 'learning/collections/editable' || path === 'collections') return respond([]);
        const match = path.match(/^learning\/posts\/(p|q)(\/comments)?$/);
        if (!match) throw new Error('Unexpected endpoint ' + path);
        const [, id, route] = match;
        if (!route) return respond({ id, kind: id === 'p' ? 'article' : 'video', title: '合成资料', body: '合成正文',
            category: '战术', author, video: id === 'p' ? null : { source: 'bilibili', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
            images: id === 'p' ? [{ id: 'image', href: '/api/v1/learning/posts/p/images/image', alt: '合成正文图片', width: 100, height: 200 }] : [],
            publishedVersion: 1, publishedAt: '2026-11-15T00:00:00Z' });
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
    const scroll = surface().querySelector('.video-discussion-scroll');
    assert.equal(composer().parentElement, scroll.nextElementSibling);
    assert.ok(composer().parentElement.matches('.video-discussion-dock'));
    assert.ok(scroll.querySelector('.learning-article img[alt="合成正文图片"]'));
    assert.equal(scroll.querySelector('.video-stage'), null);
    assert.equal(composer().querySelector('.composer-time-toggle'), null);
    const noteTrigger = button('收藏与私人备注');
    const note = document.getElementById(noteTrigger.getAttribute('aria-controls'));
    assert.equal(note.hidden, true);
    await click('收藏与私人备注');
    assert.equal(note.hidden, false);
    assert.ok(note.querySelector('textarea[name="note"]'));
    await click('收藏与私人备注');
    assert.equal(scroll.querySelectorAll('a[href^="/reflections/new"]').length, 1);
    assert.equal(scroll.querySelector('[aria-label="写复盘"]').getAttribute('href'), '/reflections/new?sourceKind=learning_post&sourceId=p');
    assert.equal(host.style.getPropertyValue('--video-viewport-height'), '500px');
    viewport.height = window.innerHeight;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(host.hasAttribute('data-video-keyboard'), false);
    await write('独立根输入');
    await click('回复 作者');
    assert.equal(document.activeElement, textarea());
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
    const videoScroll = surface().querySelector('.video-discussion-scroll');
    assert.ok(videoScroll.querySelector('.video-stage .training-stage-video-title'));
    const videoHeading = videoScroll.querySelector('.training-watch-title');
    assert.ok(videoScroll.querySelector('.video-stage').compareDocumentPosition(videoHeading) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    const timeToggle = button('讨论时间点选项');
    const timeTools = document.getElementById(timeToggle.getAttribute('aria-controls'));
    assert.equal(timeTools.hidden, true);
    await click('讨论时间点选项');
    assert.equal(timeTools.hidden, false);
    const timeInput = timeTools.querySelector('input');
    await write('其他资料输入');
    for (const invalid of ['-1', '1.5']) {
        await act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(timeInput, invalid);
            timeInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(timeInput.checkValidity(), false);
        await click('讨论时间点选项');
        assert.equal(timeTools.hidden, true);
        assert.equal(timeInput.disabled, true);
        const requestCount = requests.length;
        await click('发送讨论');
        assert.equal(requests.length, requestCount);
        assert.equal(timeTools.hidden, false);
        assert.equal(timeInput.value, invalid);
        assert.match(composer().querySelector('[role="alert"]').textContent, /有效的非负整数秒数/);
    }
    await click('载入 B 站视频：合成资料');
    const frame = videoScroll.querySelector('iframe[data-kapok-player="bilibili"]');
    assert.ok(frame);
    await render('p');
    assert.equal(frame.isConnected, false);
    assert.equal(composer().querySelector('.composer-time-toggle'), null);
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
