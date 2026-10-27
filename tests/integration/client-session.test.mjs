import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionGuard, draftKey, clearActorDrafts } from '../../lib/client/session-guard.ts';
test(
    'client session guard rejects A late response, focus generations, anonymous and B confirmation',
    () => {
        const guard = createSessionGuard('A');
        const a = guard.start();
        assert.equal(guard.confirm(a, 'A', true), true);
        assert.equal(guard.current(a), true);
        guard.conceal();
        assert.equal(guard.current(a), false);
        assert.equal(guard.confirm(a, 'A', true), false);
        const afterFocus = guard.start();
        assert.equal(guard.confirm(afterFocus, 'B', true), false);
        assert.equal(guard.confirm(afterFocus, '', false), false);
        assert.equal(guard.current(afterFocus), false);
        assert.equal(guard.confirm(afterFocus, 'A', true), true);
        guard.conceal();
        assert.equal(guard.current(afterFocus), false);
    }
);
test(
    'local draft key isolation and logout removes only the verified account drafts',
    () => {
        const values = new Map([[draftKey('A', 'new'), 'A body'], [draftKey('B', 'new'), 'B body'], ['kapok:preference', 'large']]);
        const storage = {
            get length() {
                return values.size;
            },
            key: index => [...values.keys()][index] ?? null,
            removeItem: key => values.delete(key)
        };
        assert.notEqual(draftKey('A', 'new'), draftKey('B', 'new'));
        assert.notEqual(draftKey('A:B', 'new'), draftKey('A', 'B:new'));
        clearActorDrafts(storage, 'A');
        assert.equal(values.has(draftKey('A', 'new')), false);
        assert.equal(values.get(draftKey('B', 'new')), 'B body');
        assert.equal(values.get('kapok:preference'), 'large');
    }
);
test(
    'client refuses B response before parsing, while missing actor on outage stays retryable',
    async t => {
        const {
            api
        } = await import('../../lib/client/api.ts');
        t.mock.method(
            globalThis,
            'fetch',
            async () => ({
                headers: new Headers({
                    'X-Kapok-Actor': 'B'
                }),
                status: 200,
                json: () => {
                    throw new Error('must never parse B body');
                }
            })
        );
        await assert.rejects(api('reflections', undefined, 'A'), error => error.code === 'ACCOUNT_CHANGED');
        globalThis.fetch.mock.mockImplementation(async () => ({
            headers: new Headers(),
            status: 503
        }));
        await assert.rejects(api('reflections', undefined, 'A'), error => error.code === 'SESSION_UNVERIFIED' && error.retryable);
    }
);

test('T3 fix1 expiry preserves the pending draft and old generations stay locked until same-A reauthentication', async t => {
    const { api } = await import('../../lib/client/api.ts');
    const { handleSessionSignal } = await import('../../lib/client/session-guard.ts');
    const { prepareDraftRequest } = await import('../../lib/client/reflection-draft.ts');
    const windowEvents = new EventTarget();
    globalThis.window = windowEvents;
    t.after(() => { delete globalThis.window; });
    const pending = prepareDraftRequest({
        schema: 1, title: '', text: '会话过期前尚未确认的正文', date: '2026-10-16',
        trainingId: '', videoId: '', updatedAt: 'now', cloud: null, pending: null
    }, 'must-survive-expiry');
    const stored = new Map([[draftKey('A', 'new'), JSON.stringify(pending)], [draftKey('B', 'new'), 'B private draft']]);
    const storage = {
        get length() { return stored.size; },
        key: index => [...stored.keys()][index] ?? null,
        removeItem: key => stored.delete(key)
    };
    const guard = createSessionGuard('A');
    const old = guard.start();
    guard.confirm(old, 'A', true);
    const signals = [];
    const effects = { surface: { hidden: false }, lock: () => {}, clearResource: () => {}, endEditor: () => {}, getStorage: () => storage };
    windowEvents.addEventListener('kapok-session-expired', event => {
        signals.push(handleSessionSignal(guard, 'A', { actorId: event.detail, kind: 'expired' }, effects).action);
    });
    windowEvents.addEventListener('kapok-account-changed', event => {
        signals.push(handleSessionSignal(guard, 'A', { actorId: event.detail, kind: 'ended' }, effects).action);
    });
    t.mock.method(globalThis, 'fetch', async () => ({
        headers: new Headers(), status: 401,
        json: () => { throw new Error('anonymous body must not be parsed'); }
    }));

    await assert.rejects(api('reflections', undefined, 'A'), error => error.code === 'AUTHENTICATION_REQUIRED' && error.retryable);
    assert.deepEqual(signals, ['expired']);
    assert.equal(guard.current(old), false);
    assert.equal(guard.confirm(old, 'A', true), false);
    assert.equal(stored.get(draftKey('A', 'new')), JSON.stringify(pending));

    globalThis.fetch.mock.mockImplementation(async () => ({
        headers: new Headers({ 'X-Kapok-Actor': 'A' }), status: 200, ok: true,
        json: async () => ({ data: { siteUserId: 'A', me: { user: { status: 'active' } } } })
    }));
    const fresh = guard.start();
    const authenticated = await api('bootstrap', undefined, 'A');
    assert.equal(guard.confirm(fresh, authenticated.siteUserId, authenticated.me.user.status === 'active'), true);
    assert.equal(guard.current(fresh), true);
    assert.equal(JSON.parse(stored.get(draftKey('A', 'new'))).pending.key, 'must-survive-expiry');

    globalThis.fetch.mock.mockImplementation(async () => ({
        headers: new Headers({ 'X-Kapok-Actor': 'B' }), status: 200,
        json: () => { throw new Error('B body must not be parsed'); }
    }));
    await assert.rejects(api('reflections', undefined, 'A'), error => error.code === 'ACCOUNT_CHANGED');
    assert.deepEqual(signals, ['expired', 'ended']);
    assert.equal(guard.current(fresh), false);
    assert.equal(stored.has(draftKey('A', 'new')), false);
    assert.equal(stored.get(draftKey('B', 'new')), 'B private draft');
});
