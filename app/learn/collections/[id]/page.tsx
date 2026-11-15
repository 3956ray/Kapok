import { TopicPage } from '../../../components/topic-page';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    return <TopicPage view="read" id={(await params).id} />;
}
