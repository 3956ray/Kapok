import { ReflectionRecycle } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, canReadPersonal, getPageContext, isMember } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function RecyclePage() {
    const context = await getPageContext();
    return <Shell title="复盘回收站" back="/me/data" surface="index" eyebrow="隐私与个人数据" canCompose={isMember(context.me)}>
        <EnvironmentNote />
        {context.user && context.me?.profile && canReadPersonal(context.user, context.me)
            ? <ReflectionRecycle key={context.user.userId} actorId={context.user.userId} />
            : <AccessState context={context} returnTo="/me/recycle" />}
    </Shell>;
}
