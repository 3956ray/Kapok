import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { hashUploadFile } from '../../lib/client/upload.ts';
import { MEDIA_PART_BYTES } from '../../lib/contracts/media.ts';
const owner = { subject: 'long-owner' };
const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
const stream = b => new Response(b).body;
const reject = (p, code) => assert.rejects(p, e => e.code === code);
export async function fixture(t, options = {}) {
 const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("test")}}', compatibilityDate:'2026-05-22', d1Databases:['DB'], r2Buckets:['BUCKET'] });
 t.after(() => mf.dispose()); const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('BUCKET');
 for (const file of (await readdir(new URL('../../drizzle/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
  for (const sql of (await readFile(new URL('../../drizzle/' + file, import.meta.url),'utf8')).split('--> statement-breakpoint').flatMap(s=>s.includes('CREATE TRIGGER')?[s]:s.split(';')).map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
 }
 const s = createService({db,bucket,bootstrapSiteUserId:owner.subject,...options});
 await s.bootstrap(owner,{discName:'合成管理员',jerseyNumber:'01'},'boot'); return {s,db,bucket};
}
async function manifest(file) { return hashUploadFile(file,()=>true); }
async function complete(s,id) { for(let n=0;n<2200;n++){const r=await s.completeUpload(owner,id,'complete'); if(r.status==='ready'||r.mime)return r;} throw new Error('finite completion budget exceeded'); }
test('full content identity is slice bounded and rejects changed bytes despite identical file metadata',async()=>{
 const a=new File([new Uint8Array(MEDIA_PART_BYTES+1)],'same.mp4',{lastModified:1});
 const b=new File([new Uint8Array(MEDIA_PART_BYTES),new Uint8Array([1])],'same.mp4',{lastModified:1});
 const ma=await manifest(a), mb=await manifest(b); assert.equal(ma.digests.length,2); assert.notEqual(ma.root,mb.root);
});
test('default hosted admission cannot be raised by request; durable manifest and bounded assembly preserve private media',async t=>{
 const {s,db}=await fixture(t); const file=new File([original],'synthetic.mp4'); const m=await manifest(file);
 await reject(s.createUpload(owner,{bytes:5*1024**3,manifest:m,maxBytes:5*1024**3},'attack'),'INVALID_INPUT');
 const u=await s.createUpload(owner,{bytes:file.size,manifest:m},'create');
 assert.equal((await s.getUpload(owner,u.id)).nextPart,1);
 await s.putUploadPart(owner,u.id,stream(original),m.root,1);
 assert.equal((await s.getUpload(owner,u.id)).nextPart,2);
 const changed=Buffer.from(original);changed[100]^=1;await reject(s.putUploadPart(owner,u.id,stream(changed),m.root,1),'IDEMPOTENCY_CONFLICT');
 assert.equal((await complete(s,u.id)).durationSec,3);
 assert.equal((await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first()).status,'ready');
});

const localPolicy = { maxBytes: 5*1024**3, teamBytes: 10*1024**3, maxSeconds: 7200 };
const buffer = b => b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
const proxy = (target, overrides) => new Proxy(target,{get(o,k){const v=overrides[k]??o[k];return typeof v==='function'?v.bind(o):v;}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function syntheticManifest(file){return hashUploadFile({size:file.size,slice:(at,end)=>({arrayBuffer:async()=>buffer(file.read(at,end-at))})},()=>true);}
function accounting(db,bucket){
 const originals=new WeakMap();let active={sql:0,r2:0,reads:0,writes:0};const totals={sql:0,r2:0,reads:0,writes:0},max={sql:0,r2:0,reads:0,writes:0},phases={};let rowsWritten=0;
 const add=k=>{active[k]++;totals[k]++;};
 function statement(s){const p=new Proxy(s,{get(o,k){if(k==='bind')return(...args)=>statement(o.bind(...args));if(['first','all','run','raw'].includes(k))return(...args)=>{add('sql');return o[k](...args);};const v=o[k];return typeof v==='function'?v.bind(o):v;}});originals.set(p,s);return p;}
 const d=proxy(db,{prepare:sql=>statement(db.prepare(sql)),batch:async rows=>{rows.forEach(()=>add('sql')); const result=await db.batch(rows.map(s=>originals.get(s)??s));rowsWritten+=result.reduce((n,r)=>n+(r.meta.rows_written??0),0);return result;}});
 function multipart(m){return proxy(m,{uploadPart:(...args)=>{add('r2');add('writes');return m.uploadPart(...args);},complete:(...args)=>{add('r2');add('writes');return m.complete(...args);},abort:(...args)=>{add('r2');return m.abort(...args);}});}
 const b=proxy(bucket,{put:(key,bytes,options)=>{assert.ok(bytes.byteLength<=MEDIA_PART_BYTES);add('r2');add('writes');return bucket.put(key,bytes,options);},get:(...args)=>{add('r2');add('reads');return bucket.get(...args);},head:(...args)=>{add('r2');return bucket.head(...args);},delete:(...args)=>{add('r2');return bucket.delete(...args);},createMultipartUpload:async(...args)=>{add('r2');return multipart(await bucket.createMultipartUpload(...args));},resumeMultipartUpload:(...args)=>multipart(bucket.resumeMultipartUpload(...args))});
 return {db:d,bucket:b,totals,max,phases,get rowsWritten(){return rowsWritten;},async run(f,label='other'){active={sql:0,r2:0,reads:0,writes:0};try{return await f();}finally{for(const k of Object.keys(max))max[k]=Math.max(max[k],active[k]);assert.ok(active.sql<50,JSON.stringify(active));assert.ok(active.r2<=20,JSON.stringify(active));const p=phases[label]??={calls:0,minSQL:Infinity,maxSQL:0,minR2:Infinity,maxR2:0};p.calls++;p.minSQL=Math.min(p.minSQL,active.sql);p.maxSQL=Math.max(p.maxSQL,active.sql);p.minR2=Math.min(p.minR2,active.r2);p.maxR2=Math.max(p.maxR2,active.r2);}}};
}
test('22 actual 5MiB parts use indexed receipts, durable restart, local R2 assembly and authenticated Range under bounded accounting',async t=>{
 const {s,db,bucket}=await fixture(t,{mediaPolicy:localPolicy});
 const {sizedMP4}=await import('../fixtures/mp4-sized.mjs'); const file=sizedMP4(original,22*MEDIA_PART_BYTES,7200),m=await syntheticManifest(file);
 const count=accounting(db,bucket),service=createService({db:count.db,bucket:count.bucket,mediaPolicy:localPolicy});
 const u=await count.run(()=>service.createUpload(owner,{bytes:file.size,manifest:m},'actual22'),'reservation');
 assert.equal((await count.run(()=>service.getUpload(owner,u.id),'status')).reservedBytes,file.size*2);
 for(let part=1;part<=22;part++){
  // New factory instances model Worker restarts and read progress from actual D1.
  const running=part===12?createService({db:count.db,bucket:count.bucket,mediaPolicy:localPolicy}):service;
  await count.run(()=>running.putUploadPart(owner,u.id,stream(file.read((part-1)*MEDIA_PART_BYTES,MEDIA_PART_BYTES)),m.root,part),'stage-part');
  assert.equal((await count.run(()=>running.getUpload(owner,u.id),'status')).nextPart,part+1);
 }
 assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts WHERE upload_id=? AND attempt_id IS NOT NULL').bind(u.id).first()).n,22);
 let result,calls=0;do{result=await count.run(()=>service.completeUpload(owner,u.id,'complete'),calls<22?'assembly-part':calls===22?'multipart-finish':calls<=44?'stage-cleanup':'metadata');calls++;}while(result.status!=='ready'&&calls<100);
 assert.equal(result.durationSec,7200);assert.equal((await count.run(()=>service.getUpload(owner,u.id),'status')).reservedBytes,file.size);
 const tr=await s.saveTraining(owner,null,{title:'合成长训练',date:'2026-10-17',status:'published',description:''},'training');
 const video=await s.addVideo(owner,tr.id,{title:'合成长视频',source:'upload',uploadId:u.id,position:0},'video');
 const range=await s.getMedia(owner,video.id,'bytes=-16');assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,16);
 assert.match(range.headers.get('Cache-Control'),/private, no-store/);
 t.diagnostic(JSON.stringify({actualClientBytes:file.size,actualStagingBytes:file.size,actualAssemblyBytes:file.size,metadataIsSynthetic:true,completionCalls:calls,total:count.totals,perInvocationMax:count.max,perPhase:count.phases,batchRowsWrittenIncludingGuardsAndOperations:count.rowsWritten,commitmentRows:22,peakReservedBytes:file.size*2}));
});
test('5GiB admission at local 10GiB has zero retry headroom; hosted policy and 80KiB manifest parser stay trusted',async t=>{
 const {s,db,bucket}=await fixture(t,{mediaPolicy:localPolicy});
 const bytes=new Uint8Array(MEDIA_PART_BYTES),h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const {manifestRoot}=await import('../../lib/contracts/media.ts');const digests=Array.from({length:1024},()=>h),m={root:await manifestRoot(localPolicy.maxBytes,digests),digests};
 const {dispatchApi}=await import('../../lib/server/http.ts');
 const response=await dispatchApi(new Request('https://kapok.test/api/v1/uploads',{method:'POST',headers:{Origin:'https://kapok.test','X-Kapok-Actor':owner.subject,'Idempotency-Key':'five','Content-Type':'application/json'},body:JSON.stringify({bytes:localPolicy.maxBytes,manifest:m})}),['uploads'],owner,s);
 assert.equal(response.status,200);const u=(await response.json()).data;assert.equal((await s.getUpload(owner,u.id)).reservedBytes,10*1024**3);
 let puts=0;const faulty=proxy(bucket,{async put(){puts++;throw new Error('synthetic unknown staging outcome');}});
 const counted=accounting(db,faulty),service=createService({db:counted.db,bucket:counted.bucket,mediaPolicy:localPolicy});
 await reject(counted.run(()=>service.putUploadPart(owner,u.id,stream(bytes),m.root,1),'unknown-stage'),'RESULT_UNKNOWN');
 await reject(counted.run(()=>service.putUploadPart(owner,u.id,stream(bytes),m.root,1),'quota-denied-retry'),'UPLOAD_LIMIT');assert.equal(puts,1);
 await reject(counted.run(()=>service.cancelUpload(owner,u.id,'cancel'),'unknown-cancel'),'CLEANUP_PENDING');assert.equal((await s.getUpload(owner,u.id)).reservedBytes,10*1024**3);
 const hosted=createService({db,bucket});await reject(hosted.createUpload(owner,{bytes:localPolicy.maxBytes,manifest:m},'hosted'),'UPLOAD_LIMIT');
 t.diagnostic(JSON.stringify({adversePerPhase:counted.phases,adverseTotal:counted.totals}));
 t.diagnostic('5GiB manifest admitted structurally; only one actual 5MiB staging request attempted and rejected before R2 write; no 5GiB transfer claimed.');
});
test('expired staging lease cannot publish late old PUT; same content successor commits and cleanup waits for old settlement',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'same.mp4'));
 const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'race');const started=deferred(),release=deferred();
 const held=proxy(bucket,{async put(...args){started.resolve();await release.promise;return bucket.put(...args);}});
 const a=createService({db,bucket:held,clock});const old=a.putUploadPart(owner,u.id,stream(original),m.root,1).then(()=>null,e=>e);await started.promise;
 time+=180001;await s.putUploadPart(owner,u.id,stream(original),m.root,1);
 assert.equal((await s.getUpload(owner,u.id)).receivedParts,1);
 release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts WHERE upload_id=? AND attempt_id IS NOT NULL').bind(u.id).first()).n,1);
 assert.equal((await complete(s,u.id)).durationSec,3);assert.equal((await s.getUpload(owner,u.id)).reservedBytes,original.length);
});
test('cancel retains quota for a missing unknown late PUT; known settlement enables finite cleanup without resurrection',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'cancel-late');
 const started=deferred(),release=deferred();const held=proxy(bucket,{async put(...args){started.resolve();await release.promise;return bucket.put(...args);}});
 const old=createService({db,bucket:held}).putUploadPart(owner,u.id,stream(original),m.root,1).then(()=>null,e=>e);await started.promise;
 await reject(s.cancelUpload(owner,u.id,'cancel'),'CLEANUP_PENDING');assert.equal((await s.getUpload(owner,u.id)).reservedBytes,original.length*2);
 assert.equal((await bucket.list()).objects.length,0,'HEAD absence does not establish settled side effect');
 release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 for(let n=0;n<5;n++){const r=await s.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}
 assert.equal((await s.getUpload(owner,u.id)).status,'cancelled');assert.equal((await bucket.list()).objects.length,0);
 await reject(s.completeUpload(owner,u.id,'complete'),'CLEANUP_PENDING');
});

