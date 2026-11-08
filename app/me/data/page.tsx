import { PersonalData } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, canReadPersonal, getPageContext, isMember } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function PersonalDataPage() {
    const context = await getPageContext();
    return <Shell title="隐私与个人数据" back="/me" surface="index" eyebrow="账户设置" description="管理你保存在 Kapok 的个人记录。" canCompose={isMember(context.me)}>
        <EnvironmentNote />
        {context.user && context.me?.profile && canReadPersonal(context.user, context.me)
            ? <PersonalData key={context.user.userId} actorId={context.user.userId} />
            : <AccessState context={context} returnTo="/me/data" />}
    </Shell>;
}
