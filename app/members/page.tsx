import { Shell, getPageContext, AccessState, isMember } from '../components/shell';
import { MemberDirectory } from '../components/community';
export const dynamic = 'force-dynamic';
export default async function Members() {
    const context = await getPageContext();
    return <Shell title="队伍成员" surface="index" eyebrow="一起上场的人" description="按盘名或背号，查找队友的队内档案。" back="/" canCompose={isMember(context.me)}>
        {context.user && isMember(context.me) ? <MemberDirectory key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/members" />}
    </Shell>;
}
