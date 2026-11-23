import { WorkspaceEntry } from '../../components/workspace-entry';
import { Shell, AccessState, getPageContext, canReadPersonal, isMember } from '../../components/shell';
import { ProfileEditor } from '../../components/profile-editor';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/account?edit=1'} />;
    return <Shell title="编辑个人资料" back="/me" surface="index" canCompose={isMember(context.me)} description="更新盘名、背号和简介，队友可在你的队内档案查看。">
        {context.user && canReadPersonal(context.user, context.me) ? <ProfileEditor actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me/edit" />}
    </Shell>;
}
