import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVideoSeek } from '../../lib/client/video-seek.ts';
import { safeReturnTo } from '../../lib/server/domain.ts';
test('B safe return bounds route-specific query and comment hash', () => {
 assert.equal(safeReturnTo('/me/edit'), '/me/edit');
 assert.equal(safeReturnTo('/videos/v?t=13#comment-c'), '/videos/v?t=13#comment-c');
 for (const path of ['/videos/v?t=-1','/videos/v?t=1.2','/videos/v?t=9007199254740992','/videos/v?text=secret','/me?returnTo=https://evil.test','//evil.test','/videos/v#evil']) assert.equal(safeReturnTo(path), '/');
 assert.equal(safeReturnTo('/reflections/new?training=t&video=v'), '/reflections/new?training=t&video=v');
 assert.equal(safeReturnTo('/reflections/new?collection=saved'),'/reflections/new?collection=saved');
 for(const path of ['/reflections/new?collection=saved&training=t','/reflections/new?collection=one&collection=two','/reflections/new?collection=x&text=secret','/reflections/new?collection=bad%2Fid'])assert.equal(safeReturnTo(path),'/');
});
test('B seek queues metadata, validates actual target and rejects stale seeked', () => {
 const events=[]; const seek=createVideoSeek((kind,text)=>events.push([kind,text]));
 const media={currentTime:0,duration:60,readyState:0,seeking:false};
 seek.request('v',13,media); assert.match(events.at(-1)[1], /未就绪/);
 media.readyState=1; seek.ready('v',media); assert.equal(media.currentTime,13);
 media.currentTime=2; seek.seeked('v',media); assert.notEqual(events.at(-1)[0],'success');
 media.currentTime=13; seek.seeked('other',media); assert.notEqual(events.at(-1)[0],'success');
 seek.seeked('v',media); assert.equal(events.at(-1)[0],'success');
 seek.request('v',70,media); assert.equal(events.at(-1)[0],'error');
 seek.request('v',5,media); seek.clear(); media.currentTime=5; seek.seeked('v',media); assert.equal(events.at(-1)[0],'neutral');
 seek.dispose();
});

const { JSDOM } = await import('jsdom');
const React = (await import('react')).default;
const { act } = await import('react');
const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'https://kapok.local/',pretendToBeVisual:true});
for (const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','CustomEvent','Event','FormData','localStorage']) Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.BroadcastChannel=class { close(){} };
dom.window.HTMLMediaElement.prototype.pause=function(){};
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const {createRoot}=await import('react-dom/client');
const {VideoDiscussion}=await import('../../app/components/video-discussion.tsx');
const {ProfileEditor}=await import('../../app/components/profile-editor.tsx');
const {MemberDirectory}=await import('../../app/components/community.tsx');
const {CollectionList}=await import('../../app/components/collections.tsx');
const {clearNavigationActor,confirmNavigationActor,navigationBuffer,pendingMutationKey,acknowledgeMutation}=await import('../../lib/client/navigation-state.ts');
let root,calls,data,override;
const me={user:{id:'u',status:'active'},profile:{discName:'木棉',jerseyNumber:'07',version:1},membership:{id:'m',teamId:'t',status:'active',role:'member',epoch:1,version:1}};
const training={id:'tr',title:'训练',date:'2026-10-18',status:'published'};
const video={id:'v',trainingId:'tr',title:'视频',source:'upload',durationSec:60,training};
const comment={id:'c',videoId:'v',authorId:'other',authorName:'阿禾',authorJerseyNumber:'09',replyTargetName:null,text:'原文',rootId:null,timestampSec:4,status:'active',version:1,createdAt:'2026-10-18T04:00:00Z'};
const response=value=>new Response(JSON.stringify({data:value}),{headers:{'X-Kapok-Actor':'A'}});
function setup(path='/videos/v',role='member') {
 clearNavigationActor('A'); clearNavigationActor('B'); dom.window.history.replaceState({},'',path); calls=[];override=null;
 data={bootstrap:{siteUserId:'A',me:{...me,membership:{...me.membership,role}}},me,'videos/v':video,'videos/v/comments':[comment],members:[{id:'other',discName:'阿禾',jerseyNumber:'09',role:'member'}],collections:[]};
 globalThis.fetch=async(url,options={})=>{const path=String(url).replace('/api/v1/','');calls.push({path,options});return await override?.(path,options) ?? response(data[path]??[]);};
}
async function flush(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,8));});}
async function mount(node){document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(node,{actorId:'A',videoId:'v'})));await flush();}
async function unmount(){await act(async()=>root?.unmount());root=null;}
const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
async function click(text){const node=button(text);assert.ok(node,text);await act(async()=>node.click());await flush();}
async function input(node,value){assert.ok(node);await act(async()=>{Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});await flush();}
const writes=()=>calls.filter(c=>c.options.method==='POST'||c.options.method==='PATCH');
test('B member/admin freeze13, edit/remove/no-time, explicit reply failure and cancel',async()=>{
 for(const role of ['member','admin']){setup('/videos/v',role);try{
  await mount(VideoDiscussion);const player=document.querySelector('video');Object.defineProperty(player,'readyState',{configurable:true,value:1});Object.defineProperty(player,'duration',{configurable:true,value:60});
  player.currentTime=13.9;await act(async()=>player.dispatchEvent(new Event('loadedmetadata')));await click('添加当前视频时间');
  player.currentTime=29;assert.equal(document.querySelector('input[type=number]').value,'13');
  await click('回复');assert.match(document.body.textContent,/回复 阿禾/);await input(document.querySelector('#comment-input'),'原卡回复');
  override=(path,options)=>{if(options.method==='POST')throw new Error('断网未保存');};await click('发送讨论');
  assert.equal(document.querySelector('#comment-input').value,'原卡回复');assert.equal(document.querySelector('input[type=number]').value,'13');assert.equal(JSON.parse(writes()[0].options.body).rootId,'c');
  await click('取消');assert.equal(document.querySelector('#comment-input').value,'');assert.equal(document.querySelector('input[type=number]').value,'');
  override=null;await input(document.querySelector('#comment-input'),'无时间新讨论');await click('发送讨论');assert.deepEqual(JSON.parse(writes().at(-1).options.body),{text:'无时间新讨论',timestampSec:null,rootId:null});
  assert.equal(document.querySelector('#comment-input').rows,1);
 }finally{await unmount();}}
});
test('B replies stay inside root card with identity and actual posted time',async()=>{setup();data['videos/v/comments']=[comment,{...comment,id:'reply',authorName:'木棉',authorJerseyNumber:'07',rootId:'c',replyTargetName:'阿禾',text:'同卡回复'}];try{await mount(VideoDiscussion);assert.equal(document.querySelectorAll('.discussion-card').length,1);const reply=document.querySelector('.reply');assert.equal(reply.closest('.discussion-card'),document.querySelector('.discussion-card'));assert.ok(reply.parentElement.classList.contains('discussion-replies'));assert.equal(reply.parentElement.style.marginLeft,'');assert.match(reply.textContent,/木棉.*07.*回复 阿禾.*发表于/);assert.ok(reply.querySelector('.default-avatar'));}finally{await unmount();}});
test('B profile return restores React state, cancel does not PATCH, success and later input truth',async()=>{setup('/me/edit');try{
 await mount(ProfileEditor);await input(document.querySelector('[name=discName]'),'返回保留');await unmount();await mount(ProfileEditor);assert.equal(document.querySelector('[name=discName]').value,'返回保留');
 let finish;override=(path,options)=>path==='me'&&options.method==='PATCH'?new Promise(resolve=>{finish=resolve;}):null;
 await click('保存资料');assert.equal(JSON.parse(writes()[0].options.body).discName,'返回保留');await input(document.querySelector('[name=discName]'),'后来输入');
 await act(async()=>finish(response({me:{...me,profile:{...me.profile,discName:'返回保留',version:2}}})));await flush();assert.equal(document.querySelector('[name=discName]').value,'后来输入');assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
 await click('取消修改');assert.equal(writes().length,1);await unmount();await mount(ProfileEditor);assert.equal(document.querySelector('[name=discName]').value,'木棉');
 override=(path,options)=>path==='me'&&options.method==='PATCH'?response({me:{...me,profile:{...me.profile,...JSON.parse(options.body),version:2}}}):null;
 await input(document.querySelector('[name=discName]'),'真实保存');await click('保存资料');assert.match(document.body.textContent,/资料已保存到账号.*真实保存/s);
 }finally{await unmount();}});
test('B member query return and collection entity buffers require fresh source validation',async()=>{setup('/members');try{
 await mount(MemberDirectory);await input(document.querySelector('input'),'阿');await unmount();await mount(MemberDirectory);assert.equal(document.querySelector('input').value,'阿');await unmount();
 window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'}));await mount(MemberDirectory);assert.equal(document.querySelector('input').value,'');await unmount();
 dom.window.history.replaceState({},'','/growth');data.collections=[{id:'one',sourceKind:'video',sourceId:'v',privateNote:'原备注',timestampSec:13,version:1,createdAt:'2026-10-18',source:null}];await mount(CollectionList);await click('编辑私人备注');await input(document.querySelector('textarea'),'私密未提交');await unmount();data.collections=[{...data.collections[0],id:'two',privateNote:'另一个'}];await mount(CollectionList);await click('编辑私人备注');assert.equal(document.querySelector('textarea').value,'另一个');
 }finally{await unmount();}});
