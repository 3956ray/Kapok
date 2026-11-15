import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { safeReturnTo } from '../../lib/server/return-to.ts';
import { publicAuthEntry } from '../../lib/server/auth-entry.ts';
import { navigation } from '../helpers/next-stubs.mjs';
import { confirmNavigationActor, controlledBackSource } from '../../lib/client/navigation-state.ts';
import { draftKey, signalAccountChange } from '../../lib/client/session-guard.ts';
import { putLearningImage, queueLearningImage, matchesLearningFile } from '../../lib/client/learning-images.ts';

const h = React.createElement;
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/learn', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
let revoked = [];
let created = [];
URL.createObjectURL = file => {
    const url = 'blob:https://kapok.test/' + crypto.randomUUID();
    created.push({ file, url });
    return url;
};
URL.revokeObjectURL = url => revoked.push(url);
const { createRoot } = await import('react-dom/client');
const { LearningEditing } = await import('../../app/components/learning-editor.tsx');
const { LearningReading, LearningBrowse, LearningMine } = await import('../../app/components/learning-posts.tsx');

const actor = 'cp03-author';
const me = { user: { id: 'u', status: 'active' }, membership: { id: 'm', teamId: 't', role: 'admin', status: 'active', epoch: 1 } };
const base = 'learning/posts';
const path = base + '/p';
const newPath = '/learn/posts/new';
const author = { id: 'u', discName: '合成作者', jerseyNumber: '12' };
const empty = () => ({ id: 'p', kind: 'article', category: '战术', title: '私稿标题', summary: '', body: '私稿正文',
    images: [], video: null, status: 'draft', version: 1, publishedVersion: null, membershipEpoch: 1, collectionTargetId: null, association: null });
const response = (data, status = 200, actorId = actor) => Response.json(status < 400 ? { data } : { error: data, requestId: 'synthetic' },
    { status, headers: actorId ? { 'X-Kapok-Actor': actorId } : {} });
const error = (code, status, retryable = false) => response({ code, message: '合成失败 ' + code, retryable }, status);
const uploadFile = (name, bytes) => new File([Uint8Array.from(bytes)], name, { type: 'image/png' });
const first = uploadFile('第一张.png', [1, 2, 3]);
const second = uploadFile('第二张.png', [4, 5, 6]);

