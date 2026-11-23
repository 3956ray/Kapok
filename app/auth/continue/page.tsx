import { redirect } from 'next/navigation';
import { authAccountState, authContinuationPath, authDestination, authEntryPath } from '../../../lib/server/auth-entry';
import { safeReturnTo } from '../../../lib/server/return-to';
import { AuthLayout, NotRegistered, RestrictedAccount } from '../../components/auth-entry';
import { chatGPTSignOutPath } from '../../chatgpt-auth';
import { SignOut } from '../../components/signout';
import { getPageContext } from '../../components/shell';

export const dynamic = 'force-dynamic';

export default async function Continue({ searchParams }: { searchParams: Promise<{ intent?: string; returnTo?: string; prefill?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (params.intent !== 'register' && params.intent !== 'login') redirect(authEntryPath('login', returnTo));
  const intent = params.intent;
  const context = await getPageContext();
  if (context.user?.principal.provider !== 'access') redirect(authEntryPath(intent, returnTo));
  if (context.error || !context.me) return <AuthLayout register={intent === 'register'} verifiedActorId={context.user.userId} title="暂时无法确认账号">
    <p role="alert">暂时未能加载账号，请稍后重试。</p>
    <a className="kapok-auth-primary" href={authContinuationPath(intent, returnTo)}>重新确认</a>
    <a className="kapok-auth-secondary" href={authEntryPath(intent, returnTo)}>返回入口</a>
  </AuthLayout>;
  const switchEmail = <SignOut actorId={context.user.userId} href={chatGPTSignOutPath()} switchEmail />;
  const state = authAccountState(context.me);
  if (state === 'restricted') return <AuthLayout register={intent === 'register'} verifiedActorId={context.user.userId} title="账号暂不可用"><RestrictedAccount returnTo={returnTo} />{switchEmail}</AuthLayout>;
  if (state === 'registered') {
    const destination = authDestination(context.me, returnTo);
    if (intent === 'login') redirect(destination === '/' ? '/home' : destination);
    return <AuthLayout register verifiedActorId={context.user.userId} title="你已经是 Kapok 成员">
      <p>你可以使用当前资料直接进入应用。</p>
      <a className="kapok-auth-primary" href={destination === '/' ? '/home' : destination}>进入应用 →</a>
      {switchEmail}
    </AuthLayout>;
  }
  if (intent === 'register') {
    const handoff = typeof params.prefill === 'string' && /^[a-f0-9]{32}$/.test(params.prefill) ? `&prefill=${params.prefill}` : '';
    redirect(authContinuationPath('register', returnTo, true) + handoff);
  }
  return <AuthLayout verifiedActorId={context.user.userId} title="该邮箱尚未注册"><NotRegistered returnTo={returnTo} />{switchEmail}</AuthLayout>;
}
