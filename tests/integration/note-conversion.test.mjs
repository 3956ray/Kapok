import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';
import { dispatchApi } from '../../lib/server/http.ts';
const admin = { subject: 'admin' }, member = { subject: 'member' };
const state = r => ({ expectedVersion: r.version, expectedSharingVersion: r.sharingVersion, expectedGeneration: r.generation });
async function fixture(t) {
 const mf = new Miniflare({ modules:true, script:'export default {fetch(){return new Response("test")}}', compatibilityDate:'2026-05-22', d1Databases:['DB'] });
 t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB');
 for (const file of (await readdir(new URL('../../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) {
  const sql=await readFile(new URL('../../drizzle/'+file,import.meta.url),'utf8');
  for(const statement of sql.split('--> statement-breakpoint').flatMap(x=>x.includes('CREATE TRIGGER')?[x]:x.split(';')).map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
 }
 const s=createService({db,bootstrapSiteUserId:admin.subject});const boot=await s.bootstrap(admin,{discName:'管理',jerseyNumber:'01'},'boot');
 await s.join(member,{discName:'队员',jerseyNumber:'07',token:boot.inviteToken},'join');
 const training=await s.saveTraining(admin,null,{title:'训练',description:'',date:'2026-10-19',status:'published'},'training');
 const video=await s.addVideo(admin,training.id,{title:'视频',source:'bilibili',url:'BV1xx411c7mD',position:0},'video');
 return {s,db,training,video};
}
test('collection seed is an owner-only read, copies saved note only and preserves authorized source associations',async t=>{
 const {s,db,training,video}=await fixture(t);
 const comment=await s.saveComment(admin,video.id,null,{text:'不应复制的原讨论',timestampSec:4},'comment');
 let reflection=await s.saveReflection(admin,null,{title:'原复盘',text:'不应复制的原复盘正文',date:'2026-10-19',trainingId:training.id,videoId:video.id},'reflection');
 reflection=await s.shareReflection(admin,reflection.id,{...state(reflection),scope:'team'},'share');
 for(const [kind,id] of [['video',video.id],['comment',comment.id],['reflection',reflection.id]]) {
  const collection=await s.saveCollection(member,null,{sourceKind:kind,sourceId:id,privateNote:'  本人已保存备注 🥏\n第二行  '},'collection-'+kind);
  const readOnly=createService({db:{prepare(sql){assert.match(sql,/^\s*SELECT\b/i,'seed must issue only reads');return db.prepare(sql);},batch(){assert.fail('seed must not batch writes');}}});
  const seed=await readOnly.getCollectionReflectionSeed(member,collection.id);
  assert.deepEqual(seed,{text:'本人已保存备注 🥏\n第二行',trainingId:training.id,videoId:video.id});
  const response=await dispatchApi(new Request('https://k.test/api/v1/collections/'+collection.id+'/reflection-seed'),['collections',collection.id,'reflection-seed'],member,readOnly);
  assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/private, no-store/);assert.equal(response.headers.get('X-Kapok-Actor'),'member');assert.deepEqual((await response.json()).data,seed);
  for(const target of [collection.id,'missing']) await assert.rejects(s.getCollectionReflectionSeed(admin,target),e=>e.code==='NOT_FOUND'&&e.message==='内容不可用或当前无权查看。');
  await assert.rejects(s.getCollectionReflectionSeed(null,collection.id),e=>e.code==='UNAUTHENTICATED');
  const unauth=await dispatchApi(new Request('https://k.test/'),['collections',collection.id,'reflection-seed'],null,s);assert.equal(unauth.status,401);assert.match(unauth.headers.get('Cache-Control'),/no-store/);
 }
 const notes=await s.listCollections(member);
 await s.shareReflection(admin,reflection.id,{...state(reflection),scope:'private'},'unshare');
 assert.deepEqual(await s.getCollectionReflectionSeed(member,notes.find(x=>x.sourceKind==='reflection').id),{text:'本人已保存备注 🥏\n第二行',trainingId:null,videoId:null});
 await s.saveComment(admin,video.id,comment.id,{action:'delete',expectedVersion:1},'delete-comment');
 assert.equal((await s.getCollectionReflectionSeed(member,notes.find(x=>x.sourceKind==='comment').id)).videoId,null);
 await s.saveTraining(admin,training.id,{title:training.title,description:training.description,date:training.date,status:'hidden',expectedVersion:training.version},'hide');
 assert.deepEqual(await s.getCollectionReflectionSeed(member,notes.find(x=>x.sourceKind==='video').id),{text:'本人已保存备注 🥏\n第二行',trainingId:null,videoId:null});
 assert.equal((await s.listCollections(member)).length,3,'conversion does not remove collection');
 assert.equal((await s.listMyReflections(member)).length,0,'GET never creates a reflection');
});

test('training-only reflection, long own note, source deletion and departed membership use safe association fallback',async t=>{
 const {s,db,training,video}=await fixture(t);const longNote='长备注🥏\n'.repeat(250);
 let reflection=await s.saveReflection(admin,null,{title:'',text:'别人的原文',date:'2026-10-19',trainingId:training.id,videoId:null},'training-reflection');
 reflection=await s.shareReflection(admin,reflection.id,{...state(reflection),scope:'team'},'share-training');
 const note=await s.saveCollection(member,null,{sourceKind:'reflection',sourceId:reflection.id,privateNote:longNote},'long-note');
 assert.deepEqual(await s.getCollectionReflectionSeed(member,note.id),{text:longNote.trim(),trainingId:training.id,videoId:null});
 const adminNote=await s.saveCollection(admin,null,{sourceKind:'video',sourceId:video.id,privateNote:'管理员自己的备注'},'admin-note');
 await s.saveTraining(admin,training.id,{title:training.title,description:'',date:training.date,status:'draft',expectedVersion:training.version},'withdraw');
 assert.deepEqual(await s.getCollectionReflectionSeed(admin,adminNote.id),{text:'管理员自己的备注',trainingId:null,videoId:null},'admin management access cannot seed unpublished training');
 await s.updateVideo(admin,video.id,{title:video.title,position:0,status:'deleted',expectedVersion:video.version},'delete-video');
 assert.equal((await s.getCollectionReflectionSeed(admin,adminNote.id)).videoId,null);
 const me=await s.me(member);await s.leaveTeam(member,{expectedVersion:me.membership.version,expectedEpoch:me.membership.epoch},'leave');
 assert.deepEqual(await s.getCollectionReflectionSeed(member,note.id),{text:longNote.trim(),trainingId:null,videoId:null});
 await db.prepare("UPDATE users SET status='deleted' WHERE id=?").bind(me.user.id).run();
 await assert.rejects(s.getCollectionReflectionSeed(member,note.id),e=>e.code==='FORBIDDEN');
});
