import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorKey } from '../../lib/server/identity.ts';
import { verifyAccessPrincipal } from '../../lib/server/access-identity.ts';

const issuer = 'https://synthetic-team.cloudflareaccess.com';
const production = { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: 'synthetic-production', ACCESS_ALLOWED_HOST: 'prod.example.test' };
const staging = { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: 'synthetic-staging', ACCESS_ALLOWED_HOST: 'staging.example.test' };
const site = { provider: 'site', issuer: 'sites:legacy', subject: 'same-subject' };
const now = Math.floor(Date.now() / 1000);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const keys = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'synthetic-key' };
const fetchKeys = async url => {
    assert.equal(url, issuer + '/cdn-cgi/access/certs');
    return Response.json({ keys: [jwk] });
};
const sign = async (config = production, claims = {}, header = {}, privateKey = keys.privateKey) => {
    const content = encode({ alg: 'RS256', kid: jwk.kid, ...header }) + '.' + encode({
        type: 'app', aud: [config.ACCESS_AUDIENCE], iss: config.ACCESS_ISSUER, sub: site.subject, email: 'member@example.test',
        iat: now - 60, nbf: now - 60, exp: now + 60, ...claims,
    });
    const signature = await crypto.subtle.sign(params, privateKey, new TextEncoder().encode(content));
    return content + '.' + Buffer.from(signature).toString('base64url');
};
const verify = (token, config = production, host = config.ACCESS_ALLOWED_HOST, fetcher = fetchKeys, protocol = 'https') => verifyAccessPrincipal(
    new Request(`${protocol}://${host ?? 'unconfigured.example.test'}/`, { headers: {
        'Cf-Access-Jwt-Assertion': token, 'Host': production.ACCESS_ALLOWED_HOST, 'oai-authenticated-user-id': site.subject, 'oai-authenticated-user-email': 'spoof@example.test',
    } }),
    config, fetcher,
);

test('verified application assertion supplies trusted identity and distinguishes provider, issuer, and subject', async () => {
    const principal = await verify(await sign());
    assert.deepEqual(principal, { provider: 'access', issuer, subject: site.subject, verifiedEmail: 'member@example.test' });
    assert.notEqual(await actorKey(site), await actorKey(principal));
    assert.notEqual(await actorKey(principal), await actorKey({ ...principal, issuer: 'https://other-team.cloudflareaccess.com' }));
    assert.notEqual(await actorKey(principal), await actorKey({ ...principal, subject: 'other' }));
});

test('forged, invalid-claim, malformed, or unexpected key assertions fail closed', async () => {
    for (const token of [
        await sign(production, {}, {}, other.privateKey),
        await sign(production, {}, { alg: 'none' }),
        await sign(production, {}, { kid: 'unknown' }),
        await sign(production, { exp: now }),
        await sign(production, { nbf: now + 60 }),
        await sign(production, { iat: now + 60 }),
        await sign(production, { iss: 'https://forged.cloudflareaccess.com' }),
        await sign(production, { type: 'org' }),
        await sign(production, { sub: '' }),
        await sign(production, { email: undefined }),
        'broken',
        '',
    ]) assert.equal(await verify(token), null);
    const token = await sign();
    assert.equal(await verify(token, production, production.ACCESS_ALLOWED_HOST, async () => { throw Error('synthetic network failure'); }), null);
    assert.equal(await verify(token, production, production.ACCESS_ALLOWED_HOST, async () => Response.json({ keys: [] })), null);
});

test('staging and production deny each other even on the same issuer and signing key', async () => {
    assert.equal(await verify(await sign(production, { aud: [production.ACCESS_AUDIENCE, staging.ACCESS_AUDIENCE] })), null);
    assert.equal(await verify(await sign(), production, production.ACCESS_ALLOWED_HOST, fetchKeys, 'http'), null);
    for (const [source, target] of [[production, staging], [staging, production]]) {
        const token = await sign(source);
        assert.ok(await verify(token, source));
        assert.equal(await verify(token, target), null);
        assert.equal(await verify(token, source, target.ACCESS_ALLOWED_HOST), null);
        assert.equal(await verify(token, { ...source, ACCESS_AUDIENCE: undefined }), null);
        assert.equal(await verify(token, { ...source, ACCESS_ISSUER: undefined }), null);
        assert.equal(await verify(token, { ...source, ACCESS_ALLOWED_HOST: undefined }), null);
    }
});

