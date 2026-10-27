import { JoinPage } from '../../components/join-page';
export const dynamic = 'force-dynamic';
export default async function Join({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ returnTo?: string }> }) { return <JoinPage token={(await params).token} target={(await searchParams).returnTo} />; }