test('expired assembly part and complete callbacks touch only abandoned keys and cannot replace current receipts or ready object',async t=>{
 for(const phase of ['part','complete']){
  let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'same.mp4'));
  const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'held-'+phase);await s.putUploadPart(owner,u.id,stream(original),m.root,1);
  if(phase==='complete')await s.completeUpload(owner,u.id,'complete');
  const started=deferred(),release=deferred();const keys=[];
  function hold(mp,key){return proxy(mp,{async uploadPart(...args){if(phase==='part'){keys.push(key);started.resolve();await release.promise;}return mp.uploadPart(...args);},async complete(...args){if(phase==='complete'){keys.push(key);started.resolve();await release.promise;}return mp.complete(...args);}});}
  const held=proxy(bucket,{async createMultipartUpload(key,...args){return hold(await bucket.createMultipartUpload(key,...args),key);},resumeMultipartUpload(key,...args){return hold(bucket.resumeMultipartUpload(key,...args),key);}});
  const old=createService({db,bucket:held,clock}).completeUpload(owner,u.id,'complete').then(()=>null,e=>e);await started.promise;
  time+=180001;await s.completeUpload(owner,u.id,'complete');
  const current=await db.prepare('SELECT a.object_key FROM uploads u JOIN upload_attempts a ON a.id=u.assembly_id WHERE u.id=?').bind(u.id).first();assert.notEqual(current.object_key,keys[0]);
  release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
  assert.equal((await complete(s,u.id)).durationSec,3);
  assert.equal((await db.prepare('SELECT object_key FROM uploads WHERE id=?').bind(u.id).first()).object_key,current.object_key);
  assert.equal((await bucket.list()).objects.length,1);assert.equal((await s.getUpload(owner,u.id)).reservedBytes,original.length);
 }
});
test('late assembly complete after cancel cannot free unknown bytes or resurrect cancelled publication',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'cancel-complete');await s.putUploadPart(owner,u.id,stream(original),m.root,1);await s.completeUpload(owner,u.id,'complete');
 const started=deferred(),release=deferred();const held=proxy(bucket,{resumeMultipartUpload(...args){const mp=bucket.resumeMultipartUpload(...args);return proxy(mp,{async complete(...parts){started.resolve();await release.promise;return mp.complete(...parts);}});}});
 const old=createService({db,bucket:held}).completeUpload(owner,u.id,'complete').then(()=>null,e=>e);await started.promise;
 let pending=false;for(let n=0;n<4;n++){try{await s.cancelUpload(owner,u.id,'cancel');}catch(e){assert.equal(e.code,'CLEANUP_PENDING');pending=true;break;}}
 assert.equal(pending,true);assert.ok((await s.getUpload(owner,u.id)).reservedBytes>=original.length);
 release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 for(let n=0;n<5;n++){const r=await s.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}
 assert.equal((await s.getUpload(owner,u.id)).status,'cancelled');assert.equal((await bucket.list()).objects.length,0);assert.equal((await s.getUpload(owner,u.id)).reservedBytes,0);
});
test('late validation cannot override newer checkpoint or cancellation and role revocation cannot commit a staging pointer',async t=>{
 for(const action of ['takeover','cancel','revoke']){
  let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'validation-'+action);
  const started=deferred(),release=deferred();
  if(action==='revoke'){
   const held=proxy(bucket,{async put(...args){started.resolve();await release.promise;return bucket.put(...args);}});
   const old=createService({db,bucket:held,clock}).putUploadPart(owner,u.id,stream(original),m.root,1).then(()=>null,e=>e);await started.promise;
   await db.exec("UPDATE memberships SET role='member',epoch=epoch+1");release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
   assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts WHERE upload_id=? AND attempt_id IS NOT NULL').bind(u.id).first()).n,0);await reject(s.getUpload(owner,u.id),'FORBIDDEN');continue;
  }
  await s.putUploadPart(owner,u.id,stream(original),m.root,1);await s.completeUpload(owner,u.id,'complete');await s.completeUpload(owner,u.id,'complete');
  await s.completeUpload(owner,u.id,'complete'); // bounded staging cleanup before metadata
  let first=true;const held=proxy(bucket,{async get(...args){const result=await bucket.get(...args);if(first&&args[1]?.range){first=false;started.resolve();await release.promise;}return result;}});
  const old=createService({db,bucket:held,clock}).completeUpload(owner,u.id,'complete').then(()=>null,e=>e);await started.promise;
  if(action==='takeover'){time+=180001;assert.equal((await complete(s,u.id)).durationSec,3);}else{for(let n=0;n<4;n++){const r=await s.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}}
  release.resolve();assert.ok(['VERSION_CONFLICT','RESULT_UNKNOWN'].includes((await old).code));assert.equal((await s.getUpload(owner,u.id)).status,action==='takeover'?'ready':'cancelled');
 }
});
test('R2 delete/abort failure retains reservations; retry and zero-effect D1 receipt rollback remain safe',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'faults');
 await db.exec("CREATE TRIGGER suppress_v2_part BEFORE UPDATE OF received_parts ON uploads BEGIN SELECT RAISE(IGNORE); END");
 await reject(s.putUploadPart(owner,u.id,stream(original),m.root,1),'VERSION_CONFLICT');assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts WHERE upload_id=? AND attempt_id IS NOT NULL').bind(u.id).first()).n,0);
 await db.exec('DROP TRIGGER suppress_v2_part');await s.putUploadPart(owner,u.id,stream(original),m.root,1);
 let fail=true;const faulty=proxy(bucket,{async delete(...args){if(fail)throw new Error('synthetic cleanup unavailable');return bucket.delete(...args);}});
 const service=createService({db,bucket:faulty});await reject(service.cancelUpload(owner,u.id,'cancel'),'CLEANUP_PENDING');assert.ok((await s.getUpload(owner,u.id)).reservedBytes>=original.length*2);
 fail=false;for(let n=0;n<5;n++){const r=await service.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}
 assert.equal((await s.getUpload(owner,u.id)).reservedBytes,0);
});

