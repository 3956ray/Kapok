import { MemberManagement } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, getPageContext } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function ManagedMembersPage() {
    const context = await getPageContext();
    return <Shell title="成员管理" back="/me" nav={false}>
        <EnvironmentNote />
        {!context.me?.profile || context.error ? <AccessState context={context} returnTo="/admin/members" /> : <MemberManagement actorId={context.user!.userId} />}
    </Shell>;
}
