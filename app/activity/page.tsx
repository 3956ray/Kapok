import { Shell, getPageContext, AccessState, isMember } from '../components/shell';
import { Activity } from '../components/community';
export const dynamic = 'force-dynamic';
export default async function ActivityPage() {
    const context = await getPageContext();
    return <Shell title="队内动态" back="/">
        {context.user && isMember(context.me) ? <Activity key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/activity" />}
    </Shell>;
}
