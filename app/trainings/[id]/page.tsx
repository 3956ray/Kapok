import Link from 'next/link';
import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from '../../components/shell';
import { TrainingScreen } from '../../components/legacy-screens';

export const dynamic = 'force-dynamic';
export default async function Page({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
    const { id } = await params;
    const query = await searchParams;
    const memberView = query?.view === 'member' && Object.keys(query).length === 1;
    const path = '/trainings/' + encodeURIComponent(id);
    const context = await getPageContext();
    const member = isMember(context.me);
    return <Shell title="训练详情" surface="detail" back={memberView ? undefined : '/trainings'} canCompose={member && !memberView}>
        <EnvironmentNote />
        {context.user && member ? memberView && context.me?.membership?.role !== 'admin' ?
            <section className="notice error" role="alert">
                <h2>此页面仅管理员可访问</h2>
                <Link className="button secondary" href={path}>查看训练详情</Link>
            </section> : <>
                {memberView && <Link className="back-link" href={'/admin/trainings/' + encodeURIComponent(id)}>返回训练管理</Link>}
                <TrainingScreen actorId={context.user.userId} id={id} memberView={memberView} />
            </> : <AccessState context={context} returnTo={path + (memberView ? '?view=member' : '')} />}
    </Shell>;
}