function harness(t, { draft = null, snapshot = null, choices = [], associationFails = false } = {}) {
    const calls = [];
    navigation.length = 0;
    localStorage.clear();
    created = [];
    revoked = [];
    let root;
    let custom;
    let publication = snapshot;
    const reservations = new Map();
    const committed = new Map();
    let nextId = 0;
    let publishCount = 0;
    const copy = value => structuredClone(value);
    function dispatch(call) {
        const { route, method, body, key } = call;
        if (route === 'bootstrap') return response({ actorId: actor, me });
        if (route === 'learning/collections/editable') return response(choices);
        if (route === 'learning/mine') return response(draft ? [draft] : []);
        if (method === 'GET' && route === base) return response(publication ? [publication] : []);
        if (method === 'GET' && route === path + '/activity') return response({ publishedVersion: publication?.publishedVersion, lastEventId: null, event: null });
        if (method === 'GET' && route === path + '/comments') return response([]);
        if (route === path + '?view=draft') return draft ? response(draft) : error('NOT_FOUND', 404);
        if (method === 'GET' && route === path) return publication ? response(publication) : error('NOT_FOUND', 404);
        if (method === 'POST' && route === base) {
            if (!committed.has(key)) {
                draft = { ...empty(), ...body, images: [] };
                committed.set(key, copy(draft));
            }
            return response(draft);
        }
        if (method === 'PATCH' && route === path) {
            if (committed.has(key)) return response(draft);
            if (body.expectedVersion !== draft.version) return error('VERSION_CONFLICT', 409);
            const images = body.kind === 'article' ? body.images.map(ref => ({ ...draft.images.find(image => image.id === ref.id), ...ref })) : [];
            draft = { ...draft, ...body, images, version: draft.version + 1 };
            committed.set(key, copy(draft));
            return response(draft);
        }
        if (route === path + '/images') {
            let row = reservations.get(key);
            if (!row) {
                row = { id: 'image-' + ++nextId, status: 'reserved' };
                reservations.set(key, row);
            }
            return response(row);
        }
        const handle = route.match(/^learning\/posts\/p\/images\/(image-\d+)(?:\/(content|complete))?$/);
        if (handle) {
            const row = [...reservations.values()].find(item => item.id === handle[1]);
            if (handle[2] === 'content') {
                row.status = 'uploaded';
                return response(row);
            }
            if (handle[2] === 'complete') {
                if (row.status === 'reserved') return error('IMAGE_NOT_UPLOADED', 409);
                if (row.status !== 'ready') {
                    row.status = 'ready';
                    draft = { ...draft, version: draft.version + 1, images: [...draft.images, {
                        id: row.id, href: '/api/v1/' + path + '/images/' + row.id + '?view=draft', alt: '', decorative: false,
                        width: 2, height: 2, bytes: 3, mimeType: 'image/png',
                    }] };
                }
                return response(draft.images.find(img => img.id === row.id));
            }
            return response({ id: row.id, status: 'removed' });
        }
        if (route === path + '/publish') {
            if (committed.has(key)) return publication ? response(draft) : error('VERSION_CONFLICT', 409);
            if (body.expectedVersion !== draft.version || body.expectedMembershipEpoch !== draft.membershipEpoch) return error('VERSION_CONFLICT', 409);
            const publishedVersion = draft.version + 1;
            draft = { ...draft, status: 'published', version: publishedVersion, publishedVersion, association: draft.collectionTargetId
                ? { targetId: draft.collectionTargetId, publishedVersion, status: associationFails ? 'pending' : 'added-published' } : null };
            publication = { ...draft, author, isAuthor: true, images: draft.images.map(image => ({ ...image, href: image.href.replace('?view=draft', '') })) };
            publishCount++;
            committed.set(key, copy(draft));
            return response(draft);
        }
        if (route === path + '/inclusion-retry') {
            if (!publication || publication.publishedVersion !== body.expectedPublishedVersion) return error('VERSION_CONFLICT', 409);
            if (!committed.has(key)) {
                draft.association = { ...draft.association, status: associationFails ? 'pending' : 'added-published' };
                committed.set(key, copy(draft.association));
            }
            return response(committed.get(key));
        }
        if (route === path + '/hide' || route === path + '/withdraw') {
            const status = route.endsWith('hide') ? 'hidden' : 'withdrawn';
            publication = null;
            draft = { ...draft, status, version: draft.version + 1, publishedVersion: null, association: null };
            return response(draft);
        }
        throw new Error('Unexpected endpoint ' + method + ' ' + route);
    }
    globalThis.fetch = async (href, options) => {
        const route = href.replace('/api/v1/', '');
        const call = { route, method: options.method, options, key: options.headers['Idempotency-Key'],
            body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
        calls.push(call);
        return custom ? custom(call, () => dispatch(call)) : dispatch(call);
    };
    async function unmount() {
        if (root) await act(async () => root.unmount());
        root = null;
    }
    t.after(unmount);
    return {
        calls, override: fn => { custom = fn; }, unmount,
        draft: () => draft, publication: () => publication, publishCount: () => publishCount,
        allowAssociation: () => { associationFails = false; },
        async render(Component, props, url) {
            window.history.replaceState({}, '', url);
            root ??= createRoot(document.querySelector('#root'));
            await act(async () => root.render(h(Component, { actorId: actor, ...props })));
            await settle();
        },
    };
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 8)); });
function button(name, root = document) {
    return [...root.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === name);
}
async function click(name, root) {
    const node = button(name, root);
    assert.ok(node, name);
    assert.equal(node.disabled, false, name);
    await act(async () => node.click());
    await settle();
}
async function change(node, value) {
    assert.ok(node);
    await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value);
        node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
}
const text = (name, value) => change(document.querySelector(`[name="${name}"]`), value);
async function choose(...files) {
    const node = document.querySelector('#learning-images');
    Object.defineProperty(node, 'files', { configurable: true, value: files });
    await act(async () => node.dispatchEvent(new Event('change', { bubbles: true })));
    await settle();
}
async function publish() {
    await click('预览内容');
    await click('发布到队内');
    const dialog = document.querySelector('dialog[open]');
    assert.ok(dialog);
    await click('确认发布', dialog);
}

