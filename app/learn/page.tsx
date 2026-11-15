import { LearningPage } from '../components/learning-page';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
    const { tab } = await searchParams;
    return <LearningPage view="index" tab={tab === 'contents' || tab === 'collections' ? tab : undefined} />;
}
