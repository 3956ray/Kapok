import { WorkspaceEntry } from './components/workspace-entry';
import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from './components/shell';
export const dynamic = 'force-dynamic';

export default async function Page() {
    const context = await getPageContext();
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/trainings'} />;
    return <Shell surface="home" eyebrow="Kapok Bloom" title="训练的收获，值得留下。" description="回看场上的配合，记录自己的下一步。">
        <EnvironmentNote />
        <AccessState context={context} returnTo="/" />
    </Shell>;
}
