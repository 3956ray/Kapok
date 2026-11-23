import Workspace from '../workspace-ui/main';
import { chatGPTSignOutPath } from '../chatgpt-auth';

export function WorkspaceEntry({ actorId, path = '/trainings' }: { actorId: string; path?: string }) {
  return <Workspace key={actorId} actorId={actorId} initialPath={path} logoutHref={chatGPTSignOutPath('/')} />;
}
