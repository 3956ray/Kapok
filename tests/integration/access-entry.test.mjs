import '../helpers/react-loader.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { setServerMe } from '../helpers/server-stubs.mjs';
import { runWithAccessIdentity, scopedPrincipal } from '../../lib/server/request-identity.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'vinext/server/fetch-handler') {
      return { url: 'data:text/javascript,export default {fetch: (...args) => globalThis.handleAuthEntryTest(...args)}', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { default: worker } = await import('../../build/staging-worker.ts');
const { default: Continue } = await import('../../app/auth/continue/page.tsx');
const { default: Profile } = await import('../../app/register/profile/page.tsx');
const env = {
  ACCESS_ALLOWED_HOST: 'kapok.party',
  ACCESS_ISSUER: 'https://entry-test.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'entry-test',
};
const origin = 'https://kapok.party';
const principal = { provider: 'access', issuer: env.ACCESS_ISSUER, subject: 'private-synthetic-subject', verifiedEmail: 'entry@example.test' };
const empty = { user: null, profile: null, membership: null, team: null };
const registered = {
  ...empty, user: { id: 'private-user', status: 'active' },
  membership: { id: 'membership', role: 'member', status: 'active', epoch: 1, version: 1 },
};
const spoofed = { 'oai-authenticated-user-id': 'spoofed', 'oai-authenticated-user-email': 'spoofed@example.test' };
const request = (path, init) => worker.fetch(new Request(origin + path, init), env, {});

test('standalone public documents are independent of identity and of Vinext rendering', async () => {
  globalThis.handleAuthEntryTest = () => assert.fail('public document reached the protected renderer');
  const root = await request('/', { headers: spoofed });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('Location'), '/login?returnTo=%2F');
  assert.equal(root.headers.get('cache-control'), 'private, no-store');
  for (const intent of ['login', 'register']) {
    const response = await request('/' + intent + '?returnTo=%2Fvideos%2Fv%3Ft%3D14%23comment-note', {
      headers: { ...spoofed, 'Cf-Access-Jwt-Assertion': 'forged.assertion.token' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; style-src 'sha256-/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    assert.match(html, intent === 'register' ? /验证邮箱并继续注册/ : /前往邮箱验证/);
    assert.match(html, /class="kapok-auth-court" aria-hidden="true"/);
    assert.equal(html.includes('固定队伍 · 无需邀请码'), intent === 'register');
    const style = html.match(/<style>([\s\S]+?)<\/style>/)[1];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style));
    assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${Buffer.from(digest).toString('base64')}'`));
    assert.ok(html.includes('/auth/continue?intent=' + intent + '&amp;returnTo=%2Fvideos%2Fv%3Ft%3D14%23comment-note'));
    assert.ok(html.includes(intent === 'login' ? '前往注册' : '前往登录'));
    assert.doesNotMatch(html, /_next\/static|spoofed@example/);
    const head = await request('/' + intent, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  for (const returnTo of ['//attacker.test/', 'https://attacker.test/', '/%2f%2fattacker.test/', '/register/profile', '/login', '/trainings?next=external']) {
    const html = await (await request('/login?returnTo=' + encodeURIComponent(returnTo))).text();
    assert.match(html, /intent=login&amp;returnTo=%2F"/);
    assert.doesNotMatch(html, /attacker\.test|next=external/);
  }
});

test('unsigned variants, framework requests, private resources and wrong hosts fail closed', async () => {
  globalThis.handleAuthEntryTest = () => assert.fail('unauthenticated request reached the protected renderer');
  for (const path of ['/Login', '/login/', '/%6cogin', '/%72egister', '/register%2fprofile', '//login',
    '/home', '/trainings', '/register/profile?intent=register', '/auth/continue?intent=login',
    '/api/v1/me', '/api/v1/videos/abc/media', '/_next/static/chunks/private.js', '/favicon.svg']) {
    const response = await request(path, { headers: spoofed });
    assert.equal(response.status, 403, path);
    assert.equal(await response.text(), 'Forbidden');
  }
  for (const route of ['/', '/login', '/register']) {
    for (const method of ['POST', 'PUT', 'OPTIONS']) assert.equal((await request(route, { method })).status, 403);
    for (const headers of [{ RSC: '1' }, { 'Next-Router-Prefetch': '1' }, { Accept: 'text/x-component' }, { 'Next-Action': 'x' }]) {
      assert.equal((await request(route, { headers })).status, 403);
    }
    assert.equal((await request(route + '?%5frsc=anything')).status, 403);
  }
  for (const url of ['http://kapok.party/login', 'https://kapok.party.evil.test/login', 'https://staging.kapok.party/login', 'https://kapok.party:444/register']) {
    assert.equal((await worker.fetch(new Request(url), env, {})).status, 403);
  }
});

test('root JWT is a cryptographically verified redirect hint only', async () => {
  const originalFetch = globalThis.fetch;
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' };
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'entry-key' };
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const mint = async claims => {
    const value = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({
      type: 'app', iss: env.ACCESS_ISSUER, aud: [env.ACCESS_AUDIENCE],
      exp: now + 300, iat: now - 100, nbf: now - 100, sub: principal.subject, email: principal.verifiedEmail, ...claims,
    });
    return value + '.' + Buffer.from(await crypto.subtle.sign(algorithm, keys.privateKey, Buffer.from(value))).toString('base64url');
  };
  globalThis.fetch = async url => {
    assert.equal(url, env.ACCESS_ISSUER + '/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
  };
  try {
    const token = await mint();
    const cookie = { Cookie: 'other=ok; CF_Authorization=' + token };
    globalThis.handleAuthEntryTest = () => assert.fail('root hint entered Vinext');
    for (const [path, headers] of [['/', cookie], ['/?_rsc=opaque', { ...cookie, RSC: '1' }], ['/', { 'Cf-Access-Jwt-Assertion': token }]]) {
      const response = await request(path, { headers });
      assert.equal(response.status, 307);
      assert.equal(response.headers.get('Location'), '/home');
      assert.equal(await response.text(), '');
    }
    const parts = token.split('.');
    const bad = parts.slice(0, 2).join('.') + '.' + Buffer.alloc(256, 7).toString('base64url');
    for (const wrong of [bad, await mint({ exp: now - 1 }), await mint({ aud: ['wrong'] }), await mint({ iss: 'https://wrong.cloudflareaccess.com' })]) {
      assert.equal((await request('/', { headers: { Cookie: 'CF_Authorization=' + wrong } })).status, 302);
      assert.equal((await request('/?_rsc=opaque', { headers: { Cookie: 'CF_Authorization=' + wrong, RSC: '1' } })).status, 403);
    }
    assert.equal((await request('/', { headers: { Cookie: cookie.Cookie + '; CF_Authorization=' + token } })).status, 302);
    assert.equal((await request('/', { headers: { ...cookie, 'Cf-Access-Jwt-Assertion': bad } })).status, 302);
    for (const path of ['/home', '/auth/continue', '/register/profile', '/api/v1/me', '/_next/static/private.js']) {
      assert.equal((await request(path, { headers: cookie })).status, 403, path);
    }
    globalThis.handleAuthEntryTest = request => {
      assert.equal(new URL(request.url).pathname, '/home');
      assert.deepEqual(scopedPrincipal(request.headers), principal);
      return new Response('protected handler');
    };
    const protectedHome = await request('/home', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    assert.equal(protectedHome.status, 200);
    assert.equal(await protectedHome.text(), 'protected handler');
    assert.equal(protectedHome.headers.get('cache-control'), 'private, no-store');
  } finally { globalThis.fetch = originalFetch; }
});

test('protected continuation resolves verified current state and preserves only safe destinations', async () => {
  const props = (intent, returnTo = '/videos/v?t=14#comment-note') => ({ searchParams: Promise.resolve({ intent, returnTo }) });
  await runWithAccessIdentity(null, async () => {
    await assert.rejects(Continue(props('register')), /redirect \/register\?returnTo=/);
    await assert.rejects(Profile(props('register')), /redirect \/register\?returnTo=/);
  });
  await runWithAccessIdentity(principal, async () => {
    setServerMe(empty);
    const login = renderToStaticMarkup(await Continue(props('login')));
    assert.match(login, /该邮箱尚未注册/);
    assert.match(login, /\/register\?returnTo=%2Fvideos%2Fv%3Ft%3D14%23comment-note/);
    assert.doesNotMatch(login, /<form|name="discName"|entry@example.test/);
    await assert.rejects(Continue(props('register')), /redirect \/register\/profile\?intent=register&returnTo=%2Fvideos%2Fv%3Ft%3D14%23comment-note/);
    await assert.rejects(Profile(props('login')), /redirect \/register\?returnTo=/);
    assert.match(renderToStaticMarkup(await Profile(props('register'))), /让队友认出你/);
    setServerMe(registered);
    await assert.rejects(Continue(props('login')), /redirect \/videos\/v\?t=14#comment-note$/);
    for (const unsafe of ['/admin/members', '/%61dmin/members', '//outside.test/']) {
      await assert.rejects(Continue(props('login', unsafe)), /redirect \/home$/);
    }
    const already = renderToStaticMarkup(await Continue(props('register')));
    assert.match(already, /你已经是 Kapok 成员/);
    assert.match(already, /进入应用/);
    assert.doesNotMatch(already, /<form|name="discName"/);
    await assert.rejects(Profile(props('register')), /redirect \/auth\/continue\?intent=register/);
    for (const blocked of [
      { ...registered, membership: { ...registered.membership, status: 'paused' } },
      { ...registered, membership: { ...registered.membership, status: 'left' } },
      { ...empty, user: { id: 'deleted', status: 'deleted' } },
    ]) {
      setServerMe(blocked);
      const text = renderToStaticMarkup(await Continue(props('register')));
      assert.match(text, /此账号暂不可进入队伍/);
      assert.doesNotMatch(text, /<form|前往注册|进入应用/);
      assert.match(renderToStaticMarkup(await Profile(props('register'))), /此账号暂不可进入队伍/);
    }
  });
});
