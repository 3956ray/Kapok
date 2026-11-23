import { WorkspaceEntry } from '../components/workspace-entry';
import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../components/shell';
import { TrainingsScreen } from '../components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/trainings'} />;
    return <Shell title="训练记录" surface="index" eyebrow="队内训练" description="按训练日期回看，一次训练可以有多段视频。" canCompose={isMember(context.me)}>
        <EnvironmentNote />
        {context.user && isMember(context.me) ? <TrainingsScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/trainings" />}
    </Shell>;
}
