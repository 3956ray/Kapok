import { WorkspaceEntry } from '../components/workspace-entry';
import { Shell, getPageContext, AccessState, isMember } from '../components/shell';
import { Activity } from '../components/community';
export const dynamic = 'force-dynamic';
export default async function ActivityPage() {
    const context = await getPageContext();
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/activity'} />;
    return <Shell title="队内动态" surface="index" eyebrow="队伍工作区" description="查看队伍公告、新视频和队友主动发布的复盘。" back="/" canCompose={isMember(context.me)}>
        {context.user && isMember(context.me) ? <Activity key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/activity" />}
    </Shell>;
}
