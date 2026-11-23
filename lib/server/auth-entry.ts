import { registrationPrefillScript } from '../client/registration-prefill.ts';
import type { Me } from '../contracts/index';
import { safeReturnTo } from './return-to.ts';

export type AuthIntent = 'login' | 'register';

export function authEntryPath(intent: AuthIntent, target: unknown) {
  return `/${intent}?returnTo=${encodeURIComponent(safeReturnTo(target))}`;
}

export function authContinuationPath(intent: AuthIntent, target: unknown, profile = false) {
  return `${profile ? '/register/profile' : '/auth/continue'}?intent=${intent}&returnTo=${encodeURIComponent(safeReturnTo(target))}`;
}

export function authDestination(me: Me, target: unknown) {
  const destination = safeReturnTo(target);
  return me.membership?.role !== 'admin' && destination.startsWith('/admin/') ? '/' : destination;
}

export function authAccountState(me: Me) {
  if (me.user?.status === 'deleted' || (me.membership && me.membership.status !== 'active')) return 'restricted';
  return me.user?.status === 'active' && me.membership?.status === 'active' ? 'registered' : 'unregistered';
}

export function isFrameworkRequest(request: Request, url: URL) {
  return url.searchParams.has('_rsc') ||
    [...request.headers.keys()].some(name => name === 'rsc' || name.startsWith('next-') ||
      name.startsWith('x-nextjs-') || name.startsWith('x-vinext-') || name === 'x-middleware-prefetch') ||
    !!request.headers.get('accept')?.toLowerCase().includes('text/x-component');
}

// The root is outside Access. Treat this application JWT only as a redirect hint.
// Reject duplicate credentials or a disagreement with a supplied assertion.
export function rootCredentialRequest(request: Request): Request | null {
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => /^CF_Authorization\s*=/.test(value));
  if (cookies.length > 1) return null;
  if (cookies.length === 0) return assertion ? request : null;
  const token = cookies[0].slice(cookies[0].indexOf('=') + 1);
  if (!token || (assertion !== null && assertion !== token)) return null;
  return new Request(request.url, { method: request.method, headers: { 'Cf-Access-Jwt-Assertion': token } });
}

// The exact public /login and /register Access routes serve these presentation files.
export function authArtPath(pathname: string, query: string): string | null {
  if (pathname !== '/login' && pathname !== '/register') return null;
  const media = '/workspace-assets/media/';
  const type = '/workspace-assets/type/';
  switch (query) {
    case '?art=cover': return media + (pathname === '/login' ? 'sky.webp' : 'sideline-team.webp');
    case '?art=serif': return type + 'field-song.woff2';
    case '?art=sans': return type + 'dm-sans-latin-wght-normal.woff2';
    case '?art=signature': return type + 'barlow-condensed-latin-600-normal.woff2';
    case '?art=signature-italic': return type + 'barlow-condensed-latin-600-italic.woff2';
    default: return null;
  }
}
export const authMast = `<a class="auth-skip" href="#main-content">跳到表单</a><header class="access-mast">
  <a class="auth-brand" href="/home" aria-label="Kapok 训练室"><span class="auth-flower" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><b>Kapok</b></a>
  <a class="access-return" href="/home">浏览训练室 ↗</a></header>`;
