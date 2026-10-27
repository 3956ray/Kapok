import { getChatGPTUser, chatGPTSignInPath } from '../../chatgpt-auth';
import { EnvironmentNote, Shell } from '../../components/shell';
import { BootstrapScreen } from '../../components/legacy-screens';
export const dynamic = 'force-dynamic';
export default async function Bootstrap() {
    const user = await getChatGPTUser();
    return <Shell title="合成队伍初始化" nav={false} back="/">
        <EnvironmentNote />
        <section className="panel access-panel">
        <p className="muted">受限初始化仅供已配置的站点所有者使用。</p>
        {user ? <BootstrapScreen actorId={user.userId} /> : <a href={chatGPTSignInPath('/internal/bootstrap')} target="_top" className="button">所有者先登录</a>}
        </section>
    </Shell>;
}
