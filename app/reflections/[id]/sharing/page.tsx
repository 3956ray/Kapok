import { WorkspaceEntry } from '../../../components/workspace-entry';
import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../../../components/shell';
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
    if (!context.user || !canReadPersonal(context.user, context.me)) return <Shell title="分享与发布" nav={false} back="/growth">
        <AccessState context={context} returnTo={`/reflections/${id}/sharing`} />
    </Shell>;
    try {
        await getService().getOwnReflection(context.user.principal, id);
    } catch {
        return <Shell title="此内容暂不可用" nav={false} back="/growth">
            <p>请确认账号或返回成长。</p>
        </Shell>;
    }
    if (isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/notes/' + encodeURIComponent(id) + '/sharing'} />;
    return <Shell title="分享与发布" back={`/reflections/${id}`} canCompose={isMember(context.me)}>
        <ReflectionSharing key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} />
    </Shell>;
}
