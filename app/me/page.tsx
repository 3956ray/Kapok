import { WorkspaceEntry } from '../components/workspace-entry';
import { Shell, EnvironmentNote, AccessState, getPageContext, canReadPersonal, isMember } from '../components/shell';
import { MyScreen } from '../components/legacy-screens';
import { chatGPTSignOutPath } from '../chatgpt-auth';
import { SignOut } from '../components/signout';
export const dynamic = 'force-dynamic';
export default async function Page() {
    const context = await getPageContext();
    if (context.user && isMember(context.me)) return <WorkspaceEntry actorId={context.user.userId} path={'/account'} />;
    return <Shell title="我的账户" surface="index" description="管理队内资料，查看自己的记录与创作。" canCompose={isMember(context.me)}>
        <div className="account-page">
            <EnvironmentNote />
            {context.user && canReadPersonal(context.user, context.me) ? <MyScreen actorId={context.user.userId} /> : <AccessState context={context} returnTo="/me" />}
            {context.user && <section className="account-session" aria-labelledby="account-session-title">
                <div>
                    <h2 id="account-session-title">登录会话</h2>
                    <p>退出会清理当前账号在这台设备上的未保存草稿。</p>
                    <p className="small">如需更换已绑定的邮箱，请联系管理员核实账号归属。</p>
                </div>
                <SignOut key={context.user.userId} actorId={context.user.userId} href={chatGPTSignOutPath('/')} />
            </section>}
        </div>
    </Shell>;
}
