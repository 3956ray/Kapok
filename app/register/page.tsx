import { redirect } from 'next/navigation';
import { authMode } from '../chatgpt-auth';
import { authContinuationPath } from '../../lib/server/auth-entry';
import { safeReturnTo } from '../../lib/server/return-to';
import { AuthLayout } from '../components/auth-entry';

export const dynamic = 'force-dynamic';

// The standalone Worker supplies the public document before Vinext. Keep the
// separate Sites renderer closed to verified-email self-enrollment.
export default async function Register({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  if (authMode() === 'access') redirect(authContinuationPath('register', returnTo));
  return <AuthLayout register title="当前入口暂不提供注册">
    <p>请使用已有队员账号登录。</p>
    <a className="kapok-auth-primary" href={'/login?returnTo=' + encodeURIComponent(returnTo)}>前往登录</a>
  </AuthLayout>;
}
