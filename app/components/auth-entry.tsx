import { authEntryPath, authStyles, authMast, authCover } from '../../lib/server/auth-entry';
import { AuthDraftActor } from './auth-draft-actor';

export function AuthLayout({ title, children, verifiedActorId, register = false }: { title: string; children: React.ReactNode; verifiedActorId?: string; register?: boolean }) {
  return <div className="kapok-auth">
    {verifiedActorId && <AuthDraftActor actorId={verifiedActorId} />}
    <style>{authStyles(false)}</style>
    <div dangerouslySetInnerHTML={{ __html: authMast }} />
    <main id="main-content" tabIndex={-1} className="access-spread">
      <section className="access-form-panel" aria-labelledby="access-title"><div className="access-entry">
        <h1 id="access-title">{title}</h1>
        {children}
      </div></section>
      <div style={{display:'contents'}} dangerouslySetInnerHTML={{ __html: authCover(register, false) }} />
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
