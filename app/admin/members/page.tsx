import { WorkspaceEntry } from '../../components/workspace-entry';
import { MemberManagement } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, getPageContext, isMember } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function ManagedMembersPage() {
    const context = await getPageContext();
    if (context.user && isMember(context.me) && context.me?.membership?.role === 'admin') return <WorkspaceEntry actorId={context.user.userId} path="/account/manage/members"/>;
    return <Shell title="成员管理" back="/me" nav={false} eyebrow="队伍管理" description="查看成员状态，确认后变更队内角色与访问权限。">
        <EnvironmentNote />
        {context.user && isMember(context.me) && context.me?.membership?.role === 'admin'
            ? <MemberManagement key={context.user.userId} actorId={context.user.userId} />
            : <AccessState context={context} returnTo="/admin/members" />}
    </Shell>;
}
