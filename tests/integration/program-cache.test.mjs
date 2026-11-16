import assert from 'node:assert/strict';
import { test } from 'node:test';
import { programCacheControl } from '../../build/program-cache.ts';
import { isProgramChunk } from '../../build/program-assets-plugin.ts';
const origin = 'https://kapok.party';
const js = '/_next/static/chunks/growth-content-Abcd123_.js';
const css = '/_next/static/css/index.Abcd123_.css';
test('provenance allowlist rejects data-bearing shared chunks and unknown modules', () => {
  assert.equal(isProgramChunk(js.slice(1), ['/app/components/growth-content.tsx']), true);
  for (const modules of [[], ['/app/a.tsx','/lib/import/initial-batch.json'], ['/app/a.tsx','/data/private.json?commonjs-proxy'], ['/lib/import/initial-videos.mjs']]) {
    assert.equal(isProgramChunk(js.slice(1), modules), false);
  }
});
const policy = (route, init = {}, status = 200, headers = {}) => programCacheControl(
  new Request(origin + route, init), new Response(null, { status, headers: { 'Content-Type': 'application/javascript', ...headers } }), new Set([js, css]));
test('only fingerprinted program GET successes get private immutable caching', () => {
  assert.equal(programCacheControl(new Request(origin + js), new Response(null, {headers:{'Content-Type':'application/javascript'}}), new Set()), 'private, no-store');
  assert.equal(policy(js), 'private, max-age=31536000, immutable');
  assert.equal(policy(css, {}, 200, { 'Content-Type': 'text/css; charset=utf-8' }), 'private, max-age=31536000, immutable');
  for (const route of ['/home','/api/v1/me','/api/v1/videos/id/media','/_next/static/build/_buildManifest.js','/_next/static/chunks/app.js',js+'.map',js+'?v=1','/vendor/player.js',css]) assert.equal(policy(route), 'private, no-store', route);
  for (const status of [206, 301, 302, 304, 401, 403, 404, 500]) assert.equal(policy(js, {}, status), 'private, no-store');
  for (const init of [{method:'HEAD'},{method:'POST'},{headers:{Range:'bytes=0-10'}},{headers:{RSC:'1'}}]) assert.equal(policy(js,init), 'private, no-store');
  for (const headers of [{'Content-Type':'text/html'},{'Content-Type':'application/json'},{'Set-Cookie':'test=1'}]) assert.equal(policy(js,{},200,headers), 'private, no-store');
});
