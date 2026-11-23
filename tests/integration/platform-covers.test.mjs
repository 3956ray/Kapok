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
      objects.set(key, { bytes, httpMetadata:options.httpMetadata, uploaded:new Date(), etag:'test' });
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
  assert.equal(fetcher.mock.callCount(),1);
});