test('durable active-attempt slot exists before slow body allocation and blocks a third unresolved takeover',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db}=await fixture(t,{clock});const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'slowbody');
 const bodies=[];const runs=[];
 for(let i=0;i<2;i++){
  const started=deferred();let controller;
  const body=new ReadableStream({start(c){controller=c;},pull(){started.resolve();return new Promise(()=>{});}});bodies.push(controller);
  runs.push(s.putUploadPart(owner,u.id,body,m.root,1).then(()=>null,e=>e));await started.promise;
  // Stream pull may happen before consumer read; wait for durable allocation.
  for(let n=0;n<100;n++){const r=await db.prepare('SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND active=1').bind(u.id).first();if(r.n===i+1)break;await new Promise(r=>setTimeout(r,2));}
  assert.equal((await db.prepare('SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND active=1').bind(u.id).first()).n,i+1);time+=180001;
 }
 await reject(s.putUploadPart(owner,u.id,stream(original),m.root,1),'CLEANUP_PENDING');
 assert.equal((await db.prepare('SELECT count(*) n FROM upload_attempts WHERE upload_id=?').bind(u.id).first()).n,2);
 for(const body of bodies)body.error(new Error('synthetic stream closed'));await Promise.all(runs);
 assert.equal((await db.prepare('SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND active=1').bind(u.id).first()).n,0);
});
test('HEAD-confirmed terminal completion can be cleaned before its old response without resurrecting deleted attempts',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'complete-settled');await s.putUploadPart(owner,u.id,stream(original),m.root,1);await s.completeUpload(owner,u.id,'complete');
 const started=deferred(),release=deferred();const held=proxy(bucket,{resumeMultipartUpload(...args){const mp=bucket.resumeMultipartUpload(...args);return proxy(mp,{async complete(...parts){const result=await mp.complete(...parts);started.resolve();await release.promise;return result;}});}});
 const old=createService({db,bucket:held}).completeUpload(owner,u.id,'complete').then(()=>null,e=>e);await started.promise;
 for(let n=0;n<5;n++){const r=await s.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}
 assert.equal((await s.getUpload(owner,u.id)).status,'cancelled');release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 assert.equal((await db.prepare("SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND state!='deleted'").bind(u.id).first()).n,0);assert.equal((await bucket.list()).objects.length,0);
});
test('incremental 0004 preserves v5 ready media and existing rows, while legacy pending is explicitly distinguishable',async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-05-22',d1Databases:['DB'],r2Buckets:['BUCKET']});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 for(const file of ['0000_identity.sql','0001_training.sql','0002_upload_cleanup.sql'])for(const sql of(await readFile(new URL('../../drizzle/'+file,import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 const s=createService({db,bucket,bootstrapSiteUserId:owner.subject});await s.bootstrap(owner,{discName:'旧版合成管理员',jerseyNumber:'01'},'boot');const me=await s.me(owner);await bucket.put('legacy-ready',original);
 for(const [id,status]of[['legacy-ready','ready'],['legacy-pending','pending']])await db.prepare('INSERT INTO uploads(id,team_id,owner_id,bytes,status,object_key,mime,duration_sec,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,me.membership.teamId,me.user.id,original.length,status,status==='ready'?'legacy-ready':null,status==='ready'?'video/mp4':null,status==='ready'?3:null,'2026-10-16').run();
 for(const sql of(await readFile(new URL('../../drizzle/0004_resumable_uploads.sql',import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 const rows=(await db.prepare('SELECT id,protocol_version,reserved_bytes FROM uploads ORDER BY id').all()).results;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.protocol_version===1&&r.reserved_bytes===original.length));
 const tr=await s.saveTraining(owner,null,{title:'旧版训练',date:'2026-10-17',description:'',status:'published'},'training');const v=await s.addVideo(owner,tr.id,{title:'旧版视频',source:'upload',uploadId:'legacy-ready',position:0},'video');const r=await s.getMedia(owner,v.id,'bytes=0-15');assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,16);
 assert.equal((await s.getUpload(owner,'legacy-pending')).protocol,1);assert.equal((await s.getUpload(owner,'legacy-ready')).status,'ready');
});

test('SHA256 HEAD reconciliation settles a completed staging PUT before its old response without full-object reads',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'head-stage');const started=deferred(),release=deferred();
 const held=proxy(bucket,{async put(...args){const result=await bucket.put(...args);started.resolve();await release.promise;return result;}});
 const old=createService({db,bucket:held}).putUploadPart(owner,u.id,stream(original),m.root,1).then(()=>null,e=>e);await started.promise;
 let gets=0;const cleanup=createService({db,bucket:proxy(bucket,{get(...args){gets++;return bucket.get(...args);}})});
 for(let n=0;n<4;n++){const r=await cleanup.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}
 assert.equal((await s.getUpload(owner,u.id)).status,'cancelled');assert.equal(gets,0);release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 assert.equal((await db.prepare("SELECT count(*) n FROM upload_attempts WHERE upload_id=? AND state!='deleted'").bind(u.id).first()).n,0);
});
test('failed multipart abort retains base quota until confirmed cleanup; rejected codec reason survives confirmation retries',async t=>{
 const {s,db,bucket}=await fixture(t);const m=await manifest(new File([original],'same.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'abort-fault');await s.putUploadPart(owner,u.id,stream(original),m.root,1);await s.completeUpload(owner,u.id,'complete');
 let fail=true;const faulty=proxy(bucket,{resumeMultipartUpload(...args){const mp=bucket.resumeMultipartUpload(...args);return proxy(mp,{async abort(){if(fail)throw new Error('synthetic abort unavailable');return mp.abort();}});}});const service=createService({db,bucket:faulty});
 let pending=false;for(let n=0;n<4;n++){try{await service.cancelUpload(owner,u.id,'cancel');}catch(e){assert.equal(e.code,'CLEANUP_PENDING');pending=true;break;}}
 assert.equal(pending,true);assert.ok((await s.getUpload(owner,u.id)).reservedBytes>=original.length);fail=false;
 for(let n=0;n<5;n++){const r=await service.cancelUpload(owner,u.id,'cancel');if(r.status==='cancelled')break;}assert.equal((await s.getUpload(owner,u.id)).reservedBytes,0);
 const bad=Buffer.from(original);bad.write('hvc1',bad.indexOf('avc1'));const bm=await manifest(new File([bad],'bad.mp4'));const bu=await s.createUpload(owner,{bytes:bad.length,manifest:bm},'bad');await s.putUploadPart(owner,bu.id,stream(bad),bm.root,1);
 await assert.rejects(complete(s,bu.id),e=>e.code==='UNSUPPORTED_CODEC'&&/先取消并清理/.test(e.message));
 await assert.rejects(s.completeUpload(owner,bu.id,'same'),e=>e.code==='UNSUPPORTED_CODEC'&&/先取消并清理/.test(e.message));
 assert.equal((await s.getUpload(owner,bu.id)).cleanupState,'pending');
});

test('commitment reservation is atomic under suppressed row insertion and lost real D1 response',async t=>{
 const {s,db,bucket}=await fixture(t);const file=new File([new Uint8Array(MEDIA_PART_BYTES+1)],'two.mp4');const m=await manifest(file);
 await db.exec('CREATE TRIGGER suppress_commitment BEFORE INSERT ON upload_parts WHEN NEW.part_number=2 BEGIN SELECT RAISE(IGNORE); END');
 await reject(s.createUpload(owner,{bytes:file.size,manifest:m},'atomic'),'VERSION_CONFLICT');
 assert.equal((await db.prepare('SELECT count(*) n FROM uploads').first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts').first()).n,0);
 await db.exec('DROP TRIGGER suppress_commitment');let lose=true;
 const lost=proxy(db,{async batch(...args){const result=await db.batch(...args);if(lose){lose=false;throw new Error('synthetic committed response lost');}return result;}});
 const service=createService({db:lost,bucket});const first=await service.createUpload(owner,{bytes:file.size,manifest:m},'atomic');const replay=await service.createUpload(owner,{bytes:file.size,manifest:m},'atomic');assert.equal(first.id,replay.id);
 assert.equal((await db.prepare('SELECT count(*) n FROM uploads').first()).n,1);assert.equal((await db.prepare('SELECT count(*) n FROM upload_parts').first()).n,2);
 const status=await service.getUpload(owner,first.id);assert.deepEqual(status.manifest,{root:m.root});assert.ok(JSON.stringify(status).length<1024,'progress must not return full digest list');
});

test('actual local R2 long metadata continues through durable D1 checkpoints across service restarts',async t=>{
 const {db,bucket,s}=await fixture(t,{mediaPolicy:localPolicy});const {longMP4}=await import('../fixtures/mp4-long.mjs');const file=longMP4({seconds:7200,size:8*1024**2,offset:40}),m=await syntheticManifest(file);
 const u=await s.createUpload(owner,{bytes:file.size,manifest:m},'durable-metadata');
 for(let part=1;part<=m.digests.length;part++)await s.putUploadPart(owner,u.id,stream(file.read((part-1)*MEDIA_PART_BYTES,Math.min(MEDIA_PART_BYTES,file.size-(part-1)*MEDIA_PART_BYTES))),m.root,part);
 let result,metadataSteps=0,rangeReads=0,rangeBytes=0;
 const bounded=proxy(bucket,{async get(key,options){if(options?.range){assert.ok(options.range.length<=65536);rangeReads++;rangeBytes+=options.range.length;}return bucket.get(key,options);}});
 for(let n=0;n<300;n++){
  const running=createService({db,bucket:bounded,mediaPolicy:localPolicy});result=await running.completeUpload(owner,u.id,'complete');
  if(result.metrics){metadataSteps++;const row=await db.prepare('SELECT validation_state FROM uploads WHERE id=?').bind(u.id).first();const saved=JSON.parse(row.validation_state);assert.equal(saved.steps,metadataSteps);assert.ok(result.metrics.reads<=16);assert.ok(result.metrics.work<=4096);}
  if(result.status==='ready')break;
 }
 assert.equal(result.durationSec,7200);assert.ok(metadataSteps>1);assert.equal((await s.getUpload(owner,u.id)).reservedBytes,file.size);
 t.diagnostic(JSON.stringify({actualClientAndObjectBytes:file.size,actualMetadataBytes:file.metadata.length,metadataSteps,rangeReads,rangeBytes,nativePlayback:'NOT_RUN',virtualOffsetScenario:false}));
});

test('R1 I1 ready publication retires its lease atomically before any fallible release and attaches after restart',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'ready.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'r1-ready');await s.putUploadPart(owner,u.id,stream(original),m.root,1);
 let readyReleaseCalls=0;const faulty=proxy(db,{prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('UPDATE uploads SET lease_token=NULL,lease_until=NULL,transfer_active=0 WHERE'))return statement;function wrap(s){return proxy(s,{bind(...args){return wrap(s.bind(...args));},async run(){const row=await db.prepare('SELECT status FROM uploads WHERE id=?').bind(u.id).first();if(row.status==='ready'){readyReleaseCalls++;throw new Error('synthetic postcommit release failure');}return s.run();}});}return wrap(statement);}});
 const value=await complete(createService({db:faulty,bucket,clock}),u.id);assert.equal(value.durationSec,3);assert.equal(readyReleaseCalls,0);
 const ready=await db.prepare('SELECT transfer_active,lease_token,lease_until,version FROM uploads WHERE id=?').bind(u.id).first();assert.equal(ready.transfer_active,0);assert.equal(ready.lease_token,null);assert.equal(ready.lease_until,null);
 time+=180001;const fresh=createService({db,bucket,clock});assert.equal((await fresh.completeUpload(owner,u.id,'after-restart')).status,'ready');assert.equal((await fresh.completeUpload(owner,u.id,'again')).status,'ready');
 assert.equal((await db.prepare('SELECT version FROM uploads WHERE id=?').bind(u.id).first()).version,ready.version);
 const tr=await fresh.saveTraining(owner,null,{title:'完成后恢复',date:'2026-10-17',description:'',status:'published'},'r1-training');assert.ok((await fresh.addVideo(owner,tr.id,{title:'已核验视频',source:'upload',uploadId:u.id,position:0},'r1-attach')).id);
});
test('R1 I2 bounded cursor enumeration reaches the 51st authorized reservation and survives insertion and boundary removal',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'page.mp4'));const ids=[];
 for(let i=0;i<51;i++){time=i;ids.push((await s.createUpload(owner,{bytes:original.length,manifest:m},'r1-page-'+i)).id);}
 const fresh=createService({db,bucket,clock}),first=await fresh.listUploads(owner);assert.equal(first.items.length,50);assert.ok(first.nextCursor);assert.ok(!first.items.some(r=>r.id===ids[0]));
 time=100;await s.createUpload(owner,{bytes:original.length,manifest:m},'newer');await s.cancelUpload(owner,first.items.at(-1).id,'remove-boundary');
 const second=await fresh.listUploads(owner,first.nextCursor);assert.deepEqual(second.items.map(r=>r.id),[ids[0]]);assert.equal(second.nextCursor,null);
 await fresh.putUploadPart(owner,ids[0],stream(original),m.root,1);assert.equal((await complete(fresh,ids[0])).status,'ready');
 for(let n=0;n<5;n++){const r=await fresh.cancelUpload(owner,ids[0],'cleanup-oldest');if(r.status==='cancelled')break;}
 assert.equal((await fresh.getUpload(owner,ids[0])).status,'cancelled');
});

