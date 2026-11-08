import { redirect } from 'next/navigation';
import { authAccountState, authContinuationPath, authEntryPath } from '../../../lib/server/auth-entry';
import { safeReturnTo } from '../../../lib/server/return-to';
import { AuthLayout, RestrictedAccount } from '../../components/auth-entry';
import { JoinScreen } from '../../components/legacy-screens';
import { getPageContext } from '../../components/shell';
import { SignOut } from '../../components/signout';
import { chatGPTSignOutPath } from '../../chatgpt-auth';

export const dynamic = 'force-dynamic';

export default async function RegistrationProfile({ searchParams }: { searchParams: Promise<{ intent?: string; returnTo?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (params.intent !== 'register') redirect(authEntryPath('register', returnTo));
  const context = await getPageContext();
  if (context.user?.principal.provider !== 'access') redirect(authEntryPath('register', returnTo));
  if (context.error || !context.me) redirect(authContinuationPath('register', returnTo));
  const state = authAccountState(context.me);
  if (state === 'restricted') return <AuthLayout verifiedActorId={context.user.userId} title="账号暂不可用"><RestrictedAccount returnTo={returnTo} /></AuthLayout>;
  if (state === 'registered') redirect(authContinuationPath('register', returnTo));
  return <AuthLayout title="让队友认出你">
    <p>填写队友熟悉的盘名与背号，确认后加入 Kapok。</p>
    <JoinScreen actorId={context.user.userId} returnTo={returnTo} reverifyHref={authContinuationPath('register', returnTo)} />
    <SignOut actorId={context.user.userId} href={chatGPTSignOutPath()} switchEmail />
    <a className="kapok-auth-secondary" href={authEntryPath('register', returnTo)}>返回注册说明</a>
  </AuthLayout>;
}
