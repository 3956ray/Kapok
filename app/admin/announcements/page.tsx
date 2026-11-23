import { WorkspaceEntry } from '../../components/workspace-entry';
import { Shell, getPageContext, AccessState, isMember } from '../../components/shell';
import { AnnouncementAdmin } from '../../components/community';
export const dynamic = 'force-dynamic';
export default async function AnnouncementsAdmin() {
    const context = await getPageContext();
    if (context.user && isMember(context.me) && context.me?.membership?.role === 'admin') return <WorkspaceEntry actorId={context.user.userId} path="/account/manage/announcements"/>;
    return <Shell title="公告管理" back="/me" nav={false} eyebrow="队伍管理" description="编辑草稿，确认发布后在队内动态展示。">
        {context.user && isMember(context.me) && context.me?.membership?.role === 'admin' ? <AnnouncementAdmin key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/admin/announcements" />}
    </Shell>;
}
