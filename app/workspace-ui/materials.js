import { parseVideo } from './video-source.js';
import { finishLearningImage, learningFileDigest, queueLearningImage } from '../../lib/client/learning-images.ts';
import { cancelUploadReservation, finishUpload, hashUploadFile, resumeUpload } from '../../lib/client/upload.ts';

const encode = encodeURIComponent;
const details = row => JSON.parse(row.workspaceDetails || '{}');
const assetUrl = id => '/api/v1/material-assets/'+encode(id);
const workspacePhotos = extra => (extra.photos || []).map(photo=>({...photo,url:assetUrl(photo.id)}));
function training(row, account) {
  const extra = details(row);
  return { ...row, kind: 'training', format: '场上练习', sourceKind: 'training', sourceId: row.id,
    platformCover: row.coverVideoId ? '/api/v1/video-covers/video/'+encode(row.coverVideoId) : '',
    category: extra.category || '训练', summary: row.description, body: extra.body || '',
    extra, canEdit: row.publisherId === account.user.id && (row.status !== 'hidden' || account.membership.role === 'admin'),
    canManageArchive: account.membership.role === 'admin' && row.status !== 'deleted', published: row.status === 'published',
    ownerId: row.publisherId === account.user.id ? 'me' : row.publisherId, author: row.publisherName || account.team?.name || '队内训练', photos:workspacePhotos(extra), steps: [] };
}
function post(row, account, draft = false) {
  const extra = details(row), mine = draft || row.isAuthor;
  return { ...row, sourceKind: 'learning_post', sourceId: row.id, extra, isDraft: draft, format: row.kind === 'video' ? '队员视频' : '场边图文',
    platformCover: row.kind === 'video' && row.video?.source !== 'upload' ? '/api/v1/video-covers/'+(draft?'draft/':'post/')+encode(row.id) : '',
    canEdit: mine && row.status !== 'hidden', published: !draft || row.status === 'published',
    category: row.category, date: extra.date || (row.publishedAt || row.updatedAt).slice(0,10),
    ownerId: mine ? 'me' : row.author?.id, author: row.author?.discName || account.profile?.discName,
    source: row.video && row.video.source!=='upload' ? parseVideo(row.video.url) : null, videoAsset:row.video?.source==='upload'?row.video.url:null, photos:[...row.images.map(p => ({ ...p, url:p.href })),...workspacePhotos(extra)], steps: [] };
}
export function presentMaterials(account, items, posts, categories, drafts) {
  const rows = posts.map(row => post(row,account));
  const publishedIds = new Set(rows.map(row => row.id));
  const trainings = [...items.map(row => training(row,account)), ...rows,
    ...drafts.filter(row => !publishedIds.has(row.id)).map(row => post(row,account,true))];
  trainings.sort((a,b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return { trainings, categoryNames: [...new Set([...categories, ...trainings.map(t=>t.category)])] };
}
export async function loadMaterial(ctx,item,signal,edit = false) {
  if (item.kind === 'training') {
    const row = await ctx.read('trainings/'+encode(item.id),signal);
    return { ...training(row,ctx.account), videos:row.videos.filter(v=>v.status === 'active') };
  }
  if (edit || item.isDraft) return post(await ctx.read('learning/posts/'+encode(item.id)+'?view=draft',signal),ctx.account,true);
  const { value } = await ctx.read('page-read/article/'+encode(item.id),signal);
  return {...post(value.post,ctx.account),activity:value.activity};
}
export function selectVideo(item,id) {
  const video = item.videos?.find(v=>v.id===id) ?? item.videos?.[0];
  const source = video?.url ? parseVideo(video.url) : item.source;
  const videoAsset = video?.source === 'upload' ? '/api/v1/videos/'+encode(video.id)+'/media' : item.videoAsset || null;
  const key = source?.url || videoAsset;
  return { ...item, selectedVideo:video, platformCover:video ? (source ? '/api/v1/video-covers/video/'+encode(video.id) : '') : item.platformCover, videoAsset, source, duration:video?.durationSec || 0, timepoints:item.extra?.chapters?.[key] || [] };
}
export async function deleteMaterial(ctx,item) {
  if (!item.canEdit) throw Error('没有管理权限。');
  if (item.kind === 'training') {
    await ctx.write('trainings/'+encode(item.id),'PATCH',{title:item.title,date:item.date,description:item.summary,status:'deleted',expectedVersion:item.version});
  } else {
    const path = 'learning/posts/'+encode(item.id);
    const draft = await ctx.read(path+'?view=draft');
    await ctx.write(path+'/withdraw','POST',{expectedVersion:draft.version,expectedMembershipEpoch:draft.membershipEpoch});
  }
}
export async function attachClip(ctx,file,signal,key,progress) {
  const active = () => !signal.aborted;
  const manifest = await hashUploadFile(file,active);
  const {id} = await ctx.write('uploads','POST',{bytes:file.size,manifest},key+'-reserve');
  let xhr;
  const cancel = () => xhr?.abort();
  signal.addEventListener('abort',cancel,{once:true});
  try {
    await resumeUpload(file,id,ctx.actorId,manifest,active,r=>{xhr=r},percent=>progress('正在上传 '+percent+'%'));
    await finishUpload(id,ctx.actorId,key+'-complete',manifest.digests.length,active,progress,signal);
    return id;
  } catch (error) {
    if (signal.aborted) await cancelUploadReservation(id,ctx.actorId,key+'-cancel',manifest.digests.length,()=>true).catch(()=>{});
    throw error;
  } finally { signal.removeEventListener('abort',cancel); }
}
async function uploadAsset(ctx,kind,parentId,file,signal,attempt) {
  const files=attempt.assets ??= new Map();
  if (!files.has(file)) files.set(file,{key:crypto.randomUUID()});
  const state=files.get(file);
  if (state.ready) return state.id;
  state.digest ??= await learningFileDigest(file);
  if (!state.id) {
    const reserved=await ctx.write('material-assets','POST',{kind,parentId,mime:file.type,bytes:file.size,digest:state.digest},state.key);
    state.id=reserved.id;
  }
  const response=await fetch(assetUrl(state.id)+'/content',{method:'PUT',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':file.type,'X-Kapok-Actor':ctx.actorId,'Idempotency-Key':state.key},
    signal:AbortSignal.any([signal,ctx.signal]),body:file});
  if (response.headers.get('X-Kapok-Actor')!==ctx.actorId) throw Error('请重新确认登录账号。');
  const result=await response.json();
  if (!response.ok || result.data?.id!==state.id) throw Error(result.error?.message || '文件尚未上传完成。');
  state.ready=true;
  return state.id;
}
async function saveAssetPhotos(ctx,kind,id,photos,signal,attempt) {
  const result=[];
  for (const photo of photos) {
    result.push({id:photo.file ? await uploadAsset(ctx,kind,id,photo.file,signal,attempt) : photo.id,alt:photo.alt.trim()});
  }
  return result;
}
export async function saveMaterial(ctx,item,input,signal,attempt) {
  const {kind,title,date,category,summary,body,photos,source,clipFile,timepoints} = input;
  const key = attempt.key;
  if (kind === 'training') {
    const chapters = { ...item?.extra?.chapters };
    const fields = {title,date,description:summary};
    let uploadId=input.uploadId;
    const needsVideo = !!clipFile || !!uploadId || (item && source && source.url !== item.source?.url);
    let id = item?.id || attempt.trainingId;
    let version = item?.version ?? attempt.version;
    if (!id) {
      const result = await ctx.write('trainings/publish','POST',{
        ...fields, status:needsVideo || photos.length ? 'draft' : 'published',
        workspaceDetails:{category,body,chapters:source ? {[source.url]:timepoints} : {}},
        ...(source && {video:{title,url:source.url}}),
      },key+'-create');
      id = attempt.trainingId = result.training.id;
      version = attempt.version = result.training.version;
      if (!needsVideo && !photos.length) return id;
    }
    const attachments=await saveAssetPhotos(ctx,'training',id,photos,signal,attempt);
    if (clipFile && !uploadId) uploadId=await uploadAsset(ctx,'training',id,clipFile,signal,attempt);
    let media = source?.url || item?.videoAsset;
    let appendVideo;
    if (needsVideo) {
      const videoId=attempt.videoId ??= crypto.randomUUID();
      const attached=uploadId ? {source:'upload',uploadId} : {source:source.platform==='YouTube'?'youtube':'bilibili',url:source.url};
      const position=item?.videos?.length ? Math.max(...item.videos.map(v=>v.position))+1 : 0;
      appendVideo={id:videoId,title,position,...attached};
      if (uploadId) media='/api/v1/videos/'+encode(videoId)+'/media';
    }
    if (media) chapters[media] = timepoints;
    await ctx.write('trainings/'+encode(id),'PATCH',{
      ...fields,status:item && item.status!=='draft' ? item.status : 'published',expectedVersion:version,...(appendVideo && {appendVideo}),
      workspaceDetails:{...item?.extra,category,body,chapters,photos:attachments},
    },key+'-edit');
    return id;
  }
  const base='learning/posts';
  if (!['战术','基本功','基本概念'].includes(category) && category !== item?.category && !attempt.categorySaved) {
    await ctx.write('learning/categories','POST',{name:category},key+'-category');
    attempt.categorySaved = true;
  }
  const fields = {kind,title,summary,category,body,video:source ? {source:source.platform==='YouTube'?'youtube':'bilibili',url:source.url}:null,
    workspaceDetails:{date,chapters:source ? {[source.url]:timepoints} : {}}};
  let draft = attempt.draft;
  if (!draft) {
    const seed=clipFile ? {...fields,kind:'article',video:null} : fields;
    draft = attempt.draft = item || await ctx.write(base,'POST',seed,key+'-draft');
  }
  const path = base+'/'+encode(draft.id);
  if (kind==='video') {
    const clip=clipFile ? assetUrl(await uploadAsset(ctx,'post',draft.id,clipFile,signal,attempt)) : !source ? (item?.videoAsset || (item?.video?.source==='upload' && item.video.url)) : null;
    if (clip) {
      fields.video={source:'upload',url:clip};
      fields.workspaceDetails.chapters={[clip]:timepoints};
    }
    fields.workspaceDetails.photos=await saveAssetPhotos(ctx,'post',draft.id,photos,signal,attempt);
  }
  if (!attempt.saved) {
    let version=draft.version;
    const images=[];
    for (const photo of kind==='article'?photos:[]) {
      let id = photo.id;
      if (photo.file) {
        const state=attempt.images ??= new Map();
        if (!state.has(photo.file)) state.set(photo.file,await queueLearningImage(photo.file));
        const image=await finishLearningImage(path+'/images',state.get(photo.file),photo.file,ctx.actorId,signal,row=>state.set(photo.file,row));
        id=image.id;
      }
      images.push({id,alt:photo.alt.trim(),decorative:!photo.alt.trim()});
    }
    if (kind==='article' && photos.some(photo=>photo.file)) {
      const current=await ctx.read(path+'?view=draft',signal);
      // Completing each image advances the draft version once. Reject concurrent edits.
      if (current.version!==version+photos.filter(photo=>photo.file).length) throw Error('草稿已变化，请重新打开编辑器。');
      version=current.version;
    }
    attempt.saved=await ctx.write(path,'PATCH',{...fields,...(kind==='article' && {images}),expectedVersion:version},key+'-edit');
  }
  await ctx.write(path+'/publish','POST',{expectedVersion:attempt.saved.version,expectedMembershipEpoch:ctx.account.membership.epoch},key+'-publish');
  return draft.id;
}
