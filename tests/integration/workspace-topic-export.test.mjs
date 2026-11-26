import assert from 'node:assert/strict';
import test from 'node:test';
import { exportTopicHtml } from '../../app/workspace-ui/topic-export.js';

function fixture(t, { revoke = false, change = false, isAuthor = true } = {}) {
  const paths = [], user = {id:'mine'}, signal = new AbortController().signal;
  const source = {kind:'post',id:'a',author:user}, other = {kind:'post',id:'b',author:{id:'other'}};
  const edition = {isAuthor,coverVersion:3,title:'<我的目录>',summary:'训练资料',items:[source,other]};
  const own = {isAuthor:true,author:user,title:'本人文章',summary:'摘要',body:'<script>privateText()</script>',images:[{id:'old-photo',alt:'旧图'}],
    workspaceDetails:JSON.stringify({photos:[{id:'mine-photo',alt:'新图'},{id:'others-photo',alt:'队友的照片'}]}),publishedVersion:1};
  let editions = 0, articles = 0;
  t.mock.method(globalThis,'fetch',async path=>{paths.push(path);return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});});
  const initialLocation = globalThis.location;
  globalThis.location = {origin:'https://kapok.test'};
  t.after(()=>{if(initialLocation===undefined) delete globalThis.location;else globalThis.location=initialLocation;});
  const ctx = {actorId:'actor',account:{user},read:async path=>{
    paths.push(path);
    if (path==='workspace/topic-shares/s') {
      if (++editions>1 && revoke) throw Error('没有队伍访问权限');
      return edition;
    }
    if (path==='workspace/export-assets') return [{parentKind:'post',parentId:'a',id:'mine-photo'}];
    if (path==='learning/posts/a') return ++articles>1 && change ? {...own,publishedVersion:2} : own;
    throw Error('unexpected path '+path);
  }};
  return {ctx,signal,paths};
}

test('offline topic embeds only owned publication assets, escapes content, and links teammate records', async t => {
  const {ctx,signal,paths} = fixture(t);
  const {file} = await exportTopicHtml(ctx,'s',signal);
  const html = await file.text();
  assert.match(html,/&lt;我的目录&gt;/);
  assert.match(html,/&lt;script&gt;privateText\(\)&lt;\/script&gt;/);
  assert.match(html,/<img alt="合集封面"/);
  assert.ok(paths.includes('/api/v1/workspace/topic-covers/share/s/3'));
  assert.match(html,/data:image\/png;base64,AQID/);
  assert.match(html,/href="https:\/\/kapok.test\/learn\/posts\/b"/);
  assert.doesNotMatch(html,/<script>|队友的照片|others-photo/);
  assert.ok(!paths.includes('learning/posts/b'));
  assert.ok(!paths.includes('me/export'));
  assert.ok(!paths.some(path=>path.includes('draft') || path.includes('comments')));
});
test('offline topic refuses to release a file after membership revocation during download', async t => {
  const {ctx,signal} = fixture(t,{revoke:true});
  await assert.rejects(exportTopicHtml(ctx,'s',signal),/访问权限/);
});
test('offline topic rejects an outdated copy if a source was edited while assets downloaded', async t => {
  const {ctx,signal} = fixture(t,{change:true});
  await assert.rejects(exportTopicHtml(ctx,'s',signal),/权限已变化/);
});

test('offline topic keeps another author’s edition cover behind the member link', async t => {
  const {ctx,signal,paths} = fixture(t,{isAuthor:false});
  const {file} = await exportTopicHtml(ctx,'s',signal);
  assert.doesNotMatch(await file.text(),/<img alt="合集封面"/);
  assert.ok(!paths.some(path => path.includes('topic-covers')));
});

test('reflection chapters export only the author’s team-readable text and keep teammate notes behind login', async t => {
  const {ctx,signal} = fixture(t);
  const mine = {kind:'reflection',id:'own-note',author:{id:'mine'}};
  const other = {kind:'reflection',id:'other-note',title:'队友标题',author:{id:'another'}};
  let scope = 'team';
  ctx.read = async path => {
    if (path === 'workspace/export-assets') return [];
    if (path === 'workspace/topic-shares/s') return {items:[mine,other]};
    assert.equal(path,'page-read/reflections/own-note');
    return {value:{isAuthor:true,author:mine.author,scope,title:'本人复盘',text:'本人正文',version:1}};
  };
  const html = await (await exportTopicHtml(ctx,'s',signal)).file.text();
  assert.match(html,/本人正文/);
  assert.match(html,/\/home#\/notes\/other-note/);
  assert.doesNotMatch(html,/队友标题/);
  scope = 'private';
  await assert.rejects(exportTopicHtml(ctx,'s',signal),/权限已变化/);
});
