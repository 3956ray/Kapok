import { AccessState, getPageContext, isMember, Shell } from '../../../components/shell';
import { TrainingAdminBar, TrainingManagement } from '../../../components/training-management';

export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const context = await getPageContext();
    const allowed = context.user && isMember(context.me) && context.me?.membership?.role === 'admin';
    return <div className={allowed ? 'training-admin-page' : undefined}>
        <Shell title="管理训练" surface="index" canCompose={isMember(context.me)}>
            {allowed && context.user ? <>
                <TrainingAdminBar title="管理训练" back="/admin/trainings" />
                <TrainingManagement actorId={context.user.userId} mode="detail" id={id} />
            </> : <AccessState context={context} returnTo={'/admin/trainings/' + encodeURIComponent(id)} />}
        </Shell>
    </div>;
}
