// Only compiler-emitted, content-fingerprinted program files. Public files,
// manifests, source maps, RSC, HTML and private media are intentionally excluded.
export function programCacheControl(request: Request, response: Response, allowed: ReadonlySet<string>): string {
  const url = new URL(request.url);
  const js = /^\/_next\/static\/chunks\/[\w-]+-[\w-]{8}\.js$/.test(url.pathname);
  const css = /^\/_next\/static\/css\/[\w-]+\.[\w-]{8}\.css$/.test(url.pathname);
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (allowed.has(url.pathname) && request.method === 'GET' && !url.search && response.status === 200 &&
      !request.headers.has('Range') && !request.headers.has('RSC') &&
      !response.headers.has('Set-Cookie') &&
      ((js && (mime === 'text/javascript' || mime === 'application/javascript')) || (css && mime === 'text/css'))) {
    // Browser-only reuse of identical program bytes, never shared CDN caching.
    // New requests still pass Access before the asset binding is consulted.
    return 'private, max-age=31536000, immutable';
  }
  return 'private, no-store';
}
