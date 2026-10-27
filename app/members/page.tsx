import { Shell, getPageContext, AccessState, isMember } from '../components/shell';
import { MemberDirectory } from '../components/community';
export const dynamic = 'force-dynamic';
export default async function Members() {
    const context = await getPageContext();
    return <Shell title="队伍成员" back="/">
        {context.user && isMember(context.me) ? <MemberDirectory key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/members" />}
    </Shell>;
}
