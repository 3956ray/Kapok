import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadOwnData } from '../../lib/client/data-export.ts';
import { createSessionGuard } from '../../lib/client/session-guard.ts';

// Uses the production download orchestrator and API response-actor check; no browser/React proof is claimed.
test('JSON download refuses an old generation and never parses another account response', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const guard = createSessionGuard('A');
    guard.confirm(guard.start(), 'A', true);
    let release;
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    let consumed = 0;
    globalThis.fetch = async () => {
        entered();
        await wait;
        return new Response(JSON.stringify({ data: { profile: { discName: 'A' } } }), { headers: { 'X-Kapok-Actor': 'A' } });
    };
    const pending = downloadOwnData('A', async () => guard.token(), token => guard.current(token), () => { consumed += 1; });
    await ready;
    guard.conceal();
    guard.confirm(guard.start(), 'A', true);
    release();
    await assert.rejects(pending, /未下载旧内容/);
    assert.equal(consumed, 0);
    let parsed = false;
    const oldDispatch = globalThis.dispatchEvent;
    const oldWindow = globalThis.window;
    const oldChannel = globalThis.BroadcastChannel;
    t.after(() => {
        globalThis.dispatchEvent = oldDispatch;
        globalThis.window = oldWindow;
        globalThis.BroadcastChannel = oldChannel;
    });
    globalThis.window = { dispatchEvent() {} };
    globalThis.BroadcastChannel = class { postMessage() {} close() {} };
    globalThis.fetch = async () => ({
        status: 200,
        headers: new Headers({ 'X-Kapok-Actor': 'B' }),
        json: async () => { parsed = true; return { data: { text: 'B content' } }; },
    });
    await assert.rejects(downloadOwnData('A', async () => guard.token(), token => guard.current(token), () => { consumed += 1; }), e => e.code === 'ACCOUNT_CHANGED');
    assert.equal(parsed, false);
    assert.equal(consumed, 0);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { format: 'kapok-personal-v1' } }), { headers: { 'X-Kapok-Actor': 'A' } });
    await downloadOwnData('A', async () => guard.token(), token => guard.current(token), () => { consumed += 1; });
    assert.equal(consumed, 1);
});
