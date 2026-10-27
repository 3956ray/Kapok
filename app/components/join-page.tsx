import { getChatGPTUser, chatGPTSignInPath } from '../chatgpt-auth';
import { safeReturnTo } from '../../lib/server/domain';
import { EnvironmentNote, Shell } from './shell';
import { JoinScreen } from './legacy-screens';
export async function JoinPage({ token = '', target }: { token?: string; target?: string }) {
  const user = await getChatGPTUser();
  const returnTo = safeReturnTo(target);
  const loginReturn = `/join${token ? `/${encodeURIComponent(token)}` : ''}?returnTo=${encodeURIComponent(returnTo)}`;
  return <Shell title="加入队伍" nav={false} back="/"><EnvironmentNote /><section className="panel access-panel"><p>填写队友熟悉的盘名与背号。默认头像由盘名生成，确认加入后才能访问队内内容。</p>{user ? <JoinScreen actorId={user.userId} token={token} returnTo={returnTo} /> : <a className="button" href={chatGPTSignInPath(loginReturn)} target="_top">先登录，再确认邀请</a>}</section></Shell>;
}
