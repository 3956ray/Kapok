import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLeaveRequest } from '../../lib/client/leave-team.ts';

const membership = status => ({
    id: 'membership', teamId: 'kapok', role: 'member', status, version: 5, epoch: 2,
});
for (const currentStatus of ['active', 'paused', 'left']) {
    test(`leave receipt returning current ${currentStatus} reports actual state and requires fresh confirmation`, async t => {
        const original = globalThis.fetch;
        t.after(() => { globalThis.fetch = original; });
        const oldRequest = {
            path: 'me/leave', method: 'POST', key: 'completed-historical-key',
            body: { expectedVersion: 1, expectedEpoch: 1 },
        };
        const state = { confirmed: true, membership: membership('active'), pending: oldRequest };
        const calls = [];
        let notice = '';
        let refreshes = 0;
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            return Response.json({ data: { membership: membership(currentStatus) } }, {
                headers: { 'X-Kapok-Actor': 'A' },
            });
        };
        const effects = {
            authorize: async () => 1,
            isCurrent: token => token === 1,
            setPending: request => { state.pending = request; },
            setConfirmed: confirmed => { state.confirmed = confirmed; },
            refresh: async () => { refreshes += 1; state.membership = membership(currentStatus); },
            showStatus: message => { notice = message; },
        };
        await submitLeaveRequest('A', state, effects);
        assert.equal(calls.length, 1, 'a done receipt never auto-reissues a new leave');
        assert.equal(calls[0].options.headers['Idempotency-Key'], oldRequest.key);
        assert.deepEqual(JSON.parse(calls[0].options.body), oldRequest.body);
        assert.equal(state.pending, null);
        assert.equal(state.confirmed, false);
        assert.equal(refreshes, 1);
        assert.equal(state.membership.status, currentStatus);
        if (currentStatus === 'left') {
            assert.match(notice, /已确认退出队伍/);
        } else {
            assert.doesNotMatch(notice, /已确认退出队伍/);
            assert.match(notice, /上次退出请求已完成/);
            assert.match(notice, /身份后来已变化/);
            assert.match(notice, currentStatus === 'active' ? /有效成员/ : /暂停/);
            assert.match(notice, /重新勾选确认/);
        }
        await submitLeaveRequest('A', state, effects);
        assert.equal(calls.length, 1, 'cleared confirmation prevents a second submission');
        if (currentStatus !== 'left') {
            state.confirmed = true;
            await submitLeaveRequest('A', state, effects);
            assert.equal(calls.length, 2, 'only a new explicit confirmation submits again');
            assert.notEqual(calls[1].options.headers['Idempotency-Key'], oldRequest.key);
            assert.deepEqual(JSON.parse(calls[1].options.body), { expectedVersion: 5, expectedEpoch: 2 });
        }
    });
}
