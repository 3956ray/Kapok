import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { registerHooks } from 'node:module';
import { navigation } from '../helpers/next-stubs.mjs';
import { clearNavigationActor } from '../../lib/client/navigation-state.ts';

const h = React.createElement;
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://kapok.local/videos/v', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'CustomEvent', 'Event', 'FormData', 'localStorage']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.BroadcastChannel = class { close() {} };
const { createRoot } = await import('react-dom/client');
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { TrainingManagement } = await import('../../app/components/training-management.tsx');
const { TrainingScreen } = await import('../../app/components/legacy-screens.tsx');
const actorId = 'A';
const training = { id: 't', title: '合成训练', date: '2026-11-14', description: '', status: 'published', version: 1 };
const video = { id: 'v', trainingId: training.id, title: '合成视频', source: 'youtube', position: 0, status: 'active', version: 1, durationSec: null, url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=0s' };
const me = { user: { id: 'u', status: 'active' }, membership: { id: 'm', teamId: 't', role: 'admin', status: 'active', epoch: 1 } };
const comment = { id: 'c', authorId: 'u', authorName: '合成队员', status: 'active', rootId: null, timestampSec: 0, text: '合成讨论', version: 1, createdAt: '2026-11-14T01:02:03Z' };
let root, calls, override, status, currentVideo;
const imports = [];
const mounts = [];
let loadModule;
globalThis.kapokTestImport = async () => { await loadModule(); };
globalThis.kapokTestMount = (slot, source, handlers) => {
    const element = document.createElement('youtube-video');
    Object.assign(element, { readyState: 1, duration: 120, currentTime: 0, seeking: false });
    const shadow = element.attachShadow({ mode: 'open' });
    const frame = document.createElement('iframe');
    frame.src = source;
    shadow.append(frame);
    slot.append(element);
    const entry = { slot, source, handlers, element, frame, destroys: 0 };
    mounts.push(entry);
    return { element, destroy() { entry.destroys++; element.remove(); } };
};
registerHooks({
    resolve(specifier, context, next) {
        if (!specifier.startsWith('/vendor/kapok-player/player-island.js')) return next(specifier, context);
        imports.push(specifier);
        return { url: 'data:text/javascript,' + encodeURIComponent('await globalThis.kapokTestImport(); export const mount = globalThis.kapokTestMount;') + '#' + imports.length, shortCircuit: true };
    },
});
const response = (data, code = 200) => new Response(JSON.stringify(code < 400 ? { data } : data), { status: code, headers: { 'X-Kapok-Actor': actorId } });
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
function setup(path = '/videos/v') {
    clearNavigationActor(actorId);
    window.history.replaceState({}, '', path);
    navigation.length = 0;
    imports.length = 0;
    mounts.length = 0;
    calls = [];
    override = null;
    loadModule = async () => {};
    status = 'published';
    currentVideo = video;
    globalThis.fetch = async (url, options) => {
        const path = String(url).replace('/api/v1/', '');
        calls.push({ path, options });
        const result = override?.(path, options);
        if (result) return result;
        if (path === 'bootstrap') return response({ actorId, me });
        if (path === 'collections') return response([]);
        if (/^videos\/(v|other)\/comments$/.test(path)) return response([comment]);
        if (/^videos\/(v|other)$/.test(path)) return response({ ...currentVideo, id: path.split('/')[1], training: { ...training, status } });
        if (path === 'trainings/t?view=member') return response({ ...training, status, videos: [] });
        throw new Error('unexpected path ' + path);
    };
}
async function render(component, props) {
    root ??= createRoot(document.getElementById('root'));
    await act(async () => root.render(h(component, { actorId, ...props })));
    await pause();
}
async function unmount() {
    if (root) await act(async () => root.unmount());
    root = null;
}
function button(label, scope = document) {
    return [...scope.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);
}
async function click(label, scope) {
    const node = button(label, scope);
    assert.ok(node, label);
    await act(async () => node.click());
    await pause();
}
async function input(name, value) {
    const node = name === "comment" ? composer() : document.querySelector(`[name="${name}"]`);
    await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const composer = () => document.getElementById('comment-input');
const posts = () => calls.filter(call => call.options.method === 'POST');

test('YouTube loads only on explicit action, retries a failed module, and reads or seeks second zero', async () => {
    setup();
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        assert.equal(imports.length, 0);
        assert.equal(document.querySelector('iframe, youtube-video, img[src*="ytimg"]'), null);
        await input('comment', '讨论草稿');
        await click('讨论时间点 00:00');
        assert.equal(imports.length, 0);
        loadModule = async () => { throw new Error('module unavailable'); };
        await click('载入 YouTube 视频');
        assert.match(document.querySelector('.video-stage [role=alert]').textContent, /加载失败/);
        assert.equal(composer().value, '讨论草稿');
        let finishImport;
        loadModule = () => new Promise(resolve => { finishImport = resolve; });
        await click('重试 YouTube 视频');
        assert.notEqual(imports[0], imports[1]);
        await render(VideoDiscussion, { videoId: 'other' });
        await act(async () => finishImport());
        assert.equal(mounts.length, 0);
        await render(VideoDiscussion, { videoId: 'v' });
        assert.equal(composer().value, '讨论草稿');
        await click('载入 YouTube 视频');
        assert.equal(mounts.length, 1);
        const { element, handlers, source } = mounts[0];
        assert.equal(source, 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?t=0s');
        await act(async () => handlers.ready(element));
        await click('讨论时间点选项');
        await click('添加当前视频时间');
        assert.ok(button('已添加时间点 00:00（已固定）'));
        element.currentTime = 12;
        await click('讨论时间点 00:00');
        assert.equal(element.currentTime, 0);
        await act(async () => handlers.time(element));
        element.currentTime = 7.9;
        await click('更新为当前视频时间');
        assert.ok(button('已添加时间点 00:07（已固定）'));
        element.currentTime = 0;
        await click('更新为当前视频时间');
        assert.ok(button('已添加时间点 00:00（已固定）'));
        await click('去掉时间点');
        assert.equal(button('已添加时间点 00:00（已固定）'), undefined);
        assert.equal(composer().value, '讨论草稿');
    } finally { await unmount(); }
});

test('create draft uses explicit draft status and preserves the key and optional video on an unknown result', async () => {
    setup('/admin/trainings/new');
    try {
        await render(TrainingManagement, { mode: 'new' });
        await input('title', '草稿训练');
        await input('date', '2026-11-14');
        await input('videoTitle', '测试视频');
        await input('videoLink', 'https://youtu.be/M7lc1UVf-VE?t=0');
        override = path => path === 'trainings/publish' ? response({ error: { code: 'RESULT_UNKNOWN', message: '结果尚未确认，请重试', retryable: true } }, 503) : null;
        await click('保存草稿');
        assert.deepEqual(navigation, []);
        assert.equal(document.querySelector('[name=videoTitle]').value, '测试视频');
        const first = posts()[0].options;
        assert.deepEqual(JSON.parse(first.body), { title: '草稿训练', date: '2026-11-14', description: '', status: 'draft', video: { title: '测试视频', url: 'https://youtu.be/M7lc1UVf-VE?t=0' } });
        override = path => path === 'trainings/publish' ? response({ training: { ...training, status: 'draft' }, video }) : null;
        await click('保存草稿');
        const retry = posts()[1].options;
        assert.equal(retry.body, first.body);
        assert.equal(retry.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
        assert.deepEqual(navigation, ['/admin/trainings/t']);
    } finally { await unmount(); }
});

test('archived training without media has a linked private reflection and retains discussion governance', async () => {
    setup('/trainings/t');
    status = 'archived';
    try {
        await render(TrainingScreen, { id: 't' });
        assert.ok(document.querySelector('a[href="/reflections/new?training=t"]'));
        assert.match(document.body.textContent, /本次训练暂无视频/);
        await render(VideoDiscussion, { videoId: 'v' });
        assert.equal(composer().form.hidden, true);
        assert.equal(button('回复'), undefined);
        assert.equal(button('编辑本人讨论'), undefined);
        assert.equal(button('删除'), undefined);
        assert.ok(button('举报'));
        assert.ok(button('管理员隐藏'));
        assert.ok(document.querySelector('a[href="/reflections/new?training=t&video=v"]'));
    } finally { await unmount(); }
});

test('video switch fences stale callbacks, lock disposes a mounted player, and stale callbacks cannot affect the next draft', async () => {
    setup();
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        // A successful module stays cached on this page. Repeated mounts still create distinct DOM roots.
        await input('comment', '第一个视频的草稿');
        await click('载入 YouTube 视频');
        const old = mounts[0];
        await act(async () => old.handlers.ready(old.element));
        await click('讨论时间点选项');
        await click('添加当前视频时间');
        await act(async () => window.dispatchEvent(new Event('blur')));
        assert.equal(old.frame.isConnected, false);
        assert.equal(old.destroys, 1);
        await act(async () => window.dispatchEvent(new Event('focus')));
        await pause();
        assert.equal(composer().value, '第一个视频的草稿');
        assert.ok(button('已添加时间点 00:00（已固定）'));
        assert.equal(mounts.length, 1);
        await render(VideoDiscussion, { videoId: 'other' });
        assert.equal(composer().value, '');
        await input('comment', '第二个视频的草稿');
        await click('载入 YouTube 视频');
        const current = mounts[1];
        old.element.currentTime = 93;
        await act(async () => {
            old.handlers.ready(old.element);
            old.handlers.time(old.element);
            old.handlers.error(old.element);
        });
        assert.equal(composer().value, '第二个视频的草稿');
        assert.equal(current.frame.isConnected, true);
        assert.equal(button('重试 YouTube 视频'), undefined);
        await act(async () => current.handlers.ready(current.element));
        await click('讨论时间点选项');
        await click('添加当前视频时间');
        assert.ok(button('已添加时间点 00:00（已固定）'));
        await unmount();
        assert.equal(current.destroys, 1);
    } finally { await unmount(); }
});

test('focus inside the authorized YouTube media shadow iframe permits playback; outside or wrong-origin markers lock', async () => {
    for (const fake of [null, 'outside', 'wrong-origin', 'wrong-marker']) {
        setup();
        const original = document.hasFocus;
        try {
            await render(VideoDiscussion, { videoId: 'v' });
            await click('载入 YouTube 视频');
            const { element, frame } = mounts[0];
            await act(async () => mounts[0].handlers.ready(element));
            if (fake === 'outside') document.body.appendChild(element);
            if (fake === 'wrong-origin') frame.src = 'https://untrusted.example/embed/M7lc1UVf-VE?t=0s';
            if (fake === 'wrong-marker') frame.dataset.kapokPlayer = 'fake-youtube';
            frame.focus();
            assert.equal(document.activeElement, element);
            assert.equal(element.shadowRoot.activeElement, frame);
            document.hasFocus = () => true;
            await act(async () => window.dispatchEvent(new Event('blur')));
            assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, fake !== null);
            if (fake === null) {
                assert.equal(frame.isConnected, true);
                document.hasFocus = () => false;
                await act(async () => window.dispatchEvent(new Event('blur')));
                assert.equal(document.querySelector('[data-kapok-sensitive]').hidden, true);
                assert.equal(frame.isConnected, false);
            }
        } finally {
            document.hasFocus = original;
            await unmount();
        }
    }
});

test('edit adds a recognized YouTube link via the video API and shows its platform in management', async () => {
    setup('/admin/trainings/t');
    let videos = [];
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    override = (path, options) => {
        if (path === 'uploads') return response({ items: [], nextCursor: null });
        if (path === 'trainings/t') return response({ ...training, videos });
        if (path === 'trainings/t/videos' && options.method === 'POST') {
            videos = [video];
            return response(video);
        }
    };
    try {
        await render(TrainingManagement, { mode: 'detail', id: 't' });
        await click('添加视频');
        await input('title', '合成视频');
        await input('url', 'https://youtu.be/M7lc1UVf-VE?t=0');
        await click('添加到训练', document.querySelector('dialog'));
        assert.deepEqual(JSON.parse(posts()[0].options.body), { title: '合成视频', position: 0, source: 'youtube', url: 'https://youtu.be/M7lc1UVf-VE?t=0' });
        assert.match(document.querySelector('.training-video-order').textContent, /合成视频.*YouTube.*排序 0/);
    } finally { await unmount(); }
});

test('returning to an earlier time query requires a fresh YouTube player while retaining the discussion draft', async () => {
    setup('/videos/v?t=0');
    try {
        await render(VideoDiscussion, { videoId: 'v', initialSeconds: 0 });
        await input('comment', '同一视频的讨论草稿');
        await click('讨论时间点选项');
        assert.equal(button('添加当前视频时间').disabled, true);
        await click('载入 YouTube 视频');
        const original = mounts[0];
        await act(async () => original.handlers.ready(original.element));
        assert.equal(button('添加当前视频时间').disabled, false);

        window.history.replaceState({}, '', '/videos/v?t=30');
        await render(VideoDiscussion, { videoId: 'v', initialSeconds: 30 });
        assert.equal(original.frame.isConnected, false);
        assert.equal(button('添加当前视频时间').disabled, true);
        window.history.replaceState({}, '', '/videos/v?t=0');
        await render(VideoDiscussion, { videoId: 'v', initialSeconds: 0 });
        assert.equal(mounts.length, 1);
        assert.equal(composer().value, '同一视频的讨论草稿');
        assert.equal(button('添加当前视频时间').disabled, true);
        await act(async () => original.handlers.ready(original.element));
        assert.equal(button('添加当前视频时间').disabled, true);

        await click('载入 YouTube 视频');
        assert.equal(button('添加当前视频时间').disabled, true);
        await act(async () => mounts[1].handlers.ready(mounts[1].element));
        await click('添加当前视频时间');
        assert.ok(button('已添加时间点 00:00（已固定）'));
        assert.equal(composer().value, '同一视频的讨论草稿');
    } finally { await unmount(); }
});

test('discussion moderation uses an in-page confirmation: cancel does not write and confirm preserves authorization', async () => {
    setup();
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const oldPrompt = window.prompt;
    window.prompt = () => { throw new Error('native prompt must not interrupt account authorization'); };
    override = (path, options) => path === 'comments/c/moderation' && options.method === 'POST' ? response({}) : undefined;
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        await click('管理员隐藏');
        assert.ok(document.querySelector('dialog[open]'), 'visible in-page moderation dialog');
        await input('moderationReason', '合成隐藏原因');
        await click('取消', document.querySelector('dialog'));
        assert.equal(posts().length, 0);
        await click('管理员隐藏');
        await input('moderationReason', '合成隐藏原因');
        await click('确认隐藏', document.querySelector('dialog'));
        assert.deepEqual(JSON.parse(posts()[0].options.body), { action: 'hide', reason: '合成隐藏原因' });
    } finally { window.prompt = oldPrompt; await unmount(); }
});

