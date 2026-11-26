import { parseVideo } from './video-source.js';

const enc = encodeURIComponent;
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const key = (kind, parent, id) => JSON.stringify([kind, parent, id]);
const assetIndex = rows => new Set(rows.map(row => key(row.parentKind, row.parentId, row.id)));
const assetPath = id => '/api/v1/material-assets/' + enc(id);
const changed = () => new Error('合集或资料权限已变化，请重新打开后再导出。');
const sourcePath = (kind,id) => ({training:'/trainings/',post:'/learn/posts/',video:'/videos/',reflection:'/home#/notes/'})[kind] + enc(id);

function ownedPhotos(extra, kind, parent, owned) {
  return (extra.photos || []).filter(p => safeId(p.id) && owned.has(key(kind,parent,p.id)))
    .map(p => ({type:'image',path:assetPath(p.id),alt:p.alt || ''}));
}

function clip(video, kind, parent, owned) {
  if (kind === 'video' && video.source === 'upload') {
    return owned.has(key(kind,parent,video.id)) ? {type:'video',path:'/api/v1/videos/'+enc(video.id)+'/media'} : null;
  }
  if (kind === 'post' && video.source === 'upload') {
    const id = /^\/api\/v1\/material-assets\/([a-zA-Z0-9_-]+)$/.exec(video.url)?.[1];
    return id && owned.has(key(kind,parent,id)) ? {type:'video',path:assetPath(id)} : null;
  }
  const source = parseVideo(video.url || '');
  return source && ['YouTube','B 站'].includes(source.platform) ? {type:'external',href:source.url,label:source.platform} : null;
}

async function chapter(ctx, ref, owned, signal) {
  const {kind,id} = ref;
  const href = sourcePath(kind,id);
  const actor = ctx.account.user.id;
  if (kind === 'reflection') {
    if (ref.author?.id !== actor) return {href};
    const {value:n} = await ctx.read('page-read/reflections/'+enc(id),signal);
    if (!n.isAuthor || n.author.id !== actor || n.scope !== 'team') throw changed();
    const media = (n.photos || []).filter(p => owned.has(key('reflection',id,p.id)))
      .map(p => ({type:'image',path:p.url,alt:p.caption}));
    return {href,title:n.title || '无标题复盘',body:n.text,revision:n.version,media};
  }
  if (kind === 'post') {
    if (ref.author?.id !== actor) return {href};
    const p = await ctx.read('learning/posts/'+enc(id),signal);
    if (!p.isAuthor || p.author?.id !== actor) return {href};
    const media = p.images.map(image => ({type:'image',path:'/api/v1/learning/posts/'+enc(id)+'/images/'+enc(image.id),alt:image.alt}));
    media.push(...ownedPhotos(JSON.parse(p.workspaceDetails || '{}'),'post',id,owned));
    if (p.video) media.push(clip(p.video,'post',id,owned));
    return {href,title:p.title,summary:p.summary,body:p.body,revision:p.publishedVersion,media:media.filter(Boolean)};
  }
  if (kind === 'video') {
    if (ref.author?.id !== actor) return {href};
    const v = await ctx.read('videos/'+enc(id),signal);
    if (v.status !== 'active' || !['published','archived'].includes(v.training.status)) throw changed();
    if (v.publisherId !== actor) return {href};
    const media = clip(v,'video',v.trainingId,owned);
    return {href,title:v.title,revision:v.version,media:media ? [media] : []};
  }
  const t = await ctx.read('trainings/'+enc(id),signal);
  if (!['published','archived'].includes(t.status)) throw changed();
  if (t.publisherId !== actor) return {href};
  const extra = JSON.parse(t.workspaceDetails || '{}');
  const media = ownedPhotos(extra,'training',id,owned);
  for (const v of t.videos.filter(v=>v.status === 'active')) {
    const resource = v.publisherId === actor ? clip(v,'video',id,owned) : null;
    media.push(resource || {type:'member',href:sourcePath('video',v.id)});
  }
  return {href,title:t.title,summary:t.description,body:extra.body,revision:t.version,media};
}