test('B UI buffer fences cleared actor and unknown operation keeps immutable key until acknowledgment',()=>{
 setup('/trainings');confirmNavigationActor('A','epoch1');const stale=navigationBuffer('A','/trainings','test');stale.write({text:'private'});const first=pendingMutationKey('A','POST','trainings',{title:'x'},'candidate');assert.equal(pendingMutationKey('A','POST','trainings',{title:'x'},'new-candidate'),first);
 acknowledgeMutation('A','POST','trainings',{title:'x'});assert.notEqual(pendingMutationKey('A','POST','trainings',{title:'x'},'new'),first);
 clearNavigationActor('A');confirmNavigationActor('A','epoch1');stale.write({text:'late'});assert.equal(navigationBuffer('A','/trainings','test').read(),null);
});
test('B unknown writes survive ignored success and definitive rejection cleanup is exact and bounded',async()=>{
 setup('/trainings');confirmNavigationActor('A','epoch1');const {api}=await import('../../lib/client/api.ts');const {rejectMutationKey}=await import('../../lib/client/navigation-state.ts');
 override=()=>new Response(JSON.stringify({error:{code:'INVALID_INPUT',message:'invalid',retryable:false},requestId:'r'}),{status:400,headers:{'X-Kapok-Actor':'A'}});
 for(let i=0;i<25;i++)await assert.rejects(api('trainings',{method:'POST',actorId:'A',body:{title:String(i)},key:'candidate'}));
 override=null;await api('trainings',{method:'POST',actorId:'A',body:{title:'late'},key:'first'});await api('trainings',{method:'POST',actorId:'A',body:{title:'late'},key:'second'});
 const pair=writes().slice(-2);assert.equal(pair[0].options.headers['Idempotency-Key'],pair[1].options.headers['Idempotency-Key']);
 const old=pair[0].options.headers['Idempotency-Key'];acknowledgeMutation('A','POST','trainings',{title:'late'});const next=pendingMutationKey('A','POST','trainings',{title:'late'},'next');rejectMutationKey('A','POST','trainings',{title:'late'},old,'INVALID_INPUT');assert.equal(pendingMutationKey('A','POST','trainings',{title:'late'},'retry'),next);
 const trainingKey=pendingMutationKey('A','PATCH','trainings/t',{title:'x'},'training');rejectMutationKey('A','PATCH','trainings/t',{title:'x'},trainingKey,'VERSION_CONFLICT');assert.equal(pendingMutationKey('A','PATCH','trainings/t',{title:'x'},'different'),trainingKey);
 const profileKey=pendingMutationKey('A','PATCH','me',{discName:'x'},'profile');rejectMutationKey('A','PATCH','me',{discName:'x'},profileKey,'VERSION_CONFLICT');assert.equal(pendingMutationKey('A','PATCH','me',{discName:'x'},'different'),profileKey);
});
test('B legal auth return keeps video query/hash and controlled source back uses framework navigation',async()=>{
 setup('/videos/v?t=13#comment-c');const {AccessLink,ControlledBack}=await import('../../app/components/navigation.tsx');
 try{await mount(()=>React.createElement(AccessLink,{href:'/signin-with-chatgpt?return_to=%2Fvideos%2Fv%3Ft%3D13',returnTo:'/videos/v?t=13',param:'return_to'},'登录'));assert.equal(new URL(document.querySelector('a').href).searchParams.get('return_to'),'/videos/v?t=13#comment-c');await unmount();
 confirmNavigationActor('A','epoch1');dom.window.history.replaceState({},'','/activity');document.body.innerHTML='<a href="/reflections/r">查看</a>';const link=document.querySelector('a');link.addEventListener('click',e=>e.preventDefault());link.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));dom.window.history.replaceState({},'','/reflections/r');await mount(()=>React.createElement(ControlledBack,{fallback:'/growth'}));assert.equal(document.querySelector('a').getAttribute('href'),'/activity');
 }finally{await unmount();}
});
test('B reflection successful client navigation keeps original growth tab and list scroll',async()=>{
 setup('/growth');const {GrowthContent}=await import('../../app/components/growth-content.tsx');const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {navigation}=await import('../helpers/next-stubs.mjs');
 const reflection={id:'r',title:'复盘',text:'原文',date:'2026-10-18',isAuthor:true,author:{id:'u',discName:'木棉',jerseyNumber:'07'},version:1,sharingVersion:1,generation:1,scope:'private',published:false,trainingId:null,videoId:null,link:null};
 data.reflections=[reflection];data['reflections/r/edit']=reflection;data.collections=[{id:'one',sourceKind:'reflection',sourceId:'r',privateNote:'原备注',timestampSec:null,version:1,createdAt:'2026-10-18',source:{title:'复盘',href:'/reflections/r'}}];
 let y=0,restored=0;Object.defineProperty(window,'scrollY',{configurable:true,get:()=>y});const originalScroll=window.scrollTo;window.scrollTo=(_x,value)=>{restored=value;y=value;};
 const follow=path=>{const anchor=document.createElement('a');anchor.href=path;anchor.addEventListener('click',event=>event.preventDefault());document.body.append(anchor);anchor.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));anchor.remove();};
 try{
  await mount(GrowthContent);await click('收藏');y=275;window.dispatchEvent(new Event('scroll'));follow('/reflections/r');await unmount();dom.window.history.replaceState({},'','/reflections/r');follow('/reflections/r/edit');dom.window.history.replaceState({},'','/reflections/r/edit');
  await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',id:'r'}));await input(document.querySelector('textarea'),'新正文');
  override=(path,options)=>path==='reflections/r'&&options.method==='PATCH'?response({...reflection,...JSON.parse(options.body),version:2}):null;
  await click('保存记录');assert.equal(navigation.at(-1),'/reflections/r?saved=1');
  const {controlledBackSource}=await import('../../lib/client/navigation-state.ts');dom.window.history.replaceState({},'','/reflections/r');assert.equal(controlledBackSource(),'/growth');
  await unmount();dom.window.history.replaceState({},'','/growth');await mount(GrowthContent);assert.equal([...document.querySelectorAll('button')].find(node=>node.textContent==='收藏').getAttribute('aria-pressed'),'true');assert.equal(restored,275);
 }finally{window.scrollTo=originalScroll;await unmount();}
});
test('B admin form return keeps edited fields and unknown request key, rights loss clears them',async()=>{
 setup('/admin/announcements','admin');const {AnnouncementAdmin}=await import('../../app/components/community.tsx');data.announcements=[];
 try{await mount(AnnouncementAdmin);await input(document.querySelector('[name=title]'),'未提交标题');await input(document.querySelector('[name=text]'),'未提交正文');await unmount();await mount(AnnouncementAdmin);assert.equal(document.querySelector('[name=title]').value,'未提交标题');assert.equal(writes().length,0);
 override=(path,options)=>{if(path==='announcements'&&options.method==='POST')throw new Error('lost');};await click('保存草稿');const first=writes()[0];await unmount();await mount(AnnouncementAdmin);await click('保存草稿');assert.equal(writes().at(-1).options.headers['Idempotency-Key'],first.options.headers['Idempotency-Key']);assert.equal(writes().at(-1).options.body,first.options.body);
 await unmount();override=path=>path==='announcements'?new Response(JSON.stringify({error:{code:'FORBIDDEN',message:'no access',retryable:false}}),{status:403,headers:{'X-Kapok-Actor':'A'}}):null;await mount(AnnouncementAdmin);assert.equal(document.querySelector('form'),null);await unmount();override=null;await mount(AnnouncementAdmin);assert.equal(document.querySelector('[name=title]').value,'');
 }finally{await unmount();}
});
test('B browser UI bounds do not expose mutable snapshots or initialize server user state',()=>{
 setup('/me/edit');confirmNavigationActor('A','epoch1');const buffer=navigationBuffer('A','/me/edit','bounded');buffer.write({text:'small'});const copy=buffer.read();copy.text='changed';assert.equal(buffer.read().text,'small');buffer.write({text:'棉'.repeat(12_000)});assert.equal(buffer.read().text,'small');
 for(let i=0;i<81;i++)navigationBuffer('A','/me/edit','entry'+i).write(i);assert.equal(buffer.read(),null);
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');Object.defineProperty(globalThis,'window',{configurable:true,value:undefined});try{confirmNavigationActor('server','secret');assert.equal(navigationBuffer('server','/','private').read(),null);assert.equal(pendingMutationKey('server','POST','trainings',{title:'x'},'native-key'),'native-key');}finally{Object.defineProperty(globalThis,'window',descriptor);}
});
test('B My summary has default avatar/edit entry and profile conflict keeps input until explicit retry',async()=>{
 setup('/me');const {MyScreen}=await import('../../app/components/legacy-screens.tsx');try{await mount(MyScreen);assert.ok(document.querySelector('.default-avatar'));assert.equal(document.querySelector('form'),null);assert.ok(document.querySelector('a[href="/me/edit"]'));await unmount();
 dom.window.history.replaceState({},'','/me/edit');await mount(ProfileEditor);await input(document.querySelector('[name=discName]'),'冲突输入');override=(path,options)=>path==='me'&&options.method==='PATCH'?new Response(JSON.stringify({error:{code:'VERSION_CONFLICT',message:'资料版本冲突',retryable:false}}),{status:409,headers:{'X-Kapok-Actor':'A'}}):null;await click('保存资料');assert.equal(document.querySelector('[name=discName]').value,'冲突输入');assert.match(document.body.textContent,/资料已在其他位置更新/);assert.ok(!document.body.textContent.includes('资料已保存到账号。'));
 }finally{await unmount();}
});
test('B manual time editing confirms or cancels before changing the frozen annotation',async()=>{
 setup();try{await mount(VideoDiscussion);const media=document.querySelector('video');Object.defineProperty(media,'readyState',{configurable:true,value:1});Object.defineProperty(media,'duration',{configurable:true,value:60});media.currentTime=13;await act(async()=>media.dispatchEvent(new Event('loadedmetadata')));await click('添加当前视频时间');await input(document.querySelector('#comment-input'),'手动时间');await click('修改时间点');await input(document.querySelector('input[type=number]'),'8');await click('发送讨论');assert.equal(writes().length,0);assert.match(document.body.textContent,/已添加时间点 00:13/);await click('取消时间修改');assert.equal(document.querySelector('input[type=number]').value,'13');
 await click('修改时间点');await input(document.querySelector('input[type=number]'),'-1');await click('确认时间点');assert.match(document.body.textContent,/非负整数秒/);await click('取消时间修改');await click('修改时间点');await input(document.querySelector('input[type=number]'),'8');await click('确认时间点');media.currentTime=29;assert.equal(document.querySelector('input[type=number]').value,'8');await click('发送讨论');assert.equal(JSON.parse(writes().at(-1).options.body).timestampSec,8);
 }finally{await unmount();}
});
test('B unavailable reply keeps private draft and target while blocking silent top-level submission',async()=>{
 setup();try{await mount(VideoDiscussion);await click('回复');await input(document.querySelector('#comment-input'),'仅本人的未提交回复');await unmount();data['videos/v/comments']=[{...comment,text:null,status:'deleted'}];await mount(VideoDiscussion);assert.equal(document.querySelector('#comment-input').value,'仅本人的未提交回复');const composer=document.querySelector('[data-own-buffer]');assert.match(composer.textContent,/回复 当前不可用的讨论/);assert.ok(!composer.textContent.includes('阿禾'));await click('发送讨论');assert.equal(writes().length,0);await click('取消回复并清除草稿');assert.equal(document.querySelector('#comment-input').value,'');
 }finally{await unmount();}
});
test('B explicit new-version profile submit uses freshly read truth without replacing the owner input',async()=>{
 setup('/me/edit');try{await mount(ProfileEditor);await input(document.querySelector('[name=discName]'),'保留输入');let first=true;override=(path,options)=>{if(path!=='me'||options.method!=='PATCH')return null;if(first){first=false;data.me={...me,profile:{...me.profile,discName:'其他位置资料',version:2}};return new Response(JSON.stringify({error:{code:'VERSION_CONFLICT',message:'changed',retryable:false}}),{status:409,headers:{'X-Kapok-Actor':'A'}});}const body=JSON.parse(options.body);assert.equal(body.expectedVersion,2);return response({me:{...data.me,profile:{...data.me.profile,discName:body.discName,version:3}}});};await click('保存资料');assert.equal(document.querySelector('[name=discName]').value,'保留输入');assert.match(document.body.textContent,/其他位置资料/);assert.ok(button('重新载入当前资料'));assert.equal(writes().length,1);await click('基于当前资料版本保存输入');assert.equal(writes().length,2);assert.match(document.body.textContent,/资料已保存到账号.*保留输入/s);
 }finally{await unmount();}
});
test('B confirmed inactive account drops mounted input and cannot restore it on a later active read',async()=>{
 setup('/me/edit');try{await mount(ProfileEditor);await input(document.querySelector('[name=discName]'),'已失权私密输入');override=(path,options)=>{if(path==='me'&&options.method==='PATCH'){const inactive={user:{id:'u',status:'deleted'},profile:null,membership:null};data.bootstrap={...data.bootstrap,me:inactive};return response({me:inactive});}return null;};await click('保存资料');assert.equal(document.querySelector('form'),null);override=null;data.bootstrap={siteUserId:'A',me};await act(async()=>window.dispatchEvent(new Event('focus')));await flush();assert.equal(document.querySelector('[name=discName]').value,'木棉');
 }finally{await unmount();}
});

