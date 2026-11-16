import type { Principal } from '../contracts/index';

export type AccessIdentityConfig = {
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_ALLOWED_HOST?: string;
};

const accessAssertion = 'Cf-Access-Jwt-Assertion';
const rsa = 'RSASSA-PKCS1-v1_5';
type JwtObject = Record<string, unknown>;

// Cache only public key material, never assertions, identities, or permissions.
// Like jose's remote JWKS policy: bounded freshness and a rotation cooldown.
const keyMaxAgeMs = 5 * 60_000;
const rotationCooldownMs = 30_000;
type PublicKeys = { fetchedAt: number; keys: JwtObject[]; imported: Map<string, CryptoKey> };
const keyCaches = new WeakMap<typeof fetch, Map<string, PublicKeys>>();

async function publicKeys(issuer: string, kid: string, fetchKeys: typeof fetch): Promise<PublicKeys> {
  let cache = keyCaches.get(fetchKeys);
  if (!cache) { cache = new Map(); keyCaches.set(fetchKeys, cache); }
  const previous = cache.get(issuer);
  const now = Date.now();
  if (previous && now >= previous.fetchedAt && now - previous.fetchedAt < keyMaxAgeMs &&
      (previous.keys.some(key => key.kid === kid) || now - previous.fetchedAt < rotationCooldownMs)) return previous;
  // Keep request-owned I/O out of isolate-wide state (Workers can cancel it when
  // its originating request ends). Only fully read key sets are shared.
  const response = await fetchKeys(`${issuer}/cdn-cgi/access/certs`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error('Public key fetch failed');
  const { keys } = object(await response.json());
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32) throw new Error('Invalid public key set');
  const next: PublicKeys = { fetchedAt: now, keys: keys.map(object), imported: new Map() };
  // A slower request must not overwrite a newer rotation snapshot.
  if (!cache.get(issuer) || cache.get(issuer)!.fetchedAt <= now) {
    if (!cache.has(issuer) && cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(issuer, next);
  }
  return next;
}

function decode(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('Invalid JWT encoding');
  return Uint8Array.from(atob(segment.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function object(value: unknown): JwtObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JWT object');
  return value as JwtObject;
}

function decodeObject(segment: string) {
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(segment))));
}

// The issuer and audience are configured independently of the incoming assertion.
// Cloudflare publishes its rotating public keys on the configured team origin.
export async function verifyAccessPrincipal(
  request: Request,
  { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, ACCESS_ALLOWED_HOST: allowedHost }: AccessIdentityConfig,
  fetchKeys: typeof fetch = fetch,
): Promise<Extract<Principal, { provider: 'access' }> | null> {
  if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
      !audience || !/^[A-Za-z0-9_-]+$/.test(audience) ||
      !allowedHost || !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(allowedHost)) return null;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.host !== allowedHost) return null;
  const token = request.headers.get(accessAssertion);
  if (!token || token.length > 16_384) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const { alg, kid, crit, b64 } = decodeObject(encodedHeader);
    if (alg !== 'RS256' || typeof kid !== 'string' || !kid || crit !== undefined || b64 !== undefined) return null;
    const { iss, aud, exp, iat, nbf, sub, email, type } = decodeObject(encodedClaims);
    const now = Math.floor(Date.now() / 1000);
    if (iss !== issuer || !Array.isArray(aud) || aud.length !== 1 || aud[0] !== audience || type !== 'app' ||
        typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= now ||
        typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat > now || iat >= exp ||
        typeof nbf !== 'number' || !Number.isSafeInteger(nbf) || nbf > now || nbf >= exp ||
        typeof sub !== 'string' || !sub || sub.length > 255 || /\s|[\u0000-\u001f\u007f]/.test(sub) ||
        typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;

    const signature = decode(encodedSignature);
    const keySet = await publicKeys(issuer, kid, fetchKeys);
    const matching = keySet.keys.filter(key => key.kid === kid);
    const [key] = matching;
    if (matching.length !== 1 || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig')) return null;
    let publicKey = keySet.imported.get(kid);
    if (!publicKey) {
      publicKey = await crypto.subtle.importKey('jwk', key as JsonWebKey, { name: rsa, hash: 'SHA-256' }, false, ['verify']);
      keySet.imported.set(kid, publicKey);
    }
    if (!await crypto.subtle.verify(rsa, publicKey, signature, new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`))) return null;
    if (exp <= Math.floor(Date.now() / 1000)) return null;
    return { provider: 'access', issuer, subject: sub, verifiedEmail: email };
  } catch {
    return null;
  }
}
