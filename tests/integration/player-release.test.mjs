import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const source = 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?t=0s';
const alternate = 'https://www.youtube-nocookie.com/embed/abcdefghijk?t=13s';
const scriptURL = 'https://www.youtube.com/iframe_api';
const moduleURL = new URL('../../public/vendor/kapok-player/player-island.js', import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(context) {
    const dom = new JSDOM('<main><div id="a"></div><div id="b"></div><div id="c"></div></main>', { url: 'https://kapok.local/' });
    for (const key of ['window', 'document', 'Event']) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
        context.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
    }
    context.after(() => dom.window.close());
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const players = [];
    const pending = [];
    const Player = class {
        constructor(frame, { events }) {
            this.frame = frame;
            this.events = events;
            this.time = 0;
            this.duration = 0;
            this.state = -1;
            this.seeks = [];
            this.pauses = 0;
            this.destroys = 0;
            players.push(this);
        }
        getDuration() { return this.duration; }
        getCurrentTime() { return this.time; }
        getPlayerState() { return this.state; }
        seekTo(seconds, ahead) { this.seeks.push([seconds, ahead]); }
        pauseVideo() { this.pauses++; }
        destroy() { this.destroys++; this.frame.remove(); }
        ready() { this.events.onReady({ target: this }); }
        fail(data) { this.events.onError({ target: this, data }); }
    };
    const { mount } = await import(String(moduleURL) + '?' + encodeURIComponent(context.name));
    const open = (id, url = source) => {
        const calls = [];
        const slot = document.getElementById(id);
        const instance = mount(slot, url, Object.fromEntries(['ready', 'time', 'playing', 'error'].map(name => [
            name,
            node => calls.push([name, node]),
        ])));
        pending.push(instance);
        return { instance, slot, calls };
    };
    context.after(() => pending.forEach(instance => instance.destroy()));
    return {
        mount, open, players,
        scripts: () => [...document.querySelectorAll(`script[src="${scriptURL}"]`)],
        connect() { window.YT = { Player }; window.onYouTubeIframeAPIReady(); },
    };
}

test('official player loads only when mounted and shares one API request across isolated iframes', async context => {
    const f = await fixture(context);
    assert.equal(f.scripts().length, 0);
    assert.throws(() => f.mount(document.getElementById('a'), 'https://example.test/embed/M7lc1UVf-VE', {}), /Invalid YouTube embed URL/);
    const a = f.open('a');
    const b = f.open('b', alternate);
    const cancelled = f.open('c');
    cancelled.instance.destroy();
    assert.equal(f.scripts().length, 1);
    assert.equal(a.instance.element.shadowRoot.querySelector('iframe'), null);
    f.connect();
    await flush();
    assert.equal(window.onYouTubeIframeAPIReady, undefined);
    assert.equal(f.players.length, 2);
    assert.equal(cancelled.slot.childElementCount, 0);
    assert.deepEqual(cancelled.calls, []);

    const startPolling = context.mock.method(globalThis, 'setInterval');
    for (const [index, start] of ['0', '13'].entries()) {
        const parent = index ? b : a;
        const player = f.players[index];
        const frame = parent.instance.element.shadowRoot.querySelector('iframe');
        const url = new URL(frame.src);
        assert.equal(url.origin, 'https://www.youtube-nocookie.com');
        assert.equal(url.searchParams.get('enablejsapi'), '1');
        assert.equal(url.searchParams.get('origin'), 'https://kapok.local');
        assert.equal(url.searchParams.get('start'), start);
        assert.equal(url.searchParams.get('playsinline'), '1');
        assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
        assert.equal(frame.dataset.kapokPlayer, 'youtube');
        player.ready();
        assert.deepEqual(parent.calls.map(([name]) => name), ['ready']);
    }
    const stopPolling = context.mock.method(globalThis, 'clearInterval');
    a.instance.destroy();
    a.instance.destroy();
    const firstPoll = startPolling.mock.calls[0].result;
    const secondPoll = startPolling.mock.calls[1].result;
    assert.equal(stopPolling.mock.calls.filter(call => call.arguments[0] === firstPoll).length, 1);
    assert.ok(stopPolling.mock.calls.every(call => call.arguments[0] !== secondPoll));
    assert.equal(f.players[0].destroys, 1);
    assert.equal(f.players[1].destroys, 0);
    assert.equal(a.slot.childElementCount, 0);
    assert.ok(f.players[1].frame.isConnected);
    f.players[0].ready();
    f.players[0].fail(101);
    f.players[0].events.onStateChange({ data: 1 });
    f.players[0].frame.dispatchEvent(new Event('error'));
    context.mock.timers.tick(400);
    assert.deepEqual(a.calls.map(([name]) => name), ['ready']);
    assert.deepEqual(b.calls.map(([name]) => name), ['ready', 'time', 'time']);
});

test('official metadata and seek completion reflect provider time, including zero', async context => {
    const f = await fixture(context);
    const a = f.open('a');
    f.connect();
    await flush();
    const player = f.players[0];
    player.ready();
    const element = a.instance.element;
    assert.equal(element.readyState, 0);
    assert.ok(Number.isNaN(element.duration));
    player.duration = 120;
    player.state = 2;
    let seeksCompleted = 0;
    element.addEventListener('seeked', () => seeksCompleted++);
    context.mock.timers.tick(200);
    assert.equal(element.readyState, 1);
    assert.equal(element.duration, 120);
    assert.equal(element.currentTime, 0);

    element.currentTime = 13;
    assert.deepEqual(player.seeks, [[13, true]]);
    assert.equal(element.currentTime, 0);
    assert.equal(element.seeking, true);
    player.time = 13;
    player.state = 3;
    context.mock.timers.tick(200);
    assert.equal(element.seeking, true);
    assert.equal(seeksCompleted, 0);
    player.state = 2;
    context.mock.timers.tick(200);
    assert.equal(element.seeking, false);
    assert.equal(seeksCompleted, 1);

    element.currentTime = 20;
    element.currentTime = 0;
    assert.deepEqual(player.seeks, [[13, true], [20, true], [0, true]]);
    player.time = 20;
    context.mock.timers.tick(200);
    assert.equal(element.seeking, true);
    assert.equal(seeksCompleted, 1);
    player.time = 0;
    context.mock.timers.tick(200);
    assert.equal(element.seeking, false);
    assert.equal(seeksCompleted, 2);
    element.currentTime = 0;
    assert.equal(player.seeks.length, 3);
    assert.equal(player.pauses, 0);
});

test('official script error and timeout permit retry, and provider errors retain their code', async context => {
    const f = await fixture(context);
    const a = f.open('a');
    f.scripts()[0].dispatchEvent(new Event('error'));
    await flush();
    assert.deepEqual(a.calls.map(([name]) => name), ['error']);
    assert.equal(f.scripts().length, 0);
    assert.equal(a.instance.element.error, null);
    a.instance.destroy();

    const b = f.open('b');
    context.mock.timers.tick(12_000);
    await flush();
    assert.deepEqual(b.calls.map(([name]) => name), ['error']);
    assert.equal(f.scripts().length, 0);
    b.instance.destroy();

    const retry = f.open('a');
    f.connect();
    await flush();
    const player = f.players[0];
    player.fail(101);
    assert.deepEqual(retry.calls.map(([name]) => name), ['error']);
    assert.equal(retry.instance.element.error.code, 101);
    retry.instance.destroy();
    assert.equal(player.destroys, 1);
});
