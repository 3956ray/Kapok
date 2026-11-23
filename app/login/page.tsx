import { redirect } from 'next/navigation';
import { authMode, chatGPTSignInPath } from '../chatgpt-auth';
import { authContinuationPath } from '../../lib/server/auth-entry';
import { safeReturnTo } from '../../lib/server/domain';
import { AuthLayout } from '../components/auth-entry';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  if (authMode() === 'access') redirect(authContinuationPath('login', returnTo));
  return <AuthLayout title="登录工作区">
    <p>使用 ChatGPT 登录，继续访问你的队伍和训练记录。</p>
    <a href={chatGPTSignInPath(returnTo)} target="_top" className="kapok-auth-primary">使用 ChatGPT 登录 →</a>
  </AuthLayout>;
}
