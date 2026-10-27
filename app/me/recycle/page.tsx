import { ReflectionRecycle } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, getPageContext } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function RecyclePage() {
    const context = await getPageContext();
    return <Shell title="回收站" back="/me/data">
        <EnvironmentNote />
        {!context.me?.profile || context.error ? <AccessState context={context} returnTo="/me/recycle" /> : <ReflectionRecycle actorId={context.user!.userId} />}
    </Shell>;
}
