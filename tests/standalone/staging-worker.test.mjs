import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { actorKey } from "../../lib/server/identity.ts";

const configPath = "dist/staging/server/wrangler.json";
const serverDir = path.dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const { main, workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(configPath);
const assetsDir = path.resolve(serverDir, config.assets.directory);
const migrationDir = path.resolve(serverDir, config.d1_databases[0].migrations_dir);
const chunkDir = path.join(assetsDir, "_next/static/chunks");
const chunk = readdirSync(chunkDir).find(name => name.endsWith(".js"));
assert.ok(chunk);
const chunkRoute = "/_next/static/chunks/" + chunk;
const { programAssets } = await import('../../dist/staging/server/program-assets.js');
const importChunk = readdirSync(chunkDir).find(name => name.startsWith('initial-videos-import-'));
const migrations = [
  "0000_identity.sql",
  "0001_training.sql",
  "0002_upload_cleanup.sql",
  "0003_reflections.sql",
  "0004_resumable_uploads.sql",
  "0005_two_scope_reflections.sql",
  "0006_identity_namespace.sql",
  "0007_email_bound_invites.sql",
  "0008_fixed_team_onboarding.sql",
  "0009_kapok_team_name.sql",
  "0010_training_publication.sql",
  "0011_profile_bio.sql",
  "0012_video_platforms.sql",
  "0013_learning_posts.sql",
  "0014_topic_collections.sql",
  "0015_learning_discussion.sql",
  "0016_learning_private_sources.sql",
  "0017_learning_activity.sql",
  "0018_learning_categories.sql",
  "0019_workspace_growth.sql",
  "0020_workspace_topics.sql",
  "0021_workspace_materials.sql",
  "0022_workspace_profile_position.sql",
  "0023_announcement_revisions.sql",
  "0024_profile_avatars.sql",
  "0025_workspace_topic_covers.sql",
  "0026_reflection_photos.sql",
  "0027_reflection_image_cleanup.sql",
  "0028_reader_discussions.sql",
  "0029_field_positions.sql",
  "0030_team_bulletin.sql",
  "0031_topic_reflection_items.sql",
];

test("the default build targets only synthetic D1, with Worker-first assets and no public routes", () => {
  assert.equal(config.name, "kapok-local");
  assert.equal(config.account_id, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.deepEqual(config.vars, {
    ACCESS_ALLOWED_HOST: "kapok.test",
    ACCESS_ISSUER: "https://kapok-test.cloudflareaccess.com",
    ACCESS_AUDIENCE: "local-test-audience",
  });
  assert.deepEqual(config.d1_databases, [{
    binding: "DB",
    database_name: "kapok-local",
    database_id: "00000000-0000-4000-8000-000000000001",
    migrations_dir: "../../../drizzle",
  }]);
  assert.deepEqual(config.assets, { binding: "ASSETS", run_worker_first: true, directory: "../client" });
  assert.deepEqual(config.r2_buckets, [{ binding: "BUCKET", bucket_name: "kapok-local-media" }]);
  assert.deepEqual(config.services, []);
  assert.deepEqual(externalWorkers, []);
  assert.equal(existsSync(main), true);
  assert.equal(existsSync(path.join(assetsDir, "_next/static")), true);
  assert.ok(importChunk);
  assert.equal(programAssets.has('/_next/static/chunks/' + importChunk), false);
  for (const file of programAssets) assert.ok(existsSync(path.join(assetsDir, file)), 'allowlist references an emitted program');
  assert.deepEqual(readdirSync(migrationDir).filter(name => name.endsWith(".sql")).sort(), migrations);
  for (const file of readdirSync("dist/staging", { recursive: true })) {
    assert.doesNotMatch(file, /(^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|hosting\.json|.*(?:fixture|proxy).*\.(?:js|mjs))$/i);
    if (file.endsWith(".js")) {
      assert.doesNotMatch(readFileSync(path.join("dist/staging", file), "utf8"), /local_seedy|seedy@sites\.test|sharing-browser-fixture|sharing-browser-proxy/);
    }
  }
});

const principal = {
  provider: "access",
  issuer: "https://synthetic-staging.cloudflareaccess.com",
  subject: "synthetic-staging-viewer",
  verifiedEmail: "staging-viewer@example.test",
};
const bindings = {
  ACCESS_ALLOWED_HOST: config.vars.ACCESS_ALLOWED_HOST,
  ACCESS_ISSUER: principal.issuer,
  ACCESS_AUDIENCE: "synthetic-staging-audience",
};
const origin = `https://${bindings.ACCESS_ALLOWED_HOST}`;
const spoofedSites = {
  "oai-authenticated-user-id": "spoofed-site-owner",
  "oai-authenticated-user-email": "spoofed-owner@example.test",
};
const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" };
const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "staging-test-key" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function assertion(identity = principal) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ alg: "RS256", kid: jwk.kid }) + "." + encode({
    type: "app", iss: principal.issuer, aud: [bindings.ACCESS_AUDIENCE],
    sub: identity.subject, email: identity.verifiedEmail, iat: now - 1, nbf: now - 1, exp: now + 300,
  });
  const signature = await crypto.subtle.sign(algorithm, keys.privateKey, new TextEncoder().encode(payload));
  return payload + "." + Buffer.from(signature).toString("base64url");
}