test('pending moderation closes on account invalidation and cannot write after membership revocation', async () => {
    for (const mode of ['account', 'membership']) {
        setup();
        try {
            await render(VideoDiscussion, { videoId: 'v' });
            await click('管理员隐藏');
            await input('moderationReason', '不得提交的原因');
            if (mode === 'account') {
                await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
                assert.equal(document.querySelector('dialog[open]'), null);
            } else {
                override = path => path === 'bootstrap' ? response({ actorId, me: { ...me, membership: { ...me.membership, status: 'left', epoch: 2 } } }) : undefined;
                await click('确认隐藏', document.querySelector('dialog'));
            }
            assert.equal(posts().length, 0);
        } finally { await unmount(); }
    }
});

test('late moderation success cannot reopen the UI after account invalidation', async () => {
    setup();
    let complete;
    override = (path, options) => path === 'comments/c/moderation' && options.method === 'POST'
        ? new Promise(resolve => { complete = () => resolve(response({})); }) : undefined;
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        await click('管理员隐藏');
        await input('moderationReason', '迟到响应');
        await click('确认隐藏', document.querySelector('dialog'));
        assert.equal(posts().length, 1);
        await act(async () => window.dispatchEvent(new CustomEvent('kapok-account-changed', { detail: actorId })));
        await act(async () => complete());
        assert.equal(document.querySelector('dialog[open]'), null);
        assert.doesNotMatch(document.body.textContent, /讨论已隐藏。/);
        assert.equal(document.querySelector('[data-kapok-sensitive]')?.hidden ?? true, true);
    } finally { await unmount(); }
});

