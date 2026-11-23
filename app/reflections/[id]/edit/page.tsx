import { WorkspaceEntry } from '../../../components/workspace-entry';
import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../../../components/shell';
import { ReflectionEditor } from '../../../components/reflections';
import { getService } from '../../../../lib/server/runtime';
export const dynamic = 'force-dynamic';
export default async function EditReflection({
    params, searchParams
}: {
    searchParams?: Promise<{ resumeDraft?: string }>;
    params: Promise<{
        id: string;
    }>;
}) {
    const context = await getPageContext();
    const {
        id
    } = await params;
    const resume = (await searchParams)?.resumeDraft === '1';
    if (!context.user || !canReadPersonal(context.user, context.me)) return <Shell title="编辑复盘" nav={false} back="/growth">
        <AccessState context={context} returnTo={`/reflections/${id}/edit${resume ? "?resumeDraft=1" : ""}`} />
    </Shell>;
    if (context.user && isMember(context.me) && !resume) return <WorkspaceEntry actorId={context.user.userId} path={'/notes/' + encodeURIComponent(id) + '/edit'} />;
    try {
        await getService().getOwnReflection(context.user.principal, id);
    } catch {
        return <Shell title="此内容暂不可用" nav={false} back="/growth">
            <p>请确认账号或返回成长。</p>
        </Shell>;
    }
    return <Shell title="编辑复盘" back={`/reflections/${id}`} canCompose={isMember(context.me)}>
        <ReflectionEditor key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} />
    </Shell>;
}
