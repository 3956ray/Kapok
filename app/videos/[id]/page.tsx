import { Shell, EnvironmentNote, getPageContext, AccessState, isMember } from '../../components/shell';
import { safeReturnTo } from '../../../lib/server/domain';
import { TrainingWatch } from '../../components/training-watch';
export const dynamic = 'force-dynamic';
export default async function VideoPage({ params, searchParams }: {
    params: Promise<{ id: string }>; searchParams: Promise<{ t?: string | string[] }>;
}) {
    const { id } = await params;
    const { t } = await searchParams;
    const context = await getPageContext();
    const returnTo = safeReturnTo('/videos/' + encodeURIComponent(id) + (typeof t === 'string' && /^\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? '?t=' + encodeURIComponent(t) : ''));
    return <Shell title="训练观看" back="/trainings" surface="video" canCompose={isMember(context.me)}>
        {context.user && isMember(context.me) ? <TrainingWatch actorId={context.user.userId} legacyVideoId={id} initialSeconds={t !== undefined ? typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : Number.NaN : undefined} environmentNote={<EnvironmentNote />} /> : <div className="video-content video-access"><EnvironmentNote /><AccessState context={context} returnTo={returnTo} /></div>}
    </Shell>;
}
