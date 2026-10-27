import { Shell, EnvironmentNote, AccessState, getPageContext } from '../components/shell';
import { MyScreen } from '../components/legacy-screens';
import { chatGPTSignOutPath } from '../chatgpt-auth';
import { SignOut } from '../components/signout';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="我的">
        <EnvironmentNote />
        {context.user && context.me?.user?.status === 'active' ? <MyScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me" />}
        {context.user && <SignOut actorId={context.user.userId} href={chatGPTSignOutPath('/')} />}
    </Shell>;
}
