import { Shell, getPageContext, AccessState } from '../../../components/shell';
import { ReflectionEditor } from '../../../components/reflections';
import { getService } from '../../../../lib/server/runtime';
export const dynamic = 'force-dynamic';
export default async function EditReflection({
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
    if (!context.user || context.me?.user?.status !== 'active') return <Shell title="编辑复盘" nav={false} back="/growth">
        <AccessState context={context} returnTo={`/reflections/${id}/edit`} />
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
    return <Shell title="编辑复盘" nav={false} back={`/reflections/${id}`}>
        <ReflectionEditor key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} />
    </Shell>;
}
