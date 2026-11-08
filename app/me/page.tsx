import { Shell, EnvironmentNote, AccessState, getPageContext, canReadPersonal, isMember } from '../components/shell';
import { MyScreen } from '../components/legacy-screens';
import { chatGPTSignOutPath } from '../chatgpt-auth';
import { SignOut } from '../components/signout';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    return <Shell title="我的账户" surface="index" eyebrow="Kapok Bloom" description="查看队内资料，管理你的个人记录和登录会话。" canCompose={isMember(context.me)}>
        <EnvironmentNote />
        {context.user && canReadPersonal(context.user, context.me) ? <MyScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me" />}
        {context.user && <section className="panel account-session">
            <h2>登录会话</h2>
            <p>退出会清理当前账号在这台设备上的未保存草稿。</p>
            <SignOut key={context.user.userId} actorId={context.user.userId} href={chatGPTSignOutPath('/')} />
            <p className="small">如需更换已绑定的邮箱，请联系管理员核实账号归属。</p>
        </section>}
    </Shell>;
}