test('editor preview returns the same fields and file order; partial retry keeps raw bytes, phase keys and publication snapshot separate', async t => {
    const app = harness(t);
    let fail = true;
    app.override((call, next) => {
        if (call.route.endsWith('/content') && call.body?.name === first.name && fail) {
            fail = false;
            return Promise.reject(new Error('合成上传结果未知'));
        }
        return next();
    });
    await app.render(LearningEditing, {}, newPath);
    await text('title', '合成图文');
    await text('body', '第一段\n第二段');
    await choose(first, second);
    const altFields = () => [...document.querySelectorAll('.learning-image-row input:not([type])')];
    await change(altFields()[0], '第一个示意');
    await change(altFields()[1], '第二个示意');
    await click('上移图片 2');
    await click('预览内容');
    assert.equal(document.querySelector('h2:focus')?.textContent, '发布预览');
    assert.match(document.querySelector('.learning-body').textContent, /第一段\n第二段/);
    assert.deepEqual([...document.querySelectorAll('figure img')].map(node => node.alt), ['第二个示意', '第一个示意']);
    assert.equal(app.calls.some(call => call.method !== 'GET'), false);
    await click('返回编辑');
    assert.equal(document.querySelector('[name=title]').value, '合成图文');
    assert.deepEqual(altFields().map(node => node.value), ['第二个示意', '第一个示意']);
    assert.ok(revoked.length >= 4);
    await click('保存草稿');
    assert.equal(app.draft().images.length, 1);
    assert.equal(app.draft().images[0].alt, '第二个示意');
    assert.match(document.body.textContent, /草稿已保存，部分图片操作尚未完成/);
    await click('重试图片');
    const uploads = app.calls.filter(call => call.method === 'PUT' && call.body?.name === first.name);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].key, uploads[1].key);
    assert.equal(uploads[0].body, first);
    assert.equal(uploads[1].body, first);
    assert.equal(uploads[0].options.cache, 'no-store');
    assert.deepEqual(app.draft().images.map(image => image.alt), ['第二个示意', '第一个示意']);
    assert.equal(app.calls.filter(call => call.route === path + '?view=draft').length, 2);
    assert.equal(app.publication(), null);

    await app.unmount();
    await app.render(LearningEditing, { id: 'p' }, '/learn/posts/p/edit');
    await publish();
    const original = structuredClone(app.publication());
    assert.equal(original.title, '合成图文');
    assert.equal(original.images.every(image => !image.href.includes('view=draft')), true);
    assert.equal(app.publishCount(), 1);
    await app.unmount();
    await app.render(LearningEditing, { id: 'p' }, '/learn/posts/p/edit');
    await text('title', '之后的私稿');
    await click('移除图片 1');
    await click('保存草稿');
    assert.deepEqual(app.publication(), original);
    assert.equal(app.draft().title, '之后的私稿');
    assert.equal(app.draft().images.length, 1);
});

test('unknown create is recovered with the immutable input and key after a cold remount', async t => {
    const app = harness(t);
    let unknown = true;
    app.override((call, next) => {
        if (call.method === 'POST' && call.route === base && unknown) {
            unknown = false;
            next();
            throw new Error('合成创建响应丢失');
        }
        return next();
    });
    await app.render(LearningEditing, {}, newPath);
    await text('title', '保留的标题');
    await text('body', '保留的正文');
    await click('保存草稿');
    assert.match(document.body.textContent, /上次保存结果待确认/);
    await app.unmount();
    await app.render(LearningEditing, {}, newPath);
    assert.equal(document.querySelector('[name=body]').value, '保留的正文');
    await click('确认保存结果');
    const requests = app.calls.filter(call => call.method === 'POST' && call.route === base);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, requests[1].key);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(navigation.at(-1), '/learn/posts/p/edit');
});

