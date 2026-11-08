import { LEGACY_SITES_ISSUER } from '../contracts/index.ts';
import type { Me, Principal } from '../contracts/index';

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function identityTuple(principal: Principal) {
  return [principal.provider, principal.issuer, principal.subject] as const;
}

// Evaluate the same Access binding and membership epoch captured by the caller's account read.
export function accessMembershipFence(principal: Principal | null, account: Me) {
  if (principal?.provider !== 'access') return { predicate: '1', values: [] };
  return {
    predicate: `EXISTS(SELECT 1 FROM auth_identities ai
        JOIN users au ON au.id=ai.user_id JOIN memberships am ON am.user_id=au.id
        WHERE au.id=? AND au.status='active' AND ai.provider=? AND ai.issuer=? AND ai.subject=?
        AND am.team_id=? AND am.status='active' AND am.epoch=?)`,
    values: [account.user?.id ?? null, ...identityTuple(principal), account.membership?.teamId ?? null, account.membership?.epoch ?? null],
  };
}

export async function actorKey(principal: Principal): Promise<string> {
  return `actor_${await sha256(JSON.stringify(identityTuple(principal)))}`;
}

export async function identityFor(db: D1Database, principal: Principal): Promise<string> {
  const identity = await db.prepare('SELECT user_id FROM auth_identities WHERE provider=? AND issuer=? AND subject=?')
    .bind(...identityTuple(principal)).first<{ user_id: string }>();
  if (identity) return identity.user_id;
  const namespace = principal.provider === 'site' && principal.issuer === LEGACY_SITES_ISSUER
    ? `site:${principal.subject}`
    : JSON.stringify(identityTuple(principal));
  return `usr_${await sha256(namespace)}`;
}
