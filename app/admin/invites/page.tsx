import { JoinPage } from '../../components/join-page';

export const dynamic = 'force-dynamic';
export default async function LegacyInvites({ searchParams }: { searchParams?: Promise<{ returnTo?: string }> }) {
  return <JoinPage target={(await searchParams)?.returnTo ?? '/me'} />;
}