for (const [kind, path, submitLabel] of [['profile','/me/edit','保存资料'],['join','/join','保存资料并加入'],['bootstrap','/internal/bootstrap','初始化合成队伍']]) {
 test(`B fix1 ${kind} composes both restored fields and retries unknown exact body/key`, async()=>{
  setup(path);const {JoinScreen,BootstrapScreen}=await import('../../app/components/legacy-screens.tsx');
  if(kind!=='profile')data.bootstrap={siteUserId:'A',initialized:false,canBootstrap:true,me:{user:null,profile:null,membership:null,team:null}};
  const screen=kind==='profile'?ProfileEditor:kind==='join'?()=>React.createElement(JoinScreen,{actorId:'A',token:'valid-synthetic-token',returnTo:'/growth'}):BootstrapScreen;
  override=(_path,options)=>{if(options.method==='PATCH'||options.method==='POST')throw new Error('lost response');return null;};
  try{await mount(screen);await input(document.querySelector('[name=discName]'),'RestoredName');await input(document.querySelector('[name=jerseyNumber]'),'19');await click(submitLabel);
   const original=writes()[0];assert.equal(JSON.parse(original.options.body).discName,'RestoredName');assert.equal(JSON.parse(original.options.body).jerseyNumber,'19');
   await unmount();await mount(screen);assert.equal(document.querySelector('[name=discName]').value,'RestoredName');assert.equal(document.querySelector('[name=jerseyNumber]').value,'19');assert.equal(writes().length,1);
   await click(submitLabel);assert.equal(writes().length,2);assert.equal(writes()[1].options.body,original.options.body);assert.equal(writes()[1].options.headers['Idempotency-Key'],original.options.headers['Idempotency-Key']);
  }finally{await unmount();}
 });
}
test('B fix1 queued old seeked cannot confirm a new still-seeking or different mounted player',()=>{
 const events=[];const seek=createVideoSeek((kind,text)=>events.push([kind,text]));const media={currentTime:2,duration:60,readyState:1,seeking:false};
 try{seek.request('v',2,media);seek.seeked('v',media);assert.equal(events.at(-1)[0],'success');media.seeking=true;seek.request('v',13,media);assert.equal(media.currentTime,13);seek.seeked('v',media);assert.notEqual(events.at(-1)[0],'success');
  media.seeking=false;seek.seeked('v',{...media});assert.notEqual(events.at(-1)[0],'success');seek.seeked('v',media);assert.equal(events.at(-1)[0],'success');
 }finally{seek.dispose();}
});

test('B growth all filter merges authorized records by month and retains unavailable source notes',async()=>{
 setup('/growth');const {GrowthContent}=await import('../../app/components/growth-content.tsx');
 data.reflections=[{id:'r',title:'十月复盘',text:'本人正文',date:'2026-10-17',scope:'private'}];
 data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'仍保留的私人备注',timestampSec:13,version:1,createdAt:'2026-09-18',source:null}];
 try{
  await mount(GrowthContent);assert.equal(button('全部').getAttribute('aria-pressed'),'true');
  assert.match(document.body.textContent,/2026年10月.*十月复盘.*2026年09月.*来源暂不可用/s);
  await click('编辑私人备注');assert.equal(document.querySelector('textarea').value,'仍保留的私人备注');
  await input(document.querySelector('textarea'),'切换前未保存');await click('复盘');assert.ok(document.querySelector('a[href="/reflections/r"]'));assert.ok(document.querySelector('textarea').closest('[hidden]'));
  await click('收藏');assert.ok(document.querySelector('a[href="/reflections/r"]').closest('[hidden]'));assert.equal(document.querySelector('textarea').value,'切换前未保存');
  assert.equal(writes().length,0);
 }finally{await unmount();}
});
test('B private video note and one-row discussion are separate forms and save separate payloads',async()=>{
 setup();try{
  await mount(VideoDiscussion);const note=document.querySelector('.private-note textarea');assert.ok(note);assert.equal(note.rows,3);
  const discussion=document.querySelector('#comment-input');assert.equal(discussion.rows,1);assert.notEqual(note.closest('form'),discussion.closest('form'));
  await input(note,'只留给自己');await click('保存私人备注');assert.equal(writes().length,1);assert.equal(writes()[0].path,'collections');
  assert.deepEqual(JSON.parse(writes()[0].options.body),{sourceKind:'video',sourceId:'v',timestampSec:null,privateNote:'只留给自己'});
  assert.equal(document.querySelector('#comment-input').value,'');assert.ok(!writes().some(c=>c.path.endsWith('/comments')));
 }finally{await unmount();}
});
test('B member empty and search-empty states are distinct without concealing a read error',async()=>{
 setup('/members');try{
  await mount(MemberDirectory);await input(document.querySelector('input'),'没有匹配');assert.match(document.body.textContent,/没有匹配的成员/);await unmount();
  clearNavigationActor('A');data.members=[];await mount(MemberDirectory);assert.match(document.body.textContent,/队伍暂时没有成员/);await unmount();
  override=path=>path==='members'?new Response(JSON.stringify({error:{code:'NETWORK',message:'暂时无法加载，请重试',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}}):null;
  await mount(MemberDirectory);assert.match(document.body.textContent,/暂时无法加载/);assert.ok(!document.body.textContent.includes('队伍暂时没有成员'));
 }finally{await unmount();}
});

test('B growth a failed collection read does not turn into an empty or partial success list',async()=>{
 setup('/growth');const {GrowthContent}=await import('../../app/components/growth-content.tsx');
 data.reflections=[{id:'r',title:'不可作为部分成功展示',text:'本人正文',date:'2026-10-17',scope:'private'}];
 override=path=>path==='collections'?new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'收藏暂时无法加载',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}}):null;
 try{await mount(GrowthContent);assert.match(document.body.textContent,/收藏暂时无法加载/);assert.ok(!document.body.textContent.includes('还没有成长记录'));assert.equal(document.querySelector('a[href="/reflections/r"]'),null);}finally{await unmount();}
});

