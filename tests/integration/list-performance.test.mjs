import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createService } from '../../lib/server/domain.ts';

const admin = {provider:'access',issuer:'https://synthetic.cloudflareaccess.com',subject:'perf-admin',verifiedEmail:'perf-admin@example.test'};
const reader = {...admin,subject:'perf-reader',verifiedEmail:'perf-reader@example.test'};
const author = {...admin,subject:'perf-author',verifiedEmail:'perf-author@example.test'};

test('list source projections stay authorized with bounded database round trips at 3/30/300 records', {timeout:120000}, async t => {
 const mf = new Miniflare({modules:true,script:'export default {}',compatibilityDate:'2026-05-22',d1Databases:['DB']});
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 const dir=new URL('../../drizzle/',import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.batch((await readFile(new URL(f,dir),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 const make=database=>createService({db:database,accessInitialAdminEmail:admin.verifiedEmail});
 const s=make(db);
 for(const p of [admin,reader,author])await s.join(p,{intent:'register',confirmed:true,discName:p.subject,jerseyNumber:'01'},'join');
 const c=await s.me(reader),a=await s.me(author),now='2026-11-16T00:00:00Z';
 const tr=await s.saveTraining(admin,null,{title:'Synthetic training',date:'2026-11-16',description:'',status:'published'},'training');
 let reads=0;let beforeRead;
 const wrapped={prepare(sql){const wrap=stmt=>new Proxy(stmt,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(['first','all','raw'].includes(key))return async(...args)=>{reads++;await beforeRead?.(sql);return target[key](...args)};const v=target[key];return typeof v==='function'?v.bind(target):v;}});return wrap(db.prepare(sql));},batch:db.batch.bind(db)};
 const measured=make(wrapped),results=[];
 for(const size of [3,30,300]){
  await db.batch([db.prepare('DELETE FROM collections'),db.prepare('DELETE FROM reflections')]);
  const stmts=[];
  for(let i=0;i<size;i++){
   stmts.push(db.prepare("INSERT OR IGNORE INTO videos(id,training_id,team_id,title,source,url,position,created_at,updated_at) VALUES(?,?,?,'Synthetic video','bilibili','https://www.bilibili.com/video/BV1xx411c7mD/',?,?,?)").bind('pv-'+i,tr.id,c.membership.teamId,i,now,now));
   stmts.push(db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,timestamp_sec,private_note,created_at,updated_at) VALUES(?,?,'video',?,15,'Synthetic note',?,?)").bind('pc-'+i,c.user.id,'pv-'+i,now,now));
   stmts.push(db.prepare("INSERT INTO reflections(id,owner_id,team_id,text,date,training_id,video_id,created_at,updated_at) VALUES(?,?,?,'Synthetic reflection','2026-11-16',?,?,?,?)").bind('pr-'+i,c.user.id,c.membership.teamId,tr.id,'pv-'+i,now,now));
  }
  await db.batch(stmts);
  for(const [kind,call] of [['collections',()=>measured.listCollections(reader)],['reflections',()=>measured.listMyReflections(reader)]]){
   reads=0;const started=performance.now();const rows=await call();const ms=performance.now()-started;
   assert.equal(rows.length,size);assert.ok(rows.every(r=>kind==='collections'?r.source?.title==='Synthetic video':r.link?.title==='Synthetic video'));
   if(!process.env.KAPOK_PERF_BASELINE)assert.equal(reads,3);
   results.push({size,kind,reads,ms});
  }
 }
 // Current final-source read must observe newly hidden videos and preserve notes.
 await db.prepare("UPDATE videos SET status='hidden' WHERE id='pv-0'").run();
 assert.equal((await measured.listCollections(reader)).find(r=>r.id==='pc-0').source,null);
 assert.equal((await measured.listMyReflections(reader)).find(r=>r.id==='pr-0').link,null);
 await db.prepare("UPDATE videos SET status='active' WHERE id='pv-0'").run();
 // A source shared with the team can be read; withdrawal must remove text/title.
 await db.prepare("INSERT INTO reflections(id,owner_id,team_id,title,text,date,scope,gate,author_epoch,published_at,created_at,updated_at) VALUES('shared',?,?,'Shared','Source text','2026-11-16','team','open',?,?,?,?)").bind(a.user.id,a.membership.teamId,a.membership.epoch,now,now,now).run();
 await db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,private_note,created_at,updated_at) VALUES('saved-shared',?,'reflection','shared','Keep private note',?,?)").bind(c.user.id,now,now).run();
 assert.equal((await measured.listCollections(reader)).find(r=>r.id==='saved-shared').source.text,'Source text');
 await db.prepare("UPDATE reflections SET gate='closed',scope='private',published_at=NULL WHERE id='shared'").run();
 const withdrawn=(await measured.listCollections(reader)).find(r=>r.id==='saved-shared');
 assert.equal(withdrawn.source,null);assert.equal(withdrawn.privateNote,'Keep private note');
 // Comment text must follow both comment and training visibility.
 await db.prepare("INSERT INTO video_comments(id,video_id,team_id,author_id,text,created_at,updated_at) VALUES('comment','pv-0',?,?,'Comment text',?,?)").bind(c.membership.teamId,a.user.id,now,now).run();
 await db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,timestamp_sec,private_note,created_at,updated_at) VALUES('saved-comment',?,'comment','comment',0,'Comment note',?,?)").bind(c.user.id,now,now).run();
 const comment=async()=>(await measured.listCollections(reader)).find(r=>r.id==='saved-comment');
 assert.deepEqual((await comment()).source,{title:'Synthetic video',href:'/videos/pv-0?t=0#comment-comment',text:'Comment text'});
 await db.prepare("UPDATE video_comments SET status='hidden' WHERE id='comment'").run();
 assert.equal((await comment()).source,null);
 await db.prepare("UPDATE video_comments SET status='active' WHERE id='comment'").run();
 await db.prepare("UPDATE trainings SET status='hidden' WHERE id=?").bind(tr.id).run();
 assert.equal((await comment()).source,null);
 await db.prepare("UPDATE trainings SET status='published' WHERE id=?").bind(tr.id).run();
 // A private own reflection remains readable as a source; another owner's does not.
 await db.prepare("INSERT INTO collections(id,owner_id,source_kind,source_id,created_at,updated_at) VALUES('saved-own',?,'reflection','pr-0',?,?)").bind(c.user.id,now,now).run();
 assert.equal((await measured.listCollections(reader)).find(r=>r.id==='saved-own').source.text,'Synthetic reflection');
 // Revoke between initial rows and final source read, not just before entry.
 beforeRead=async sql=>{if(sql.startsWith('WITH viewer')){beforeRead=null;await db.prepare("UPDATE memberships SET status='paused',epoch=epoch+1 WHERE user_id=?").bind(c.user.id).run();}};
 await assert.rejects(measured.listCollections(reader),e=>e.code==='NOT_FOUND');
 if(process.env.KAPOK_PERF_OUTPUT)await writeFile(process.env.KAPOK_PERF_OUTPUT,JSON.stringify(results,null,2));
});
