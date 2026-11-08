import { AccessState, getPageContext, isMember, Shell } from '../../../../components/shell';
import { TrainingAdminBar, TrainingManagement } from '../../../../components/training-management';

export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const path = '/admin/trainings/' + encodeURIComponent(id);
    const context = await getPageContext();
    const allowed = context.user && isMember(context.me) && context.me?.membership?.role === 'admin';
    return <div className={allowed ? 'training-admin-page' : undefined}>
        <Shell title="编辑训练" surface="index" canCompose={isMember(context.me)}>
            {allowed && context.user ? <>
                <TrainingAdminBar title="编辑训练" back={path} />
                <TrainingManagement actorId={context.user.userId} mode="edit" id={id} />
            </> : <AccessState context={context} returnTo={path + '/edit'} />}
        </Shell>
    </div>;
}