test('B private note accepts only a current matching owner value, not a duplicate collection receipt',async()=>{
 for(const matching of [true,false]){setup();
  data.collections=[{id:'saved',privateNote:matching?'本次备注':'以前的备注'}];
  override=(path,options)=>path==='collections'&&options.method==='POST'?response({id:'saved'}):null;
  try{
   await mount(VideoDiscussion);await input(document.querySelector('.private-note textarea'),' 本次备注 ');await click('保存私人备注');
   if(matching){assert.match(document.body.textContent,/私人备注已保存到账号/);assert.equal(document.querySelector('.private-note textarea'),null);}
   else{assert.match(document.body.textContent,/此次备注尚未保存/);assert.equal(document.querySelector('.private-note textarea').value,' 本次备注 ');assert.ok(!document.body.textContent.includes('私人备注已保存到账号'));assert.ok(document.querySelector('.private-note a[href="/growth"]'));}
  }finally{await unmount();}
 }
});
test('discussion collection reconciles the owner note before claiming success or clearing new input',async()=>{
 for(const matching of [false,true]){setup();
  data.collections=[{id:'saved-comment',privateNote:matching?'本次讨论备注':'以前的讨论备注'}];
  override=(path,options)=>path==='collections'&&options.method==='POST'?response({id:'saved-comment'}):null;
  try{
   await mount(VideoDiscussion);await click('加入成长');
   await input(document.querySelector('.collection-action textarea'),' 本次讨论备注 ');await click('保存收藏');
   assert.deepEqual(JSON.parse(writes()[0].options.body),{sourceKind:'comment',sourceId:'c',timestampSec:null,privateNote:' 本次讨论备注 '});
   assert.ok(!writes().some(call=>call.options.method==='PATCH'),'duplicate submission must not overwrite an existing note');
   if(matching){assert.match(document.body.textContent,/已加入本人成长/);assert.equal(document.querySelector('.collection-action textarea'),null);}
   else{
    assert.equal(document.querySelector('.collection-action textarea').value,' 本次讨论备注 ');
    assert.match(document.querySelector('.collection-action').textContent,/此次备注尚未保存/);
    assert.ok(document.querySelector('.collection-action a[href="/growth"]'));
    assert.ok(!document.body.textContent.includes('已加入本人成长'));
    await unmount();await mount(VideoDiscussion);
    assert.equal(document.querySelector('.collection-action textarea').value,' 本次讨论备注 ','same-account return retains the unsaved note');
   }
  }finally{await unmount();}
 }
});
test('discussion collection verification failure or late account response cannot claim a note save',async()=>{
 for(const late of [false,true]){setup();let finish;
  override=(path,options)=>path==='collections'?(options.method==='POST'?response({id:'saved-comment'}):late?new Promise(resolve=>{finish=resolve;}):new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'讨论备注尚未核对',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}})):null;
  try{
   await mount(VideoDiscussion);await click('加入成长');await input(document.querySelector('.collection-action textarea'),'等待核对的讨论备注');await click('保存收藏');
   const request=writes()[0],body=JSON.parse(request.options.body),key=request.options.headers['Idempotency-Key'];
   if(late){
    assert.ok(finish);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));
    await act(async()=>finish(response([{id:'saved-comment',privateNote:'等待核对的讨论备注'}])));await flush();
    assert.equal(document.querySelector('.collection-action textarea'),null);
    assert.ok(!document.body.textContent.includes('等待核对的讨论备注'));
   }else{
    assert.equal(document.querySelector('.collection-action textarea').value,'等待核对的讨论备注');
    assert.match(document.querySelector('.collection-action').textContent,/讨论备注尚未核对/);
    assert.equal(pendingMutationKey('A','POST','collections',body,'different-candidate'),key);
    await click('保存收藏');assert.equal(writes()[1].options.headers['Idempotency-Key'],key);
   }
   assert.ok(!document.body.textContent.includes('已加入本人成长'));
   assert.ok(!writes().some(call=>call.options.method==='PATCH'));
  }finally{await unmount();}
 }
});
test('growth note PATCH failure retains owner input and explicit save refreshes the persisted note',async()=>{
 setup('/growth');let fail=true;
 data.collections=[{id:'saved',sourceKind:'comment',sourceId:'c',privateNote:'已有备注',timestampSec:4,version:1,createdAt:'2026-10-18',source:{title:'讨论视频',text:'原文',href:'/videos/v?t=4#comment-c'}}];
 override=(path,options)=>{
  if(path!=='collections/saved'||options.method!=='PATCH')return null;
  if(fail)return new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'备注保存失败，请重试',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}});
  data.collections=[{...data.collections[0],privateNote:JSON.parse(options.body).privateNote,version:2}];return response({id:'saved'});
 };
 try{
  await mount(CollectionList);await click('编辑私人备注');await input(document.querySelector('textarea'),'明确编辑的新备注');await click('保存备注');
  assert.equal(document.querySelector('textarea').value,'明确编辑的新备注');assert.match(document.body.textContent,/备注保存失败/);
  assert.ok(!document.body.textContent.includes('当前备注已保存在账号中'));
  const key=writes()[0].options.headers['Idempotency-Key'];fail=false;await click('保存备注');
  assert.equal(writes()[1].options.headers['Idempotency-Key'],key);assert.match(document.body.textContent,/当前备注已保存在账号中/);
  await unmount();await mount(CollectionList);assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note').textContent,/明确编辑的新备注/);
  assert.equal(document.querySelector('.collection-card h2 a').getAttribute('href'),'/videos/v?t=4#comment-c');
 }finally{await unmount();}
});
test('B private note failed verification and a late response after account loss cannot clear input or report success',async()=>{
 for(const late of [false,true]){setup();let finish;
  override=(path,options)=>path==='collections'?(options.method==='POST'?response({id:'saved'}):late?new Promise(resolve=>{finish=resolve;}):new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'尚未核对备注',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}})):null;
  try{
   await mount(VideoDiscussion);await input(document.querySelector('.private-note textarea'),'等待核对的备注');await click('保存私人备注');
   if(late){assert.ok(finish);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await act(async()=>finish(response([{id:'saved',privateNote:'等待核对的备注'}])));await flush();}
   else{assert.equal(document.querySelector('.private-note textarea').value,'等待核对的备注');assert.match(document.body.textContent,/尚未核对备注/);}
   assert.ok(!document.body.textContent.includes('私人备注已保存到账号'));
  }finally{await unmount();}
 }
});
test('B growth fresh source revalidation removes titles from visible and hidden filtered rows',async()=>{
 setup('/growth');const {GrowthContent}=await import('../../app/components/growth-content.tsx');data.reflections=[];
 data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'本人备注',timestampSec:null,version:1,createdAt:'2026-10-18',source:{title:'撤权前来源标题',href:'/videos/v'}}];
 try{
  await mount(GrowthContent);assert.ok(document.body.textContent.includes('撤权前来源标题'));await click('复盘');
  data.collections=[{...data.collections[0],source:null}];await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
  assert.ok(!document.body.textContent.includes('撤权前来源标题'));await click('收藏');assert.match(document.body.textContent,/来源暂不可用/);await click('编辑私人备注');assert.equal(document.querySelector('textarea').value,'本人备注');
  await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await flush();assert.ok(!document.body.textContent.includes('来源暂不可用'));assert.equal(document.querySelector('textarea'),null);
 }finally{await unmount();}
});

test('B reconciled duplicate private notes do not exhaust the pending budget or block unrelated saves',async()=>{
 setup();const {api}=await import('../../lib/client/api.ts');
 data.collections=[{id:'saved',privateNote:'已有私人备注'}];
 override=(path,options)=>path==='collections'&&options.method==='POST'?response({id:'saved'}):null;
 try{
  await mount(VideoDiscussion);
  for(let index=0;index<25;index++){
   const note=`本次不同输入 ${index}`;
   await input(document.querySelector('.private-note textarea'),note);await click('保存私人备注');
   assert.equal(writes().filter(call=>call.path==='collections').length,index+1,'each distinct reconciled request must reach the server beyond the pending limit');
   assert.equal(document.querySelector('.private-note textarea').value,note);
   assert.match(document.body.textContent,/此次备注尚未保存/);
   assert.ok(document.querySelector('.private-note a[href="/growth"]'));
   assert.ok(!document.body.textContent.includes('私人备注已保存到账号'));
  }
  await api('trainings',{method:'POST',actorId:'A',body:{title:'独立提交仍可进行'},key:'unrelated-training'});
  assert.equal(writes().filter(call=>call.path==='trainings').length,1);
  assert.ok(!writes().some(call=>call.options.method==='PATCH'),'duplicate-note reconciliation must not update the existing note implicitly');
 }finally{await unmount();}
});
test('B missing collection receipt or missing returned-ID owner row retains the unknown POST key',async()=>{
 const {api}=await import('../../lib/client/api.ts');
 for(const missing of ['receipt','row']){setup();
  data.collections=[{id:'saved',privateNote:'本次备注'}];
  override=(path,options)=>path==='collections'&&options.method==='POST'?response(missing==='receipt'?{}:{id:'unresolved'}):null;
  try{
   await mount(VideoDiscussion);await input(document.querySelector('.private-note textarea'),'本次备注');await click('保存私人备注');
   const request=writes()[0],body=JSON.parse(request.options.body),key=request.options.headers['Idempotency-Key'];
   assert.equal(pendingMutationKey('A','POST','collections',body,'different-candidate'),key,missing);
   assert.equal(document.querySelector('.private-note textarea').value,'本次备注');assert.ok(!document.body.textContent.includes('私人备注已保存到账号'));
   await click('保存私人备注');assert.equal(writes()[1].options.headers['Idempotency-Key'],key);
   // Consume an unrelated real API mutation as a sanity check without acknowledging the unknown note.
   await api('trainings',{method:'POST',actorId:'A',body:{title:missing},key:'other'});
   assert.equal(pendingMutationKey('A','POST','collections',body,'another-candidate'),key);
  }finally{await unmount();}
 }
});
test('B failed or stale private-note verification retains the exact unknown POST key for same-account recovery',async()=>{
 for(const stale of [false,true]){setup();let finish;
  override=(path,options)=>path==='collections'?(options.method==='POST'?response({id:'saved'}):stale?new Promise(resolve=>{finish=resolve;}):new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'尚未核对备注',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}})):null;
  try{
   await mount(VideoDiscussion);await input(document.querySelector('.private-note textarea'),'尚未确认输入');await click('保存私人备注');
   const request=writes()[0],body=JSON.parse(request.options.body),key=request.options.headers['Idempotency-Key'];
   if(stale){assert.ok(finish);await act(async()=>window.dispatchEvent(new Event('blur')));await act(async()=>finish(response([{id:'saved',privateNote:'尚未确认输入'}])));await flush();}
   assert.equal(pendingMutationKey('A','POST','collections',body,'different-candidate'),key);
   assert.equal(document.querySelector('.private-note textarea').value,'尚未确认输入');assert.ok(!document.body.textContent.includes('私人备注已保存到账号'));
   if(stale){override=(path,options)=>path==='collections'?(options.method==='POST'?response({id:'saved'}):response([{id:'saved',privateNote:'尚未确认输入'}])):null;await act(async()=>window.dispatchEvent(new Event('focus')));await flush();}
   await click('保存私人备注');assert.equal(writes()[1].options.headers['Idempotency-Key'],key);
  }finally{await unmount();}
 }
});
test('B shell uses one header tagline while keeping the wordmark branding',async()=>{
 setup('/me');const {Shell}=await import('../../app/components/shell.tsx');
 try{await mount(()=>React.createElement(Shell,{title:'我的',nav:false}));const header=document.querySelector('.topbar');assert.equal(header.textContent.match(/训练之后/g)?.length,1);assert.equal(header.querySelector('.wordmark span').textContent,'训练之后');}finally{await unmount();}
});

