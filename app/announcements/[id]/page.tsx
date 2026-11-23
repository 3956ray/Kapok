import { AccessState, getPageContext, isMember } from '../../components/shell';
import { WorkspaceEntry } from '../../components/workspace-entry';
import { safeReturnTo } from '../../../lib/server/return-to';

export const dynamic = 'force-dynamic';

export default async function AnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
    const [{ id }, context] = await Promise.all([params, getPageContext()]);
    const path = '/announcements/' + encodeURIComponent(id);
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={path} />;
    return <main><AccessState context={context} returnTo={safeReturnTo(path)} /></main>;
}
