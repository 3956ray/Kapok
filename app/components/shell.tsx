import Link from 'next/link';
import { headers } from 'next/headers';
import { UserRound } from 'lucide-react';
import { authMode, getChatGPTUser, chatGPTSignInPath } from '../chatgpt-auth';
import { getService } from '../../lib/server/runtime';
import type { Me } from '../../lib/contracts';
import { makersPreview, productionLoginPath } from '../../lib/server/makers-login';
import { authEntryPath } from '../../lib/server/auth-entry';
import { AuthDraftActor } from './auth-draft-actor';
import { AccessLink, ControlledBack, Navigation, WorkspaceSidebar } from './navigation';

export async function getPageContext() {
  const user = await getChatGPTUser();
  if (!user) return { user: null, me: null, error: null };
  try {
    const service = await getService();
    const me = await service.getAccount(user.principal);
    return { user, me, error: null };
  }
  catch { return { user, me: null, error: '暂时未能加载账号，请稍后刷新重试。' }; }
}
export async function EnvironmentNote() {
  if (authMode() === 'access') return <p className="environment">Kapok 队内空间</p>;
  const host = (await headers()).get('host') ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  return <p className="environment">{local ? '本地合成测试 · 非真实队员数据' : '所有者私有审阅环境 · 仅合成业务数据'}</p>;
}
export function Shell({ title, children, nav = true, back, surface, eyebrow, description, headingAside, canCompose = false }: {
  title: string;
  children: React.ReactNode;
  nav?: boolean;
  back?: string;
  surface?: 'home' | 'index' | 'detail' | 'video';
  eyebrow?: string;
  description?: string;
  headingAside?: React.ReactNode;
  canCompose?: boolean;
}) {
  const video = surface === 'video';
  return <div className={`app-shell${nav ? ' with-nav' : ''}${video ? ' video-workspace' : ''}`} data-surface={surface}>
    {nav && <WorkspaceSidebar canCompose={canCompose} />}
    <header className="topbar">
      <Link href={canCompose ? "/home" : "/"} prefetch={false} className="wordmark" aria-label="Kapok 首页">
        <strong>Kapok<span className="brand-dot" aria-hidden="true">.</span></strong>
        {nav && <span className="workspace-crumb" aria-hidden="true"> / 队伍工作区</span>}
      </Link>
      {video && <div className="video-topbar-heading">
        {back && <ControlledBack fallback={back} compact />}
        <h1>{title}</h1>
      </div>}
      {nav && <Link href="/me" className="topbar-account" aria-label="我的账号"><UserRound size={18} aria-hidden="true" /></Link>}
    </header>
    <main id="main-content" tabIndex={-1}>
      {!video && back && <ControlledBack fallback={back} />}
      {!video && <div className={headingAside ? 'shell-heading with-aside' : 'shell-heading'}>
        <div>
          {eyebrow && <p className="workspace-overline">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="shell-description">{description}</p>}
        </div>
        {headingAside}
      </div>}
      {children}
    </main>
    {nav && <Navigation canCompose={canCompose} />}
  </div>;
}
export function AccessState({ context, returnTo = '/' }: { context: Awaited<ReturnType<typeof getPageContext>>; returnTo?: string }) {
  const draftActor = context.user?.principal.provider === 'access' && <AuthDraftActor actorId={context.user.userId} />;
  if (context.error) return <section className="notice error" role="alert">{draftActor}<h2>暂时未能加载</h2><p>{context.error}</p><a href={returnTo} className="button secondary">重新加载</a></section>;
  if (!context.user) {
    const sites = authMode() === 'site';
    return <section className="panel access-panel"><h2>继续你的训练记录</h2><p>登录后即可继续。</p>
      {makersPreview ? <AccessLink href={productionLoginPath(returnTo)} returnTo={returnTo} param="returnTo" target="_top">前往正式站邮箱登录</AccessLink> :
      <AccessLink href={sites ? chatGPTSignInPath(returnTo) : authEntryPath('login', returnTo)} returnTo={returnTo} param={sites ? 'return_to' : 'returnTo'} target="_top">{sites ? '使用 ChatGPT 登录' : '使用邮箱登录'}</AccessLink>}
    </section>;
  }
  if (context.me?.membership?.status === 'active' && returnTo.startsWith('/admin/') && context.me.membership.role !== 'admin') return <section className="notice error" role="alert">{draftActor}<h2>此页面仅管理员可访问</h2><Link href="/me" className="button secondary">返回我的</Link></section>;
  if (context.me?.user?.status === 'deleted' || (context.me?.membership && context.me.membership.status !== 'active')) return <section className="notice error" role="alert">{draftActor}<h2>当前账号没有队伍访问权限</h2><p>{context.me?.user?.status === 'deleted' ? '账号已停用。' : context.me?.membership?.status === 'paused' ? '成员资格已暂停，请联系管理员。' : '当前已退出队伍。'}</p><Link href="/me" className="button secondary">查看我的账号</Link></section>;
  if (context.user.principal.provider === 'access') return <section className="panel access-panel">
    {draftActor}
    <h2>该邮箱尚未注册</h2>
    <p>邮箱验证已完成。选择注册后，可填写资料并加入 Kapok。</p>
    <AccessLink href={authEntryPath('register', returnTo)} returnTo={returnTo} param="returnTo" target="_top">前往注册</AccessLink>
    {' '}<AccessLink href={authEntryPath('login', returnTo)} returnTo={returnTo} param="returnTo" target="_top">返回登录</AccessLink>
  </section>;
  return <section className="panel"><h2>当前账号没有队伍访问权限</h2><p>请使用已有队员账号登录。</p></section>;
}
export function isMember(me: Me | null) { return me?.user?.status === 'active' && me.membership?.status === 'active'; }

export function canReadPersonal(user: Awaited<ReturnType<typeof getChatGPTUser>>, me: Me | null) {
  return me?.user?.status === 'active' && (user?.principal.provider === 'site' || isMember(me));
}