export function authCover(register: boolean, publicDocument = true) {
  const src = publicDocument ? (register ? '/register' : '/login') + '?art=cover'
    : '/workspace-assets/media/' + (register ? 'sideline-team.webp' : 'sky.webp');
  const photo = register ? 'File:Finals_of_the_Ultimate_Frisbee_competitions,_USA-AUS,_World_Games_2005,_Duisburg-7242599.jpg' : 'File:Ultimate_frisbee_(491411732).jpg';
  return `<aside class="access-cover${register ? ' joining' : ''}"><img class="access-photo" src="${src}" alt="" fetchpriority="high">
    <span class="access-signature">Kapok <i>Bloom</i></span><details class="access-credit"><summary>摄影署名 ↗</summary><div>
    <a href="https://commons.wikimedia.org/wiki/${photo}" target="_blank" rel="noreferrer">${register ? 'Raimond Spekking' : 'Devon Hollahan'}</a>
    · <a href="https://creativecommons.org/licenses/by-sa/${register ? '4.0' : '2.0'}/" target="_blank" rel="noreferrer">CC BY-SA ${register ? '4.0' : '2.0'}</a> · 裁切、调色</div></details></aside>`;
}
export function authStyles(publicDocument = true) {
  function font(key: string) {
    const query = '?art=' + key;
    return publicDocument ? '/login' + query : authArtPath('/login', query);
  }
  return `
@font-face{font-family:KapokSong;src:url('${font('serif')}') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:KapokSans;src:url('${font('sans')}') format('woff2');font-weight:100 1000;font-display:swap}
@font-face{font-family:KapokNumber;src:url('${font('signature')}') format('woff2');font-weight:600;font-display:swap}
@font-face{font-family:KapokNumber;src:url('${font('signature-italic')}') format('woff2');font-style:italic;font-weight:600;font-display:swap}
body:has(.kapok-auth){margin:0;background:#faf9f4;color:#1a2823}
.kapok-auth{box-sizing:border-box;width:min(100%,1680px);min-height:100svh;margin-inline:auto;padding:0 clamp(24px,4.6vw,78px);display:flex;flex-direction:column;font:400 16px/1.55 KapokSans,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a2823}
.kapok-auth *{box-sizing:border-box}.kapok-auth a{color:inherit}.kapok-auth [hidden]{display:none}
.auth-skip{position:absolute;left:0;transform:translateY(-125%);background:#faf9f4;z-index:2}.auth-skip:focus{transform:none}
.kapok-auth .access-mast{display:flex;align-items:center;justify-content:space-between;min-height:78px;border-bottom:1px solid #cecec1}
.kapok-auth .auth-brand{display:flex;align-items:center;gap:7px;text-decoration:none;min-height:48px}
.auth-brand b{font:740 31px/.95 KapokSans,sans-serif;letter-spacing:-.055em}
.auth-flower{position:relative;width:30px;height:30px;color:#ad3925}.auth-flower i{position:absolute;left:11px;top:1px;width:8px;height:14px;background:currentColor;border-radius:75% 75% 50% 50%;transform-origin:4px 14px}
.auth-flower i:nth-child(2){transform:rotate(72deg)}.auth-flower i:nth-child(3){transform:rotate(144deg)}.auth-flower i:nth-child(4){transform:rotate(216deg)}.auth-flower i:nth-child(5){transform:rotate(288deg)}.auth-flower:after{content:'';position:absolute;inset:13px;background:#142f29;border-radius:50%}
.kapok-auth .access-return{display:flex;align-items:center;min-height:44px;color:#58635c;text-decoration:none;font-size:13px}
.kapok-auth .access-spread{flex:1;display:grid;grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr);gap:clamp(26px,4.2vw,74px);padding-block:24px clamp(24px,3vw,49px)}
.kapok-auth .access-form-panel{display:grid;place-items:center;padding-block:36px}
.kapok-auth .access-entry{width:min(100%,380px);overflow-wrap:anywhere}
.kapok-auth h1{font:600 clamp(38px,3.6vw,56px)/1.18 KapokSong,"Songti SC","Noto Serif CJK SC",serif;letter-spacing:-.042em;margin:0;color:#1a2823}
.kapok-auth p{margin:12px 0;line-height:1.7;font-size:14px;color:#58635c}
.kapok-auth form{margin-top:26px;width:100%}.kapok-auth label{display:block;font-weight:600;color:#1a2823}.kapok-auth input{display:block;width:100%;min-height:49px;margin-top:6px;padding:10px 13px;border:1px solid #b5b9ac;border-radius:3px;background:#fffdf6;font:inherit}
.kapok-auth .kapok-auth-primary,.kapok-auth form button[type=submit]{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:50px;margin:22px 0 12px;width:100%;padding:12px 17px;background:#173b33;color:#fffef9;line-height:1.5;font-family:inherit;font-weight:650;font-size:1rem;text-decoration:none;border:0;border-radius:3px;cursor:pointer}
.kapok-auth a:focus-visible,.kapok-auth button:focus-visible,.kapok-auth input:focus-visible,.kapok-auth summary:focus-visible{outline:2px solid #ad3925;outline-offset:3px}
.kapok-auth .kapok-auth-help{font-size:13px}.kapok-auth [role=alert]{color:#ad3925}.kapok-auth-secondary{display:inline-flex;align-items:center;min-height:44px;font-weight:650;font-size:14px;color:#173b33;text-underline-offset:4px}
.kapok-auth .access-cover{isolation:isolate;position:relative;display:flex;align-items:flex-end;min-height:490px;overflow:hidden;background:#244437}
.kapok-auth .access-photo{position:absolute;inset:0;z-index:-2;width:100%;height:100%;object-fit:cover;object-position:53% 43%;mix-blend-mode:luminosity;opacity:.88}.kapok-auth .joining .access-photo{object-position:44% 50%}
.access-cover:before{position:absolute;inset:0;z-index:-1;content:'';background:linear-gradient(0deg,#0a231bd9,#112e2026 32%,transparent 57%)}
.kapok-auth .access-signature{color:#fff8e4;font:600 clamp(60px,6.7vw,112px)/.95 KapokNumber,"Arial Narrow",sans-serif;letter-spacing:-.035em;margin:0 0 clamp(22px,2.4vw,40px) clamp(22px,2.4vw,40px)}
.kapok-auth .access-credit{position:absolute;bottom:12px;right:13px;color:white;font-size:13px}.access-credit[open]{background:#173b33;padding:0 12px 6px}.access-credit summary{cursor:pointer;min-height:44px;line-height:44px;text-align:right}
.kapok-auth .registration-confirm{max-width:min(28rem,calc(100% - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;padding:1.5rem;background:#fffdf6;color:#1a2823}.registration-confirm::backdrop{background:#142f2980}.registration-confirm-actions{display:flex;gap:.75rem;flex-wrap:wrap}
@media(max-width:860px) and (min-width:651px){.kapok-auth .access-spread{grid-template-columns:1fr .9fr;gap:28px}.kapok-auth .access-cover{min-height:465px}.kapok-auth .access-signature{font-size:55px}}
@media(max-width:650px){.kapok-auth{padding:0 clamp(17px,5vw,26px) 20px}.kapok-auth .access-mast{min-height:60px}.auth-brand b{font-size:26px}.kapok-auth .access-spread{flex:none;display:flex;flex-direction:column;gap:0;padding-block:14px 0}.kapok-auth .access-cover{order:-1;min-height:0;height:clamp(96px,18svh,150px)}.kapok-auth .access-photo{object-position:50% 32%}.kapok-auth .joining .access-photo{object-position:50% 42%}.kapok-auth .access-signature{margin:0 0 12px 14px;font-size:38px}.kapok-auth .access-credit{bottom:0;right:9px;font-size:12px}.kapok-auth .access-form-panel{padding-block:26px 0}.kapok-auth .access-entry{width:min(100%,435px)}.kapok-auth h1{font-size:clamp(33px,8vw,39px)}}
`;
}

