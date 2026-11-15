import { LearningPage } from '../../../components/learning-page';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    return <LearningPage view="read" id={(await params).id} />;
}
