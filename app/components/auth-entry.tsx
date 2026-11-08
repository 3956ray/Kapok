import { authEntryPath, authStyles } from '../../lib/server/auth-entry';
import { AuthDraftActor } from './auth-draft-actor';

export function AuthLayout({ title, children, verifiedActorId }: { title: string; children: React.ReactNode; verifiedActorId?: string }) {
  return <div className="kapok-auth">
    {verifiedActorId && <AuthDraftActor actorId={verifiedActorId} />}
    <style>{authStyles}</style>
    <header className="kapok-auth-brand">
      {/* This is a document navigation to the standalone Worker entry. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="kapok-auth-wordmark">Kapok<span aria-hidden="true">•</span></a>
      <div className="kapok-auth-brand-copy"><p className="kapok-auth-label">Kapok Bloom</p><p className="kapok-auth-brand-title">每次上场，<br />都有新的可能。</p><p>属于一支队伍。<br />也属于每一个认真成长的你。</p></div>
      <div className="kapok-auth-court" aria-hidden="true" />
      <p className="kapok-auth-brand-foot">训练 · 连接 · 成长</p>
    </header>
    <main id="main-content" className="kapok-auth-main">
      <p className="kapok-auth-label">Kapok Bloom</p>
      <h1>{title}</h1>
      {children}
    </main>
  </div>;
}

export function NotRegistered({ returnTo }: { returnTo: string }) {
  return <>
    <p>邮箱验证已完成。选择注册后，可填写资料并加入 Kapok。</p>
    <a className="kapok-auth-primary" href={authEntryPath('register', returnTo)}>前往注册</a>
    <a className="kapok-auth-secondary" href={authEntryPath('login', returnTo)}>返回登录</a>
  </>;
}

export function RestrictedAccount({ returnTo }: { returnTo: string }) {
  return <>
    <p role="alert">此账号暂不可进入队伍。请联系队伍管理员核实成员资格。</p>
    <a className="kapok-auth-secondary" href={authEntryPath('login', returnTo)}>返回登录</a>
  </>;
}