test('R1 I1 expired stranded ready recovery is fenced, preserves media and attaches with current permission',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'stranded.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'stranded');await s.putUploadPart(owner,u.id,stream(original),m.root,1);await complete(s,u.id);
 await db.prepare("UPDATE uploads SET transfer_active=1,lease_token='stranded-ready',lease_until=?,generation=generation+1,version=version+1 WHERE id=?").bind(new Date(clock().getTime()+180000).toISOString(),u.id).run();
 const before=await db.prepare('SELECT * FROM uploads WHERE id=?').bind(u.id).first();await reject(s.completeUpload(owner,u.id,'too-early'),'UPLOAD_BUSY');time+=180001;
 const fresh=createService({db,bucket,clock});assert.equal((await fresh.completeUpload(owner,u.id,'recover')).status,'ready');const after=await db.prepare('SELECT * FROM uploads WHERE id=?').bind(u.id).first();assert.equal(after.generation,before.generation+1);assert.equal(after.version,before.version+1);assert.equal(after.transfer_active,0);assert.equal(after.lease_token,null);assert.equal(after.object_key,before.object_key);assert.equal(after.duration_sec,before.duration_sec);
 await fresh.completeUpload(owner,u.id,'again');assert.equal((await db.prepare('SELECT version FROM uploads WHERE id=?').bind(u.id).first()).version,after.version);
 const tr=await fresh.saveTraining(owner,null,{title:'旧完成状态恢复',date:'2026-10-17',description:'',status:'published'},'stranded-training');assert.ok((await fresh.addVideo(owner,tr.id,{title:'恢复后视频',source:'upload',uploadId:u.id,position:0},'stranded-attach')).id);
});
test('R1 I1 ready recovery cannot clear a newer lease, a closed upload or revoked permission',async t=>{
 for(const action of ['new-generation','closed','revoked']){
  let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time);const {s,db,bucket}=await fixture(t,{clock});const m=await manifest(new File([original],'fenced.mp4'));const u=await s.createUpload(owner,{bytes:original.length,manifest:m},'ready-fence-'+action);await s.putUploadPart(owner,u.id,stream(original),m.root,1);await complete(s,u.id);
  await db.prepare("UPDATE uploads SET transfer_active=1,lease_token='old',lease_until=?,generation=generation+1,version=version+1 WHERE id=?").bind(clock().toISOString(),u.id).run();time++;
  const started=deferred(),release=deferred();const held=proxy(db,{async batch(statements){started.resolve();await release.promise;return db.batch(statements);}});
  const old=createService({db:held,bucket,clock}).completeUpload(owner,u.id,'recover').then(()=>null,e=>e);await started.promise;
  if(action==='new-generation')await db.prepare("UPDATE uploads SET generation=generation+1,version=version+1,lease_token='new-current',lease_until=? WHERE id=?").bind(new Date(clock().getTime()+180000).toISOString(),u.id).run();
  else if(action==='revoked')await db.exec("UPDATE memberships SET role='member',epoch=epoch+1");
  else for(let n=0;n<5;n++){const r=await s.cancelUpload(owner,u.id,'closed');if(r.status==='cancelled')break;}
  const expected=await db.prepare('SELECT generation,version,lease_token,status,cleanup_state FROM uploads WHERE id=?').bind(u.id).first();release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');assert.deepEqual(await db.prepare('SELECT generation,version,lease_token,status,cleanup_state FROM uploads WHERE id=?').bind(u.id).first(),expected);
 }
});
test('R1 M1 assembly retry quota shortage stays a capacity error and does not reject valid-duration media',async t=>{
 let time=0;const clock=()=>new Date(Date.UTC(2026,9,17)+time),policy={maxBytes:original.length,teamBytes:original.length*2,maxSeconds:600};const {s,db,bucket}=await fixture(t,{clock,mediaPolicy:policy});const m=await manifest(new File([original],'capacity.mp4')),u=await s.createUpload(owner,{bytes:original.length,manifest:m},'capacity');await s.putUploadPart(owner,u.id,stream(original),m.root,1);
 const started=deferred(),release=deferred();const held=proxy(bucket,{resumeMultipartUpload(...args){const mp=bucket.resumeMultipartUpload(...args);return proxy(mp,{async uploadPart(...parts){started.resolve();await release.promise;return mp.uploadPart(...parts);}});}});
 const old=createService({db,bucket:held,clock,mediaPolicy:policy}).completeUpload(owner,u.id,'complete').then(()=>null,e=>e);await started.promise;time+=180001;
 await assert.rejects(s.completeUpload(owner,u.id,'retry'),e=>e.code==='UPLOAD_LIMIT'&&/容量不足/.test(e.message)&&!/时长|分钟/.test(e.message));
 const row=await db.prepare('SELECT status,cleanup_state,cleanup_target FROM uploads WHERE id=?').bind(u.id).first();assert.equal(row.status,'receiving');assert.equal(row.cleanup_state,'none');assert.equal(row.cleanup_target,null);
 release.resolve();assert.equal((await old).code,'VERSION_CONFLICT');
 const room=createService({db,bucket,clock,mediaPolicy:{...policy,teamBytes:original.length*3}});assert.equal((await complete(room,u.id)).durationSec,3);
});
