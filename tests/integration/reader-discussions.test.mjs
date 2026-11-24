import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharingFixture, principals as p, syntheticContent as content, versions} from '../helpers/sharing-browser-fixture.mjs';
import {actorKey} from '../helpers/identity-fixture.mjs';
import {createService} from '../../lib/server/domain.ts';
import {dispatchApi} from '../../lib/server/http.ts';

async function setup(t) {
    const f=await createSharingFixture(); t.after(()=>f.dispose());
    return f;
}
async function api(s,actor,path,method='GET',input,key='') {
    const req=new Request('https://kapok.test/api/v1/'+path,{method,body:input===undefined ? undefined : JSON.stringify(input),
        headers:{Origin:'https://kapok.test','X-Kapok-Actor':await actorKey(actor),'Idempotency-Key':key,'Content-Type':'application/json'}});
    const response=await dispatchApi(req,path.split('/'),actor,s);
    assert.match(response.headers.get('Cache-Control'),/no-store/);
    return {status:response.status,...await response.json()};
}
const token=data=>({expectedDiscussionEpoch:data.discussionEpoch,expectedMembershipEpoch:data.membershipEpoch});
const grant=(s,n,scope,key)=>s.shareReflection(p.author,n.id,{scope,...versions(n)},key);
const note=(s,key)=>s.saveReflection(p.author,null,content,key);
const announce=(s,id,status,key,version)=>s.saveAnnouncement(p.admin,id,{title:'合成公告',text:'合成内容',status,...(id ? {expectedVersion:version} : {})},key);

test('reflection discussions follow a reading grant independently of the activity publication and expire on revoke',async t=>{
    const {service:s,db,ids}=await setup(t);
    let n=await note(s,'note');
    const path='reflections/'+n.id+'/discussion';
    assert.equal((await api(s,p.author,path)).status,404);
    n=await grant(s,n,'team','share');
    const data=(await api(s,p.member,path)).data;
    assert.deepEqual(data.items,[]);
    const fence=token(data), rootBody={...fence,text:' 开始讨论 '};
    assert.equal((await api(s,p.member,path,'POST',{text:'missing epochs'},'invalid')).status,400);
    const created=await api(s,p.member,path,'POST',rootBody,'root');
    assert.equal(created.status,200);
    const root=created.data.id;
    assert.deepEqual((await api(s,p.member,path,'POST',rootBody,'root')).data,{id:root});
    assert.equal((await api(s,p.member,path,'POST',{...rootBody,text:'other'},'root')).status,409);
    const replies=async (actor,text,target)=>api(s,actor,path,'POST',{...fence,text,rootId:root,replyToId:target},text);
    const reply=(await replies(p.member,'self',root)).data.id;
    const second=(await replies(p.author,'teammate',reply)).data.id;
    const list=(await api(s,p.author,path)).data;
    assert.equal(list.discussionEpoch,data.discussionEpoch);
    const record=list.items.find(row=>row.id===root);
    assert.deepEqual(Object.keys(record).sort(),['authorId','authorName','createdAt','id','replyTargetName','replyToId','rootId','status','text','version'].sort());
    assert.equal(record.text,'开始讨论');
    assert.equal(list.items.find(row=>row.id===second).replyTargetName,record.authorName);
    const del={...fence,action:'delete',expectedVersion:1};
    assert.equal((await api(s,p.admin,path+'/'+root,'PATCH',del,'foreign-delete')).status,409);
    assert.equal((await api(s,p.member,path+'/'+root,'PATCH',del,'delete')).status,200);
    assert.equal((await api(s,p.member,path+'/'+root,'PATCH',del,'delete')).status,200);
    const after=(await api(s,p.author,path)).data.items;
    assert.equal(after.length,3);
    assert.equal(after.find(row=>row.id===root).text,null);
    assert.equal(after.find(row=>row.id===reply).replyTargetName,null);
    assert.equal((await replies(p.member,'reply-to-deleted',root)).status,409);
    assert.equal((await replies(p.member,'reply-to-live-child',reply)).status,200);
    n=await s.publishReflection(p.author,n.id,{...versions(n),published:true},'feed');
    n=await s.publishReflection(p.author,n.id,{...versions(n),published:false},'unlist');
    assert.equal((await api(s,p.author,path)).data.items.length,4);
    n=await grant(s,n,'private','revoke');
    assert.equal((await api(s,p.member,path)).status,404);
    assert.equal((await api(s,p.member,path,'POST',rootBody,'root')).status,404);
    n=await grant(s,n,'team','reshare');
    const fresh=(await api(s,p.member,path)).data;
    assert.ok(fresh.discussionEpoch>data.discussionEpoch);
    assert.deepEqual(fresh.items,[]);
    assert.equal((await api(s,p.member,path,'POST',rootBody,'root')).status,409);
    assert.equal((await api(s,p.member,path,'POST',{...token(fresh),text:'old target',rootId:root,replyToId:reply},'late-reply')).status,409);
    await db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(ids.author).run();
    assert.equal((await api(s,p.member,path)).status,404);
    await db.prepare("UPDATE memberships SET status='active',epoch=epoch+1 WHERE user_id=?").bind(ids.author).run();
    n=await grant(s,await s.getOwnReflection(p.author,n.id),'team','after-author-rejoin');
    const restoredEpoch=(await api(s,p.member,path)).data.discussionEpoch;
    assert.ok(restoredEpoch>fresh.discussionEpoch);
    await s.deleteReflection(p.author,n.id,versions(n),'delete-note');
    assert.equal((await api(s,p.member,path)).status,404);
    const [deleted]=await s.listDeletedReflections(p.author);
    n=await s.restoreReflection(p.author,n.id,versions(deleted),'restore-note');
    assert.equal((await api(s,p.author,path)).status,404);
    await grant(s,n,'team','grant-restored');
    assert.ok((await api(s,p.author,path)).data.discussionEpoch>restoredEpoch);
});

