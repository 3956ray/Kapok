import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectMP4Stage } from '../../lib/server/media-stages.ts';
import { longMP4 } from '../fixtures/mp4-long.mjs';
const buffer = b => b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
async function inspect(file) {
 let state=null,media,steps=0,maxReads=0,maxBytes=0,maxCpu=0,totalCpu=0,readBytes=0,reads=0;const cpus=[];
 while(!media && steps<2048) {
  const cpu=process.cpuUsage();
  const result=await inspectMP4Stage(file.size,async(at,n)=>{assert.ok(n<=65536);readBytes+=n;reads++;return buffer(file.read(at,n));},state);
  const used=process.cpuUsage(cpu);const ms=(used.user+used.system)/1000;maxCpu=Math.max(maxCpu,ms);totalCpu+=ms;cpus.push(ms);
  state=JSON.parse(JSON.stringify(result.state)); media=result.media; steps++;
  assert.ok(result.metrics.reads<=16);assert.ok(result.metrics.readBytes<=16*65536);assert.ok(result.metrics.work<=4096);
  assert.ok(JSON.stringify(state).length<32768);maxReads=Math.max(maxReads,result.metrics.reads);maxBytes=Math.max(maxBytes,result.metrics.readBytes);
 }
 assert.ok(media,'bounded client continuation budget must finish supported metadata');
 cpus.sort((a,b)=>a-b);return {media,steps,maxReads,maxBytes,maxCpu,p50Cpu:cpus[Math.floor(cpus.length*.5)],p95Cpu:cpus[Math.floor(cpus.length*.95)],totalCpu,readBytes,reads};
}
test('40/60/120 minute counts, >2MiB moov and genuine 2GiB/5GiB virtual offsets use bounded durable windows',async t=>{
 for(const seconds of [2400,3600,7200]){
  const file=longMP4({seconds,size:seconds===2400?2*1024**3:5*1024**3,offset:seconds===2400?2*1024**3-8*1024**2:4*1024**3+128});
  const result=await inspect(file);assert.equal(result.media.durationSec,seconds);
  if(seconds===7200)assert.ok(file.metadata.length>2*1024**2);
  t.diagnostic(JSON.stringify({seconds,virtualBytes:file.size,materializedFixtureBytes:file.materializedBytes,...result}));
 }
});
test('1million timing rows and 700000 interleaved variable sample/chunk/rule rows finish below finite continuation cap',async t=>{
 for(const options of [{seconds:7000,videoCount:1000000,variable:false,timingRows:true,audio:false},{seconds:7000,videoCount:700000,variable:true,timingRows:true,everyChunk:true,audio:false,composition:true,sync:true}]) {
  const file=longMP4(options);assert.ok(file.metadata.length<32*1024**2);
  const result=await inspect(file);assert.equal(result.media.durationSec,7000);assert.ok(result.steps<2048);
  t.diagnostic(JSON.stringify({metadataBytes:file.metadata.length,...result}));
 }
});
test('malformed sample counts, big offsets, table boundaries and duration are rejected without full media reads',async()=>{
 for(const mutate of [b=>b.writeUInt32BE(1000001,b.indexOf('stsz')+12),b=>b.writeBigUInt64BE(2n**63n,b.indexOf('co64')+12),b=>b.writeUInt32BE(0xffffffff,b.indexOf('stsc')+8),b=>b.writeUInt32BE(0,b.indexOf('stts')+16),b=>b.writeUInt32BE(0,b.indexOf('ctts')+12),b=>b.writeUInt32BE(0,b.indexOf('stss')+12)]){
  const f=longMP4({seconds:2400,composition:true,sync:true});mutate(f.metadata);await assert.rejects(inspect(f),e=>e.code==='UNSUPPORTED_MEDIA');
 }
 const f=longMP4({seconds:7201,audio:false});await assert.rejects(inspect(f),e=>e.code==='UPLOAD_LIMIT');
});
