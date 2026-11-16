import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { navigation } from '../helpers/next-stubs.mjs';
import { controlledBackSource } from '../../lib/client/navigation-state.ts';
import { signalAccountChange } from '../../lib/client/session-guard.ts';
import { publicAuthEntry } from '../../lib/server/auth-entry.ts';

const h = React.createElement;
const actor = 'topic-synthetic-owner';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.test/learn', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
};
const { createRoot } = await import('react-dom/client');
const { LearningBrowse, LearningMine, LearningReading } = await import('../../app/components/learning-posts.tsx');
const { TopicEditing, TopicReading } = await import('../../app/components/topic-collections.tsx');
const { ManageFeaturedTopics, HomeFeaturedTopics } = await import('../../app/components/topic-featured.tsx');

const base = 'learning/collections';
const featured = 'learning/featured';
const read = '/learn/collections/c1';
const edit = read + '/edit';
const createPath = '/learn/collections/new';
const author = { id: 'u', discName: '合成整理人', jerseyNumber: '12' };
const source = (id, title, kind = 'post') => ({
    id, title, kind, summary: '', cover: null, author, category: kind === 'post' ? '战术' : null,
    mediaKind: kind === 'post' ? 'article' : 'video', trainingId: kind === 'video' ? 't1' : null,
});
const article = source('typed', '图文甲');
const video = source('typed', '训练乙', 'video');
const rejected = source('removed', '临时来源');
const initial = () => ({ id: 'c1', title: '合集一', summary: '', version: 1, membershipEpoch: 1,
    publishedVersion: null, status: 'draft', items: [] });
const snapshot = (draft, version = 2) => ({ id: draft.id, title: draft.title, summary: draft.summary,
    items: draft.items, author, isAuthor: true, publishedVersion: version, publishedAt: '2026-01-01' });
const ref = ({ id, kind }) => ({ kind, id });
const keyOf = item => item.kind + ':' + item.id;

