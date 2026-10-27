import { AccessState, EnvironmentNote, Shell, getPageContext, isMember } from './shell';
export async function PendingPage({ title, text, path, back }: { title: string; text: string; path: string; back?: string }) {
  const context = await getPageContext();
  return <Shell title={title} back={back}><EnvironmentNote />{!isMember(context.me) ? <AccessState context={context} returnTo={path} /> : <section className="panel"><h2>功能待接入</h2><p>{text}</p><p className="muted">当前页面未读取此类业务数据。</p></section>}</Shell>;
}
