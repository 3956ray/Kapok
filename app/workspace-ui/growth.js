// IDs, ownership and visibility come from the existing guarded D1 services.
function fromReflection(row) {
  return {
    ...row,
    ownerId: row.isAuthor ? 'me' : row.author.id,
    author: row.author.discName,
    body: row.text,
    created: row.date,
    training: row.trainingId || (row.sourceRef?.kind === 'learning_post' ? row.sourceRef.id : ''),
    scope: row.isAuthor ? row.scope : 'team',
  };
}

export async function loadNote(ctx, id) {
  const { value } = await ctx.read('page-read/reflections/' + encodeURIComponent(id), ctx.signal);
  return fromReflection(value);
}

function sourceHref(entry) {
  if (!entry.source) return null;
  const id = encodeURIComponent(entry.sourceId);
  if (entry.sourceKind === 'reflection') return '/notes/' + id;
  if (entry.sourceKind === 'topic_collection') return '/collections/' + id;
  if (['training', 'learning_post'].includes(entry.sourceKind)) return '/trainings/' + id;
  return entry.source.href; // Preserve the original video/time/comment locator.
}

export async function loadGrowth(ctx) {
  const { value } = await ctx.read('page-read/growth', ctx.signal);
  return presentGrowth(value);
}

export function presentGrowth(value) {
  const notes = value.reflections.map(fromReflection);
  const saved = Object.create(null);
  const savedCollections = Object.create(null);
  for (const row of value.collections) {
    const entry = {
      ...row,
      date: row.createdAt,
      note: row.privateNote,
      title: row.source?.title || '收藏的内容',
      href: sourceHref(row),
      missing: !row.source,
    };
    if (row.sourceKind === 'topic_collection') savedCollections[row.sourceId] = entry;
    else {
      const isMaterial = row.sourceKind === 'training' || row.sourceKind === 'learning_post';
      saved[isMaterial ? row.sourceId : row.sourceKind + ':' + row.sourceId] = entry;
    }
  }
  return { notes, saved, savedCollections, allNotes: notes };
}

export function removeBookmark(ctx, entry) {
  return ctx.write('collections/' + encodeURIComponent(entry.id), 'PATCH', {
    action: 'delete', expectedVersion: entry.version,
  });
}

export function editRemark(ctx, entry, privateNote) {
  return ctx.write('collections/' + encodeURIComponent(entry.id), 'PATCH', {
    privateNote, expectedVersion: entry.version,
  });
}

export function bookmark(ctx, item, existing) {
  if (existing) return removeBookmark(ctx, existing);
  return ctx.write('collections', 'POST', {
    sourceKind: item.kind === 'training' ? 'training' : 'learning_post',
    sourceId: item.id, privateNote: '',
  });
}

export function saveCollection(ctx, key, _info, existing) {
  if (existing) return removeBookmark(ctx, existing);
  return ctx.write('collections', 'POST', {
    sourceKind: 'topic_collection', sourceId: key.replace(/^shared:/, ''), privateNote: '',
  });
}

function expected(note) {
  return {
    expectedVersion: note.version, expectedSharingVersion: note.sharingVersion,
    expectedGeneration: note.generation,
  };
}
export function deleteNote(ctx, note) {
  return ctx.write('reflections/' + encodeURIComponent(note.id), 'DELETE', expected(note));
}

// Resolve source URLs from both generations of the editor. Only service-returned
// associations are used for a bookmark or published learning source.
export function reflectionSeedPath(params, bookmark) {
  const collection = params.get('collection');
  const kind = params.get('sourceKind');
  const source = params.get('sourceId');
  function id(value) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value || '')) throw new Error('来源链接无效。');
    return encodeURIComponent(value);
  }
  if (params.has('bookmark')) {
    if (!bookmark) throw new Error('这条收藏已不可用。');
    return 'collections/' + id(bookmark.id) + '/reflection-seed';
  }
  if (collection !== null) return 'collections/' + id(collection) + '/reflection-seed';
  if (params.has('video')) return 'videos/' + id(params.get('video'));
  if (params.has('training')) { id(params.get('training')); return null; }
  if (kind !== null || source !== null) {
    if (!['learning_post', 'topic_collection'].includes(kind)) throw new Error('来源链接无效。');
    return 'learning/' + (kind === 'learning_post' ? 'posts/' : 'collections/') + id(source) + '/reflection-seed';
  }
  return null;
}

export function prepareSave(draft, existing, association, today) {
  const operation = {
    key: crypto.randomUUID(),
    id: existing?.id || null,
    scope: draft.scope,
    publish: draft.scope === 'team' && draft.publish === true,
    body: {
      title: draft.title.trim(), text: draft.body.trim(), category: draft.category,
      date: existing?.date || today, ...association,
      ...(existing ? expected(existing) : {}),
    },
  };
  return operation;
}

export async function saveNote(ctx, op) {
  const path = op.id ? 'reflections/' + encodeURIComponent(op.id) : 'reflections';
  let saved;
  try { saved = await ctx.write(path, op.id ? 'PATCH' : 'POST', op.body, op.key); }
  catch (error) {
    if (['VERSION_CONFLICT', 'INVALID_INPUT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)) error.beforeSave = true;
    throw error;
  }
  if (op.scope !== 'team') return saved;
  // The server creates/edits privately first. On retry, its receipt returns the current row.
  // A different edit must never inherit this operation's grant.
  const expectedVersion = (op.body.expectedVersion || 0) + 1;
  const expectedSharing = (op.body.expectedSharingVersion || 0) + 1;
  if (saved.version !== expectedVersion || saved.generation !== (op.body.expectedGeneration || 1) ||
      saved.sharingVersion < expectedSharing || saved.sharingVersion > expectedSharing + (op.publish ? 2 : 1) ||
      (saved.scope === 'private' && saved.sharingVersion !== expectedSharing)) {
    throw new Error('复盘已在其他页面更改。请刷新后核对可见范围。');
  }
  const detail = 'reflections/' + encodeURIComponent(saved.id);
  const shared = saved.scope === 'team' ? saved : await ctx.write(detail + '/grants', 'PUT',
    { scope: 'team', ...expected(saved) }, op.key + '-share');
  if (!op.publish || shared.published) return shared;
  return ctx.write(detail + '/publication', 'PUT', { published: true, ...expected(shared) }, op.key + '-publish');
}