function fixture(t, { draft = initial(), published = null, sources = [article, video, rejected], role = 'member', options = null, learningPost = null } = {}) {
    localStorage.clear();
    navigation.length = 0;
    let root;
    let override;
    let featuredVersion = 0;
    let featuredIds = [];
    let createCount = 0;
    let currentActor = actor;
    const me = { user: { id: 'u', status: 'active' }, membership: { id: 'm', teamId: 't', role, status: 'active', epoch: 1 } };
    const calls = [];
    const receipts = new Map();
    const response = (data, status = 200) => Response.json(status === 200 ? { data } : { error: data, requestId: 'synth' },
        { status, headers: { 'X-Kapok-Actor': currentActor } });
    const error = (code, status = 409) => response({ code, message: '合成 ' + code, retryable: false }, status);
    const list = () => options ?? (published ? [published] : []);
    function dispatch({ route, method, body, key }) {
        if (route === 'bootstrap') return response({ actorId: currentActor, me });
        if (route === 'learning/mine') return response([]);
        if (learningPost && route === 'learning/posts/' + learningPost.id) return response(learningPost);
        if (learningPost && route === 'learning/posts/' + learningPost.id + '/comments') return response([]);
        if (route === base + '/editable') return response(draft ? [draft] : []);
        if (route === base + '/sources') return response(sources);
        if (method === 'GET' && route === base) return response(list());
        if (method === 'GET' && route === base + '/c1') return published ? response(published) : error('NOT_FOUND', 404);
        if (method === 'GET' && route === base + '/c1?view=draft') return draft ? response(draft) : error('NOT_FOUND', 404);
        const featuredData = () => ({ collections: featuredIds.flatMap(id => list().filter(entry => entry.id === id)),
            version: featuredVersion, maxFeatured: 2 });
        if (route === featured && method === 'GET') return response({ collections: featuredData().collections });
        if (route === featured + '?view=admin') return me.membership.role === 'admin' ? response(featuredData()) : error('FORBIDDEN', 403);
        if (route === featured && method === 'PATCH') {
            if (me.membership.role !== 'admin') return error('FORBIDDEN', 403);
            if (!receipts.has(key)) {
                if (body.expectedVersion !== featuredVersion) return error('VERSION_CONFLICT');
                featuredVersion++;
                featuredIds = body.collectionIds;
                receipts.set(key, true);
            }
            return response(featuredData());
        }
        if (route === base && method === 'POST') {
            if (!receipts.has(key)) {
                draft = { ...initial(), ...body };
                createCount++;
                receipts.set(key, true);
            }
            return response(draft);
        }
        if (!draft) return error('NOT_FOUND', 404);
        if (receipts.has(key)) return response(route === base + '/c1/items' && method === 'POST'
            ? { collection: draft, outcomes: receipts.get(key) } : draft);
        if (body.expectedVersion !== draft.version) return error('VERSION_CONFLICT');
        const version = draft.version + 1;
        if (route === base + '/c1' && method === 'PATCH') {
            draft = { ...draft, title: body.title, summary: body.summary, version };
        } else if (route === base + '/c1/items' && method === 'POST') {
            const items = [...draft.items];
            const outcomes = body.items.map(item => {
                const match = sources.find(source => keyOf(source) === keyOf(item));
                if (items.some(source => keyOf(source) === keyOf(item))) return { ...item, status: 'duplicate' };
                if (!match || match.id === rejected.id) return { ...item, status: 'unavailable' };
                items.push(match);
                return { ...item, status: 'added' };
            });
            if (items.length !== draft.items.length) draft = { ...draft, items, version };
            receipts.set(key, outcomes);
            return response({ collection: draft, outcomes });
        } else if (route.endsWith('/items/order') && method === 'PATCH') {
            draft = { ...draft, items: body.items.map(item => draft.items.find(old => keyOf(old) === keyOf(item))), version };
        } else if (route.endsWith('/items') && method === 'DELETE') {
            draft = { ...draft, items: draft.items.filter(item => keyOf(item) !== keyOf(body.item)), version };
        } else if (route.endsWith('/publish') && method === 'POST') {
            if (body.expectedMembershipEpoch !== draft.membershipEpoch) return error('VERSION_CONFLICT');
            draft = { ...draft, status: 'published', publishedVersion: version, version };
            published = snapshot(draft, version);
        } else if (route.endsWith('/withdraw') && method === 'POST') {
            if (body.expectedMembershipEpoch !== draft.membershipEpoch) return error('VERSION_CONFLICT');
            draft = { ...draft, status: 'withdrawn', publishedVersion: null, version };
            published = null;
        } else throw new Error('Unexpected ' + method + ' ' + route);
        receipts.set(key, true);
        return response(draft);
    }
    globalThis.fetch = async (href, request) => {
        const call = { route: href.replace('/api/v1/', ''), method: request.method, key: request.headers['Idempotency-Key'],
            actor: request.headers['X-Kapok-Actor'], body: request.body ? JSON.parse(request.body) : undefined };
        calls.push(call);
        return override ? override(call, () => dispatch(call)) : dispatch(call);
    };
    async function unmount() {
        if (root) await act(async () => root.unmount());
        root = null;
    }
    t.after(unmount);
    return {
        calls, writes: () => calls.filter(call => call.method !== 'GET'), draft: () => draft, published: () => published,
        createCount: () => createCount, featuredIds: () => featuredIds, unmount, override: fn => { override = fn; },
        setPublished: next => { published = next; }, setOptions: next => { options = next; }, setDraft: next => { draft = next; },
        setActor: next => { currentActor = next; }, setEpoch: epoch => { me.membership.epoch = epoch; },
        setRole: next => { me.membership.role = next; },
        async render(Component, props, path, actorId = currentActor) {
            window.history.replaceState({}, '', path);
            root ??= createRoot(document.querySelector('#root'));
            await act(async () => root.render(h(Component, { actorId, ...props })));
            await settle();
        },
    };
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 8)); });
const visible = () => document.querySelector('#root').textContent;
const focused = () => document.activeElement;
const openDialog = () => document.querySelector('dialog[open]');
const button = (label, where = document) => [...where.querySelectorAll('button')]
    .find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);
