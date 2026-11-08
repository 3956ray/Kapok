import { Shell, AccessState, getPageContext, canReadPersonal } from '../../components/shell';
import { ProfileEditor } from '../../components/profile-editor';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="编辑资料" back="/me" nav={false} eyebrow="我的队内档案" description="盘名和背号会显示在队伍成员列表。">
        {context.user && canReadPersonal(context.user, context.me) ? <ProfileEditor actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me/edit" />}
    </Shell>;
}
