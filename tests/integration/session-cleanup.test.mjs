import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionGuard, draftKey, handleSessionSignal } from '../../lib/client/session-guard.ts';

function visibleSession(getStorage, callbackFailure = false) {
    const guard = createSessionGuard('A');
    const oldToken = guard.start();
    guard.confirm(oldToken, 'A', true);
    const state = { hidden: false, locked: false, memory: 'A private body', editor: 'A pending input', ended: false };
    const effects = {
        surface: state,
        lock: () => {
            state.locked = true;
            if (callbackFailure) throw new Error('consumer failed after lock');
        },
        clearResource: () => { state.memory = null; },
        endEditor: () => { state.editor = null; state.ended = true; },
        getStorage: () => getStorage({ guard, oldToken, state })
    };
    return { guard, oldToken, state, effects };
}

for (const failure of ['getter', 'removeItem']) {
    test(`T3 I3 ${failure} failure happens after hide, lock and invalidation; ended memory cannot reopen`, () => {
        const retained = new Map([[draftKey('A', 'new'), 'A pending request'], [draftKey('B', 'new'), 'B draft']]);
        const observations = [];
        const session = visibleSession(({ guard, oldToken, state }) => {
            const observe = () => observations.push({
                hidden: state.hidden, locked: state.locked, oldValid: guard.current(oldToken),
                memory: state.memory, editor: state.editor, ended: state.ended
            });
            if (failure === 'getter') {
                const storageHost = Object.defineProperty({}, 'localStorage', {
                    get() {
                        observe();
                        throw new DOMException('Storage getter blocked', 'SecurityError');
                    }
                });
                return storageHost.localStorage;
            }
            return {
                get length() { return retained.size; },
                key: index => [...retained.keys()][index] ?? null,
                removeItem: () => {
                    observe();
                    throw new DOMException('Draft removal blocked', 'SecurityError');
                }
            };
        });
        let result;

        assert.doesNotThrow(() => {
            result = handleSessionSignal(session.guard, 'A', { actorId: 'A', kind: 'ended' }, session.effects);
        });

        assert.deepEqual(observations, [{ hidden: true, locked: true, oldValid: false, memory: null, editor: null, ended: true }]);
        assert.equal(result.action, 'ended');
        assert.equal(result.cleanupFailed, true);
        assert.equal(session.guard.current(session.oldToken), false);
        assert.equal(session.guard.confirm(session.oldToken, 'A', true), false);
        const retry = session.guard.start();
        assert.equal(session.guard.confirm(retry, 'A', true), false);
        assert.equal(session.state.hidden, true);
        assert.equal(session.state.locked, true);
        assert.equal(retained.get(draftKey('A', 'new')), 'A pending request');
        assert.equal(retained.get(draftKey('B', 'new')), 'B draft');
    });
}

test('T3 I3 consumer callback failure cannot skip end, memory clearing or cleanup and is reported', () => {
    const retained = new Map([[draftKey('A', 'new'), 'A pending request'], [draftKey('B', 'new'), 'B draft']]);
    const session = visibleSession(() => ({
        get length() { return retained.size; },
        key: index => [...retained.keys()][index] ?? null,
        removeItem: key => retained.delete(key)
    }), true);
    let result;

    assert.doesNotThrow(() => {
        result = handleSessionSignal(session.guard, 'A', { actorId: 'A', kind: 'ended' }, session.effects);
    });

    assert.equal(result.callbackFailed, true);
    assert.equal(result.cleanupFailed, false);
    assert.equal(session.state.hidden, true);
    assert.equal(session.state.locked, true);
    assert.equal(session.state.memory, null);
    assert.equal(session.state.editor, null);
    assert.equal(session.state.ended, true);
    assert.equal(retained.has(draftKey('A', 'new')), false);
    assert.equal(retained.get(draftKey('B', 'new')), 'B draft');
    const retry = session.guard.start();
    assert.equal(session.guard.confirm(retry, 'A', true), false);
});

test('T3 I3 expiry never obtains storage, retains pending input and permits only fresh same-A verification', () => {
    let storageTouches = 0;
    const session = visibleSession(() => {
        storageTouches += 1;
        throw new DOMException('Storage unavailable during expiry', 'SecurityError');
    });
    let result;

    assert.doesNotThrow(() => {
        result = handleSessionSignal(session.guard, 'A', { actorId: 'A', kind: 'expired' }, session.effects);
    });

    assert.equal(result.action, 'expired');
    assert.equal(result.cleanupFailed, false);
    assert.equal(storageTouches, 0);
    assert.equal(session.state.hidden, true);
    assert.equal(session.state.locked, true);
    assert.equal(session.state.editor, 'A pending input');
    assert.equal(session.state.ended, false);
    assert.equal(session.guard.confirm(session.oldToken, 'A', true), false);
    const fresh = session.guard.start();
    assert.equal(session.guard.confirm(fresh, 'A', true), true);
    const wrong = session.guard.start();
    assert.equal(session.guard.confirm(wrong, 'B', true), false);
});

test('T3 I3 signal consumer/delivery failure returns failure without skipping channel close', async t => {
    const { signalAccountChange } = await import('../../lib/client/session-guard.ts');
    let posted = false;
    let closed = false;
    globalThis.window = { dispatchEvent: () => { throw new Error('consumer dispatch failed'); } };
    t.after(() => { delete globalThis.window; });
    t.mock.method(globalThis, 'BroadcastChannel', function () {
        return {
            postMessage() { posted = true; throw new Error('channel delivery failed'); },
            close() { closed = true; }
        };
    });
    let delivered;

    assert.doesNotThrow(() => { delivered = signalAccountChange('A'); });

    assert.equal(delivered, false);
    assert.equal(posted, true);
    assert.equal(closed, true);
});