test('B8 official Bilibili frame is bounded and unloads synchronously on account lock',async()=>{
 setup(); data['videos/v']={...video,source:'bilibili',url:'https://www.bilibili.com/video/BV1raQXYpEkG/?spm_id_from=333&p=2',durationSec:null};
 try {
  await mount(VideoDiscussion);
  const frame=document.querySelector('iframe'); assert.ok(frame);
  const url=new URL(frame.src); assert.equal(url.origin,'https://player.bilibili.com'); assert.equal(url.searchParams.get('bvid'),'BV1raQXYpEkG'); assert.equal(url.searchParams.get('p'),'2'); assert.equal(url.searchParams.get('autoplay'),'0'); assert.equal(url.searchParams.has('spm_id_from'),false);
  assert.equal(document.querySelector('video'),null);
  await act(async()=>window.dispatchEvent(new Event('blur')));
  assert.equal(frame.getAttribute('src'),'about:blank'); assert.equal(document.querySelector('iframe'),null);
  await act(async()=>window.dispatchEvent(new Event('focus')));await flush();assert.ok(document.querySelector('iframe'));
  await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await flush();assert.equal(document.querySelector('iframe'),null);
 } finally {await unmount();}
});


test('B8 focusing official iframe is not leaving the page; actual window departure still locks',async()=>{
 setup(); data['videos/v']={...video,source:'bilibili',url:'https://www.bilibili.com/video/BV1raQXYpEkG/',durationSec:null};
 const original=document.hasFocus;
 try {
  await mount(VideoDiscussion); const frame=document.querySelector('iframe');
  await act(async()=>frame.focus());
  document.hasFocus=()=>true;
  await act(async()=>window.dispatchEvent(new Event('blur')));
  assert.equal(document.querySelector('iframe'),frame);assert.equal(frame.closest('[data-kapok-sensitive]').hidden,false);
  const reads=calls.length;await act(async()=>window.dispatchEvent(new Event('focus')));await flush();assert.equal(calls.length,reads);assert.equal(document.querySelector('iframe'),frame);
  await act(async()=>window.dispatchEvent(new Event('blur')));
  document.hasFocus=()=>false;
  await act(async()=>window.dispatchEvent(new Event('blur')));
  assert.equal(frame.getAttribute('src'),'about:blank');assert.equal(document.querySelector('iframe'),null);
 } finally {document.hasFocus=original;await unmount();}
});

test('B8 link-only add form preserves failed inputs and retries the same request before clearing',async()=>{
 setup('/trainings/tr','admin');
 const {AddVideoForm}=await import('../../app/components/training-forms.tsx');
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');
 const Form=()=>React.createElement(AccountBoundary,{actorId:'A',load:'me'},()=>React.createElement(AddVideoForm,{actorId:'A',trainingId:'tr'}));
 try {
  await mount(Form);assert.equal(document.querySelector('input[type=file]'),null);assert.equal(document.querySelector('select'),null);
  const url='https://www.bilibili.com/video/BV1raQXYpEkG/?spm_id_from=333';
  await input(document.querySelector('[name=url]'),url);await input(document.querySelector('[name=title]'),'链接验证');
  override=(path,options)=>{if(options.method==='POST')throw new Error('网络中断');};
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await flush();
  assert.equal(document.querySelector('[name=url]').value,url);assert.equal(document.querySelector('[name=title]').value,'链接验证');assert.match(document.querySelector('[role=alert]').textContent,/网络中断/);
  const first=writes().at(-1);assert.deepEqual(JSON.parse(first.options.body),{title:'链接验证',position:0,source:'bilibili',url});
  override=(path,options)=>options.method==='POST'?response({id:'new-video'}):null;
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await flush();
  assert.deepEqual(writes().at(-1).options.headers,first.options.headers);assert.equal(document.querySelector('[name=url]').value,'');
  assert.equal(calls.some(c=>c.path.startsWith('uploads')),false);
 }finally{await unmount();}
});

test('B10 video dialog opens from heading, retains cancelled inputs, closes after success and on lock',async()=>{
 setup('/trainings/tr','admin');
 const {AddVideoDialog}=await import('../../app/components/training-forms.tsx');
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');
 const Surface=()=>React.createElement(AccountBoundary,{actorId:'A',load:'me'},()=>React.createElement(AddVideoDialog,{actorId:'A',trainingId:'tr',nextPosition:4}));
 try{
  await mount(Surface);const dialog=document.querySelector('dialog');assert.equal(dialog.open,false);assert.equal(document.querySelector('[aria-label="添加视频"]').parentElement.querySelector('h2').textContent,'训练视频');
  await act(async()=>document.querySelector('[aria-label="添加视频"]').click());assert.equal(dialog.open,true);
  await input(document.querySelector('[name=url]'),'https://b23.tv/vP9CEuO');await input(document.querySelector('[name=title]'),'弹窗新增');
  await act(async()=>document.querySelector('[aria-label="关闭添加视频"]').click());assert.equal(dialog.open,false);assert.equal(writes().length,0);
  await act(async()=>document.querySelector('[aria-label="添加视频"]').click());assert.equal(document.querySelector('[name=title]').value,'弹窗新增');
  override=(path,options)=>options.method==='POST'?response({id:'new'}):null;
  await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await flush();assert.equal(dialog.open,false);assert.equal(JSON.parse(writes()[0].options.body).position,4);assert.equal(document.querySelector('[name=url]').value,'');
  await act(async()=>document.querySelector('[aria-label="添加视频"]').click());assert.equal(dialog.open,true);
  await act(async()=>window.dispatchEvent(new Event('blur')));assert.equal(dialog.open,false);
 }finally{await unmount();}
});

test('publish confirmation return waits for superseding same-account verification before one write',async()=>{
 setup('/trainings/tr','admin');
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');
 const {TrainingForm}=await import('../../app/components/training-forms.tsx');
 data['trainings/tr']={...training,status:'draft',description:'fixture',version:1};
 const originalConfirm=window.confirm;let release,delayed=false;
 try{
  await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'trainings/tr'},t=>React.createElement(TrainingForm,{actorId:'A',training:t})));
  document.querySelector('[name=status]').value='published';
  window.confirm=()=>{throw new Error('training must not use browser confirmation');};delayed=true;
  override=(path,options)=>{
   if(path==='bootstrap'&&delayed){delayed=false;return new Promise(resolve=>{release=()=>resolve(response(data.bootstrap));});}
   if(options.method==='PATCH'){data['trainings/tr']={...data['trainings/tr'],...JSON.parse(options.body),version:2};return response(data['trainings/tr']);}
  };
  await click('保存训练');await click('确认并保存');assert.equal(writes().length,0);
  await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
  await act(async()=>release());await flush();
  assert.equal(writes().length,1,'confirmation/focus race must not discard the authorized submit');
  assert.equal(data['trainings/tr'].status,'published');assert.equal(document.querySelector('[role=alert]'),null);
 }finally{window.confirm=originalConfirm;await unmount();}
});

test('publish authorization refuses departure, changed actor, changed rights and expired session without a write',async()=>{
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');
 const {TrainingForm}=await import('../../app/components/training-forms.tsx');
 const originalConfirm=window.confirm;window.confirm=()=>true;
 try{for(const scenario of ['blur','actor','role','expired']){
  setup('/trainings/tr','admin');data['trainings/tr']={...training,status:'draft',description:'fixture',version:1};let release;
  try{
   await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'trainings/tr'},t=>React.createElement(TrainingForm,{actorId:'A',training:t})));
   document.querySelector('[name=status]').value='published';
   override=path=>path==='bootstrap'?new Promise(resolve=>{release=resolve;}):null;
   await click('保存训练');await click('确认并保存');override=null;
   if(scenario==='blur')await act(async()=>window.dispatchEvent(new Event('blur')));
   if(scenario==='expired')await act(async()=>window.dispatchEvent(new CustomEvent('kapok-session-expired',{detail:'A'})));
   const state=scenario==='actor'?{...data.bootstrap,siteUserId:'B'}:scenario==='role'?{...data.bootstrap,me:{...data.bootstrap.me,membership:{...data.bootstrap.me.membership,role:'member',epoch:2}}}:data.bootstrap;
   await act(async()=>release(response(state)));await flush();assert.equal(writes().length,0,scenario);
  }finally{await unmount();}
 }}finally{window.confirm=originalConfirm;}
});

test('publish duplicate submit sends once and lost result retains immutable retry without automatic mutation',async()=>{
 setup('/trainings/tr','admin');const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');const {TrainingForm}=await import('../../app/components/training-forms.tsx');
 data['trainings/tr']={...training,status:'draft',description:'fixture',version:1};const originalConfirm=window.confirm;window.confirm=()=>true;let fail;
 try{
  await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'trainings/tr'},t=>React.createElement(TrainingForm,{actorId:'A',training:t})));
  document.querySelector('[name=status]').value='published';
  override=(_path,options)=>options.method==='PATCH'?new Promise((_resolve,reject)=>{fail=reject;}):null;
  const form=document.querySelector('form');await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();const confirmButton=button('确认并保存');await act(async()=>{confirmButton.click();confirmButton.click();});await flush();assert.equal(writes().length,1);
  await act(async()=>fail(new Error('transport result unknown')));await flush();assert.equal(writes().length,1);assert.equal(document.querySelector('[name=status]').value,'published');
  override=(_path,options)=>{if(options.method==='PATCH')throw new Error('still unknown');};await click('保存训练');await click('确认并保存');assert.equal(writes().length,2);assert.equal(writes()[0].options.headers['Idempotency-Key'],writes()[1].options.headers['Idempotency-Key']);assert.equal(writes()[0].options.body,writes()[1].options.body);
 }finally{window.confirm=originalConfirm;await unmount();}
});

