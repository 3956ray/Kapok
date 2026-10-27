import type { Me } from '../contracts/index';
import { api } from './api.ts';

export type LeaveRequest = { path: 'me/leave'; method: 'POST'; body: unknown; key: string };
export async function submitLeaveRequest(
    actorId: string,
    state: { confirmed: boolean; membership: Me['membership']; pending: LeaveRequest | null },
    effects: {
        authorize: () => Promise<number>;
        isCurrent: (token: number) => boolean;
        setPending: (request: LeaveRequest | null) => void;
        setConfirmed: (confirmed: boolean) => void;
        refresh: () => Promise<void>;
        showStatus: (message: string) => void;
    },
) {
    if (!state.confirmed || !state.membership) return;
    const token = await effects.authorize();
    const request: LeaveRequest = state.pending ?? {
        path: 'me/leave', method: 'POST', key: crypto.randomUUID(),
        body: { expectedVersion: state.membership.version, expectedEpoch: state.membership.epoch },
    };
    effects.setPending(request);
    const result = await api<{ membership: Me['membership'] }>(request.path, { ...request, actorId });
    if (!effects.isCurrent(token)) return;
    effects.setPending(null);
    effects.setConfirmed(false);
    await effects.refresh();
    if (result.membership?.status === 'left') {
        effects.showStatus('已确认退出队伍。本人私稿和备注保留；原分享不会恢复。');
    } else {
        const current = result.membership?.status === 'active' ? '有效成员'
            : result.membership?.status === 'paused' ? '队内访问已暂停' : '成员状态待确认';
        effects.showStatus(`上次退出请求已完成，但成员身份后来已变化：${current}。本次未再次退出。如仍需退出，请重新勾选确认后提交新请求。`);
    }
}
