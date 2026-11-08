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

export const authStyles = `
.kapok-auth{min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:minmax(0,46fr) minmax(0,54fr);background:#f7f8f5;color:#203a2e;font:1rem/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.kapok-auth,.kapok-auth *{box-sizing:border-box}
.kapok-auth-brand{background:#203d32;color:#eff4e7;padding:2.5rem clamp(1.5rem,3.3vw,2.625rem) 1.75rem;display:flex;flex-direction:column;gap:1.5rem;min-width:0}
.kapok-auth-wordmark{display:inline-flex;align-items:center;gap:.125rem;align-self:flex-start;min-height:44px;padding-inline:2px;font-weight:800;font-size:1.5625rem;letter-spacing:-.045em;color:inherit;text-decoration:none}
.kapok-auth-wordmark span{color:#d2dea5}
.kapok-auth-brand-copy{margin-top:clamp(1.5rem,5.25vw,4.75rem)}
.kapok-auth-brand p{margin:0}
.kapok-auth-brand-copy>p:last-child{color:#c1d0c3;font-size:.875rem;line-height:1.9}
.kapok-auth-brand .kapok-auth-brand-title{font-weight:700;font-size:clamp(2rem,3.2vw,2.7rem);line-height:1.4;letter-spacing:-.04em;margin:1.25rem 0}
.kapok-auth-court{position:relative;min-height:clamp(8rem,16vw,13.75rem);overflow:hidden}
.kapok-auth-court::before,.kapok-auth-court::after{content:"";position:absolute;border-radius:50%;transform:rotate(-24deg)}
.kapok-auth-court::before{inset:18% 2% auto 1%;aspect-ratio:2.1;border:1px solid #b7cda65c;outline:1px solid #b7cda638;outline-offset:-1rem}
.kapok-auth-court::after{top:25%;right:6%;width:35%;aspect-ratio:2.8;background:#d2dea5;border:1px solid #9db384;box-shadow:0 5px 0 #9db384,inset 0 0 0 .5rem #d2dea5,inset 0 0 0 calc(.5rem + 1px) #9db384}
.kapok-auth-brand .kapok-auth-brand-foot{margin-top:auto;color:#c1d0c3;font-size:.75rem;letter-spacing:.08em}
.kapok-auth-main{min-width:0;display:grid;grid-template-columns:minmax(0,380px);align-content:center;justify-content:center;justify-items:start;gap:1rem;padding:clamp(1.5rem,4.5vw,4rem);overflow-wrap:anywhere}
.kapok-auth-main h1{margin:0;color:inherit;font-size:clamp(1.75rem,3vw,2.125rem);line-height:1.38;letter-spacing:-.035em}
.kapok-auth-main p,.kapok-auth-main ul{margin:0}
.kapok-auth-intro{color:#536159;font-size:.9375rem;line-height:1.75}
.kapok-auth-help{color:#536159;font-size:.8125rem}
.kapok-auth-main ul{padding-inline-start:1.5rem}
.kapok-auth-main [data-kapok-sensitive]{width:100%}
.kapok-auth-main form{width:100%}.kapok-auth-main input{display:block;width:100%;min-width:0;min-height:44px;padding:.5rem;border:1px solid #536159;border-radius:.5rem;font:inherit;margin-bottom:1rem}.kapok-auth-main [hidden]{display:none}
.kapok-auth-main .registration-confirm{position:fixed;inset:0;margin:auto;width:min(28rem,calc(100% - 2rem));max-height:calc(100dvh - 2rem);overflow:auto;padding:1.5rem;border:1px solid #466355;border-radius:1rem;background:#f7f8f5;color:#203a2e;overflow-wrap:anywhere}
.kapok-auth-main .registration-confirm::backdrop{background:#172f2680}
.kapok-auth-main .registration-confirm-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
.kapok-auth-label{font-size:.6875rem;font-weight:650;letter-spacing:.14em}
.kapok-auth-team{display:flex;align-items:center;gap:.75rem;width:100%;padding:.75rem .875rem;background:#edf1e9;border:1px solid #dce1d9;border-radius:.75rem}
.kapok-auth-team>span:first-child{display:grid;place-items:center;flex:0 0 2rem;height:2rem;border-radius:.5rem;background:#cfdbc3;font-size:.875rem;font-weight:750}
.kapok-auth-team small{display:block;color:#536159}
.kapok-auth-primary{display:inline-flex;justify-content:center;align-items:center;width:100%;min-height:50px;background:#245b42;color:#fff;padding:.75rem 1rem;border-radius:.625rem;text-decoration:none;font-weight:700;text-align:center}
.kapok-auth-secondary{display:inline-flex;align-items:center;min-height:44px;color:#244e3e;text-underline-offset:.22em;font-size:.875rem;font-weight:650}
.kapok-auth a:focus-visible,.kapok-auth button:focus-visible,.kapok-auth input:focus-visible{outline:3px solid #bb5916;outline-offset:3px}
@media(min-width:900px){body:has(.kapok-auth){background:#e8ebe3}.kapok-auth{width:calc(100% - 40px);max-width:1280px;min-height:min(760px,calc(100dvh - 48px));margin:24px auto;border:1px solid #d5ded0;border-radius:16px;overflow:clip;box-shadow:0 20px 60px #1a2c1e0c}}
@media(max-width:899px){.kapok-auth{grid-template-columns:minmax(0,1fr);grid-template-rows:auto 1fr}.kapok-auth-brand{padding:1rem max(1.5rem,calc((100% - 380px)/2));background:transparent;color:inherit}.kapok-auth-wordmark span{color:#a76631}.kapok-auth-brand-copy,.kapok-auth-court,.kapok-auth-brand-foot{display:none}.kapok-auth-main{align-content:start;padding-top:2rem}}
`;

