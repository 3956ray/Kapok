import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../components/shell';
import { TrainingsScreen } from '../components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="训练">
        <EnvironmentNote />
        {context.user && isMember(context.me) ? <TrainingsScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/trainings" />}
    </Shell>;
}
