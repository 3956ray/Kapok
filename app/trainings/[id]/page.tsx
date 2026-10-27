import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../../components/shell';
import { TrainingScreen } from '../../components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const context = await getPageContext();
    return <Shell title="训练" back="/trainings">
        <EnvironmentNote />
        {context.user && isMember(context.me) ? <TrainingScreen actorId={context.user.userId} id={id} /> : <AccessState context={context} returnTo={'/trainings/' + id} />}
    </Shell>;
}