const privateCache = 'private, no-store';
export function publicReturnTo(url: URL) {
  const query = url.searchParams.getAll('returnTo');
  return safeReturnTo(query.length === 1 ? query[0] : null);
}

export async function publicAuthEntry(request: Request, url: URL, intent: AuthIntent) {
  const returnTo = publicReturnTo(url);
  const isLogin = intent === 'login';
  const title = isLogin ? '回到队伍，继续一起进步。' : '加入 Kapok，从认识彼此开始。';
  const introduction = isLogin ? '使用邮箱验证码登录，继续查看训练、讨论和你的复盘。' : '填写资料 → 验证邮箱 → 确认注册。任何邮箱完成验证并确认注册后，即可直接加入 Kapok 队伍，查看球队训练、视频和讨论。';
  const entry = authContinuationPath(intent, returnTo).replaceAll('&', '&amp;');
  const other = authEntryPath(isLogin ? 'register' : 'login', returnTo);
  const css = 'body{margin:0}' + authStyles;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(css));
  const styleHash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const scriptDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(registrationPrefillScript));
  const scriptHash = btoa(String.fromCharCode(...new Uint8Array(scriptDigest)));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${isLogin ? '登录' : '注册'} · Kapok</title><style>${css}</style></head><body>
<div class="kapok-auth">
<header class="kapok-auth-brand"><a href="/" class="kapok-auth-wordmark">Kapok<span aria-hidden="true">•</span></a><div class="kapok-auth-brand-copy"><p class="kapok-auth-label">Kapok Bloom</p><p class="kapok-auth-brand-title">每次上场，<br>都有新的可能。</p><p>属于一支队伍。<br>也属于每一个认真成长的你。</p></div><div class="kapok-auth-court" aria-hidden="true"></div><p class="kapok-auth-brand-foot">训练 · 连接 · 成长</p></header>
<main class="kapok-auth-main"><p class="kapok-auth-label">${isLogin ? '登录' : '注册'} · Kapok Bloom</p><h1>${title.replace('，', '，<br>')}</h1><p class="kapok-auth-intro">${introduction}</p>
${isLogin ? '' : '<div class="kapok-auth-team"><span aria-hidden="true">K</span><span><strong>Kapok</strong><small>固定队伍 · 无需邀请码</small></span></div>'}
${isLogin ? `<a class="kapok-auth-primary" href="${entry}">前往邮箱验证 →</a>` : `<form id="register-first" data-next="${entry}" novalidate><p><label>盘名（1–20字）<input name="discName" aria-describedby="prefill-message" autocomplete="off" required></label></p><p><label>背号（1–4字，保留前导零）<input name="jerseyNumber" type="text" aria-describedby="prefill-message" autocomplete="off" required></label></p><p id="prefill-message" role="alert"></p><button class="kapok-auth-primary" type="submit">验证邮箱并继续注册</button></form><a id="prefill-fallback" hidden href="${entry}">先验证邮箱，验证后重新填写</a><noscript>需启用脚本暂存资料，或<a href="${entry}">先验证邮箱，验证后填写</a>。</noscript>`}<p class="kapok-auth-help">若未收到验证码，请检查邮箱地址和垃圾邮件，或重试。验证码由 Cloudflare Access 提供。${isLogin ? '' : '接下来的邮箱验证页面可能显示“登录”，完成验证后可修改资料并确认注册。资料仅在本标签页暂存10分钟，若未能回填，请在验证后重新填写。'}若验证取消或失败，可返回此页继续。</p><a class="kapok-auth-secondary" href="${other}">${isLogin ? '第一次来？前往注册' : '已有账号？前往登录'} →</a></main></div>${isLogin ? '' : `<script>${registrationPrefillScript}</script>`}</body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': privateCache,
    'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${styleHash}'; ${isLogin ? '' : `script-src 'sha256-${scriptHash}'; `}frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  } });
}
