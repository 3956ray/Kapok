import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoCover } from '../../lib/server/video-covers.ts';

const jpeg = Uint8Array.from([255,216,255,224,0,0,255,217]);
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    get: async key => {
      const data = objects.get(key);
      return data ? { ...data, size:data.bytes.length, body:new Response(data.bytes).body } : null;
    },
    put: async (key, bytes, options) => {
      objects.set(key, { bytes, httpMetadata:options.httpMetadata, customMetadata:options.customMetadata, uploaded:new Date(), etag:'test' });
    },
  };
}
test('YouTube covers share cached artwork across different playback timestamps', async t => {
  const bucket = memoryBucket();
  const fetcher = t.mock.method(globalThis,'fetch', async url => {
    assert.equal(url,'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    return new Response(jpeg);
  });
  for (const url of ['https://youtu.be/dQw4w9WgXcQ','https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s']) {
    const r=await videoCover(bucket,url);
    assert.equal(r.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),jpeg);
  }
  assert.equal(fetcher.mock.callCount(),1);
});
test('Bilibili retrieves the upload cover from the video page when metadata is unavailable', async t => {
  const bucket=memoryBucket();
  t.mock.method(globalThis,'fetch', async (url, opts) => {
    assert.equal(opts.redirect,'error');
    if (url.includes('api.bilibili.com')) return new Response('',{status:412});
    if (url.includes('www.bilibili.com')) return new Response('<meta content="//i0.hdslb.com/bfs/archive/test.jpg@1200w_630h" property="og:image">');
    assert.equal(url,'https://i0.hdslb.com/bfs/archive/test.jpg@960w.webp');
    return new Response(jpeg);
  });
  assert.equal((await videoCover(bucket,'https://www.bilibili.com/video/BV1xx411c7mD/?p=2')).status,200);
  assert(bucket.objects.has('platform-covers/v1/bilibili/BV1xx411c7mD'));
});
test('missing or invalid artwork returns the default image and avoids repeated upstream requests', async t => {
  const bucket=memoryBucket(), fetcher=t.mock.method(globalThis,'fetch', async ()=> new Response('<html>'));
  assert.equal((await videoCover(bucket,'https://example.org/v')).status,302);
  assert.equal(fetcher.mock.callCount(),0);
  for (let i=0;i<2;i++) {
    const r=await videoCover(bucket,'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(r.headers.get('location'),'/workspace-assets/media/video-cover-unavailable.svg');
  }
  assert.equal(fetcher.mock.callCount(),3);
});

test('YouTube retries another official host for the same video despite a cached legacy miss', async t => {
  const bucket = memoryBucket();
  const key = 'platform-covers/v1/youtube/dQw4w9WgXcQ';
  await bucket.put(key, new Uint8Array(), {});
  const urls = [];
  t.mock.method(globalThis,'fetch', async (url, options) => {
    assert.equal(options.redirect,'error');
    urls.push(url);
    if (urls.length === 1) return new Response('temporarily unavailable', { status:503 });
    return new Response(jpeg);
  });
  const response = await videoCover(bucket,'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s');
  assert.equal(response.headers.get('content-type'),'image/jpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),jpeg);
  assert.deepEqual(urls,['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg','https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg']);
  assert.deepEqual(bucket.objects.get(key).bytes,jpeg);
});
test('YouTube probes WebP when JPEG renditions fail and quickly retries a temporary miss', async t => {
  const bucket = memoryBucket();
  const key = 'platform-covers/v1/youtube/dQw4w9WgXcQ';
  const webp = new TextEncoder().encode('RIFF1234WEBP');
  const url = 'https://youtu.be/dQw4w9WgXcQ';
  let available = false, attempts = 0;
  t.mock.method(globalThis,'fetch',async href => {
    attempts++;
    return available && href === 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/hqdefault.webp'
      ? new Response(webp) : new Response('Bad gateway',{ status:502 });
  });
  assert.equal((await videoCover(bucket,url)).status,302);
  available = true;
  assert.equal((await videoCover(bucket,url)).status,302);
  assert.equal(attempts,3);
  bucket.objects.get(key).uploaded = new Date(Date.now() - 31000);
  const recovered = await videoCover(bucket,url);
  assert.equal(recovered.headers.get('content-type'),'image/webp');
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()),webp);
});