test('publish late authorization cannot cross replacement actor/permission verification or blur recovery',async()=>{
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');
 const {TrainingForm}=await import('../../app/components/training-forms.tsx');
 const originalConfirm=window.confirm;window.confirm=()=>true;
 try{for(const scenario of ['actor','role-epoch','epoch-readable','blur-focus']){
  setup('/trainings/tr','admin');data['trainings/tr']={...training,title:'old administrator-only title',status:'draft',description:'old protected description',version:1};
  let release;
  try{
   await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'trainings/tr'},t=>React.createElement(TrainingForm,{actorId:'A',training:t})));
   document.querySelector('[name=status]').value='published';
   const oldBootstrap=structuredClone(data.bootstrap);
   override=path=>path==='bootstrap'?new Promise(resolve=>{release=resolve;}):null;
   await click('保存训练');await click('确认并保存');assert.equal(writes().length,0);
   if(scenario==='actor')data.bootstrap={...data.bootstrap,siteUserId:'B'};
   if(scenario==='role-epoch')data.bootstrap={...data.bootstrap,me:{...data.bootstrap.me,membership:{...data.bootstrap.me.membership,role:'member',epoch:2}}};
   if(scenario==='epoch-readable'){data.bootstrap={...data.bootstrap,me:{...data.bootstrap.me,membership:{...data.bootstrap.me.membership,epoch:2}}};data['trainings/tr']={...data['trainings/tr'],title:'fresh verified title',description:'fresh verified description'};}
   override=path=>scenario==='role-epoch'&&path==='trainings/tr'?new Response(JSON.stringify({error:{code:'FORBIDDEN',message:'no current access',retryable:false}}),{status:403,headers:{'X-Kapok-Actor':'A'}}):null;
   if(scenario==='blur-focus')await act(async()=>window.dispatchEvent(new Event('blur')));
   await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
   const surface=document.querySelector('[data-kapok-sensitive]');
   if(scenario==='blur-focus'||scenario==='epoch-readable')assert.equal(surface.hidden,false,'same-account replacement verification completed');
   else assert.equal(surface.hidden,true,'lost permissions cannot reveal the old surface');
   if(scenario==='role-epoch')assert.equal(document.querySelector('form'),null,'forbidden resource clears old protected form');
   await act(async()=>release(response(oldBootstrap)));await flush();
   assert.equal(writes().length,0,scenario+' must fence old authorization after replacement verification');
   if(scenario==='actor'||scenario==='role-epoch')assert.equal(document.querySelector('[data-kapok-sensitive]').hidden,true,'late bootstrap must not reveal old private content');
   if(scenario==='epoch-readable'){assert.equal(document.querySelector('[name=title]').value,'fresh verified title');assert.equal(document.querySelector('[name=description]').value,'fresh verified description');}
  }finally{await unmount();}
 }}finally{window.confirm=originalConfirm;}
});

test('training status dialog creates published training with captured input and no browser confirmation',async()=>{
 setup('/trainings/new','admin');const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');const {TrainingForm}=await import('../../app/components/training-forms.tsx');const {navigation}=await import('../helpers/next-stubs.mjs');
 const originalConfirm=window.confirm;window.confirm=()=>{throw new Error('browser confirmation must not be used');};
 try{
  await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'me'},()=>React.createElement(TrainingForm,{actorId:'A'})));
  await input(document.querySelector('[name=title]'),'captured title');document.querySelector('[name=date]').value='2026-10-19';document.querySelector('[name=status]').value='published';
  await click('保存训练');assert.equal(document.querySelector('dialog').open,true);assert.equal(writes().length,0);
  document.querySelector('[name=title]').value='later field change';
  override=(path,options)=>path==='trainings'&&options.method==='POST'?response({...JSON.parse(options.body),id:'new-training',version:1}):null;
  await click('确认并保存');assert.equal(writes().length,1);assert.equal(writes()[0].options.method,'POST');assert.equal(JSON.parse(writes()[0].options.body).title,'captured title');assert.equal(JSON.parse(writes()[0].options.body).status,'published');assert.equal(navigation.at(-1),'/trainings/new-training');assert.equal(document.querySelector('dialog').open,false);
 }finally{window.confirm=originalConfirm;await unmount();}
});

test('training status dialog cancel close escape and session lock discard intent without writing or losing fields',async()=>{
 const {AccountBoundary}=await import('../../app/components/secure-resource.tsx');const {TrainingForm}=await import('../../app/components/training-forms.tsx');
 for(const action of ['取消','关闭状态确认','escape','blur']){
  setup('/trainings/tr','admin');data['trainings/tr']={...training,title:'retained title',status:'draft',description:'retained description',version:1};
  try{
   await mount(()=>React.createElement(AccountBoundary,{actorId:'A',load:'trainings/tr'},t=>React.createElement(TrainingForm,{actorId:'A',training:t})));
   document.querySelector('[name=status]').value='published';await click('保存训练');const dialog=document.querySelector('dialog');assert.equal(dialog.open,true);
   if(action==='escape')await act(async()=>dialog.dispatchEvent(new Event('cancel',{cancelable:true})));
   else if(action==='blur')await act(async()=>{window.dispatchEvent(new Event('blur'));assert.equal(dialog.open,false,'must leave top layer synchronously');});
   else if(action==='关闭状态确认')await act(async()=>document.querySelector('[aria-label="关闭状态确认"]').click());
   else await click('取消');
   assert.equal(dialog.open,false);await click('确认并保存');assert.equal(writes().length,0,'discarded confirmation cannot later write');
   assert.equal(document.querySelector('[name=title]').value,'retained title');assert.equal(document.querySelector('[name=status]').value,'published');
   if(action==='blur'){await act(async()=>window.dispatchEvent(new Event('focus')));await flush();assert.equal(document.querySelector('dialog').open,false);assert.equal(writes().length,0);}
  }finally{await unmount();}
 }
});

test('Bilibili time clicks reload only on explicit navigation, preserve drafts/part, and discard intent on lock/source change',async()=>{
 setup('/videos/v?t=90');
 data['videos/v']={...video,source:'bilibili',url:'https://www.bilibili.com/video/BV1raQXYpEkG/?p=2',durationSec:null};
 data['videos/v/comments']=[{...comment,timestampSec:90},{...comment,id:'c2',timestampSec:180}];
 const originalScroll=dom.window.HTMLElement.prototype.scrollIntoView; const scrolled=[];
 dom.window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};
 try {
  await mount(()=>React.createElement(VideoDiscussion,{actorId:'A',videoId:'v',initialSeconds:90}));
  let frame=document.querySelector('iframe');assert.equal(new URL(frame.src).searchParams.get('t'),'90');
  await input(document.querySelector('#comment-input'),'保留的讨论草稿');
  await click('回复');
  assert.equal(document.querySelector('iframe'),frame);
  await click('讨论时间点 03:00');
  const second=document.querySelector('iframe');assert.notEqual(second,frame);frame=second;
  let url=new URL(frame.src);assert.equal(url.searchParams.get('t'),'180');assert.equal(url.searchParams.get('p'),'2');assert.equal(url.searchParams.get('bvid'),'BV1raQXYpEkG');
  assert.equal(scrolled.at(-1),frame);assert.equal(document.querySelector('#comment-input').value,'保留的讨论草稿');assert.ok(button('取消回复并清除草稿'));
  await input(document.querySelector('#comment-input'),'继续输入不重载');assert.equal(document.querySelector('iframe'),frame);
  await click('讨论时间点 03:00');assert.notEqual(document.querySelector('iframe'),frame);frame=document.querySelector('iframe');assert.equal(new URL(frame.src).searchParams.get('t'),'180');
  await act(async()=>window.dispatchEvent(new Event('blur')));assert.equal(frame.getAttribute('src'),'about:blank');assert.equal(document.querySelector('iframe'),null);
  data['videos/v']={...data['videos/v'],url:'https://www.bilibili.com/video/BV1raQXYpEkG/?p=3'};
  await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
  frame=document.querySelector('iframe');url=new URL(frame.src);assert.equal(url.searchParams.get('t'),'90');assert.equal(url.searchParams.get('p'),'3');assert.equal(document.querySelector('#comment-input').value,'继续输入不重载');
  await click('讨论时间点 01:30');assert.notEqual(document.querySelector('iframe'),frame);frame=document.querySelector('iframe');
  await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await flush();assert.equal(frame.getAttribute('src'),'about:blank');assert.equal(document.querySelector('iframe'),null);
  assert.equal(writes().length,0);
 } finally {dom.window.HTMLElement.prototype.scrollIntoView=originalScroll;await unmount();}
});


test('Bilibili invalid initial time is bounded and reports the error without a render loop',async()=>{
 setup('/videos/v?t=bad');data['videos/v']={...video,source:'bilibili',url:'https://www.bilibili.com/video/BV1raQXYpEkG/',durationSec:null};
 try {
  await mount(()=>React.createElement(VideoDiscussion,{actorId:'A',videoId:'v',initialSeconds:NaN}));
  assert.equal(new URL(document.querySelector('iframe').src).searchParams.get('t'),'0');
  assert.match(document.body.textContent,/有效的非负整数秒/);
 } finally {await unmount();}
});


test('Bilibili changed deep-link time cannot reopen a locked same snapshot before verification',async()=>{
 setup('/videos/v?t=90');data['videos/v']={...video,source:'bilibili',url:'https://www.bilibili.com/video/BV1raQXYpEkG/',durationSec:null};
 let target=90;const Screen=()=>React.createElement(VideoDiscussion,{actorId:'A',videoId:'v',initialSeconds:target});
 try {
  await mount(Screen);const frame=document.querySelector('iframe');
  await act(async()=>window.dispatchEvent(new Event('blur')));
  assert.equal(frame.getAttribute('src'),'about:blank');assert.equal(document.querySelector('iframe'),null);
  target=180;await act(async()=>root.render(React.createElement(Screen)));await flush();
  assert.equal(document.querySelector('iframe'),null,'changing query props alone must not recreate third-party media while locked');
  await act(async()=>window.dispatchEvent(new Event('focus')));await flush();
  assert.equal(new URL(document.querySelector('iframe').src).searchParams.get('t'),'180');
  assert.equal(writes().length,0);
 } finally {await unmount();}
});