async function readBinary(ctx, item, signal) {
  const response = await fetch(item.path,{credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal});
  const mime = response.headers.get('Content-Type')?.split(';')[0].toLowerCase();
  const actor = response.headers.get('X-Kapok-Actor');
  const allowed = item.type === 'video' ? ['video/mp4','video/webm'] : ['image/png','image/jpeg','image/webp'];
  if (response.status !== 200 || !allowed.includes(mime) || (actor && actor !== ctx.actorId)) throw changed();
  // Base64 can be written in independent blocks when all nonfinal blocks end on a three-byte boundary.
  const blob = await response.blob(), blocks = [];
  const size = 384 * 1024;
  for (let i=0; i<blob.size; i+=size) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(i,i+size).arrayBuffer());
    let chunk = '';
    for (let j=0; j<bytes.length; j+=16384) chunk += String.fromCharCode(...bytes.subarray(j,j+16384));
    blocks.push(btoa(chunk));
  }
  if (!blob.size) throw changed();
  return new Blob(['data:',mime,';base64,',...blocks]);
}

export async function exportTopicHtml(ctx, editionId, signal) {
  const route = 'workspace/topic-shares/' + enc(editionId);
  const [directory, assets] = await Promise.all([ctx.read(route,signal),ctx.read('workspace/export-assets',signal)]);
  const owned = assetIndex(assets);
  const title = directory.isAuthor ? directory.title : '队内合集';
  const origin = location.origin;
  const link = (path,label) => '<a rel="noreferrer" href="'+escape(new URL(path,origin).href)+'">'+escape(label)+'</a>';
  const parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src data:; media-src data:; base-uri &apos;none&apos;; form-action &apos;none&apos;"><title>',escape(title),'</title><style>body{max-width:44rem;margin:auto;padding:2rem 1.2rem;font:17px/1.7 system-ui;color:#183c2e;background:#fafaf5}section{border-top:1px solid #c4d1c2;margin-top:2rem}p{white-space:pre-wrap;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}a{color:#215a44}h1,h2{overflow-wrap:anywhere}figure{margin:1em 0}</style><main><h1>',escape(title),'</h1>'];
  const editionPath = '/learn/shares/'+enc(editionId);
  if (directory.isAuthor && directory.coverVersion) {
    const path = '/api/v1/workspace/topic-covers/share/' + enc(editionId) + '/' + directory.coverVersion;
    const image = await readBinary(ctx,{type:'image',path},signal);
    parts.push('<figure><img alt="合集封面" src="',image,'"></figure>');
  }
  if (directory.isAuthor && directory.summary) parts.push('<p>',escape(directory.summary),'</p>');
  parts.push(link(editionPath,'登录查看队内版本'));
  const entries = [];
  const binaries = new Map();
  for (const [index,ref] of directory.items.entries()) {
    if (!['training','video','post','reflection'].includes(ref.kind) || !safeId(ref.id)) throw changed();
    const item = await chapter(ctx,ref,owned,signal);
    entries.push(item);
    parts.push('<section><h2>',escape(item.title || '队内资料 '+(index+1)),'</h2>');
    for (const text of [item.summary,item.body]) if (text) parts.push('<p>',escape(text),'</p>');
    for (const media of item.media || []) {
      if (media.type === 'member') { parts.push('<p>',link(media.href,'登录观看队内视频'),'</p>'); continue; }
      if (media.type === 'external') { parts.push('<p>',link(media.href,'在'+media.label+'打开视频'),'</p>'); continue; }
      if (!binaries.has(media.path)) binaries.set(media.path, await readBinary(ctx,media,signal));
      if (media.type === 'image') parts.push('<figure><img alt="',escape(media.alt),'" src="',binaries.get(media.path),'"></figure>');
      else parts.push('<video controls playsinline preload="metadata" src="',binaries.get(media.path),'"></video>');
    }
    parts.push('<p>',link(item.href,'登录查看来源'),'</p></section>');
  }
  // Discard gathered bytes if publication, source ownership or media changed during the download.
  const currentAssets = assetIndex(await ctx.read('workspace/export-assets',signal));
  for (const [i,item] of entries.entries()) {
    if (item.title && JSON.stringify(item) !== JSON.stringify(await chapter(ctx,directory.items[i],currentAssets,signal))) throw changed();
  }
  const latest = await ctx.read(route,signal);
  if (JSON.stringify(latest)!==JSON.stringify(directory)) throw changed();
  signal.throwIfAborted();
  parts.push('</main></html>');
  return {file:new Blob(parts,{type:'text/html;charset=utf-8'}),name:'Kapok-'+title.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,70)+'.html'};
}