test('announcement discussions isolate sources and teams, survive public revisions, and reject old member and publication epochs',async t=>{
    const {service:s,db,ids}=await setup(t);
    let a=await announce(s,null,'draft','draft');
    const path='announcements/'+a.id+'/discussion';
    assert.equal((await api(s,p.admin,path)).status,404);
    a=await announce(s,a.id,'published','publish',a.version);
    const first=(await api(s,p.member,path)).data, form={...token(first),text:'讨论'};
    const root=(await api(s,p.member,path,'POST',form,'ann-root')).data.id;
    a=await announce(s,a.id,'revision','private-revision',a.version);
    assert.equal((await api(s,p.member,path)).data.items[0].id,root);
    a=await announce(s,a.id,'published','revise',a.version);
    assert.equal((await api(s,p.member,path)).data.discussionEpoch,first.discussionEpoch);
    const n=await grant(s,await note(s,'other'),'team','grant');
    const other='reflections/'+n.id+'/discussion';
    const cross=await api(s,p.member,other,'POST',{...token((await api(s,p.member,other)).data),text:'cross',rootId:root,replyToId:root},'cross');
    assert.equal(cross.status,409);
    await db.prepare("UPDATE memberships SET status='paused' WHERE user_id=?").bind(ids.member).run();
    assert.equal((await api(s,p.member,path,'POST',form,'paused')).status,403);
    await db.prepare("UPDATE memberships SET status='active',epoch=epoch+1 WHERE user_id=?").bind(ids.member).run();
    assert.equal((await api(s,p.member,path,'POST',form,'ann-root')).status,409);
    const freshMember=(await api(s,p.member,path)).data;
    assert.ok(freshMember.membershipEpoch>first.membershipEpoch);
    a=await announce(s,a.id,'draft','withdraw',a.version);
    assert.equal((await api(s,p.member,path)).status,404);
    a=await announce(s,a.id,'published','republish',a.version);
    const fresh=(await api(s,p.member,path)).data;
    assert.deepEqual(fresh.items,[]);
    assert.ok(fresh.discussionEpoch>first.discussionEpoch);
    assert.equal((await api(s,p.member,path,'POST',{...token(freshMember),text:'old edition'},'stale')).status,409);
    const second=(await api(s,p.member,path,'POST',{...token(fresh),text:'live'},'new')).data.id;
    // Synthetic multi-team fixture: production has one team, while readers and writes still fence the team explicitly.
    await db.prepare('DROP INDEX team_singleton').run();
    await db.prepare("INSERT INTO teams(id,singleton,name,description,created_at) VALUES('other-team',1,'Synthetic','','now')").run();
    await db.prepare("UPDATE memberships SET team_id='other-team' WHERE user_id=?").bind(ids.member).run();
    assert.equal((await api(s,p.member,path)).status,404);
    assert.equal((await api(s,p.member,path+'/'+second,'PATCH',{...token(fresh),action:'delete',expectedVersion:1},'cross-delete')).status,404);
    await announce(s,a.id,'deleted','delete',a.version);
    assert.equal((await api(s,p.admin,path)).status,404);
});

test('prepared discussion write rolls back if the source grant is revoked and restored before commit',async t=>{
    const {service:s,db}=await setup(t);
    let n=await grant(s,await note(s,'race'),'team','share');
    const path='reflections/'+n.id+'/discussion', fence=token((await api(s,p.member,path)).data);
    const delayed=createService({db:{prepare:db.prepare.bind(db),async batch(statements){
        n=await grant(s,n,'private','revoke');
        n=await grant(s,n,'team','new-epoch');
        return db.batch(statements);
    }}});
    const response=await api(delayed,p.member,path,'POST',{...fence,text:'stale'},'delayed');
    assert.equal(response.status,409);
    assert.equal((await db.prepare('SELECT count(*) FROM reader_discussions').first('count(*)')),0);
    assert.deepEqual((await api(s,p.member,path)).data.items,[]);
});