test('saved note starts as a card, pencil opens editor and cancel restores persisted content',async()=>{
 setup('/growth');data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'已保存的想法',timestampSec:null,version:1,createdAt:'2026-10-19',source:null}];
 try{await mount(CollectionList);assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note').textContent,/已保存的想法/);
 assert.equal(document.querySelector('a[href="/reflections/new?collection=saved"]').textContent,'转为复盘');
 await click('编辑私人备注');await input(document.querySelector('textarea'),'未保存修改');assert.ok(button('转为复盘').disabled);await click('取消');
 assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note').textContent,/已保存的想法/);await click('编辑私人备注');assert.equal(document.querySelector('textarea').value,'已保存的想法');assert.equal(writes().length,0);
 }finally{await unmount();}
});


test('note card blank state, confirmed trimmed save and delete preserve collection semantics',async()=>{
 setup('/growth');data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'',timestampSec:null,version:1,createdAt:'2026-10-19',source:null}];
 override=(path,options)=>{if(path!=='collections/saved'||options.method!=='PATCH')return null;const body=JSON.parse(options.body);data.collections=body.action==='delete'?[]:[{...data.collections[0],privateNote:body.privateNote.trim(),version:2}];return response({id:'saved'});};
 const originalConfirm=window.confirm;window.confirm=()=>true;
 try{await mount(CollectionList);assert.match(document.body.textContent,/暂无私人备注/);assert.ok(!document.querySelector('.private-note').textContent.includes('当前备注已保存在账号中'));assert.ok(button('转为复盘').disabled);await click('编辑私人备注');await input(document.querySelector('textarea'),'  新备注 🥏\n第二行  ');await click('保存备注');assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note .preserve').textContent,/^新备注 🥏\n第二行$/);assert.ok(document.querySelector('a[href="/reflections/new?collection=saved"]'));await click('删除收藏');assert.equal(document.querySelector('.collection-card'),null);assert.match(document.body.textContent,/还没有收藏/);assert.equal(writes().length,2);}finally{window.confirm=originalConfirm;await unmount();}
});

test('note PATCH receipt with failed refresh retains input and unknown retry until current owner snapshot confirms',async()=>{
 setup('/growth');let refreshFails=true,saved=false;
 data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'原文',timestampSec:null,version:1,createdAt:'2026-10-19',source:null}];
 override=(path,options)=>{if(path==='collections/saved'&&options.method==='PATCH'){saved=true;data.collections=[{...data.collections[0],privateNote:'待确认输入',version:2}];return response({id:'saved'});}if(path==='collections'&&saved&&refreshFails)throw new Error('刷新失败');return null;};
 try{await mount(CollectionList);await click('编辑私人备注');await input(document.querySelector('textarea'),'待确认输入');await click('保存备注');assert.equal(document.querySelector('textarea').value,'待确认输入');assert.match(document.body.textContent,/刷新失败/);assert.equal(document.querySelector('.private-note a'),null);const call=writes()[0],body=JSON.parse(call.options.body);assert.equal(pendingMutationKey('A','PATCH',call.path,body,'different'),call.options.headers['Idempotency-Key']);refreshFails=false;await click('确认保存备注结果');assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note').textContent,/待确认输入/);assert.equal(writes().length,2);assert.equal(writes()[1].options.headers['Idempotency-Key'],call.options.headers['Idempotency-Key']);assert.equal(writes()[1].options.body,call.options.body);}finally{await unmount();}
});

test('collection conversion seeds separate resumable local draft and requires an explicit private save',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor,LocalDrafts}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const {navigation}=await import('../helpers/next-stubs.mjs');
 const ordinary=draftKey('A','new'), converted=draftKey('A','collection:saved'), other=draftKey('A','collection:other');
 const untouched=JSON.stringify({schema:1,title:'普通草稿',text:'不能覆盖',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19'});localStorage.setItem(ordinary,untouched);localStorage.setItem(other,untouched);
 data['collections/saved/reflection-seed']={text:'本人备注\n只复制这段',trainingId:'tr',videoId:'v'};
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved',trainingId:'untrusted',videoId:'untrusted'}));assert.equal(document.querySelector('textarea').value,'本人备注\n只复制这段');assert.equal(document.querySelector('input').value,'');assert.equal(document.querySelector('select').value,'tr');assert.equal(JSON.parse(localStorage.getItem(converted)).videoId,'v');assert.equal(localStorage.getItem(ordinary),untouched);assert.equal(localStorage.getItem(other),untouched);assert.match(document.body.textContent,/原收藏会保留.*默认仅自己可见/);assert.equal(writes().length,0);await input(document.querySelector('textarea'),'继续写的本机内容');await unmount();
 data['collections/saved/reflection-seed']={text:'后来修改的备注',trainingId:null,videoId:null};await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.equal(document.querySelector('textarea').value,'继续写的本机内容');assert.match(document.body.textContent,/已恢复本机草稿/);assert.equal(writes().length,0);await unmount();dom.window.history.replaceState({},'','/growth');await mount(LocalDrafts);assert.ok(document.querySelector('a[href="/reflections/new?collection=saved"]'));assert.ok(document.querySelector('a[href="/reflections/new"]'));await unmount();
 dom.window.history.replaceState({},'','/reflections/new?collection=saved');await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));override=(path,options)=>{if(path==='reflections'&&options.method==='POST'){const body=JSON.parse(options.body);assert.equal('scope' in body,false);return response({...body,id:'created',version:1,sharingVersion:1,generation:1,scope:'private',isAuthor:true});}return null;};await click('保存记录');assert.equal(writes().length,1);assert.equal(navigation.at(-1),'/reflections/created?saved=1');assert.equal(localStorage.getItem(converted),null);assert.equal(localStorage.getItem(ordinary),untouched);assert.equal(localStorage.getItem(other),untouched);
 }finally{await unmount();localStorage.clear();}
});

test('collection draft restores pending unknown save with the identical body and key',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const key=draftKey('A','collection:saved');data['collections/saved/reflection-seed']={text:'原备注',trainingId:null,videoId:null};
 override=(path,options)=>{if(path==='reflections'&&options.method==='POST')throw new Error('response lost');return null;};
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));await click('保存记录');const original=writes()[0],pending=JSON.parse(localStorage.getItem(key)).pending;assert.equal(pending.key,original.options.headers['Idempotency-Key']);await unmount();await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.match(document.body.textContent,/上次云保存结果待确认/);await click('确认上次云保存结果');assert.equal(writes()[1].options.body,original.options.body);assert.equal(writes()[1].options.headers['Idempotency-Key'],original.options.headers['Idempotency-Key']);assert.equal(JSON.parse(localStorage.getItem(key)).pending.key,pending.key);}finally{await unmount();localStorage.clear();}
});

test('failed seed is recoverable and inaccessible source seeds only own note with no association',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');let failing=true;override=(path)=>path==='collections/saved/reflection-seed'&&failing?new Response(JSON.stringify({error:{code:'UNAVAILABLE',message:'草稿来源读取失败',retryable:true}}),{status:503,headers:{'X-Kapok-Actor':'A'}}):null;data['collections/saved/reflection-seed']={text:'来源消失后仍属本人的备注',trainingId:null,videoId:null};
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved',trainingId:'bad',videoId:'bad'}));assert.equal(document.querySelector('textarea'),null);assert.match(document.body.textContent,/草稿来源读取失败/);assert.equal(localStorage.length,0);failing=false;await click('重新确认');assert.equal(document.querySelector('textarea').value,'来源消失后仍属本人的备注');assert.equal(document.querySelector('select').value,'');assert.equal(document.querySelectorAll('select').length,1);assert.equal(writes().length,0);}finally{await unmount();localStorage.clear();}
});

test('late seed after account switch cannot hydrate or persist the previous owner note',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');let finish;override=path=>path==='collections/saved/reflection-seed'?new Promise(resolve=>{finish=resolve;}):null;
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.ok(finish);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await act(async()=>finish(response({text:'不可泄露的旧账号备注',trainingId:'tr',videoId:'v'})));await flush();assert.equal(document.querySelector('textarea'),null);assert.ok(!document.body.textContent.includes('不可泄露的旧账号备注'));assert.equal(localStorage.length,0);assert.equal(writes().length,0);}finally{await unmount();localStorage.clear();}
});

test('late note PATCH verification after account loss retains no visible card or conversion',async()=>{
 setup('/growth');let finish;data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'旧账号备注',timestampSec:null,version:1,createdAt:'2026-10-19',source:null}];
 override=(path,options)=>path==='collections/saved'&&options.method==='PATCH'?new Promise(resolve=>{finish=resolve;}):null;
 try{await mount(CollectionList);await click('编辑私人备注');await input(document.querySelector('textarea'),'旧账号未确认修改');await click('保存备注');assert.ok(finish);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await act(async()=>finish(response({id:'saved'})));await flush();assert.equal(document.querySelector('textarea'),null);assert.equal(document.querySelector('.collection-card'),null);assert.equal(document.querySelector('a[href="/reflections/new?collection=saved"]'),null);}finally{await unmount();}
});

test('confirmed PATCH replay showing newer owner note keeps input editable for explicit new-version save',async()=>{
 setup('/growth');data.collections=[{id:'saved',sourceKind:'video',sourceId:'v',privateNote:'原备注',timestampSec:null,version:1,createdAt:'2026-10-19',source:null}];let count=0;
 override=(path,options)=>{if(path!=='collections/saved'||options.method!=='PATCH')return null;const body=JSON.parse(options.body);count++;data.collections=[{...data.collections[0],privateNote:count===1?'其他位置的新备注':body.privateNote,version:count===1?3:4}];if(count===2)assert.equal(body.expectedVersion,3);return response({id:'saved'});};
 try{await mount(CollectionList);await click('编辑私人备注');await input(document.querySelector('textarea'),'本机仍需保存');await click('保存备注');assert.equal(document.querySelector('textarea').value,'本机仍需保存');assert.equal(document.querySelector('textarea').disabled,false);assert.match(document.body.textContent,/当前账号备注已变化/);assert.equal(document.querySelector('.private-note a'),null);await click('保存备注');assert.equal(writes().length,2);assert.equal(document.querySelector('textarea'),null);assert.match(document.querySelector('.private-note').textContent,/本机仍需保存/);}finally{await unmount();}
});

