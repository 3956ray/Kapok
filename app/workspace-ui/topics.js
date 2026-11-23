import { loadMaterial, selectVideo } from './materials.js';

function chapter(source, date) {
  const id = source.kind === 'video' ? 'video:' + source.id : source.id;
  return {
    id, reference: { kind: source.kind, id: source.id },
    kind: source.mediaKind, title: source.title, date, author: source.author?.discName || '',
    category: source.category || '', summary: source.summary || '', photos: source.cover ? [{ url: source.cover.href, alt: source.cover.alt }] : [],
    href: '/trainings/' + (source.trainingId || source.id) + (source.kind === 'video' ? '?video=' + source.id : ''),
  };
}

export function presentTopic(row) {
  const items = row.items.map(source => chapter(source, row.updated));
  return {
    id: row.id, title: row.title, author: row.author, ownerId: row.isAuthor ? 'me' : row.ownerId,
    category: row.category || '', summary: row.summary, created: row.updated, updated: row.updated,
    itemIds: items.map(item => item.id), items, version: row.version,
    shareId: row.published || row.status === 'published' ? row.id : null,
  };
}
export function presentTopics(rows) {
  const byId = new Map();
  for (const row of rows) {
    const revisions = byId.get(row.id) || {};
    revisions[row.published ? 'public' : 'draft'] = presentTopic(row);
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
    items: chapters.map(sourceReference), expectedVersion: form.baseVersion, expectedMembershipEpoch: ctx.account.membership.epoch,
  };
  return ctx.write('workspace/topics' + (previous ? '/' + previous.id : ''), previous ? 'PATCH' : 'POST', payload, key);
}

export function deleteCollection(ctx, collection) {
  return ctx.write('workspace/topics/' + collection.id, 'DELETE', {
    expectedVersion: (collection.draft || collection).version, expectedMembershipEpoch: ctx.account.membership.epoch,
  });
}

export async function readChapter(ctx, item, collection, signal) {
  const { id, kind } = item.reference;
  let material;
  if (kind === 'video') {
    const source = await ctx.read('videos/' + id, signal);
    const parent = await loadMaterial(ctx, { kind: 'training', id: source.trainingId }, signal);
    if (!parent.videos.some(v => v.id === id)) throw new Error('该视频已不可见。');
    material = selectVideo(parent,id);
  } else {
    material = selectVideo(await loadMaterial(ctx,{id,kind:kind === 'training' ? 'training' : item.kind},signal));
  }
  // A source may remain readable after this particular publication or chapter has been withdrawn.
  const visible = await ctx.read(collection.editionId ? 'workspace/topic-shares/' + collection.editionId :
    'learning/collections/' + collection.id + (collection.published ? '' : '?view=draft'), signal);
  if (!visible.items.some(ref => ref.kind === kind && ref.id === id)) throw new Error('这一项已从合集移出。');
  return { ...material, id: item.id, reference: item.reference, href: item.href, title: item.title, author: item.author || material.author };
}
