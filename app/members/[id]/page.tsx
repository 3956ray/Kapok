import { Shell, getPageContext, AccessState, isMember } from '../../components/shell';
import { MemberDirectory } from '../../components/community';
export const dynamic = 'force-dynamic';
export default async function MemberProfile({
    params
}: {
    params: Promise<{
        id: string;
    }>;
}) {
    const context = await getPageContext();
    const {
        id
    } = await params;
    return <Shell title="队友档案" back="/members">
        {context.user && isMember(context.me) ? <MemberDirectory key={context.user.userId + ':' + id} actorId={context.user.userId} id={id} /> : <AccessState context={context} returnTo={`/members/${id}`} />}
    </Shell>;
}
