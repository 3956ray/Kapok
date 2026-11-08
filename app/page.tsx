import { Shell, EnvironmentNote, AccessState, getPageContext, isMember } from './components/shell';
import { HomeScreen } from './components/legacy-screens';
export const dynamic = 'force-dynamic';

function WorkspaceDate() {
    const now = new Date();
    const timeZone = 'Asia/Shanghai';
    const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [, month, day] = date.split('-');
    const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(now);
    const label = new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full' }).format(now);
    return <time className="workspace-date" dateTime={date} aria-label={label}>
        <span>{Number(month)}月</span><b>{day}</b><small>{weekday}</small>
    </time>;
}

export default async function Page() {
    const context = await getPageContext();
    const member = isMember(context.me);
    return <Shell surface="home" eyebrow="Kapok Bloom" title="训练的收获，值得留下。" description="回看场上的配合，记录自己的下一步。" headingAside={member && <WorkspaceDate />} canCompose={member}>
        <EnvironmentNote />
        {context.user && member ? <HomeScreen key={context.user.userId} actorId={context.user.userId} /> : <AccessState context={context} returnTo="/" />}
    </Shell>;
}
