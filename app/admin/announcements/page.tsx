import { Shell, getPageContext, AccessState, isMember } from '../../components/shell';
import { AnnouncementAdmin } from '../../components/community';
export const dynamic = 'force-dynamic';
export default async function AnnouncementsAdmin() {
    const context = await getPageContext();
    return <Shell title="公告管理" back="/me" nav={false}>
        {context.user && isMember(context.me) && context.me?.membership?.role === 'admin' ? <AnnouncementAdmin key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/admin/announcements" />}
    </Shell>;
}