const privateCache = 'private, no-store';
export function publicReturnTo(url: URL) {
  const query = url.searchParams.getAll('returnTo');
  return safeReturnTo(query.length === 1 ? query[0] : null);
}

export async function publicAuthEntry(request: Request, url: URL, intent: AuthIntent) {
  const returnTo = publicReturnTo(url);
  const isLogin = intent === 'login';
  const title = isLogin ? '登录工作区' : '注册队员账户';
  const introduction = isLogin ? '使用邮箱验证码登录，继续查看训练、讨论和你的复盘。' : '固定队伍 · 无需邀请码。填写资料并验证邮箱后，可确认加入 Kapok。';
  const entry = authContinuationPath(intent, returnTo).replaceAll('&', '&amp;');
  const other = authEntryPath(isLogin ? 'register' : 'login', returnTo);
  const css = 'body{margin:0}' + authStyles();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(css));
  const styleHash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const scriptDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(registrationPrefillScript));
  const scriptHash = btoa(String.fromCharCode(...new Uint8Array(scriptDigest)));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${isLogin ? '登录' : '注册'} · Kapok</title><style>${css}</style></head><body>
<div class="kapok-auth">${authMast}
<main class="access-spread" id="main-content" tabindex="-1"><section class="access-form-panel" aria-labelledby="access-title"><div class="access-entry"><h1 id="access-title">${title}</h1><p class="kapok-auth-intro">${introduction}</p>
${isLogin ? `<a class="kapok-auth-primary" href="${entry}">前往邮箱验证 →</a>` : `<form id="register-first" data-next="${entry}" novalidate><p><label>盘名（1–20字）<input name="discName" placeholder="队友怎么称呼你" aria-describedby="prefill-message" autocomplete="off" required></label></p><p><label>背号（1–4字，保留前导零）<input name="jerseyNumber" placeholder="例如 07" type="text" aria-describedby="prefill-message" autocomplete="off" required></label></p><p id="prefill-message" role="alert"></p><button class="kapok-auth-primary" type="submit">验证邮箱并继续注册</button></form><a id="prefill-fallback" hidden href="${entry}">先验证邮箱，验证后重新填写</a><noscript>需启用脚本暂存资料，或<a href="${entry}">先验证邮箱，验证后填写</a>。</noscript>`}<p class="kapok-auth-help">验证码由 Cloudflare Access 发送。未收到时请检查垃圾邮件。${isLogin ? '' : '接下来的邮箱验证页面可能显示“登录”，完成验证后可修改资料并确认注册。资料仅在本标签页暂存10分钟，若未能回填，请在验证后重新填写。'}</p><a class="kapok-auth-secondary" href="${other}">${isLogin ? '第一次来？前往注册' : '已有账号？前往登录'} →</a></div></section>${authCover(!isLogin)}</main></div>${isLogin ? '' : `<script>${registrationPrefillScript}</script>`}</body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': privateCache,
    'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${styleHash}'; img-src 'self'; font-src 'self'; ${isLogin ? '' : `script-src 'sha256-${scriptHash}'; `}frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
