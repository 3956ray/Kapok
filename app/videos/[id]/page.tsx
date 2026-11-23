import { AccessState, getPageContext, isMember } from '../../components/shell';
import { WorkspaceEntry } from '../../components/workspace-entry';
import { safeReturnTo } from '../../../lib/server/return-to';

export const dynamic = 'force-dynamic';

export default async function VideoPage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ t?: string | string[] }>;
}) {
    const [{ id }, { t }, context] = await Promise.all([params, searchParams, getPageContext()]);
    const seconds = typeof t === 'string' && /^\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? '?t=' + t : '';
    const path = '/videos/' + encodeURIComponent(id) + seconds;
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={path} />;
    return <main><AccessState context={context} returnTo={safeReturnTo(path)} /></main>;
}
