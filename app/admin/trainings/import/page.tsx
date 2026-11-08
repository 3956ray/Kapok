import { AccessState, getPageContext, isMember, Shell } from '../../../components/shell';
import { InitialVideosImport } from '../../../components/initial-videos-import';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    const allowed = context.user && isMember(context.me) && context.me?.membership?.role === 'admin';
    return <Shell title="首批视频导入" canCompose={isMember(context.me)}>
        {allowed && context.user ? <InitialVideosImport actorId={context.user.userId} /> : <AccessState context={context} returnTo="/admin/trainings/import" />}
    </Shell>;
}
