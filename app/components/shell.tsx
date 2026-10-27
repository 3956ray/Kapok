import Link from 'next/link';
import { headers } from 'next/headers';
import { getChatGPTUser, chatGPTSignInPath } from '../chatgpt-auth';
import { getService } from '../../lib/server/runtime';
import type { Me } from '../../lib/contracts';
import { AccessLink, ControlledBack, Navigation } from './navigation';

export async function getPageContext() {
  const user = await getChatGPTUser();
  if (!user) return { user: null, me: null, error: null };
  try { return { user, me: await getService().me({ subject: user.userId }), error: null }; }
  catch { return { user, me: null, error: '暂时未能加载账号，请稍后刷新重试。' }; }
}
export async function EnvironmentNote() {
  const host = (await headers()).get('host') ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  return <p className="environment">{local ? '本地合成测试 · 非真实队员数据' : '所有者私有审阅环境 · 仅合成业务数据'}</p>;
}
export function Shell({ title, children, nav = true, back }: { title: string; children: React.ReactNode; nav?: boolean; back?: string }) {
  return <div className={nav ? 'app-shell with-nav' : 'app-shell'}><header className="topbar"><Link href="/" className="wordmark" aria-label="Kapok 首页">木棉<span>训练之后</span></Link></header><main id="main-content">{back && <ControlledBack fallback={back} />}<h1>{title}</h1>{children}</main>{nav && <Navigation />}</div>;
}
export function AccessState({ context, returnTo = '/' }: { context: Awaited<ReturnType<typeof getPageContext>>; returnTo?: string }) {
  if (context.error) return <section className="notice error" role="alert"><h2>暂时未能加载</h2><p>{context.error}</p><a href={returnTo} className="button secondary">重新加载</a></section>;
  if (!context.user) return <section className="panel access-panel"><h2>继续你的训练记录</h2><p>登录后确认邀请，建立属于自己的训练记录。</p><AccessLink href={chatGPTSignInPath(returnTo)} returnTo={returnTo} param="return_to" target="_top">使用 ChatGPT 登录</AccessLink></section>;
  if (context.me?.membership?.status === 'active' && returnTo.startsWith('/admin/') && context.me.membership.role !== 'admin') return <section className="notice error" role="alert"><h2>此页面仅管理员可访问</h2><Link href="/me" className="button secondary">返回我的</Link></section>;
  if (context.me?.user?.status === 'deleted' || (context.me?.membership && context.me.membership.status !== 'active')) return <section className="notice error" role="alert"><h2>当前账号没有队伍访问权限</h2><p>{context.me?.user?.status === 'deleted' ? '账号已停用。' : context.me?.membership?.status === 'paused' ? '成员资格已暂停，请联系管理员。' : '当前已退出队伍。'}</p><Link href="/me" className="button secondary">查看我的账号</Link></section>;
  return <section className="panel"><h2>尚未加入队伍</h2><p>请通过有效的合成邀请完成建档。登录不会自动成为队员或管理员。</p><AccessLink href={`/join?returnTo=${encodeURIComponent(returnTo)}`} returnTo={returnTo} param="returnTo">确认邀请并建档</AccessLink></section>;
}
export function isMember(me: Me | null) { return me?.user?.status === 'active' && me.membership?.status === 'active'; }
