import { loadMaterial, selectVideo } from './materials.js';

import { loadNote } from './growth.js';
import { trainingCategory } from './categories.js';

export function reflectionChapter({id, title, thumbnail, category, summary, author, date}) {
  return {id:'reflection:' + id, reference:{kind:'reflection',id}, kind:'reflection',
    title:title || '无标题复盘', category:category || '', summary:summary || '', author:author?.discName || '',
    photos:thumbnail ? [{url:thumbnail,alt:''}] : [], date, href:'/notes/' + encodeURIComponent(id)};
}

function chapter(source, date, materials) {
  if (source.kind === 'reflection') return reflectionChapter(source);
  const original = materials.get(source.trainingId || source.id);
  const id = source.kind === 'video' ? 'video:' + source.id : source.id;
  return {
    id, reference: { kind: source.kind, id: source.id },
    kind: source.mediaKind, title: source.title, date, author: source.author?.discName || '',
    category: trainingCategory(source.category) || '', summary: source.summary || '', photos: source.cover ? [{ url: source.cover.href, alt: source.cover.alt }] : original?.photos || [],
    platformCover: source.kind === 'video' ? '/api/v1/video-covers/video/' + encodeURIComponent(source.id) : original?.platformCover,
    href: '/trainings/' + (source.trainingId || source.id) + (source.kind === 'video' ? '?video=' + source.id : ''),
  };
}

export function chapterPath(item,base,videoId) {
  if (item.reference?.kind === 'reflection') return base + '/items/' + item.id;
  const [path, query] = item.href.split('?');
  const params = new URLSearchParams(query);
  if (videoId) params.set('video',videoId);
  params.set('collection',base);
  params.set('entry',item.id);
  return path + '?' + params;
}

export function presentTopic(row, originals = [], editionId) {
  const materials = originals instanceof Map ? originals : new Map(originals.map(t => [t.id,t]));
  const items = row.items.map(source => chapter(source, row.updated, materials));
  const coverMode = editionId ? 'share' : row.published ? 'published' : 'draft';
  return {
    id: row.id, title: row.title, author: row.author, ownerId: row.isAuthor ? 'me' : row.ownerId,
    category: trainingCategory(row.category) || '', summary: row.summary, created: row.updated, updated: row.updated,
    itemIds: items.map(item => item.id), items, version: row.version,
    coverUrl: row.coverVersion ? '/api/v1/workspace/topic-covers/' + coverMode + '/' + encodeURIComponent(editionId || row.id) + '/' + row.coverVersion : '',
    shareId: row.published || row.status === 'published' ? row.id : null,
  };
}
export function presentTopics(rows, originals = []) {
  const materials = new Map(originals.map(t => [t.id,t]));
  const byId = new Map();
  for (const row of rows) {
    const revisions = byId.get(row.id) || {};
    revisions[row.published ? 'public' : 'draft'] = presentTopic(row,materials);
    byId.set(row.id, revisions);
  }
  const collections = Array.from(byId.values(), revisions => ({
    ...(revisions.public || revisions.draft), draft: revisions.draft, published: !!revisions.public,
  }));
  return { collections, remoteCollections: [] };
}

export const sourceReference = item => item.reference || { kind: item.kind === 'training' ? 'training' : 'post', id: item.id };
export async function saveTopic(ctx, previous, form, chapters, key) {
  const payload = {
    title: form.title.trim(), category: form.category, summary: form.summary.trim(),
    ...(form.cover !== undefined && { cover:form.cover }),
    items: chapters.map(sourceReference), expectedVersion: form.baseVersion, expectedMembershipEpoch: ctx.account.membership.epoch,
  };
  return ctx.write('workspace/topics' + (previous ? '/' + previous.id : ''), previous ? 'PATCH' : 'POST', payload, key);
}

export function deleteCollection(ctx, collection) {
  return ctx.write('workspace/topics/' + collection.id, 'DELETE', {
    expectedVersion: (collection.draft || collection).version, expectedMembershipEpoch: ctx.account.membership.epoch,
  });
}

export async function readChapter(ctx, item, collection, signal, videoId) {
  const { id, kind } = item.reference;
  let material;
  if (kind === 'reflection') {
    material = await loadNote({...ctx,signal},id);
    if (material.scope !== 'team') throw new Error('该复盘已不可见。');
  } else if (kind === 'video') {
    const source = await ctx.read('videos/' + id, signal);
    const parent = await loadMaterial(ctx, { kind: 'training', id: source.trainingId }, signal);
    if (!parent.videos.some(v => v.id === id)) throw new Error('该视频已不可见。');
    material = selectVideo(parent,id);
  } else {
    material = selectVideo(await loadMaterial(ctx,{id,kind:kind === 'training' ? 'training' : item.kind},signal), videoId);
  }
  // A source may remain readable after this particular publication or chapter has been withdrawn.
  const visible = await ctx.read(collection.editionId ? 'workspace/topic-shares/' + collection.editionId :
    'learning/collections/' + collection.id + (collection.published ? '' : '?view=draft'), signal);
  if (!visible.items.some(ref => ref.kind === kind && ref.id === id)) throw new Error('这一项已从合集移出。');
  return material;
}