test('refresh queries a completed server upload without a File, while unmatched reselection is rejected', async t => {
    const app = harness(t);
    let unknown = true;
    app.override((call, next) => {
        if (call.method === 'PUT' && unknown) {
            unknown = false;
            next();
            throw new Error('合成 PUT 响应丢失');
        }
        return next();
    });
    await app.render(LearningEditing, {}, newPath);
    await text('title', '恢复图片');
    await choose(first);
    await change(document.querySelector('.learning-image-row input:not([type])'), '保留替代文字');
    await click('保存草稿');
    await app.unmount();
    await app.render(LearningEditing, {}, newPath);
    assert.match(document.body.textContent, /重新选择原图片/);
    assert.equal(document.querySelector('img[src^="blob:"]'), null);
    await click('重试图片');
    assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(app.draft().images[0].alt, '保留替代文字');
    assert.equal(await matchesLearningFile(await queueLearningImage(first), uploadFile(first.name, [3, 2, 1])), false);
    assert.equal(await matchesLearningFile(await queueLearningImage(first), uploadFile('另一个文件名.png', [1, 2, 3])), true);
});

test('published post survives pending inclusion, hard reload and unknown retry; a confirmed pending attempt permits a fresh key', async t => {
    const app = harness(t, { choices: [{ id: 'c', title: '合成合集', status: 'published' }], associationFails: true });
    await app.render(LearningEditing, {}, newPath);
    await text('title', '合集资料');
    await text('body', '合成正文');
    await change([...document.querySelectorAll('select')].at(-1), 'c');
    await publish();
    assert.equal(app.publication().title, '合集资料');
    assert.equal(app.draft().association.status, 'pending');
    await app.unmount();
    await app.render(LearningReading, { id: 'p' }, '/learn/posts/p');
    assert.match(document.body.textContent, /内容已发布，加入合集尚未完成/);
    assert.match(document.body.textContent, /合成作者/);
    let unknown = true;
    app.override((call, next) => {
        if (call.route.endsWith('inclusion-retry') && unknown) {
            unknown = false;
            next();
            throw new Error('合成收录响应丢失');
        }
        return next();
    });
    await click('重试加入合集');
    await app.unmount();
    await app.render(LearningReading, { id: 'p' }, '/learn/posts/p');
    await click('重试加入合集');
    app.allowAssociation();
    await click('重试加入合集');
    const attempts = app.calls.filter(call => call.route.endsWith('inclusion-retry'));
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].key, attempts[1].key);
    assert.notEqual(attempts[1].key, attempts[2].key);
    assert.deepEqual(attempts[0].body, { expectedPublishedVersion: app.publication().publishedVersion });
    assert.match(document.body.textContent, /内容已发布，已加入已发布合集/);
    assert.equal(app.publishCount(), 1);
});

test('actor change rejects a late raw write before parsing and prevents an editor queue from confirming it', async t => {
    const app = harness(t);
    let arrive;
    let reads = 0;
    app.override((call, next) => {
        if (call.method === 'PUT') return new Promise(resolve => { arrive = resolve; });
        return next();
    });
    await app.render(LearningEditing, {}, newPath);
    await text('title', '切换账号前的内容');
    await choose(first);
    await click('保存草稿');
    assert.equal(typeof arrive, 'function');
    await act(async () => signalAccountChange(actor));
    await act(async () => arrive({
        status: 200, ok: true, headers: new Headers({ 'X-Kapok-Actor': actor }),
        json: () => { reads++; return { data: { status: 'uploaded' } }; },
    }));
    await settle();
    assert.equal(reads, 0);
    assert.equal(app.calls.some(call => call.route.endsWith('/complete')), false);
    assert.equal(localStorage.getItem(draftKey(actor, 'learning:edit:new')), null);
    assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
    assert.ok(revoked.length > 0);

    globalThis.fetch = async () => ({ status: 200, headers: new Headers({ 'X-Kapok-Actor': 'another' }),
        json: () => { reads++; throw new Error('must not parse'); } });
    await act(async () => assert.rejects(putLearningImage(path + '/images/i/content', first, first.type, 'raw-key', actor),
        failure => failure.code === 'ACCOUNT_CHANGED'));
    assert.equal(reads, 0);
});

