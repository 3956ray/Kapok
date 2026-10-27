import { chatGPTSignInPath } from '../chatgpt-auth';
import { safeReturnTo } from '../../lib/server/domain';
import { EnvironmentNote, Shell } from '../components/shell';
export const dynamic = 'force-dynamic';
export default async function Login({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) { const returnTo = safeReturnTo((await searchParams).returnTo); return <Shell title="欢迎回到木棉" nav={false} back="/"><EnvironmentNote /><section className="panel access-panel"><h2>继续你的训练记录</h2><p>使用 ChatGPT 登录后，继续访问有权限的队伍内容。</p><a href={chatGPTSignInPath(returnTo)} target="_top" className="button">使用 ChatGPT 登录</a></section></Shell>; }
