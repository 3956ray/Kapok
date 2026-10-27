import { getChatGPTUser } from '../../../chatgpt-auth';
import { dispatchApi, privateHeaders } from '../../../../lib/server/http';
import { getService } from '../../../../lib/server/runtime';

export const dynamic = 'force-dynamic';
async function handler(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: { code: 'UNAUTHENTICATED', message: '请先登录。', retryable: false }, requestId: crypto.randomUUID() }, { status: 401, headers: privateHeaders });
  try {
    return await dispatchApi(request, (await context.params).path, { subject: user.userId }, getService());
  } catch {
    return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: '暂时未能连接服务，请稍后重试。', retryable: true }, requestId: crypto.randomUUID() }, { status: 503, headers: privateHeaders });
  }
}
export const GET = handler;
export const POST = handler;
export const PATCH = handler;

export const PUT = handler;

export const DELETE = handler;
