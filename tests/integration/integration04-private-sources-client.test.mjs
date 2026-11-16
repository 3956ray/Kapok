import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { draftKey } from '../../lib/client/session-guard.ts';
import { prepareDraftRequest } from '../../lib/client/reflection-draft.ts';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/learn/posts/p', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage'])
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} postMessage() {} };
const { createRoot } = await import('react-dom/client');
const { LearningBookmark } = await import('../../app/components/collections.tsx');
const { ReflectionEditor } = await import('../../app/components/reflections.tsx');
const { navigation } = await import('../helpers/next-stubs.mjs');

const h = React.createElement;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const button = label => [...document.querySelectorAll('button')].find(node =>
    !node.closest('[hidden]') && (node.getAttribute('aria-label') === label || node.textContent.trim() === label));
async function click(label) {
    const element = button(label);
    assert.ok(element, label);
    assert.equal(element.disabled, false, label);
    await act(async () => element.click());
    await settle();
}
const textarea = () => document.querySelector('textarea');
const write = value => act(async () => {
    const area = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
});

test('learning bookmark shows a saved note card and edit control; conversion replays typed pending after reload without automatic create', async t => {
    const root = createRoot(document.querySelector('#root'));
    const previousFetch = globalThis.fetch;
    t.after(async () => {
        await act(async () => root.unmount());
        globalThis.fetch = previousFetch;
        localStorage.clear();
    });
    const actorId = 'synthetic-private-actor';
    const sourceRef = { kind: 'learning_post', id: 'p' };
    const item = { id: 'bookmark', sourceKind: sourceRef.kind, sourceId: sourceRef.id, timestampSec: null,
        privateNote: '', version: 1, createdAt: '2026-11-15T00:00:00Z', source: { title: '资料标题', href: '/learn/posts/p' } };
    let saved = null;
    let withdrawn = false;
    const writes = [];
    globalThis.fetch = async (input, options) => {
        const path = input.replace('/api/v1/', '');
        const respond = (data, status = 200) => Response.json(status < 400 ? { data } : { error: data }, { status, headers: { 'X-Kapok-Actor': actorId } });
        if (path === 'bootstrap') return respond({ actorId, me: {
            user: { id: 'reader', status: 'active' }, profile: { discName: '读者', jerseyNumber: '01' },
            membership: { id: 'm', teamId: 't', status: 'active', role: 'member', epoch: 1 },
        } });
        if (path === 'collections' && options.method === 'GET') return respond(saved ? [saved] : []);
        if (path === 'collections/bookmark/reflection-seed') return respond({
            text: saved.privateNote, trainingId: null, videoId: null, sourceRef: withdrawn ? null : sourceRef,
        });
        if (path === 'learning/collections/topic/reflection-seed') return respond({
            text: '', trainingId: null, videoId: null, sourceRef: { kind: 'topic_collection', id: 'topic' },
        });
        const body = JSON.parse(options.body);
        writes.push({ path, body, key: options.headers['Idempotency-Key'] });
        if (path.startsWith('collections')) {
            saved = { ...item, privateNote: body.privateNote, version: saved ? saved.version + 1 : 1 };
            return respond({ id: item.id });
        }
        if (path === 'reflections') {
            if (writes.filter(request => request.path === 'reflections').length === 1) return respond({
                code: 'RESULT_UNKNOWN', message: '等待确认。', retryable: true,
            }, 503);
            return respond({ ...body, scope: 'private', id: 'reflection', version: 1, sharingVersion: 1, generation: 1 });
        }
        throw new Error('Unexpected endpoint ' + path);
    };
    await act(async () => root.render(h(LearningBookmark, { actorId, sourceKind: sourceRef.kind, sourceId: sourceRef.id })));
    await settle();
    await write('原私人备注');
    await click('保存收藏');
    assert.equal(textarea(), null);
    assert.match(document.body.textContent, /原私人备注/);
    assert.equal(document.querySelector('a[href="/reflections/new?collection=bookmark"]').getAttribute('aria-label'), '转为复盘');
    await click('编辑私人备注');
    await write('编辑后的私人备注');
    await click('保存备注');
    assert.equal(textarea(), null);
    assert.match(document.body.textContent, /编辑后的私人备注/);
    await act(async () => root.render(null));

    window.history.replaceState({}, '', '/reflections/new?collection=bookmark');
    const renderConversion = async () => {
        await act(async () => root.render(h(ReflectionEditor, { actorId, collectionId: 'bookmark' })));
        await settle();
    };
    await renderConversion();
    assert.equal(textarea().value, '编辑后的私人备注');
    assert.equal(document.querySelector('.reflection-title-field input').value, '');
    assert.equal(writes.filter(request => request.path === 'reflections').length, 0);
    await click('保存记录');
    const original = writes.at(-1);
    assert.deepEqual(original.body.sourceRef, sourceRef);
    assert.ok(original.key);
    const persisted = JSON.parse(localStorage.getItem(draftKey(actorId, 'collection:bookmark')));
    assert.deepEqual(persisted.pending.body, original.body);

    await act(async () => root.render(null));
    withdrawn = true;
    await renderConversion();
    assert.equal(textarea().value, '编辑后的私人备注');
    assert.equal(writes.filter(request => request.path === 'reflections').length, 1);
    await click('确认上次云保存结果');
    assert.deepEqual(writes.at(-1), original);
    assert.deepEqual(navigation, ['/reflections/reflection?saved=1']);
    assert.equal(localStorage.getItem(draftKey(actorId, 'collection:bookmark')), null);
    assert.equal(saved.privateNote, '编辑后的私人备注');

    await act(async () => root.render(null));
    window.history.replaceState({}, '', '/reflections/new?sourceKind=topic_collection&sourceId=topic');
    await act(async () => root.render(h(ReflectionEditor, { actorId, sourceKind: 'topic_collection', sourceId: 'topic' })));
    await settle();
    assert.equal(textarea().value, '');
    assert.deepEqual(JSON.parse(localStorage.getItem(draftKey(actorId, 'topic_collection:topic'))).sourceRef,
        { kind: 'topic_collection', id: 'topic' });
    assert.equal(writes.filter(request => request.path === 'reflections').length, 2);
});

test('schema 1 drafts without sourceRef keep their original serialized payload on replay', () => {
    const old = { schema: 1, title: '', text: '原稿', date: '2026-11-15', trainingId: '', videoId: '',
        updatedAt: '2026-11-15', cloud: null, pending: null };
    const first = prepareDraftRequest(old, 'original');
    assert.equal(Object.hasOwn(first.pending.body, 'sourceRef'), false);
    assert.deepEqual(prepareDraftRequest(JSON.parse(JSON.stringify(first)), 'new-key').pending, first.pending);
});
