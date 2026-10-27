import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

// Opt-in: the controller starts the official built Worker. No synthetic identity
// is sent to it. This executes its real client bundles, not next/link test stubs.
const origin = process.env.KAPOK_BUILT_ORIGIN;
test('official built runtime hydrates, navigates and dispatches a protected retry button', { skip: !origin, timeout: 20_000 }, async t => {
    const base = new URL(origin);
    assert.ok(['localhost', '127.0.0.1'].includes(base.hostname), 'built probe is loopback only');
    const nativeFetch = globalThis.fetch;
    const response = await nativeFetch(base);
    assert.equal(response.status, 200);
    const dom = new JSDOM(await response.text(), { url: base.href, pretendToBeVisual: true });
    for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'CustomEvent', 'Event', 'MouseEvent', 'localStorage', 'sessionStorage', 'location', 'history', 'Node', 'Element', 'MutationObserver']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    }
    globalThis.self = dom.window;
    globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    globalThis.BroadcastChannel = class { close() {} };
    window.scrollTo = () => {};
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); originalError(...args); };
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const absolute = new URL(url, base);
        assert.equal(absolute.origin, base.origin);
        requests.push(absolute.pathname);
        return nativeFetch(absolute, options);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 150));
    const until = async predicate => {
        for (let i = 0; i < 30 && !predicate(); i++) await settle();
        assert.ok(predicate(), 'runtime condition settled within 4.5 seconds');
    };
    const manifest = JSON.parse(readFileSync('dist/client/.vite/manifest.json', 'utf8'));
    const entry = JSON.parse(readFileSync('dist/client/vinext-client-entry-manifest.json', 'utf8')).appBrowserEntry;
    const load = file => import(pathToFileURL(resolve('dist/client', file)).href);
    try {
        // Embedded payload is exactly the anonymous Worker response. Module
        // loading uses disk to avoid pretending JSDOM is a browser network stack.
        for (const script of document.scripts) if (!script.src && !script.type) (0, eval)(script.textContent);
        await load(entry);
        await until(() => window.__NEXT_HYDRATED === true);
        for (const [path, heading] of [['/trainings', '训练'], ['/growth', '成长'], ['/me', '我的']]) {
            await t.test(`real bundled next/link navigates to ${path}`, async () => {
                const start = errors.length;
                const anchor = document.querySelector(`.bottom-nav a[href="${path}"]`);
                assert.ok(anchor);
                anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
                await until(() => location.pathname === path || errors.length > start);
                assert.equal(errors.length, start, 'no runtime exception after intercepted click');
                assert.equal(location.pathname, path);
                assert.ok(document.querySelector('h1').textContent.includes(heading));
                assert.ok(requests.includes(path), 'actual anonymous RSC request reached built Worker');
            });
        }
        await t.test('real bundled protected button dispatches retry and remains concealed on failure', async () => {
            // Synthetic transport only for the existing protected component;
            // no identity or write is sent to any Worker or hosted service.
            let reads = 0;
            globalThis.fetch = async () => { reads++; throw new Error('synthetic unavailable'); };
            const { BootstrapScreen } = await load(manifest['app/components/legacy-screens.tsx'].file);
            const React = globalThis[Symbol.for('vinext.client.react')];
            window.__VINEXT_RSC_ROOT__.render(React.createElement('html', null,
                React.createElement('body', null, React.createElement(BootstrapScreen, { actorId: 'synthetic-runtime-test' }))));
            await until(() => document.querySelector('[role=alert] button'));
            const before = reads;
            document.querySelector('[role=alert] button').click();
            await until(() => reads > before && document.querySelector('[role=alert] button'));
            assert.ok(document.querySelector('[data-kapok-sensitive]').hidden);
            assert.equal(document.querySelector('form'), null);
        });
    } finally {
        window.__VINEXT_RSC_ROOT__?.unmount();
        console.error = originalError;
        globalThis.fetch = nativeFetch;
        dom.window.close();
    }
});
