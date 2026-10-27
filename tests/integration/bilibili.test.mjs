import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliPlayerUrl } from '../../lib/client/bilibili.ts';
test('official player uses only validated BV, page and bounded integer start time',()=>{
 const url=new URL(bilibiliPlayerUrl('https://www.bilibili.com/video/BV1raQXYpEkG/?spm_id_from=333.1391.0.0&vd_source=tracking',13));
 assert.equal(url.href,'https://player.bilibili.com/player.html?bvid=BV1raQXYpEkG&p=1&autoplay=0&danmaku=0&t=13');
 for(const value of [null,'javascript:alert(1)','https://evil.test/video/BV1raQXYpEkG/','https://www.bilibili.com.evil.test/video/BV1raQXYpEkG/','https://x@www.bilibili.com/video/BV1raQXYpEkG/','https://www.bilibili.com/video/BV1raQXYpEkG/?p=-1','https://www.bilibili.com/video/BV1raQXYpEkG/?p=1.5'])assert.equal(bilibiliPlayerUrl(value),null);
 assert.equal(new URL(bilibiliPlayerUrl('https://bilibili.com/video/BV1raQXYpEkG',-1)).searchParams.get('t'),'0');
});
