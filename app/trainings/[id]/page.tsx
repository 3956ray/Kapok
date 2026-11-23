import { WorkspaceEntry } from '../../components/workspace-entry';
import Link from 'next/link';
import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../../components/shell';
import { TrainingWatch } from '../../components/training-watch';
import { safeReturnTo } from '../../../lib/server/return-to';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
    const { id } = await params;
    const query = await searchParams;
    const memberView = query?.view === 'member' && Object.keys(query).every(key => key === 'view' || key === 'video');
    const requested = query?.video;
    const selectedVideoId = typeof requested === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requested) ? requested : undefined;
    const target = new URLSearchParams();
    if (memberView) target.set('view', 'member');
    if (selectedVideoId) target.set('video', selectedVideoId);
    const path = '/trainings/' + encodeURIComponent(id);
    const context = await getPageContext();
    const member = isMember(context.me);
    if (context.user && member && !memberView) return <WorkspaceEntry actorId={context.user.userId} path={path + (selectedVideoId ? '?video=' + selectedVideoId : '')} />;
    return <Shell title="训练观看" surface="video" back={memberView ? '/admin/trainings/' + encodeURIComponent(id) : '/trainings'} canCompose={member && !memberView}>
        {context.user && member ? memberView && context.me?.membership?.role !== 'admin' ?
            <section className="video-content notice error" role="alert">
                <h2>此页面仅管理员可访问</h2>
                <Link className="button secondary" href={path}>查看训练详情</Link>
            </section> : <TrainingWatch actorId={context.user.userId} trainingId={id} selectedVideoId={selectedVideoId} memberView={memberView} environmentNote={<EnvironmentNote />} /> : <div className="video-content video-access"><EnvironmentNote /><AccessState context={context} returnTo={safeReturnTo(path + (target.size ? '?' + target.toString() : ''))} /></div>}
    </Shell>;
}
