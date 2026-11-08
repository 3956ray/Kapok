import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../../components/shell';
import { ReflectionRead } from '../../components/reflections';
export const dynamic = 'force-dynamic';
export default async function ReflectionPage({
    params,
    searchParams
}: {
    params: Promise<{
        id: string;
    }>;
    searchParams: Promise<{
        saved?: string;
    }>;
}) {
    const context = await getPageContext();
    const {
        id
    } = await params;
    const {
        saved
    } = await searchParams;
    return <Shell title="复盘阅读" back="/growth" canCompose={isMember(context.me)}>
        {context.user && canReadPersonal(context.user, context.me) ? <ReflectionRead
            key={context.user.userId + ':' + id}
            actorId={context.user.userId}
            id={id}
            saved={saved === '1'}
        /> : <AccessState context={context} returnTo={`/reflections/${id}`} />}
    </Shell>;
}
