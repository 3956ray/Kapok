import { AsyncLocalStorage } from 'node:async_hooks';
import { LEGACY_SITES_ISSUER } from '../contracts/index.ts';
import type { Principal } from '../contracts/index';

type AccessPrincipal = Extract<Principal, { provider: 'access' }>;
type AuthScope = { mode: 'site' } | { mode: 'access'; principal: AccessPrincipal | null };
const identityScope = new AsyncLocalStorage<AuthScope>();

export function runWithSitesIdentity<T>(run: () => T): T {
  return identityScope.run({ mode: 'site' }, run);
}

// The independent ingress passes only the result of verifyAccessPrincipal.
export function runWithAccessIdentity<T>(principal: AccessPrincipal | null, run: () => T): T {
  return identityScope.run({ mode: 'access', principal }, run);
}

export function authMode() {
  return identityScope.getStore()?.mode;
}

export function scopedPrincipal(headers: Headers): Principal | null {
  const scope = identityScope.getStore();
  if (scope?.mode === 'access') return scope.principal;
  if (scope?.mode !== 'site') return null;
  const subject = headers.get('oai-authenticated-user-id');
  if (!subject || !headers.get('oai-authenticated-user-email')) return null;
  return { provider: 'site', issuer: LEGACY_SITES_ISSUER, subject };
}
