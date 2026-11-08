import { Shell, EnvironmentNote, getPageContext, AccessState, canReadPersonal, isMember } from '../components/shell';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { LocalDrafts } from '../components/reflections';
import { GrowthContent } from '../components/growth-content';
export const dynamic = 'force-dynamic';
export default async function Growth() {
    const context = await getPageContext();
    if (!context.user || !canReadPersonal(context.user, context.me))
        return <Shell title="成长记录" surface="index">
            <AccessState context={context} returnTo="/growth" />
        </Shell>;
    const write = <Link href="/reflections/new" className="growth-write" aria-label="写复盘" title="写复盘"><Plus size={19} aria-hidden="true" /></Link>;
    return <Shell title="成长记录" surface="index" eyebrow="只属于你的积累" description="回看自己的复盘、收藏和私人备注。" headingAside={write} canCompose={isMember(context.me)}>
        <EnvironmentNote />
        <LocalDrafts key={context.user.userId} actorId={context.user.userId} />
        <GrowthContent key={context.user.userId} actorId={context.user.userId} />
    </Shell>;
}
