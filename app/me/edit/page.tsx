import { Shell, AccessState, getPageContext } from '../../components/shell';
import { ProfileEditor } from '../../components/profile-editor';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="编辑资料" back="/me" nav={false}>
        {context.user && context.me?.user?.status === 'active' ? <ProfileEditor actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me/edit" />}
    </Shell>;
}
