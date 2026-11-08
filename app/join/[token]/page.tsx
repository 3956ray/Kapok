import { redirect } from 'next/navigation';
import { authMode } from '../../chatgpt-auth';
import { authEntryPath } from '../../../lib/server/auth-entry';
import { safeReturnTo } from '../../../lib/server/domain';

export const dynamic = 'force-dynamic';
export default async function LegacyJoin({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  redirect(authMode() === 'access' ? authEntryPath('register', returnTo) : '/join?returnTo=' + encodeURIComponent(returnTo));
}
