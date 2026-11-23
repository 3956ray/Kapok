import { TopicPage } from '../../../components/topic-page';
import { getPageContext, isMember } from '../../../components/shell';
import { WorkspaceEntry } from '../../../components/workspace-entry';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    if (context.user && isMember(context.me) && context.me?.membership?.role === 'admin')
        return <WorkspaceEntry actorId={context.user.userId} path="/account/manage/featured"/>;
    return <TopicPage view="featured" />;
}
