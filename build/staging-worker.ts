import { cleanupReflectionImages } from "../lib/server/reflection-image-cleanup";
import handler from "vinext/server/fetch-handler";
import { verifyAccessPrincipal } from "../lib/server/access-identity";
import { authArtPath, authEntryPath, isFrameworkRequest, publicAuthEntry, publicReturnTo, rootCredentialRequest } from "../lib/server/auth-entry";
import { runWithAccessIdentity } from "../lib/server/request-identity";
import { programAssets } from "virtual:kapok-program-assets";
import { programCacheControl } from "./program-cache";

const cacheControl = "private, no-store";
const denied = (request: Request) => new Response(request.method === "HEAD" ? null : "Forbidden", {
  status: 403, headers: { "Cache-Control": cacheControl },
});

export default {
  async scheduled(event: ScheduledController, env: Cloudflare.Env) {
    if (event.cron === "*/15 * * * *") {
      if (!env.DB || !env.BUCKET) throw new Error("Reflection image cleanup requires DB and BUCKET");
      await cleanupReflectionImages(env.DB, env.BUCKET, new Date(event.scheduledTime));
    }
  },
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
      const art = authArtPath(url.pathname, url.search);
      if (art) {
        if (!env.ASSETS) return denied(request);
        const file = await env.ASSETS.fetch(new Request(new URL(art, url.origin), { method: request.method }));
        const mime = art.endsWith(".webp") ? "image/webp" : "font/woff2";
        if (file.status !== 200 || file.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== mime) return denied(request);
        return new Response(file.body, {headers: {
          "Content-Type": mime, "Cache-Control":"public, max-age=3600", "X-Content-Type-Options":"nosniff",
        }});
      }
      return publicAuthEntry(request, url, url.pathname === "/login" ? "login" : "register");
    }

    const principal = await verifyAccessPrincipal(request, env);
    if (!principal) return denied(request);

    // Vinext resolves public files itself. Its Worker handler treats unmatched
    // build chunks as missing, so serve that reserved asset prefix after auth.
    const buildAsset = url.pathname.startsWith("/_next/static/");
    const workspaceAsset = url.pathname.startsWith("/workspace-assets/");
    const response = (buildAsset || workspaceAsset) && env.ASSETS
      ? await env.ASSETS.fetch(request)
      : await runWithAccessIdentity(principal, () => handler.fetch(request, env, ctx));
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", buildAsset && env.ASSETS ? programCacheControl(request, response, programAssets) : cacheControl);
    return result;
  },
};
