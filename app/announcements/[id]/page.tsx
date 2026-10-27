import { Shell, getPageContext, AccessState, isMember } from '../../components/shell';
import { AnnouncementRead } from '../../components/community';
export const dynamic = 'force-dynamic';
export default async function AnnouncementPage({
    params
}: {
    params: Promise<{
        id: string;
    }>;
}) {
    const context = await getPageContext();
    const {
        id
    } = await params;
    return <Shell title="队伍公告" back="/activity">
        {context.user && isMember(context.me) ? <AnnouncementRead key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} /> : <AccessState context={context} returnTo={`/announcements/${id}`} />}
    </Shell>;
}
