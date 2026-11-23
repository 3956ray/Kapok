import { AccessState, getPageContext, isMember } from '../../../components/shell';
import { WorkspaceEntry } from '../../../components/workspace-entry';

export const dynamic = 'force-dynamic';

export default async function SharedEdition({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getPageContext();
  const encoded = encodeURIComponent(id);
  if (!context.user || !isMember(context.me)) {
    return <main><AccessState context={context} returnTo={'/learn/shares/' + encoded} /></main>;
  }
  return <WorkspaceEntry actorId={context.user.userId} path={'/shared/' + encoded} />;
}
