import { Shell, EnvironmentNote, getPageContext, AccessState } from '../components/shell';
import Link from 'next/link';
import { LocalDrafts } from '../components/reflections';
import { GrowthContent } from '../components/growth-content';
export const dynamic = 'force-dynamic';
export default async function Growth() {
    const context = await getPageContext();
    if (!context.user || context.me?.user?.status !== 'active')
        return <Shell title="成长">
            <AccessState context={context} returnTo="/growth" />
        </Shell>;
    return <Shell title="成长">
        <EnvironmentNote />
        <Link href="/reflections/new" className="button">写复盘</Link>
        <LocalDrafts key={context.user.userId} actorId={context.user.userId} />
        <GrowthContent key={context.user.userId} actorId={context.user.userId} />
    </Shell>;
}