test('confirmed hiding replaces the article and late verification only renders the unavailable boundary', async t => {
    const draft = { ...empty(), status: 'published', publishedVersion: 2, version: 2 };
    const app = harness(t, { draft, snapshot: { ...draft, title: '队内标题', body: '队内正文', author, isAuthor: true } });
    await app.render(LearningReading, { id: 'p' }, '/learn/posts/p');
    await click('隐藏内容');
    await click('确认隐藏', document.querySelector('dialog[open]'));
    assert.match(document.body.textContent, /此内容已从队内阅读中移除/);
    assert.equal(document.querySelector('.learning-article'), null);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    assert.equal(document.querySelector('.learning-article'), null);
    assert.match(document.body.textContent, /暂时无法加载/);
});

test('browse search, category and empty filters are operable; mine only links readable snapshots', async t => {
    const draft = { ...empty(), status: 'withdrawn' };
    const post = { ...empty(), title: '队内图文', author, publishedVersion: 2 };
    const app = harness(t, { draft, snapshot: post });
    await app.render(LearningBrowse, {}, '/learn');
    assert.match(document.querySelector('.learning-list').textContent, /队内图文/);
    await click('基本功');
    assert.equal(button('基本功').getAttribute('aria-pressed'), 'true');
    assert.match(document.body.textContent, /没有符合条件的结果/);
    await click('清除筛选');
    await change(document.querySelector('[type=search]'), '不匹配');
    assert.match(document.body.textContent, /没有符合条件的结果/);
    await app.unmount();
    await app.render(LearningMine, {}, '/learn/mine');
    assert.match(document.querySelector('.learning-list').textContent, /已撤回/);
    assert.deepEqual([...document.querySelectorAll('.learning-list a')].map(a => a.textContent), ['编辑并重新发布']);
    const css = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');
    assert.match(css, /\.learning-actions \{ display:flex; align-items:center; flex-wrap:wrap/);
    assert.match(css, /@media \(max-width:440px\) \{[\s\S]*?\.learning-filters \{ grid-template-columns:minmax\(0,1fr\)/);
});


test('controlled back retains only the permitted learning tab and known deep paths', () => {
    confirmNavigationActor(actor, 'learning-nav-test');
    const clickLink = (href) => {
        const link = document.createElement('a');
        link.href = href;
        document.body.append(link);
        link.addEventListener('click', event => event.preventDefault());
        link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
        link.remove();
    };
    window.history.replaceState({}, '', '/learn?tab=collections');
    clickLink('/learn/collections/p/edit');
    window.history.replaceState({}, '', '/learn/collections/p/edit');
    assert.equal(controlledBackSource(), '/learn?tab=collections');
    window.history.replaceState({}, '', '/learn?tab=contents&tab=collections&unknown=1#draft');
    clickLink('/learn/posts/p/edit');
    window.history.replaceState({}, '', '/learn/posts/p/edit');
    assert.equal(controlledBackSource(), '/learn');
    window.history.replaceState({}, '', '/learn');
    clickLink('/learn/posts/p%2fedit');
    window.history.replaceState({}, '', '/learn/posts/p%2fedit');
    assert.equal(controlledBackSource(), null);
});

test('learning return paths permit only known destinations and single library tabs', async () => {
  const id = 'a_B-1'.repeat(16);
  for (const destination of [
    '/learn', '/learn?tab=contents', '/learn?tab=collections', '/learn/mine', '/learn/posts/new',
    '/learn/posts/' + id, '/learn/posts/p/edit', '/learn/collections/new', '/learn/collections/p',
    '/learn/collections/p/edit', '/learn/featured/manage',
  ]) {
    assert.equal(safeReturnTo(destination), destination);
    const url = new URL('/login?returnTo=' + encodeURIComponent(destination), 'https://kapok.test');
    const html = await (await publicAuthEntry(new Request(url), url, 'login')).text();
    assert.ok(html.includes('intent=login&amp;returnTo=' + encodeURIComponent(destination) + '"'), destination);
  }
  for (const destination of [
    '//attacker.test/learn', 'https://attacker.test/learn', '/learn\\posts/p', '/learn/posts/%2fp', '/learn/posts/%5cp',
    '/learn/posts/%00p', '/learn/posts/%0ap', '/learn/posts/a%7fb', '/learn/posts/' + id + 'x',
    '/learn?action=publish', '/learn?tab=contents&tab=collections', '/learn?tab=other', '/learn?tab=',
    '/learn/mine?tab=contents', '/learn/posts/p?view=draft', '/learn/posts/p#body', '/learn/posts/new/edit',
    '/learn/collections/p/extra', '/learn/featured', '/learn/new',
  ]) assert.equal(safeReturnTo(destination), '/', destination);
});


test('a lost publish response replays the original snapshot precondition and creates one publication', async t => {
    const app = harness(t, { draft: empty() });
    let unknown = true;
    app.override((call, next) => {
        if (call.route.endsWith('/publish') && unknown) {
            unknown = false;
            next();
            throw new Error('合成发布响应丢失');
        }
        return next();
    });
    await app.render(LearningEditing, { id: 'p' }, '/learn/posts/p/edit');
    await publish();
    assert.equal(app.publication().body, '私稿正文');
    assert.match(document.body.textContent, /上次发布结果待确认/);
    await app.unmount();
    await app.render(LearningEditing, { id: 'p' }, '/learn/posts/p/edit');
    await click('确认发布结果');
    const requests = app.calls.filter(call => call.route.endsWith('/publish'));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, requests[1].key);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(app.publishCount(), 1);
    assert.equal(navigation.at(-1), '/learn/posts/p');
});

test('a partial new-draft image operation can be resumed from the canonical editor', async t => {
    const app = harness(t);
    let unknown = true;
    app.override((call, next) => {
        if (call.method === 'PUT' && unknown) {
            unknown = false;
            next();
            throw new Error('合成上传回应丢失');
        }
        return next();
    });
    await app.render(LearningEditing, {}, newPath);
    assert.match(document.body.textContent, /当前没有可选合集，仍可正常发布/);
    await text('title', '保留的草稿');
    await choose(first);
    await change(document.querySelector('.learning-image-row input:not([type])'), '通过我的创作恢复');
    await click('保存草稿');
    await app.unmount();
    await app.render(LearningEditing, { id: 'p' }, '/learn/posts/p/edit');
    assert.match(document.body.textContent, /重新选择原图片/);
    await click('重试图片');
    assert.equal(app.draft().images[0].alt, '通过我的创作恢复');
    assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(localStorage.getItem(draftKey(actor, 'learning:edit:new')), null);
});

test('video preview uses the existing YouTube source without loading media and sends its normalized URL to the service', async t => {
    const app = harness(t);
    await app.render(LearningEditing, {}, newPath);
    await change(document.querySelector('select'), 'video');
    await text('title', '合成教学视频');
    await text('video-url', 'https://youtu.be/M7lc1UVf-VE?t=25');
    await click('预览内容');
    assert.ok(button('载入 YouTube 视频：合成教学视频'));
    assert.equal(document.querySelector('iframe, youtube-video'), null);
    await click('发布到队内');
    await click('确认发布', document.querySelector('dialog[open]'));
    assert.deepEqual(app.publication().video, { source: 'youtube', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=25s' });
});

test('native selection applies the configured MIME, size and six-image bounds without attempting a write', async t => {
    const app = harness(t);
    const unsupported = new File([Uint8Array.of(1)], '不支持.gif', { type: 'image/gif' });
    const oversized = new File([new Uint8Array(2 * 1024 * 1024 + 1)], '太大.png', { type: 'image/png' });
    await app.render(LearningEditing, {}, newPath);
    await choose(unsupported, oversized, ...Array(7).fill(first));
    assert.equal(document.querySelectorAll('.learning-image-row').length, 6);
    assert.match(document.body.textContent, /PNG、JPEG 或 WebP/);
    assert.match(document.body.textContent, /最多 2 MiB/);
    assert.match(document.body.textContent, /最多 6 张图片/);
    assert.equal(app.calls.some(call => call.method !== 'GET'), false);
});
