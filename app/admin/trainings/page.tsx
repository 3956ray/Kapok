import { AccessState, getPageContext, isMember, Shell } from '../../components/shell';
import { TrainingAdminBar, TrainingManagement } from '../../components/training-management';

export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    const allowed = context.user && isMember(context.me) && context.me?.membership?.role === 'admin';
    return <div className={allowed ? 'training-admin-page' : undefined}>
        <Shell title="训练管理" surface="index" canCompose={isMember(context.me)}>
            {allowed && context.user ? <>
                <TrainingAdminBar title="管理训练" back="/trainings" />
                <TrainingManagement actorId={context.user.userId} mode="list" />
            </> : <AccessState context={context} returnTo="/admin/trainings" />}
        </Shell>
    </div>;
}
