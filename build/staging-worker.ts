import handler from "vinext/server/fetch-handler";
import { verifyAccessPrincipal } from "../lib/server/access-identity";
import { authEntryPath, isFrameworkRequest, publicAuthEntry, publicReturnTo, rootCredentialRequest } from "../lib/server/auth-entry";
import { runWithAccessIdentity } from "../lib/server/request-identity";

const cacheControl = "private, no-store";
const denied = (request: Request) => new Response(request.method === "HEAD" ? null : "Forbidden", {
  status: 403, headers: { "Cache-Control": cacheControl },
});

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.host !== env.ACCESS_ALLOWED_HOST) return denied(request);

    const documentMethod = request.method === "GET" || request.method === "HEAD";
    if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/register") {
      if (!documentMethod) return denied(request);
      if (url.pathname === "/") {
        const candidate = rootCredentialRequest(request);
        if (candidate && await verifyAccessPrincipal(candidate, env)) {
          // The public root cannot check Access session revocations. Only the
          // protected homepage consumes identity and renders the application.
          return new Response(null, { status: 307, headers: { Location: "/home", "Cache-Control": cacheControl, Vary: "Cookie, Cf-Access-Jwt-Assertion" } });
        }
      }
      if (isFrameworkRequest(request, url)) return denied(request);
      if (url.pathname === "/") {
        return new Response(null, { status: 302, headers: {
          Location: authEntryPath("login", publicReturnTo(url)),
          "Cache-Control": cacheControl,
          Vary: "Cookie, Cf-Access-Jwt-Assertion",
        } });
      }
      return publicAuthEntry(request, url, url.pathname === "/login" ? "login" : "register");
    }

    const principal = await verifyAccessPrincipal(request, env);
    if (!principal) return denied(request);

    // Vinext resolves public files itself. Its Worker handler treats unmatched
    // build chunks as missing, so serve that reserved asset prefix after auth.
    const buildAsset = url.pathname.startsWith("/_next/static/");
    const response = buildAsset && env.ASSETS
      ? await env.ASSETS.fetch(request)
      : await runWithAccessIdentity(principal, () => handler.fetch(request, env, ctx));
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", cacheControl);
    return result;
  },
};