test('Sites headers can only be used inside the trusted Sites entry scope', async () => {
    const { authMode, scopedPrincipal, runWithSitesIdentity, runWithAccessIdentity } = await import('../../lib/server/request-identity.ts');
    const spoof = new Headers({ 'oai-authenticated-user-id': site.subject, 'oai-authenticated-user-email': 'spoof@example.test' });
    assert.equal(authMode(), undefined);
    assert.equal(scopedPrincipal(spoof), null);
    const access = await verify(await sign());
    await Promise.all([
        runWithSitesIdentity(async () => {
            await Promise.resolve();
            assert.equal(authMode(), 'site');
            assert.deepEqual(scopedPrincipal(spoof), site);
        }),
        runWithAccessIdentity(access, async () => {
            await Promise.resolve();
            assert.equal(authMode(), 'access');
            assert.deepEqual(scopedPrincipal(spoof), access);
        }),
        runWithAccessIdentity(null, async () => {
            await Promise.resolve();
            assert.equal(scopedPrincipal(spoof), null);
        }),
    ]);
    assert.equal(scopedPrincipal(spoof), null);
});

test('warm public-key cache removes repeat network waits but verifies each identity and signature', async () => {
    let requests = 0;
    const fetcher = async () => { requests++; return Response.json({ keys: [jwk] }); };
    const check = token => verify(token, production, production.ACCESS_ALLOWED_HOST, fetcher);
    assert.ok(await check(await sign()));
    assert.equal((await check(await sign(production, { sub: 'second-member' }))).subject, 'second-member');
    assert.equal(await check(await sign(production, {}, {}, other.privateKey)), null);
    assert.equal(await check(await sign(production, { exp: now })), null);
    assert.equal(requests, 1);
});

test('unknown signing key refreshes after cooldown and expired keys cannot survive a failed refresh', async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    let requests = 0;
    let offline = false;
    const rotated = { ...await crypto.subtle.exportKey('jwk', other.publicKey), kid: 'rotated-key' };
    const fetcher = async () => {
        requests++;
        if (offline) throw Error('offline');
        return Response.json({ keys: requests === 1 ? [jwk] : [rotated] });
    };
    const check = token => verify(token, production, production.ACCESS_ALLOWED_HOST, fetcher);
    const original = await sign(production, { exp: now + 3600 });
    const next = await sign(production, { exp: now + 3600 }, { kid: rotated.kid }, other.privateKey);
    assert.ok(await check(original));
    assert.equal(await check(next), null);
    assert.equal(requests, 1);
    clock += 30_001;
    assert.ok(await check(next));
    assert.equal(requests, 2);
    assert.equal(await check(original), null);
    clock += 300_001;
    offline = true;
    assert.equal(await check(next), null);
    assert.equal(requests, 3);
    offline = false;
    assert.ok(await check(next));
    assert.equal(requests, 4);
});

test('cached key sets remain isolated by issuer and ambiguous keys fail closed', async () => {
    const second = { ...production, ACCESS_ISSUER: 'https://second-team.cloudflareaccess.com' };
    const urls = [];
    const fetcher = async url => { urls.push(url); return Response.json({ keys: url.startsWith(issuer) ? [jwk] : [jwk, jwk] }); };
    assert.ok(await verify(await sign(), production, production.ACCESS_ALLOWED_HOST, fetcher));
    assert.equal(await verify(await sign(second), second, second.ACCESS_ALLOWED_HOST, fetcher), null);
    assert.equal(urls.length, 2);
});
