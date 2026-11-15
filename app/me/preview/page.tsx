import { AccountPreview } from '../../components/account-preview';
import { AccessState, getPageContext, isMember, Shell } from '../../components/shell';

export const dynamic = 'force-dynamic';

export default async function Page() {
    const context = await getPageContext();
    const member = isMember(context.me);
    return <Shell title="个人资料预览" back="/me" surface="index" description="查看队友在队内档案中看到的个人资料。" canCompose={member}>
        {context.user && member ? <AccountPreview actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me/preview" />}
    </Shell>;
}
