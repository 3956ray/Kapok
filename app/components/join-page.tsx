import { redirect } from 'next/navigation';
import { authMode } from '../chatgpt-auth';
import { authDestination, authEntryPath } from '../../lib/server/auth-entry';
import { safeReturnTo } from '../../lib/server/domain';
import { AccessState, EnvironmentNote, getPageContext, isMember, Shell } from './shell';

export async function JoinPage({ target }: { target?: string }) {
  const context = await getPageContext();
  const returnTo = safeReturnTo(target);
  if (context.me && isMember(context.me)) redirect(authDestination(context.me, returnTo));
  if (authMode() === 'access' && !context.error && !context.me?.membership && context.me?.user?.status !== 'deleted') redirect(authEntryPath('register', returnTo));
  return <Shell title="完善队员资料" nav={false} back="/">
    <EnvironmentNote />
    <AccessState context={context} returnTo={returnTo} />
  </Shell>;
}