async function click(label, where = document) {
    const node = button(label, where);
    assert.ok(node, label);
    await clickNode(node);
}
async function clickNode(node) {
    assert.ok(node && !node.disabled);
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
const checkboxes = () => [...openDialog().querySelectorAll('input[type=checkbox]')];
const named = name => document.querySelector('[name=' + name + ']');

test('new collection keeps the original write identity after a server commit and lost response', async t => {
    const app = fixture(t, { draft: null });
    app.override((call, next) => {
        if (call.method === 'POST' && call.route === base && app.createCount() === 0) {
            next();
            throw new Error('合成响应丢失');
        }
        return next();
    });
    await app.render(TopicEditing, {}, createPath);
    await change(named('title'), '恢复的草稿');
    await change(named('summary'), '恢复的简介');
    await click('保存草稿');
    assert.match(visible(), /上次操作结果待确认/);
    assert.equal(app.createCount(), 1);
    assert.deepEqual(navigation, []);
    await app.unmount();
    await app.render(TopicEditing, {}, createPath);
    assert.equal(named('title').value, '恢复的草稿');
    await click('重试原请求');
    assert.equal(app.createCount(), 1);
    const [first, second] = app.writes();
    assert.ok(first.key);
    assert.equal(first.key, second.key);
    assert.deepEqual(first.body, second.body);
    assert.deepEqual(navigation, [edit]);
    await app.unmount();
    await app.render(TopicEditing, { id: 'c1' }, edit);
    assert.equal(named('summary').value, '恢复的简介');
});

test('picker stages ten typed sources across filters, cancels in isolation, and reports server partial outcomes', async t => {
    const extras = Array.from({ length: 9 }, (_, i) => source('extra-' + i, '图文扩展 ' + i));
    const app = fixture(t, { sources: [article, video, rejected, ...extras] });
    await app.render(TopicEditing, { id: 'c1' }, edit);
    await click('添加资料');
    assert.equal(focused(), openDialog().querySelector('input[type=search]'));
    await clickNode(checkboxes()[0]);
    await click('取消', openDialog());
    assert.equal(focused(), button('添加资料'));
    assert.equal(app.writes().length, 0);
    await click('添加资料');
    assert.equal(checkboxes()[0].checked, false);
    await clickNode(checkboxes()[0]);
    await change(openDialog().querySelector('select'), 'video');
    await clickNode(checkboxes()[0]);
    await change(openDialog().querySelector('select'), 'article');
    assert.equal(checkboxes()[0].checked, true);
    for (const node of checkboxes().slice(1, 9)) await clickNode(node);
    assert.equal(checkboxes()[9].disabled, true);
    assert.match(openDialog().textContent, /已选 10 \/ 10/);
    await click('添加所选资料', openDialog());
    const [call] = app.writes();
    assert.deepEqual(call.body.items.slice(0, 3), [ref(article), ref(video), ref(rejected)]);
    assert.equal(call.body.items.length, 10);
    assert.equal(call.actor, actor);
    assert.equal(app.draft().items.length, 9);
    assert.match(visible(), /已加入合集草稿 9 项；来源已不可用 1 项/);
    await click('添加资料');
    assert.equal(checkboxes()[0].disabled, true);
    assert.match(checkboxes()[0].closest('label').textContent, /已在合集中/);
});

test('order and remove acknowledgments preserve pending metadata and publication waits for explicit save', async t => {
    const draft = { ...initial(), items: [article, video], status: 'published', version: 2, publishedVersion: 2 };
    const app = fixture(t, { draft, published: snapshot(draft) });
    await app.render(TopicEditing, { id: 'c1' }, edit);
    await change(named('title'), '更新合集标题');
    await change(named('summary'), '更新合集简介');
    await click('上移 训练乙');
    assert.equal(focused().getAttribute('aria-label'), '条目顺序');
    assert.deepEqual(app.draft().items.map(ref), [ref(video), ref(article)]);
    await click('移除 图文甲');
    assert.equal(app.draft().items.length, 1);
    assert.equal(named('title').value, '更新合集标题');
    assert.equal(named('summary').value, '更新合集简介');
    assert.equal(button('发布更新').disabled, true);
    assert.equal(app.published().title, '合集一');
    await app.unmount();
    await app.render(TopicEditing, { id: 'c1' }, edit);
    assert.equal(named('title').value, '更新合集标题');
    await click('保存草稿');
    assert.equal(app.published().title, '合集一');
    await click('发布更新');
    await click('确认发布', openDialog());
    assert.equal(app.published().title, '更新合集标题');
    assert.deepEqual(app.published().items.map(ref), [ref(video)]);
    assert.deepEqual(app.writes().map(call => call.body.expectedVersion), [2, 3, 4, 5]);
    await app.unmount();
    await app.render(TopicReading, { id: 'c1' }, read);
    await click('撤回合集');
    await click('确认撤回', openDialog());
    assert.equal(app.published(), null);
    assert.match(visible(), /合集已撤回/);
    assert.doesNotMatch(visible(), /更新合集标题|训练乙/);
});

test('published sources and search retain their navigation context; clipboard fallback and auth return use the canonical URL', async t => {
    const draft = { ...initial(), items: [{ ...article, cover: { href: '/api/v1/approved-cover', height: 2, width: 2 } }, video] };
    const app = fixture(t, { draft, published: { ...snapshot(draft), isAuthor: false } });
    await app.render(LearningBrowse, { tab: 'collections' }, '/learn?tab=collections');
    await change(document.querySelector('input[type=search]'), '合集一');
    const link = document.querySelector('a[href="' + read + '"]');
    // Trigger the native capture path without allowing JSDOM to navigate.
    link.addEventListener('click', event => event.preventDefault(), { once: true });
    await act(async () => link.click());
    await app.unmount();
    await app.render(TopicReading, { id: 'c1' }, read);
    assert.equal(controlledBackSource(), '/learn?tab=collections');
    assert.equal(document.querySelector('img').getAttribute('src'), '/api/v1/approved-cover');
    for (const path of ['/learn/posts/typed', '/videos/typed']) assert.ok(document.querySelector('a[href="' + path + '"]'));
    await click('分享合集');
    const field = openDialog().querySelector('input');
    assert.equal(field.value, 'https://kapok.test' + read);
    assert.equal(focused(), field);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    await click('复制链接', openDialog());
    assert.equal(field.selectionEnd, field.value.length);
    assert.match(openDialog().textContent, /系统复制命令/);
    await click('关闭', openDialog());
    assert.equal(focused(), button('分享合集'));
    const login = new URL('/login?returnTo=' + encodeURIComponent(read), window.location.origin);
    const response = await publicAuthEntry(new Request(login), login, 'login');
    assert.match(await response.text(), new RegExp('intent=login&amp;returnTo=' + encodeURIComponent(read)));
    app.setPublished({ ...app.published(), items: [] });
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
    await settle();
    assert.match(visible(), /暂没有可阅读的条目/);
    assert.doesNotMatch(visible(), /图文甲|训练乙/);
    assert.equal(document.querySelector('img'), null);
    app.setPublished(null);
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
    await settle();
    assert.match(visible(), /此合集暂不可读/);
    assert.doesNotMatch(visible(), /合集一/);
    await app.unmount();
    await app.render(LearningBrowse, { tab: 'collections' }, '/learn?tab=collections');
    assert.equal(document.querySelector('input[type=search]').value, '合集一');
});

test('my collection group and post detail add read the owner choices and post only a typed draft reference', async t => {
    const learningPost = { ...article, kind: 'article', body: '合成正文', images: [], video: null,
        isAuthor: false, publishedVersion: 2, publishedAt: '2026-01-01' };
    const app = fixture(t, { learningPost });
    await app.render(LearningMine, {}, '/learn/mine');
    await click('我整理的');
    assert.match(visible(), /合集一/);
    assert.ok(document.querySelector('a[href="' + edit + '"]'));
    await app.unmount();
    await app.render(LearningReading, { id: article.id }, '/learn/posts/typed');
    await click('加入合集');
    await change(openDialog().querySelector('select'), 'c1');
    await click('加入合集草稿', openDialog());
    assert.deepEqual(app.writes()[0].body, { expectedVersion: 1, items: [ref(article)] });
    assert.match(visible(), /已加入合集草稿 1 项/);
    assert.ok(document.querySelector('.topic-add-toast[role="status"]'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
    assert.equal(document.querySelector('.topic-add-toast'), null);
    assert.equal(app.published(), null);
    app.setDraft(null);
    await click('加入合集');
    assert.match(openDialog().textContent, /当前没有可编辑/);
    assert.ok(openDialog().querySelector('a[href="' + createPath + '"]'));
});

test('featured management denies members, saves ordered choices as admin, and home hides unreadable entries', async t => {
    const one = snapshot({ ...initial(), items: [article] });
    const two = snapshot({ ...initial(), id: 'c2', title: '合集二', items: [video] });
    const empty = snapshot({ ...initial(), id: 'empty', title: '空合集' });
    const app = fixture(t, { options: [one, two, empty] });
    await app.render(ManageFeaturedTopics, {}, '/learn/featured/manage');
    assert.match(visible(), /仅管理员/);
    assert.equal(app.calls.some(call => call.route.includes('?view=admin')), false);
    await app.unmount();
    app.setRole('admin');
    await app.render(ManageFeaturedTopics, {}, '/learn/featured/manage');
    assert.match(visible(), /首页将隐藏精选区/);
    assert.doesNotMatch(visible(), /空合集/);
    const choices = [...document.querySelectorAll('input[type=checkbox]')];
    await clickNode(choices[1]);
    await clickNode(choices[0]);
    await click('上移 合集一');
    await click('保存首页精选');
    assert.deepEqual(app.featuredIds(), ['c1', 'c2']);
    await click('移除 合集一');
    await click('保存首页精选');
    assert.deepEqual(app.featuredIds(), ['c2']);
    await app.unmount();
    app.setRole('member');
    await app.render(HomeFeaturedTopics, {}, '/');
    assert.match(visible(), /合集二/);
    app.setOptions([{ ...two, items: [] }]);
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
    await settle();
    assert.doesNotMatch(visible(), /首页精选|合集二/);
});

test('collection metadata recovery is scoped by actor and epoch, and invalidation ignores a late write', async t => {
    const app = fixture(t);
    await app.render(TopicEditing, { id: 'c1' }, edit);
    await change(named('title'), '只给同一成员周期');
    await app.unmount();
    await app.render(TopicEditing, { id: 'c1' }, edit);
    assert.equal(named('title').value, '只给同一成员周期');
    await app.unmount();
    app.setEpoch(2);
    await app.render(TopicEditing, { id: 'c1' }, edit);
    assert.equal(named('title').value, '合集一');
    await change(named('title'), '旧身份延迟操作');
    let resolveWrite;
    app.override((call, next) => call.method === 'PATCH' ? new Promise(resolve => { resolveWrite = () => resolve(next()); }) : next());
    await click('保存草稿');
    assert.ok(resolveWrite);
    await act(async () => {
        signalAccountChange(actor);
        app.setActor('topic-other');
        resolveWrite();
    });
    await settle();
    assert.doesNotMatch(visible(), /旧身份延迟操作|草稿已保存/);
});

test('a draft conflict preserves input and requires a fresh version before a second write', async t => {
    const app = fixture(t);
    await app.render(TopicEditing, { id: 'c1' }, edit);
    await change(named('title'), '待提交标题');
    app.setDraft({ ...app.draft(), title: '另一个窗口的标题', version: 2 });
    await click('保存草稿');
    assert.match(visible(), /VERSION_CONFLICT/);
    assert.equal(button('保存草稿').disabled, true);
    await click('重新载入最新状态');
    assert.equal(named('title').value, '待提交标题');
    assert.equal(button('保存草稿').disabled, true);
    await click('保留输入并采用最新版本');
    await click('保存草稿');
    assert.equal(app.draft().title, '待提交标题');
    const [first, second] = app.writes();
    assert.notEqual(first.key, second.key);
    assert.deepEqual([first.body.expectedVersion, second.body.expectedVersion], [1, 2]);
});

test('drag and keyboard-operable buttons submit the same versioned ordering shape', async t => {
    const app = fixture(t, { draft: { ...initial(), items: [article, video] } });
    await app.render(TopicEditing, { id: 'c1' }, edit);
    const rows = [...document.querySelectorAll('.topic-order li')];
    await act(async () => {
        const start = new Event('dragstart', { bubbles: true });
        Object.defineProperty(start, 'dataTransfer', { value: { setData() {} } });
        rows[0].dispatchEvent(start);
        rows[1].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await settle();
    await click('上移 图文甲');
    assert.deepEqual(app.writes().map(call => call.body), [
        { expectedVersion: 1, items: [ref(video), ref(article)] },
        { expectedVersion: 2, items: [ref(article), ref(video)] },
    ]);
});

test('reading the same collection after republication replaces the local withdrawal status', async t => {
    const draft = { ...initial(), status: 'published', version: 2, publishedVersion: 2, items: [article] };
    const app = fixture(t, { draft, published: snapshot(draft) });
    await app.render(TopicReading, { id: 'c1' }, read);
    await click('撤回合集');
    await click('确认撤回', openDialog());
    assert.match(visible(), /合集已撤回/);
    assert.doesNotMatch(visible(), /合集一|图文甲/);

    const republished = { ...app.draft(), title: '重新发布的合集', status: 'published', version: 4, publishedVersion: 4, items: [video] };
    app.setDraft(republished);
    app.setPublished(snapshot(republished, 4));
    await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
    await settle();

    assert.equal(window.location.pathname, read);
    assert.match(visible(), /重新发布的合集/);
    assert.doesNotMatch(visible(), /合集已撤回|图文甲/);
    assert.ok(document.querySelector('a[href="/videos/typed"]'));
    assert.ok(button('分享合集'));
});
