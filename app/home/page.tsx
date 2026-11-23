import { WorkspaceEntry } from '../components/workspace-entry';
import { AccessState, getPageContext, isMember } from '../components/shell';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const context = await getPageContext();
  if (!context.user || !isMember(context.me)) return <main><AccessState context={context} returnTo="/home"/></main>;
  return <WorkspaceEntry actorId={context.user.userId}/>;
}
