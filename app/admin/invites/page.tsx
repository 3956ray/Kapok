import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../../components/shell';
import { InviteScreen } from '../../components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="邀请管理" nav={false} back="/me">
        <EnvironmentNote />
        {context.user && isMember(context.me) ? <InviteScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/admin/invites" />}
    </Shell>;
}
