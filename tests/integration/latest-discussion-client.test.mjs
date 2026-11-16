import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { clearNavigationActor } from '../../lib/client/navigation-state.ts';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/videos/v', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CustomEvent', 'Event', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
const { createRoot } = await import('react-dom/client');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { Activity } = await import('../../app/components/community.tsx');

const training = { id: 't', title: '合成训练', date: '2026-11-08', status: 'published' };
const video = {
    id: 'v', trainingId: 't', title: '合成视频', source: 'bilibili', training, durationSec: null,
    url: 'https://www.bilibili.com/video/BV1KapokTest/?p=2', publisherId: 'publisher', publisherName: '合成发布者',
};
const rootComment = {
    id: 'root-message', videoId: 'v', authorId: 'teammate', authorName: '合成队友', authorJerseyNumber: '09',
    text: '根评论正文', rootId: null, replyToId: null, replyTargetName: null, timestampSec: null,
    status: 'active', version: 1, createdAt: '2026-11-08T02:24:00Z',
};
const replyComment = {
    ...rootComment, id: 'reply-message', authorId: 'user-A', authorName: '本人盘名', authorJerseyNumber: '07',
    rootId: rootComment.id, replyToId: rootComment.id, replyTargetName: rootComment.authorName, text: '第一条回复',
};
const h = React.createElement;
let root, calls, comments, override, currentActor;
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
const response = (data, actor, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status, headers: { 'X-Kapok-Actor': actor } });
function setup() {
    for (const actor of ['A', 'B']) clearNavigationActor(actor);
    window.history.replaceState({}, '', '/videos/v');
    calls = [];
    comments = [rootComment, replyComment];
    override = null;
    globalThis.fetch = async (url, options) => {
        const path = String(url).replace('/api/v1/', '');
        const actor = options.headers['X-Kapok-Actor'] ?? currentActor;
        const me = { user: { id: 'user-' + actor, status: 'active' }, membership: { id: 'm-' + actor, teamId: 't', role: 'member', status: 'active', epoch: 1 } };
        calls.push({ path, options });
        const result = override?.(path, options, actor);
        if (result) return result;
        if (path === 'bootstrap') return response({ actorId: actor, me }, actor);
        if (path === 'videos/v/comments') return response(comments, actor);
        if (path === 'videos/other/comments' || path === 'collections') return response([], actor);
        if (path === 'videos/v') return response(video, actor);
        if (path === 'videos/other') return response({ ...video, id: 'other', publisherId: null, publisherName: null }, actor);
        throw new Error('unexpected path ' + path);
    };
}
async function render(actorId = 'A', videoId = 'v', screen = VideoDiscussion) {
    currentActor = actorId;
    root ??= createRoot(document.getElementById('root'));
    await act(async () => root.render(h(screen, { actorId, videoId })));
    await pause();
}
async function unmount() {
    if (root) { await act(async () => root.unmount()); root = null; }
}
const input = () => document.getElementById('comment-input');
const composer = () => input().form;
const message = id => document.getElementById('comment-' + id);
const button = (label, inNode = document) => [...inNode.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);
async function click(node) { assert.ok(node, 'expected button'); await act(async () => node.click()); await pause(); }
async function type(value) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function submit() {
    await act(async () => composer().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await pause();
}
const writes = () => calls.filter(({ options }) => options.method !== 'GET');

test('video workspace keeps media, secondary actions and threads in the scroll region with a separate composer', async () => {
    setup();
    comments = [{ ...rootComment, timestampSec: 84 }, replyComment];
    try {
        await render();
        const scroll = document.querySelector('.video-discussion-scroll');
        assert.deepEqual([...scroll.querySelector('.video-content').children].map(node => node.className),
            ['video-stage', 'video-actions', 'video-detail-header', 'video-discussion-list']);
        assert.equal(scroll.querySelector('iframe'), null);
        assert.equal(scroll.querySelector('.training-stage-identity'), null);
        await click(button('载入 B 站视频', scroll));
        assert.equal(scroll.querySelector('iframe').dataset.kapokPlayer, 'bilibili');
        assert.equal(scroll.querySelector('.video-reflection-link').getAttribute('href'), '/reflections/new?training=t&video=v');
        assert.equal(scroll.querySelector('.video-detail-header a').getAttribute('href'), '/trainings/t');
        const notes = scroll.querySelector('.video-note-disclosure');
        assert.equal(notes.open, false);
        await click(notes.querySelector('summary'));
        assert.equal(notes.open, true);
        assert.ok(notes.querySelector('.private-note textarea'));
        const source = scroll.querySelector('.video-source-disclosure');
        assert.equal(source.open, false);
        await click(source.querySelector('summary'));
        assert.equal(source.open, true);
        assert.equal(source.querySelector('a').href, video.url);
        assert.equal(source.querySelector('input').value, video.url);
        const stamp = button('讨论时间点 01:24', scroll);
        assert.equal(stamp.lastChild.textContent, '01:24');
        assert.equal(message(replyComment.id).closest('.discussion-card'), message(rootComment.id).closest('.discussion-card'));
        assert.equal(scroll.contains(composer()), false);
        assert.equal(scroll.nextElementSibling, composer().parentElement);
        const timeToggle = button('讨论时间点选项', composer());
        const tools = document.getElementById(timeToggle.getAttribute('aria-controls'));
        assert.equal(tools.hidden, true);
        await click(timeToggle);
        assert.equal(timeToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(tools.hidden, false);
        await click(button('手动添加时间点', tools));
        assert.equal(composer().querySelector('.time-editor').hidden, false);
        await click(button('取消时间修改', composer()));
        await click(timeToggle);
        assert.equal(tools.hidden, true);
    } finally { await unmount(); }
});

test('the video shell follows a reduced visual viewport and restores its size without treating pinch zoom as a keyboard', async () => {
    setup();
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const viewport = Object.assign(new window.EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const Screen = props => h('div', { className: 'video-workspace' }, h(VideoDiscussion, props));
    try {
        await render('A', 'v', Screen);
        const workspace = document.querySelector('.video-workspace');
        const update = () => viewport.dispatchEvent(new Event('resize'));
        assert.equal(workspace.hasAttribute('data-video-keyboard'), false);
        Object.assign(viewport, { height: 320, offsetTop: 40 });
        update();
        assert.equal(workspace.hasAttribute('data-video-keyboard'), true);
        assert.equal(workspace.style.getPropertyValue('--video-viewport-height'), '320px');
        assert.equal(workspace.style.getPropertyValue('--video-viewport-top'), '40px');
        viewport.scale = 2;
        update();
        assert.equal(workspace.hasAttribute('data-video-keyboard'), false);
        assert.equal(workspace.style.getPropertyValue('--video-viewport-height'), '100dvh');
        await unmount();
        assert.equal(workspace.style.getPropertyValue('--video-viewport-height'), '');
    } finally {
        await unmount();
        if (original) Object.defineProperty(window, 'visualViewport', original);
        else delete window.visualViewport;
    }
});

test('direct target drafts retain root text and focus on cancel and clear only the successfully submitted reply', async () => {
    setup();
    try {
        await render();
        await type('根讨论草稿');
        const rootReply = button('回复', message(rootComment.id));
        const ownReply = button('回复', message(replyComment.id));
        await click(rootReply);
        assert.equal(input().value, '');
        await type('回复队友草稿');
        await click(ownReply);
        assert.equal(input().value, '');
        assert.equal(document.activeElement, input());
        assert.match(composer().textContent, /正在回复 自己.*第一条回复/s);
        await type('回复自己的草稿');
        await click(button('取消回复', composer()));
        assert.equal(input().value, '根讨论草稿');
        assert.equal(document.activeElement, ownReply);
        await unmount();
        await render();
        await click(button('回复', message(replyComment.id)));
        assert.equal(input().value, '回复自己的草稿');
        override = (path, options, actor) => {
            if (path !== 'videos/v/comments' || options.method !== 'POST') return;
            const sent = { ...replyComment, id: 'sent', ...JSON.parse(options.body), replyTargetName: replyComment.authorName };
            comments = [...comments, sent];
            return response({ id: sent.id }, actor);
        };
        await submit();
        assert.deepEqual(JSON.parse(writes()[0].options.body), { text: '回复自己的草稿', timestampSec: null, rootId: rootComment.id, replyToId: replyComment.id });
        assert.equal(input().value, '根讨论草稿');
        const sent = message('sent');
        assert.equal(sent.closest('.discussion-replies'), message(replyComment.id).closest('.discussion-replies'));
        assert.equal(sent.closest('.discussion-card'), message(rootComment.id).closest('.discussion-card'));
        assert.equal(sent.querySelector('.discussion-recipient').textContent, '回复 自己');
        await click(button('回复', message(rootComment.id)));
        assert.equal(input().value, '回复队友草稿');
        await click(button('回复', message(replyComment.id)));
        assert.equal(input().value, '');
    } finally { await unmount(); }
});

test('editing a reply keeps its relation and edit buffer separate from the root and reply drafts', async () => {
    setup();
    try {
        await render();
        await type('根评论草稿');
        await click(button('回复', message(replyComment.id)));
        await type('回复草稿');
        await click(button('编辑本人讨论', message(replyComment.id)));
        assert.equal(input().value, replyComment.text);
        await unmount();
        await render();
        assert.equal(input().value, replyComment.text);
        await type('编辑中的内容');
        comments = [rootComment, { ...replyComment, version: 2 }];
        await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
        await pause();
        await click(button('取消编辑', composer()));
        assert.equal(input().value, '根评论草稿');
        await click(button('回复', message(replyComment.id)));
        assert.equal(input().value, '回复草稿');
        await click(button('编辑本人讨论', message(replyComment.id)));
        assert.equal(input().value, '编辑中的内容');
        override = (path, options, actor) => path.endsWith('/reply-message') && options.method === 'PATCH' ? response({ id: replyComment.id }, actor) : null;
        await submit();
        assert.deepEqual(JSON.parse(writes()[0].options.body), { text: '编辑中的内容', timestampSec: null, expectedVersion: 1 });
        assert.equal(input().value, '根评论草稿');
        await click(button('回复', message(replyComment.id)));
        assert.equal(input().value, '回复草稿');
    } finally { await unmount(); }
});

test('current authorization hides unavailable reply targets and their quotes while preserving the owner draft', async () => {
    setup();
    const dependent = { ...replyComment, id: 'dependent', replyToId: replyComment.id, replyTargetName: null, text: '可见后续回复' };
    try {
        await render();
        await click(button('回复', message(replyComment.id)));
        await type('仅本人的草稿');
        await unmount();
        comments = [rootComment, { ...replyComment, status: 'hidden', text: null }, dependent];
        await render();
        assert.match(message(dependent.id).textContent, /回复 当前不可用的讨论/);
        assert.doesNotMatch(message(dependent.id).textContent, /合成队友|第一条回复/);
        assert.match(composer().textContent, /正在回复 当前不可用的讨论/);
        assert.doesNotMatch(composer().textContent, /本人盘名|第一条回复/);
        assert.equal(input().value, '仅本人的草稿');
        assert.equal(button('回复', message(replyComment.id)), undefined);
        await submit();
        assert.equal(writes().length, 0);
    } finally { await unmount(); }
});

test('video and account changes fence late replies and segregate unsent drafts', async () => {
    setup();
    let finish;
    try {
        await render();
        await type('视频 v 的根草稿');
        await render('A', 'other');
        assert.equal(input().value, '');
        await type('另一个视频的草稿');
        await render();
        assert.equal(input().value, '视频 v 的根草稿');
        await click(button('回复', message(replyComment.id)));
        await type('账号 A 的回复');
        override = (path, options, actor) => path === 'videos/v/comments' && options.method === 'POST' ?
            new Promise(resolve => { finish = () => resolve(response({ id: 'late' }, actor)); }) : null;
        await submit();
        assert.ok(finish);
        await render('B');
        assert.equal(input().value, '');
        await type('账号 B 的根草稿');
        await act(async () => finish());
        await pause();
        assert.equal(input().value, '账号 B 的根草稿');
        assert.doesNotMatch(document.body.textContent, /回复已发送|讨论已发送|账号 A 的回复/);
        await render('B', 'other');
        assert.equal(input().value, '');
    } finally { await unmount(); }
});

test('a temporary lock fences a late reply response and keeps the same draft and retry key', async () => {
    setup();
    let finish;
    try {
        await render();
        await click(button('回复', message(replyComment.id)));
        await type('等待确认的回复');
        override = (path, options, actor) => path === 'videos/v/comments' && options.method === 'POST' ?
            new Promise(resolve => { finish = () => resolve(response({ id: 'late' }, actor)); }) : null;
        await submit();
        assert.ok(finish);
        await act(async () => window.dispatchEvent(new Event('pagehide')));
        assert.ok(writes()[0].options.signal.aborted);
        await act(async () => window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })));
        await pause();
        await act(async () => finish());
        assert.equal(input().value, '等待确认的回复');
        assert.doesNotMatch(document.body.textContent, /回复已发送/);
        override = (path, options, actor) => path === 'videos/v/comments' && options.method === 'POST' ? response({ id: 'late' }, actor) : null;
        await submit();
        assert.equal(writes()[1].options.headers['Idempotency-Key'], writes()[0].options.headers['Idempotency-Key']);
        assert.equal(input().value, '');
    } finally { await unmount(); }
});

test('video detail and video activity display only server-provided publisher names', async () => {
    setup();
    try {
        await render();
        assert.match(document.querySelector('.video-detail-header').textContent, /发布者.*合成发布者/s);
        await render('A', 'other');
        assert.doesNotMatch(document.querySelector('.video-detail-header').textContent, /发布者/);
        const event = { id: 'event', kind: 'video', href: '/videos/v', title: '已署名', publishedAt: '2026-11-08T02:24:00Z', updatedAt: '2026-11-08T02:24:00Z', publisherId: video.publisherId, publisherName: video.publisherName };
        override = (path, _options, actor) => path.startsWith('activity?') ? response({ items: [event, { ...event, id: 'historic', title: '历史视频', publisherId: null, publisherName: null }], nextCursor: null }, actor) : null;
        await render('A', 'v', Activity);
        const [named, historic] = document.querySelectorAll('.activity-card');
        assert.match(named.textContent, /发布者.*合成发布者/s);
        assert.doesNotMatch(historic.textContent, /发布者/);
    } finally { await unmount(); }
});
