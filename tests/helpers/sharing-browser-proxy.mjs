// Test-only loopback synthetic identity injection. Never imported by app/build sources.
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const roles = ['admin', 'author', 'member', 'outsider'];
export function assertLoopback(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only a plain loopback HTTP upstream is allowed.');
    return url;
}
export async function startSharingProxy({ upstream, role, port = 0 }) {
    const target = assertLoopback(upstream);
    if (!roles.includes(role)) throw new Error('Unknown synthetic role.');
    const server = http.createServer((req, res) => {
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end('Only local paths are allowed.'); return; }
        const destination = new URL(req.url, target);
        if (destination.origin !== target.origin) { res.writeHead(400); res.end('Only the fixed loopback upstream is allowed.'); return; }
        const headers = { ...req.headers };
        for (const name of Object.keys(headers)) if (/^(?:oai-authenticated-user-|x-forwarded-|forwarded$)/i.test(name)) delete headers[name];
        const localOrigin = `http://127.0.0.1:${server.address().port}`;
        headers.host = target.host;
        headers['oai-authenticated-user-id'] = `sharing_${role}`;
        headers['oai-authenticated-user-email'] = `${role}@sites.test`;
        // Preserve hostile origins so the real service's same-origin check still rejects them.
        if (headers.origin === localOrigin) headers.origin = target.origin;
        const outgoing = http.request(destination, { method: req.method, headers }, incoming => {
            const responseHeaders = { ...incoming.headers, 'cache-control': 'private, no-store, max-age=0' };
            if (responseHeaders.location) {
                const location = new URL(responseHeaders.location, target);
                if (location.origin === target.origin) responseHeaders.location = localOrigin + location.pathname + location.search + location.hash;
            }
            res.writeHead(incoming.statusCode ?? 502, responseHeaders); incoming.pipe(res);
        });
        outgoing.setTimeout(30_000, () => outgoing.destroy());
        outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' }); res.end('Local built upstream unavailable.'); });
        req.on('aborted', () => outgoing.destroy()); req.pipe(outgoing);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const upstream = process.argv[2] ?? 'http://127.0.0.1:8790';
    const servers = [];
    try {
        for (const [index, role] of roles.entries()) { const server = await startSharingProxy({ upstream, role, port: 8791 + index }); servers.push(server); console.log(`LOCAL SYNTHETIC ${role}: http://127.0.0.1:${8791 + index}`); }
    } catch (e) { for (const server of servers) server.close(); throw e; }
    const stop = () => { for (const server of servers) server.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