test('new reflection route sanitizes collection IDs and gives collection precedence over external source hints',async()=>{
 const {setServerMe}=await import('../helpers/server-stubs.mjs');const NewReflection=(await import('../../app/reflections/new/page.tsx')).default;setServerMe(me);
 const converted=await NewReflection({searchParams:Promise.resolve({collection:'saved',training:'untrusted',video:'untrusted'})});
 assert.equal(converted.props.children.props.collectionId,'saved');assert.equal(converted.props.children.props.trainingId,undefined);assert.equal(converted.props.children.props.videoId,undefined);
 const normal=await NewReflection({searchParams:Promise.resolve({training:'tr',video:'v'})});assert.equal(normal.props.children.props.trainingId,'tr');assert.equal(normal.props.children.props.videoId,'v');
 for(const collection of ['bad/id',['one','two'],'x'.repeat(81)]){const invalid=await NewReflection({searchParams:Promise.resolve({collection,training:'untrusted'})});assert.equal(invalid.props.children.props.collectionId,undefined);assert.equal(invalid.props.children.props.trainingId,undefined);}
 setServerMe({user:null,profile:null,membership:null});const gated=await NewReflection({searchParams:Promise.resolve({collection:'saved',training:'ignored'})});assert.equal(gated.props.children.props.returnTo,'/reflections/new?collection=saved');setServerMe(undefined);
});

test('deleted collection resumes independently edited conversion draft and keeps ordinary draft separate',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor,LocalDrafts}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const converted=draftKey('A','collection:saved'),ordinary=draftKey('A','new');
 const ordinaryRaw=JSON.stringify({schema:1,title:'普通稿',text:'普通草稿保留',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19T01:00:00.000Z'});localStorage.setItem(ordinary,ordinaryRaw);data['collections/saved/reflection-seed']={text:'起始备注',trainingId:null,videoId:null};
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));await input(document.querySelector('textarea'),'已有独立编辑的复盘内容');await input(document.querySelector('input[type=date]'),'');await unmount();const retained=localStorage.getItem(converted);override=path=>path==='collections/saved/reflection-seed'?new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'内容不可用或当前无权查看。',retryable:false}}),{status:404,headers:{'X-Kapok-Actor':'A'}}):null;
 dom.window.history.replaceState({},'','/growth');await mount(LocalDrafts);assert.ok(document.querySelector('a[href="/reflections/new?collection=saved"]'));await unmount();dom.window.history.replaceState({},'','/reflections/new?collection=saved');await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.equal(document.querySelector('textarea')?.value,'已有独立编辑的复盘内容');assert.equal(document.querySelector('input[type=date]').value,'');assert.match(document.body.textContent,/原收藏当前不可用/);assert.match(document.body.textContent,/已恢复本机草稿/);assert.equal(localStorage.getItem(converted),retained);assert.equal(localStorage.getItem(ordinary),ordinaryRaw);assert.equal(writes().length,0);
 await input(document.querySelector('input[type=date]'),'2026-10-19');override=(path,options)=>path==='reflections'&&options.method==='POST'?response({...JSON.parse(options.body),id:'recovered',version:1,sharingVersion:1,generation:1,scope:'private',isAuthor:true}):null;await click('保存记录');assert.equal(writes().length,1);assert.equal(localStorage.getItem(converted),null);assert.equal(localStorage.getItem(ordinary),ordinaryRaw);
 }finally{await unmount();localStorage.clear();}
});

test('deleted collection pending draft recovery replays immutable body and key before saving later writing',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const key=draftKey('A','collection:saved');data['collections/saved/reflection-seed']={text:'原待保存文字',trainingId:null,videoId:null};override=(path,options)=>path==='reflections'&&options.method==='POST'?Promise.reject(new Error('lost response')):null;
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));await click('保存记录');const original=writes()[0];await input(document.querySelector('textarea'),'上次保存后继续独立写作');const retained=localStorage.getItem(key);await unmount();override=(path,options)=>{if(path==='collections/saved/reflection-seed')return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'内容不可用或当前无权查看。',retryable:false}}),{status:404,headers:{'X-Kapok-Actor':'A'}});if(path==='reflections'&&options.method==='POST')return response({...JSON.parse(options.body),id:'pending-recovered',version:1,sharingVersion:1,generation:1,scope:'private',isAuthor:true});if(path==='reflections/pending-recovered'&&options.method==='PATCH')return response({...JSON.parse(options.body),id:'pending-recovered',version:2,sharingVersion:2,generation:1,scope:'private',isAuthor:true});return null;};
 await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.equal(document.querySelector('textarea')?.value,'上次保存后继续独立写作');assert.match(document.body.textContent,/上次云保存结果待确认/);assert.equal(localStorage.getItem(key),retained);await click('确认上次云保存结果');assert.equal(writes()[1].options.body,original.options.body);assert.equal(writes()[1].options.headers['Idempotency-Key'],original.options.headers['Idempotency-Key']);assert.equal(document.querySelector('textarea').value,'上次保存后继续独立写作');assert.equal(JSON.parse(localStorage.getItem(key)).cloud.id,'pending-recovered');await click('保存记录');assert.equal(writes()[2].path,'reflections/pending-recovered');assert.equal(JSON.parse(writes()[2].options.body).text,'上次保存后继续独立写作');assert.equal(localStorage.getItem(key),null);
 }finally{await unmount();localStorage.clear();}
});

test('missing collection without a valid matching actor-local conversion draft stays denied',async()=>{
 const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const valid={schema:1,title:'',text:'本机内容',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19T01:00:00.000Z'};
 for(const [target,raw] of [[null,null],[draftKey('A','new'),JSON.stringify(valid)],[draftKey('A','collection:other'),JSON.stringify(valid)],[draftKey('B','collection:saved'),JSON.stringify(valid)],[draftKey('A','collection:saved'),'{broken'],[draftKey('A','collection:saved'),JSON.stringify({...valid,schema:2})],[draftKey('A','collection:saved'),JSON.stringify({...valid,pending:{key:'must-not-lose'}})]]){
  setup('/reflections/new?collection=saved');localStorage.clear();if(target)localStorage.setItem(target,raw);override=path=>path==='collections/saved/reflection-seed'?new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'内容不可用或当前无权查看。',retryable:false}}),{status:404,headers:{'X-Kapok-Actor':'A'}}):null;
  try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.equal(document.querySelector('textarea'),null);assert.match(document.body.textContent,/内容不可用或当前无权查看/);assert.equal(writes().length,0);assert.equal(localStorage.getItem(draftKey('A','collection:saved')),target===draftKey('A','collection:saved')?raw:null);}finally{await unmount();localStorage.clear();}
 }
});

test('deleted collection recovery stays hidden until after-bootstrap succeeds and rejects a late account switch',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const key=draftKey('A','collection:saved');localStorage.setItem(key,JSON.stringify({schema:1,title:'',text:'旧账号独立草稿',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19T01:00:00.000Z'}));let finish,bootstrapReads=0;
 override=path=>{if(path==='collections/saved/reflection-seed')return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'内容不可用或当前无权查看。',retryable:false}}),{status:404,headers:{'X-Kapok-Actor':'A'}});if(path==='bootstrap'&&++bootstrapReads===2)return new Promise(resolve=>{finish=resolve;});return null;};
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.ok(finish,'fallback must still require after-bootstrap verification');assert.equal(document.querySelector('textarea'),null);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await act(async()=>finish(response(data.bootstrap)));await flush();assert.equal(document.querySelector('textarea'),null);assert.ok(!document.body.textContent.includes('旧账号独立草稿'));assert.equal(localStorage.getItem(key),null);assert.equal(writes().length,0);}finally{await unmount();localStorage.clear();}
});

test('collection recovery never falls back on forbidden or failed seed reads',async()=>{
 const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const key=draftKey('A','collection:saved');const raw=JSON.stringify({schema:1,title:'',text:'保留但不能绕过失败的草稿',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19T01:00:00.000Z'});
 for(const [status,code] of [[403,'FORBIDDEN'],[503,'UNAVAILABLE']]){setup('/reflections/new?collection=saved');localStorage.clear();localStorage.setItem(key,raw);override=path=>path==='collections/saved/reflection-seed'?new Response(JSON.stringify({error:{code,message:'明确读取失败',retryable:status===503}}),{status,headers:{'X-Kapok-Actor':'A'}}):null;try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.equal(document.querySelector('textarea'),null);assert.match(document.body.textContent,/明确读取失败/);assert.equal(localStorage.getItem(key),raw);assert.equal(writes().length,0);}finally{await unmount();localStorage.clear();}}
});

test('late missing-collection response cannot read back an ended actor draft or reveal cached text',async()=>{
 setup('/reflections/new?collection=saved');localStorage.clear();const {ReflectionEditor}=await import('../../app/components/reflections.tsx');const {draftKey}=await import('../../lib/client/session-guard.ts');const key=draftKey('A','collection:saved');localStorage.setItem(key,JSON.stringify({schema:1,title:'',text:'不能恢复到其他账号',date:'2026-10-19',trainingId:'',videoId:'',cloud:null,pending:null,updatedAt:'2026-10-19T01:00:00.000Z'}));let finish;override=path=>path==='collections/saved/reflection-seed'?new Promise(resolve=>{finish=resolve;}):null;
 try{await mount(()=>React.createElement(ReflectionEditor,{actorId:'A',collectionId:'saved'}));assert.ok(finish);await act(async()=>window.dispatchEvent(new CustomEvent('kapok-account-changed',{detail:'A'})));await act(async()=>finish(new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'内容不可用或当前无权查看。',retryable:false}}),{status:404,headers:{'X-Kapok-Actor':'A'}})));await flush();assert.equal(document.querySelector('textarea'),null);assert.ok(!document.body.textContent.includes('不能恢复到其他账号'));assert.equal(localStorage.getItem(key),null);assert.equal(writes().length,0);}finally{await unmount();localStorage.clear();}
});
