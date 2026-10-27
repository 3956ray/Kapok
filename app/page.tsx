import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from './components/shell';
import { HomeScreen } from './components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="回来看看这次训练">
        <EnvironmentNote />
        {context.user && isMember(context.me) ? <HomeScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/" />}
    </Shell>;
}
