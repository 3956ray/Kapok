import { JoinPage } from '../components/join-page';
export const dynamic = 'force-dynamic';
export default async function Join({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) { return <JoinPage target={(await searchParams).returnTo} />; }
