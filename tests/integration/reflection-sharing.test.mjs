import { actorKey } from '../helpers/identity-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSharingFixture, principals as p, versions, syntheticContent as content } from '../helpers/sharing-browser-fixture.mjs';
import { startSharingProxy, assertLoopback } from '../helpers/sharing-browser-proxy.mjs';
import { dispatchApi } from '../../lib/server/http.ts';
async function fixture(t) { const f = await createSharingFixture(); t.after(() => f.dispose()); return f; }
async function httpCall(service, actor, path, method = 'GET', body, key = '') {
    const request = new Request(`http://kapok.local/api/v1/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { Origin: 'http://kapok.local', 'Content-Type': 'application/json', 'X-Kapok-Actor': await actorKey(actor), 'Idempotency-Key': key } });
    const response = await dispatchApi(request, path.split('?')[0].split('/'), actor, service);
    assert.match(response.headers.get('Cache-Control'), /private, no-store/);
    assert.equal(response.headers.get('X-Kapok-Actor'), await actorKey(actor));
    return { status: response.status, ...(await response.json()) };
}
test('sharing HTTP four-role lifecycle: separate grant, duplicate publication timestamp, withdraw link, revoke source and stale replay', async t => {
    const { service: s, ids, db } = await fixture(t);
    let r = (await httpCall(s, p.author, 'reflections', 'POST', content, 'create')).data;
    const id = r.id;
    for (const actor of [p.member, p.admin, p.outsider]) {
        const read = await httpCall(s, actor, `reflections/${id}`);
        assert.equal(read.status, 404); assert.equal(JSON.stringify(read).includes(content.text), false);
        assert.equal(JSON.stringify(read).includes(content.title), false);
        assert.equal((await httpCall(s, actor, `reflections/${id}/edit`)).status, actor === p.outsider ? 403 : 404);
    }
    r = (await httpCall(s, p.author, `reflections/${id}/grants`, 'PUT', { ...versions(r), scope: 'team' }, 'grant')).data;
    for (const actor of [p.member, p.admin]) {
        const read = (await httpCall(s, actor, `reflections/${id}`)).data;
        assert.equal(read.text, content.text);
        for (const field of ['scope', 'published', 'version', 'sharingVersion', 'generation', 'trainingId', 'videoId']) assert.equal(field in read, false);
        assert.deepEqual((await s.listActivity(actor)).items, []);
        assert.equal((await s.getMemberProfile(actor, ids.author)).reflections.length, 1);
    }
    assert.equal((await httpCall(s, p.outsider, `reflections/${id}`)).status, 404);
    await s.saveCollection(p.member, null, { sourceKind: 'reflection', sourceId: id, privateNote: '合成个人备注' }, 'collect');
    const publishBody = { ...versions(r), published: true };
    r = (await httpCall(s, p.author, `reflections/${id}/publication`, 'PUT', publishBody, 'publish')).data;
    const first = (await s.listActivity(p.member)).items[0];
    assert.equal(first.href, `/reflections/${id}`);
    r = (await httpCall(s, p.author, `reflections/${id}/publication`, 'PUT', { ...versions(r), published: true }, 'publish-again')).data;
    assert.deepEqual((await s.listActivity(p.member)).items, [first]);
    assert.equal((await db.prepare('SELECT published_at FROM reflections WHERE id=?').bind(id).first()).published_at, first.publishedAt);
    r = (await httpCall(s, p.author, `reflections/${id}/publication`, 'PUT', { ...versions(r), published: false }, 'withdraw')).data;
    assert.deepEqual((await s.listActivity(p.member)).items, []);
    assert.equal((await s.getReflection(p.member, id)).text, content.text);
    assert.equal((await s.getMemberProfile(p.member, ids.author)).reflections.length, 1);
    r = (await httpCall(s, p.author, `reflections/${id}/grants`, 'PUT', { ...versions(r), scope: 'private' }, 'revoke')).data;
    const replay = (await httpCall(s, p.author, `reflections/${id}/publication`, 'PUT', publishBody, 'publish')).data;
    assert.equal(replay.scope, 'private'); assert.equal(replay.published, false);
    for (const actor of [p.member, p.admin, p.outsider]) assert.equal((await httpCall(s, actor, `reflections/${id}`)).status, 404);
    assert.deepEqual((await s.getMemberProfile(p.member, ids.author)).reflections, []);
    const collection = (await s.listCollections(p.member))[0];
    assert.equal(collection.source, null); assert.equal(collection.privateNote, '合成个人备注');
    assert.equal((await s.getOwnReflection(p.author, id)).text, content.text);
});
test('sharing old non-null activity cursor and collection source are rechecked after edit and held publication replay', async t => {
    const { service: s, ids } = await fixture(t);
    const rows = [];
    for (let i = 0; i < 3; i++) {
        let r = await s.saveReflection(p.author, null, { ...content, title: `合成分页 ${i}` }, `create-${i}`);
        r = await s.shareReflection(p.author, r.id, { ...versions(r), scope: 'team' }, `grant-${i}`);
        const input = { ...versions(r), published: true };
        r = await s.publishReflection(p.author, r.id, input, `publish-${i}`);
        rows.push({ r, input, key: `publish-${i}` });
    }
    const page = await s.listActivity(p.member, null, 1);
    assert.ok(page.nextCursor);
    const afterCursor = await s.listActivity(p.member, page.nextCursor, 1);
    const target = rows.find(row => row.r.id === afterCursor.items[0].href.split('/').at(-1));
    assert.ok(target);
    await s.saveCollection(p.member, null, { sourceKind: 'reflection', sourceId: target.r.id, privateNote: '保留的合成备注' }, 'bookmark');
    const edited = await s.saveReflection(p.author, target.r.id, { ...content, title: '合成修改后', ...versions(target.r) }, 'edit');
    assert.equal(edited.scope, 'private'); assert.equal(edited.published, false);
    const replay = await s.publishReflection(p.author, target.r.id, target.input, target.key);
    assert.equal(replay.scope, 'private'); assert.equal(replay.published, false);
    const rechecked = await s.listActivity(p.member, page.nextCursor, 30);
    assert.ok(rechecked.items.every(item => item.href !== `/reflections/${target.r.id}`));
    assert.ok((await s.getMemberProfile(p.member, ids.author)).reflections.every(row => row.id !== target.r.id));
    assert.equal((await s.listCollections(p.member))[0].source, null);
    await assert.rejects(s.getReflection(p.member, target.r.id), e => e.code === 'NOT_FOUND');
});
test('sharing synthetic proxy binds loopback, sanitizes identity headers, preserves hostile Origin and refuses open-proxy paths', async t => {
    for (const upstream of ['http://example.com', 'https://127.0.0.1', 'http://127.0.0.1/secret', 'http://user@127.0.0.1']) assert.throws(() => assertLoopback(upstream));
    await assert.rejects(startSharingProxy({ upstream: 'http://127.0.0.1:1', role: 'arbitrary' }));
    const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ headers: req.headers, path: req.url })); });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const proxy = await startSharingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, role: 'member' });
    t.after(() => { proxy.closeAllConnections(); proxy.close(); });
    assert.equal(proxy.address().address, '127.0.0.1');
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    const result = await fetch(origin + '/api/v1/bootstrap', { headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@invalid.test', 'oai-authenticated-user-full-name': 'not allowed', 'x-forwarded-host': 'evil.test', Origin: origin } });
    const data = await result.json();
    assert.equal(data.headers['oai-authenticated-user-id'], 'sharing_member');
    assert.equal(data.headers['oai-authenticated-user-email'], 'member@sites.test');
    assert.equal(data.headers['oai-authenticated-user-full-name'], undefined);
    assert.equal(data.headers['x-forwarded-host'], undefined);
    assert.equal(data.headers.origin, `http://127.0.0.1:${upstream.address().port}`);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
    const hostile = await (await fetch(origin + '/write', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).json();
    assert.equal(hostile.headers.origin, 'https://evil.test');
    for (const path of ['http://example.com/', '//example.com/', '/\\example.com/']) {
        const refused = await new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port: proxy.address().port, path }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
        assert.equal(refused, 400);
    }
});