function start(t, overrides = {}) {
  const miniflare = new Miniflare({
    ...workerOptions,
    modulesRoot: path.dirname(main),
    modules: [main, ...readdirSync(serverDir, { recursive: true })
      .filter(file => file.endsWith(".js") && file !== config.main)
      .map(file => path.resolve(serverDir, file))]
      .map(file => ({ type: "ESModule", path: file })),
    bindings,
    outboundService: request => {
      assert.equal(request.url, `${principal.issuer}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    },
    ...overrides,
  });
  t.after(() => miniflare.dispose());
  return miniflare;
}

async function assertDenied(response) {
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "Forbidden");
}

test("real workerd serves exact public documents and rejects anonymous SSR, RSC and assets", async t => {
  const app = start(t);
  const token = await assertion();
  const [header, claims] = token.split(".");
  const forged = [header, claims, Buffer.alloc(256, 42).toString("base64url")].join(".");
  const dispatch = (route, init = {}) => app.dispatchFetch(origin + route, { redirect: "manual", ...init });
  for (const headers of [spoofedSites, { ...spoofedSites, "Cf-Access-Jwt-Assertion": forged }]) {
    const root = await dispatch("/", { headers });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/login?returnTo=%2F");
    assert.equal(root.headers.get("cache-control"), "private, no-store");
    for (const entry of ["login", "register"]) {
      const response = await dispatch("/" + entry + "?returnTo=%2Fvideos%2Fsample%3Ft%3D14", { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
      const text = await response.text();
      assert.ok(text.includes(`/auth/continue?intent=${entry}&amp;returnTo=%2Fvideos%2Fsample%3Ft%3D14`));
      assert.doesNotMatch(text, /spoofed-site-owner|_next\/static/);
      const head = await dispatch("/" + entry, { method: "HEAD", headers });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    for (const route of ["/home", "/trainings", "/auth/continue?intent=login", "/register/profile?intent=register", "/Login", "/login/", "/%6cogin",
      "/register%2fprofile", "/favicon.svg", chunkRoute, "/api/v1/me", "/api/v1/videos/example/media", "/signin-with-chatgpt"]) {
      await assertDenied(await dispatch(route, { headers }));
    }
    for (const route of ["/", "/login", "/register"]) {
      await assertDenied(await dispatch(route, { method: "POST", headers }));
      await assertDenied(await dispatch(route + "?_rsc=test", { headers: { ...headers, RSC: "1" } }));
    }
  }
  for (const [route, file, mime] of [
    ["/login?art=cover", "media/sky.webp", "image/webp"],
    ["/register?art=cover", "media/sideline-team.webp", "image/webp"],
    ["/login?art=serif", "type/field-song.woff2", "font/woff2"],
  ]) {
    const asset = await dispatch(route);
    assert.equal(asset.status, 200, route);
    assert.equal(asset.headers.get("content-type"), mime);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), readFileSync(path.join(assetsDir, "workspace-assets", file)));
    await assertDenied(await dispatch("/workspace-assets/" + file));
  }
  const cookie = { Cookie: "CF_Authorization=" + token };
  for (const [path, headers] of [["/", cookie], ["/?_rsc=opaque", { ...cookie, RSC: "1" }]]) {
    const redirect = await dispatch(path, { headers });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "/home");
    assert.equal(await redirect.text(), "");
  }
  assert.equal((await dispatch("/", { headers: { Cookie: cookie.Cookie + "; CF_Authorization=" + token } })).status, 302);
  for (const route of ["/home", "/auth/continue", "/register/profile", "/api/v1/me", chunkRoute]) {
    await assertDenied(await dispatch(route, { headers: cookie }));
  }
  for (const url of [
    "http://kapok.party/login",
    "https://kapok.party.example.test/login",
    "https://staging.kapok.party/register",
    "https://kapok-staging.example.workers.dev/",
  ]) {
    await assertDenied(await app.dispatchFetch(url, { headers: { "Cf-Access-Jwt-Assertion": token } }));
  }
});

test("missing or wrong Access configuration and unavailable keys deny the valid assertion", async t => {
  const token = await assertion();
  const denyWith = async overrides => {
    const app = start(t, overrides);
    await assertDenied(await app.dispatchFetch(origin + "/api/v1/me", { headers: { ...spoofedSites, "Cf-Access-Jwt-Assertion": token } }));
  };
  await denyWith({ bindings: {} });
  await denyWith({ bindings: { ...bindings, ACCESS_AUDIENCE: "wrong-audience" } });
  await denyWith({ outboundService: () => new Response(null, { status: 503 }) });
  let fetches = 0;
  await denyWith({ outboundService: () => {
    fetches += 1;
    return new Response(null, { status: 302, headers: { Location: "https://redirect.example.test/keys" } });
  } });
  assert.equal(fetches, 1);
});

async function migratedDb(app, files = migrations) {
  const db = await app.getD1Database("DB");
  for (const name of files) {
    const sql = readFileSync(path.join(migrationDir, name), "utf8");
    await db.batch(sql.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  }
  return db;
}

test("signed request reaches real pages and assets and registers an ordinary member without an admin configuration", async t => {
  const app = start(t, { bindings: { ...bindings, BOOTSTRAP_SITE_USER_ID: spoofedSites["oai-authenticated-user-id"] } });
  const db = await migratedDb(app);
  const headers = { ...spoofedSites, "Cf-Access-Jwt-Assertion": await assertion() };
  const request = (route, init) => app.dispatchFetch(origin + route, { headers, ...init });
  const page = await request("/home");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match(await page.text(), /该邮箱尚未注册/);
  const login = await request("/auth/continue?intent=login&returnTo=%2Ftrainings", { redirect: "manual" });
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /该邮箱尚未注册/);
  assert.doesNotMatch(loginHtml, /name="discName"/);
  for (const table of ["users", "auth_identities", "profiles", "memberships", "operations"]) {
    assert.equal(await db.prepare(`SELECT count(*) AS count FROM ${table}`).first("count"), 0);
  }
  const registration = await request("/auth/continue?intent=register&returnTo=%2Ftrainings", { redirect: "manual" });
  assert.equal(registration.status, 307);
  assert.match(registration.headers.get("Location"), /\/register\/profile\?intent=register&returnTo=%2Ftrainings$/);
  const next = new URL(registration.headers.get("Location"), origin);
  assert.equal(next.origin, origin);
  const profileStep = await request(next.pathname + next.search);
  assert.equal(profileStep.status, 200);
  assert.match(await profileStep.text(), /让队友认出你/);
  const asset = await request("/favicon.svg");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "private, no-store");
  assert.match(await asset.text(), /<svg/);
  const clientChunk = await request(chunkRoute);
  assert.equal(clientChunk.status, 200);
  assert.equal(clientChunk.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal((await request('/_next/static/chunks/' + importChunk)).headers.get('cache-control'), 'private, no-store');
  const missingChunk = await request('/_next/static/chunks/missing-12345678.js');
  assert.equal(missingChunk.status, 404);
  assert.equal(missingChunk.headers.get('cache-control'), 'private, no-store');
  assert.equal((await request(chunkRoute + '?_rsc=test')).headers.get('cache-control'), 'private, no-store');
  assert.equal((await request(chunkRoute, { method: 'HEAD' })).headers.get('cache-control'), 'private, no-store');

  const session = await request("/api/v1/bootstrap");
  assert.equal(session.status, 200);
  const { data } = await session.json();
  const expectedActor = await actorKey(principal);
  assert.equal(data.actorId, expectedActor);
  assert.equal(data.me.user, null);
  assert.equal(data.siteUserId, undefined);
  assert.equal((await request("/api/v1/videos/example/media")).status, 403);

  const write = (route, body) => request("/api/v1/" + route, {
    method: "POST", body: JSON.stringify(body),
    headers: { ...headers, Origin: origin, "Content-Type": "application/json", "X-Kapok-Actor": expectedActor, "Idempotency-Key": "staging-proof" },
  });
  const profile = { discName: "Synthetic Viewer", jerseyNumber: "0042", intent: "register", confirmed: true };
  assert.equal((await write("internal/bootstrap", profile)).status, 404);
  assert.equal((await write("join", { ...profile, role: "admin" })).status, 400);
  assert.equal((await write("join", { ...profile, confirmed: false })).status, 400);
  const response = await write("join", profile);
  assert.equal(response.status, 200, await response.clone().text());
  const joined = (await response.json()).data;
  assert.equal(joined.me.membership.role, "member");
  assert.equal(joined.me.team.name, "Kapok");
  assert.equal(joined.me.profile.jerseyNumber, "0042");
  const loginAgain = await request("/auth/continue?intent=login&returnTo=%2Ftrainings", { redirect: "manual" });
  assert.equal(loginAgain.status, 307);
  assert.match(loginAgain.headers.get("location"), /\/trainings$/);
  const existing = await request("/auth/continue?intent=register&returnTo=%2Fadmin%2Fmembers");
  assert.equal(existing.status, 200);
  const existingHtml = await existing.text();
  assert.match(existingHtml, /你已经是 Kapok 成员/);
  assert.match(existingHtml, /href="\/home"/);
  for (const table of ["bootstraps", "invites", "initial_admin_grants"]) {
    assert.equal(await db.prepare(`SELECT count(*) AS count FROM ${table}`).first("count"), 0);
  }
});

test("real workerd retrieves the same video's official thumbnail after a redirected rendition and caches it", async t => {
  const primary = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  const backup = "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
  const jpeg = Uint8Array.of(255, 216, 255, 224, 0, 0, 255, 217);
  const imageRequests = [];
  const app = start(t, { outboundService(request) {
    if (request.url === principal.issuer + "/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
    imageRequests.push(request.url);
    if (request.url === primary) return Response.redirect("https://example.test/unrelated");
    return request.url === backup ? new Response(jpeg) : new Response(null, { status: 404 });
  } });
  await migratedDb(app);
  const headers = { "Cf-Access-Jwt-Assertion": await assertion() };
  const actor = await actorKey(principal);
  async function post(path, body) {
    const response = await app.dispatchFetch(origin + "/api/v1/" + path, {
      method: "POST", headers: { ...headers, Origin: origin, "X-Kapok-Actor": actor, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  }
  await post("join", { discName: "Synthetic", jerseyNumber: "07", intent: "register", confirmed: true });
  const draft = await post("learning/posts", { title: "Example", kind: "video", category: "基本功",
    video: { source: "youtube", url: "https://youtu.be/dQw4w9WgXcQ?t=5m" } });
  // Writing a video schedules a background cover fetch. Wait for that write before measuring cache reads.
  const bucket = await app.getR2Bucket("BUCKET");
  const key = "platform-covers/v1/youtube/dQw4w9WgXcQ";
  const deadline = Date.now() + 5000;
  let cached = await bucket.head(key);
  while (!cached && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    cached = await bucket.head(key);
  }
  assert.equal(cached?.size, jpeg.length, "the upload warmed its official thumbnail");
  for (let i = 0; i < 2; i++) {
    const cover = await app.dispatchFetch(origin + "/api/v1/video-covers/draft/" + draft.id, { headers, redirect: "manual" });
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), jpeg);
  }
  assert.deepEqual(imageRequests, [primary, backup]);
});

test("real bundle enrolls signed Access identities concurrently and resolves old links safely", async t => {
  const owner = { ...principal, subject: "synthetic-initial-admin", verifiedEmail: "synthetic-owner@example.test" };
  const app = start(t, { bindings: { ...bindings, ACCESS_INITIAL_ADMIN_EMAIL: owner.verifiedEmail } });
  const db = await migratedDb(app);
  async function request(identity, route, body, key = "staging-enrollment", method = "POST") {
    const headers = { "Cf-Access-Jwt-Assertion": await assertion(identity) };
    if (body === undefined) return app.dispatchFetch(origin + route, { headers, redirect: "manual" });
    return app.dispatchFetch(origin + route, {
      method,
      headers: { ...headers, Origin: origin, "Content-Type": "application/json", "X-Kapok-Actor": await actorKey(identity), "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  }
  const ownerPage = await request(owner, "/home");
  assert.equal(ownerPage.status, 200);
  const onboarding = await ownerPage.text();
  assert.match(onboarding, /该邮箱尚未注册/);
  assert.doesNotMatch(onboarding, /邀请|初始化/);
  const details = { discName: "Synthetic", jerseyNumber: "07", intent: "register", confirmed: true };
  const oldPage = await request(principal, "/join/synthetic-retired-token?returnTo=%2Ftrainings");
  assert.equal(oldPage.status, 307);
  const canonical = new URL(oldPage.headers.get("Location"), origin);
  assert.equal(canonical.href, origin + "/register?returnTo=%2Ftrainings");
  const registration = await request(principal, canonical.pathname + canonical.search);
  assert.equal(registration.status, 200);
  const oldPageText = await registration.text();
  assert.match(oldPageText, /验证邮箱并继续注册/);
  assert.match(oldPageText, /固定队伍 · 无需邀请码/);
  assert.doesNotMatch(oldPageText, /synthetic-retired-token|初始化/i);
  assert.match(oldPageText, /<form id="register-first"/);
  assert.match(oldPageText, /<input name="discName"/);
  assert.match(oldPageText, /<input name="jerseyNumber"/);
  for (const [, href] of oldPageText.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const { pathname } = new URL(href, canonical);
    assert.doesNotMatch(pathname, /^\/(?:api\/v1\/)?(?:join|admin\/invites|internal\/bootstrap)(?:\/|$)/i);
  }
  const writes = await Promise.all([
    request(principal, "/api/v1/join", { ...details, returnTo: "/trainings" }),
    request(owner, "/api/v1/join", details),
    request(principal, "/api/v1/join", { ...details, returnTo: "/trainings" }),
  ]);
  for (const response of writes) assert.equal(response.status, 200, await response.clone().text());
  const [member, admin, replay] = await Promise.all(writes.map(async response => (await response.json()).data));
  assert.equal(member.me.membership.role, "member");
  assert.equal(member.me.profile.jerseyNumber, "07");
  assert.equal(member.returnTo, "/trainings");
  assert.equal(admin.me.membership.role, "admin");
  assert.equal(replay.operationId, member.operationId);
  const deep = await request(principal, "/internal/bootstrap?returnTo=%2Ftrainings");
  assert.equal(deep.status, 307);
  assert.match(deep.headers.get("Location"), /\/trainings$/);
  assert.equal((await request(principal, "/api/v1/trainings")).status, 200);
  assert.equal((await request(owner, "/api/v1/admin/invites", {})).status, 404);
  assert.equal((await request(principal, "/api/v1/admin/members")).status, 403);
  const change = (actor, target, role, key) => request(actor, "/api/v1/admin/members/" + target.me.user.id, {
    role, status: "active", expectedVersion: target.me.membership.version, expectedEpoch: target.me.membership.epoch,
  }, key, "PATCH");
  assert.equal((await change(owner, admin, "member", "last")).status, 409);
  assert.equal((await change(owner, member, "admin", "promote")).status, 200);
  assert.equal((await change(principal, admin, "member", "demote")).status, 200);
  assert.equal((await request(owner, "/api/v1/admin/members")).status, 403);
  assert.equal((await (await request(owner, "/api/v1/join", details)).json()).data.me.membership.role, "member");
  assert.equal(await db.prepare("SELECT count(*) AS count FROM teams").first("count"), 1);
  assert.equal(await db.prepare("SELECT count(*) AS count FROM memberships").first("count"), 2);
  assert.equal(await db.prepare("SELECT count(*) AS count FROM invites").first("count"), 0);
});

test("deployed Worker runs the orphan sweep on its configured cron with no member requests",async t=>{
  const cron="*/15 * * * *";
  assert.deepEqual(config.triggers.crons,[cron]);
  // Deliver the scheduled event to the Worker entrypoint; Miniflare's HTTP-only static-asset router has no scheduled handler.
  const app=start(t,{unsafeTriggerHandlers:true,assets:undefined});
  await migratedDb(app);
  const bucket=await app.getR2Bucket("BUCKET");
  const key="reflection-images/"+crypto.randomUUID();
  await bucket.put(key,"retired original");
  await bucket.put(key+"/thumbnail","retired thumbnail");
  const query=new URLSearchParams({cron,time:String(Date.now()+2*86400000)});
  const event=await app.dispatchFetch(origin+"/cdn-cgi/handler/scheduled?"+query);
  assert.equal(event.status,200,await event.text());
  assert.equal(await bucket.head(key),null);
  assert.equal(await bucket.head(key+"/thumbnail"),null);
});

test("0028 retains existing grants and publication state, and the deployed reader discussion routes bind the current generation",async t=>{
  const app=start(t,{bindings:{...bindings,ACCESS_INITIAL_ADMIN_EMAIL:principal.verifiedEmail}});
  const db=await migratedDb(app,migrations.filter(file => file < "0028"));
  const jwt=await assertion(), actor=await actorKey(principal);
  const api=async(path,method="GET",body)=>{
    const response=await app.dispatchFetch(origin+"/api/v1/"+path,{method,body:body===undefined ? undefined : JSON.stringify(body),
      headers:{"Cf-Access-Jwt-Assertion":jwt,Origin:origin,"Content-Type":"application/json","X-Kapok-Actor":actor,"Idempotency-Key":crypto.randomUUID()}});
    return {status:response.status,...await response.json()};
  };
  assert.equal((await api("join","POST",{intent:"register",confirmed:true,discName:"合成测试",jerseyNumber:"11"})).status,200);
  const {data:note}=await api("reflections","POST",{title:"合成复盘",text:"正文",date:"2026-11-24"});
  const {data:shared}=await api("reflections/"+note.id+"/grants","PUT",{scope:"team",expectedVersion:note.version,
    expectedSharingVersion:note.sharingVersion,expectedGeneration:note.generation});
  const {data:notice}=await api("announcements","POST",{title:"合成公告",text:"正文",status:"published"});
  const rows=async()=>({
    note:await db.prepare('SELECT version,sharing_version,generation,gate,scope,published_at,text FROM reflections WHERE id=?').bind(note.id).first(),
    notice:await db.prepare('SELECT version,status,published_at,text FROM announcements WHERE id=?').bind(notice.id).first()
  });
  const before=await rows();
  const sql=readFileSync(path.join(migrationDir,"0028_reader_discussions.sql"),"utf8");
  await db.batch(sql.split("--> statement-breakpoint").map(stmt=>db.prepare(stmt.trim())));
  assert.deepEqual(await rows(),before);
  for(const prefix of ["reflections/"+shared.id,"announcements/"+notice.id]) {
    const route=prefix+"/discussion";
    const read=await api(route);
    assert.equal(read.status,200);
    assert.deepEqual(read.data.items,[]);
    const fence={expectedDiscussionEpoch:read.data.discussionEpoch,expectedMembershipEpoch:read.data.membershipEpoch};
    assert.equal(fence.expectedDiscussionEpoch,1);
    const written=await api(route,"POST",{...fence,text:"合成评论"});
    assert.equal(written.status,200);
    assert.equal((await api(route)).data.items[0].id,written.data.id);
    assert.equal((await api(route+"/"+written.data.id,"PATCH",{...fence,action:"delete",expectedVersion:1})).status,200);
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);
});
