import { Shell, getPageContext, AccessState } from '../../../components/shell';
import { ReflectionSharing } from '../../../components/reflections';
import { getService } from '../../../../lib/server/runtime';
export const dynamic = 'force-dynamic';
export default async function SharingPage({
    params
}: {
    params: Promise<{
        id: string;
    }>;
}) {
    const context = await getPageContext();
    const {
        id
    } = await params;
    if (!context.user || context.me?.user?.status !== 'active') return <Shell title="阅读范围" nav={false} back="/growth">
        <AccessState context={context} returnTo={`/reflections/${id}/sharing`} />
    </Shell>;
    try {
        await getService().getOwnReflection({
            subject: context.user.userId
        }, id);
    } catch {
        return <Shell title="此内容暂不可用" nav={false} back="/growth">
            <p>请确认账号或返回成长。</p>
        </Shell>;
    }
    return <Shell title="阅读范围与动态" nav={false} back={`/reflections/${id}`}>
        <ReflectionSharing key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} />
    </Shell>;
}