test('retryable moderation failure preserves the same reason and request key until explicit retry succeeds', async () => {
    setup();
    let attempts = 0;
    override = (path, options) => path === 'comments/c/moderation' && options.method === 'POST'
        ? (++attempts === 1 ? response({ error: { code: 'TEMPORARY_FAILURE', message: '合成暂时失败', retryable: true } }, 503) : response({})) : undefined;
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        await click('管理员隐藏');
        await input('moderationReason', '失败后必须保留的理由');
        await click('确认隐藏', document.querySelector('dialog'));
        assert.ok(document.querySelector('dialog[open]'));
        assert.equal(document.querySelector('[name=moderationReason]').value, '失败后必须保留的理由');
        assert.match(document.querySelector('dialog').textContent, /合成暂时失败/);
        assert.equal(attempts, 1, 'no automatic retry');
        await click('确认隐藏', document.querySelector('dialog'));
        assert.equal(attempts, 2);
        assert.equal(posts()[0].options.headers['Idempotency-Key'], posts()[1].options.headers['Idempotency-Key']);
        assert.equal(document.querySelector('dialog[open]'), null);
        assert.equal(document.querySelector('[name=moderationReason]').value, '');
    } finally { await unmount(); }
});

test('failed moderation is cleared by cancel, a different action, or an unavailable target', async () => {
    setup();
    let unavailable = false;
    override = (path, options) => path === 'comments/c/moderation' && options.method === 'POST'
        ? response({ error: { code: unavailable ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', message: '合成失败', retryable: !unavailable } }, unavailable ? 404 : 503) : undefined;
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        await click('管理员隐藏');
        await input('moderationReason', '不能串到举报');
        await click('确认隐藏', document.querySelector('dialog'));
        await click('取消', document.querySelector('dialog'));
        await click('举报');
        assert.equal(document.querySelector('[name=moderationReason]').value, '');
        await input('moderationReason', '目标失效必须清空');
        unavailable = true;
        await click('确认举报', document.querySelector('dialog'));
        assert.equal(document.querySelector('dialog[open]'), null);
        assert.equal(document.querySelector('[name=moderationReason]').value, '');
    } finally { await unmount(); }
});


test('moderation VERSION_CONFLICT clears its reason and revalidates the obsolete target', async () => {
    setup();
    override = (path, options) => path === 'comments/c/moderation' && options.method === 'POST'
        ? response({ error: { code: 'VERSION_CONFLICT', message: '目标版本已变化', retryable: false } }, 409) : undefined;
    try {
        await render(VideoDiscussion, { videoId: 'v' });
        await click('管理员隐藏');
        await input('moderationReason', '不重试失效目标');
        const before = calls.filter(c => c.path === 'videos/v/comments').length;
        await click('确认隐藏', document.querySelector('dialog'));
        assert.equal(document.querySelector('dialog[open]'), null);
        assert.equal(document.querySelector('[name=moderationReason]').value, '');
        assert.ok(calls.filter(c => c.path === 'videos/v/comments').length > before);
        assert.equal(posts().length, 1);
    } finally { await unmount(); }
});
