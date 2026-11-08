import { Shell, EnvironmentNote, getPageContext, AccessState, isMember } from '../../components/shell';
import { safeReturnTo } from '../../../lib/server/domain';
import { VideoDiscussion } from '../../components/video-discussion';
export const dynamic = 'force-dynamic';
export default async function VideoPage({ params, searchParams }: {
    params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }>;
}) {
    const { id } = await params;
    const { t } = await searchParams;
    const context = await getPageContext();
    const returnTo = safeReturnTo('/videos/' + id + (t !== undefined ? '?t=' + encodeURIComponent(t) : ''));
    return <Shell title="视频与讨论" back="/trainings" surface="video" canCompose={isMember(context.me)}>
        {context.user && isMember(context.me) ? <VideoDiscussion actorId={context.user.userId} videoId={id} initialSeconds={t !== undefined ? /^\d+$/.test(t) ? Number(t) : Number.NaN : undefined} environmentNote={<EnvironmentNote />} /> : <div className="video-content video-access"><EnvironmentNote /><AccessState context={context} returnTo={returnTo} /></div>}
    </Shell>;
}
