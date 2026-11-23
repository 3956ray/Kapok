import { makersPreview, productionLoginPath } from '../../lib/server/makers-login';

export function GET(request: Request) {
  if (!makersPreview) return new Response(null, { status: 404 });
  const returnTo = new URL(request.url).searchParams.get('return_to');
  return Response.redirect(productionLoginPath(returnTo), 302);
}
