import { WorkspaceEntry } from '../components/workspace-entry';
import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../components/shell';
import Link from 'next/link';
import { ReflectionIcon } from '../components/reflection-icon';
import { LocalDrafts } from '../components/reflections';
import { GrowthContent } from '../components/growth-content';
export const dynamic = 'force-dynamic';
export default async function Growth({ searchParams }: { searchParams?: Promise<{ filter?: string }> } = {}) {
    const filter = (await searchParams)?.filter;
    const initialFilter = filter === 'reflections' ? 'reflections' : filter === 'bookmarks' ? 'collections' : 'all';
    const context = await getPageContext();
    if (!context.user || !canReadPersonal(context.user, context.me))
        return <Shell title="成长记录" surface="index">
            <AccessState context={context} returnTo="/growth" />
        </Shell>;
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/growth' + (initialFilter === 'all' ? '' : '?filter=' + filter)} />;
    const write = <Link href="/reflections/new" className="button secondary growth-compose" aria-label="想和写" title="想和写"><ReflectionIcon size={18} aria-hidden="true" /><span>想和写</span></Link>;
    return <Shell title="成长记录" surface="index" description="回看复盘、收藏和私人备注。" headingAside={write} canCompose={isMember(context.me)}>
        <LocalDrafts key={context.user.userId} actorId={context.user.userId} />
        <GrowthContent key={context.user.userId + initialFilter} actorId={context.user.userId} initialFilter={initialFilter} />
    </Shell>;
}
