import type { Principal } from '../contracts/index';

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The subject comes only from getChatGPTUser. Email is never a durable identifier.
export async function identityFor(db: D1Database, principal: Principal): Promise<string> {
  const identity = await db.prepare("SELECT user_id FROM auth_identities WHERE provider = 'site' AND subject = ?").bind(principal.subject).first<{ user_id: string }>();
  return identity?.user_id ?? `usr_${await sha256(`site:${principal.subject}`)}`;
}
