import { api } from './api.ts';
import type { PersonalExport } from '../contracts/data-rights';

// Never retain a URL or payload in component state. A stale account/generation cannot reach the download effect.
export async function downloadOwnData(
    actorId: string,
    authorize: () => Promise<number>,
    isCurrent: (token: number) => boolean,
    consume: (data: PersonalExport) => void,
) {
    const token = await authorize();
    const data = await api<PersonalExport>('me/export', undefined, actorId);
    const after = await authorize();
    if (after !== token || !isCurrent(token)) throw new Error('页面正在重新确认，未下载旧内容。请确认账号后重试。');
    consume(data);
}
