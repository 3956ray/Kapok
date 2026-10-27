import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBilibiliShare } from '../../lib/server/bilibili.ts';
const share='【【华工飞盘】第七届CUUA岭南预选赛  小组赛 vs港科广-哔哩哔哩】 https://b23.tv/vP9CEuO';
const canonical='https://www.bilibili.com/video/BV1raQXYpEkG/';
test('mobile share text and bare short link resolve without retaining tracking',async()=>{
 for(const input of [share,'https://b23.tv/vP9CEuO','“'+share+'”']) {
  const calls=[];
  assert.equal(await resolveBilibiliShare(input,async(url,options)=>{
   calls.push(url);assert.equal(options.method,'HEAD');assert.equal(options.redirect,'manual');assert.ok(options.signal);
   return new Response(null,{status:302,headers:{location:canonical+'?p=1&vd_source=tracking'}});
  }),canonical);assert.deepEqual(calls,['https://b23.tv/vP9CEuO']);
 }
});
test('full share, BV and p normalize without network',async()=>{
 const never=()=>{throw new Error('unexpected network');};
 assert.equal(await resolveBilibiliShare('【标题】 '+canonical+'?p=2&junk=1',never),canonical+'?p=2');
 assert.equal(await resolveBilibiliShare('BV1raQXYpEkG',never),canonical);
});
test('reject unrelated hosts, ambiguous shares and malicious redirect before outbound follow',async()=>{
 const never=()=>{throw new Error('unexpected network');};
 for(const input of ['https://evil.test/x','https://b23.tv.evil.test/x','https://user@b23.tv/x','http://b23.tv/x','https://b23.tv:444/x',share+' '+canonical,'x'.repeat(2001)])await assert.rejects(resolveBilibiliShare(input,never));
 for(const destination of ['https://127.0.0.1/x','http://169.254.169.254/x','https://evil.test/x','https://user@www.bilibili.com/video/BV1raQXYpEkG/','https://www.bilibili.com/not-video']){
  let count=0;await assert.rejects(resolveBilibiliShare(share,async()=>{count++;return new Response(null,{status:302,headers:{location:destination}});}));assert.equal(count,1);
 }
});
test('bounded redirects, loop, missing redirect and network failure have useful errors',async()=>{
 let count=0;await assert.rejects(resolveBilibiliShare(share,async()=>{count++;return new Response(null,{status:302,headers:{location:'https://b23.tv/code'+count}});}));assert.equal(count,3);
 await assert.rejects(resolveBilibiliShare(share,async()=>new Response(null,{status:200})),e=>e.status===503&&e.retryable);
 await assert.rejects(resolveBilibiliShare(share,async()=>{throw new Error('offline');}),e=>e.status===503&&e.retryable);
 assert.equal(await resolveBilibiliShare(share,async url=>new Response(null,{status:302,headers:{location:url.endsWith('vP9CEuO')?'/next':canonical}})),canonical);
});


test('temporary upstream failures and eight-second timeout remain retryable',async t=>{
 for(const status of [429,500,503])await assert.rejects(resolveBilibiliShare(share,async()=>new Response(null,{status})),e=>e.status===503&&e.retryable);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=resolveBilibiliShare(share,async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
 const assertion=assert.rejects(pending,e=>e.status===503&&e.retryable);
 t.mock.timers.tick(8000);await assertion;
});
