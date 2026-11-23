import { AccessState, getPageContext, isMember, Shell } from '../../../components/shell';
import { TrainingAdminBar, TrainingManagement } from '../../../components/training-management';

export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    const allowed = context.user && isMember(context.me) && context.me?.membership?.role === 'admin';
    return <div className={allowed ? 'training-admin-page' : undefined}>
        <Shell title="新建" surface="index" canCompose={isMember(context.me)}>
            {allowed && context.user ? <>
                <TrainingAdminBar title="新建" back="/admin/trainings" />
                <TrainingManagement actorId={context.user.userId} mode="new" />
            </> : <AccessState context={context} returnTo="/admin/trainings/new" />}
        </Shell>
    </div>;
}
