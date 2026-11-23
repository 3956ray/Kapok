import { saveNote } from './growth.js';
import { notePhotos, splitLayout } from './note-layout.js';
import { readWorkspaceDrafts } from './local-drafts.js';
import { learningBounds, learningImageDimensions } from '../../lib/contracts/learning.ts';
import { draftKey } from '../../lib/client/session-guard.ts';

async function imageStore(actorId, mode, action, signal) {
  signal?.throwIfAborted();
  if (!actorId) throw new Error('请重新确认账号。');
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('kapok:note-images:' + encodeURIComponent(actorId), 1);
    open.onupgradeneeded = () => {
      const store = open.result.objectStoreNames.contains('photos')
        ? open.transaction.objectStore('photos') : open.result.createObjectStore('photos');
      store.createIndex('added', 'added');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error('无法打开本机图片库，请检查浏览器存储权限。'));
  });
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const request = action(tx.objectStore('photos'));
      const abort = () => { try { tx.abort(); } catch { /* Already completed. */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = () => signal?.removeEventListener('abort', abort);
      tx.oncomplete = () => { finish(); resolve(request?.result); };
      tx.onabort = () => { finish(); reject(signal?.reason || Error('图片未能存入本机，请检查可用空间后重试。')); };
    });
  } finally { db.close(); }
}

async function thumbnailFor(image, file) {
  const ratio = 480 / Math.max(image.naturalWidth, image.naturalHeight);
  if (ratio >= 1 || file.size < 48 * 1024) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [.8, .55]) {
    const small = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    if (small && small.size <= 128 * 1024 && small.size < file.size) return small;
  }
  return null;
}

export async function stageNoteImages(actorId, files, signal) {
  const records = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
    if (!file.size || file.size > learningBounds.maxImageBytes) throw new Error('每张图片需有内容，且不超过 8 MB。');
    const bytes = await file.arrayBuffer();
    const header = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
    const signature = String.fromCharCode(...header);
    const matches = {
      'image/jpeg': header[0] === 255 && header[1] === 216 && header[2] === 255,
      'image/png': signature.startsWith('\x89PNG\r\n\x1a\n'),
      'image/webp': signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP',
    };
    if (!matches[file.type]) throw new Error('无法读取「' + file.name + '」，文件格式与内容不符。');
    const url = URL.createObjectURL(file);
    let preview, width, height;
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      width = image.naturalWidth;
      height = image.naturalHeight;
      preview = await thumbnailFor(image, file);
    } catch { throw new Error('无法读取「' + file.name + '」，请重新选择图片。'); }
    finally { URL.revokeObjectURL(url); }
    // Store bytes so private WebKit windows can save the original and preview atomically.
    records.push({ id: crypto.randomUUID(), bytes, type: file.type, width, height, added: Date.now(),
      ...(preview && { previewBytes: await preview.arrayBuffer(), previewType: preview.type }) });
  }
  await imageStore(actorId, 'readwrite', store => {
    for (const record of records) store.put(record, record.id);
  }, signal);
  return records.map(({ id }) => ({ localId: id, alt: '' }));
}

export async function readNoteImage(actorId, id) {
  const record = await imageStore(actorId, 'readonly', store => store.get(id));
  if (!record?.bytes && !record?.file) throw new Error('本机找不到这张图片，请重新选择。');
  return record;
}

export function storedBlob(record, preview = false) {
  const bytes = preview ? record.previewBytes : record.bytes;
  if (bytes) return new Blob([bytes], { type: preview ? record.previewType : record.type });
  return preview ? record.preview : record.file;
}


const layoutPrefix = actorId => 'kapok:private-note-layout:' + encodeURIComponent(actorId) + ':';
const layoutKey = (actorId, id) => layoutPrefix(actorId) + encodeURIComponent(id);

// Deleting and restoring from the recycle bin both change version and generation by the same amount.
export function localEdition(note) {
  return note.version - note.generation;
}

export function readPrivateLayout(actorId, note) {
  if (!actorId || !note?.hasLocalPhotos || !note.isAuthor) return null;
  try {
    const meta = JSON.parse(localStorage.getItem(layoutKey(actorId, note.id)));
    if (meta?.edition === localEdition(note)) return meta.photos;
  } catch { /* Browser storage may be disabled. Keep remote photos accessible. */ }
  return null;
}

export function savedParts(actorId, note) {
  const remote = note.photos || [];
  const local = readPrivateLayout(actorId, note);
  const photos = local ? local.map(photo => photo.localId ? photo : remote.find(item => item.id === photo.id)).filter(Boolean) : remote;
  return splitLayout(note.text ?? note.body ?? '', photos);
}

export function persistPrivateLayout(actorId, saved, operation) {
  if (!operation.layout && !operation.body.photos) return;
  if (saved.version !== (operation.body.expectedVersion || 0) + 1) return;
  const key = layoutKey(actorId, saved.id);
  if (operation.body.hasLocalPhotos) {
    try {
      localStorage.setItem(key, JSON.stringify({ edition: localEdition(saved), photos: operation.layout }));
    } catch { throw Error('正文已保存，配图排版暂未存入本机。请保留草稿，释放空间后重试。'); }
  } else {
    try { localStorage.removeItem(key); } catch { /* Cleared server marker supersedes stale local layout. */ }
  }
  if (operation.key) {
    try { localStorage.removeItem(layoutPrefix(actorId) + 'unconfirmed:' + operation.key); } catch { /* Harmless duplicate for export. */ }
  }
}

// Keep the selected original available for the author's export. Only the team-facing copy needs the service's pixel bound.
async function uploadOriginal(record) {
  if (record.uploadBytes) return new Blob([record.uploadBytes], { type: record.uploadType });
  const original = storedBlob(record);
  const { maxEdge, maxPixels } = learningImageDimensions;
  if (!record.width || (Math.max(record.width, record.height) <= maxEdge && record.width * record.height <= maxPixels)) return original;
  const source = URL.createObjectURL(original);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const ratio = Math.min(maxEdge / Math.max(record.width, record.height), Math.sqrt(maxPixels / (record.width * record.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(record.width * ratio));
    canvas.height = Math.max(1, Math.floor(record.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw Error('本机暂无法缩放这张图片，请重新选择。');
    while (true) {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .87));
      if (!blob) throw Error('图片转换失败，请重试。');
      if (blob.size <= learningBounds.maxImageBytes) {
        record.uploadType = blob.type;
        record.uploadBytes = await blob.arrayBuffer();
        return blob;
      }
      canvas.width = Math.max(1, Math.floor(canvas.width * .7));
      canvas.height = Math.max(1, Math.floor(canvas.height * .7));
    }
  } finally { URL.revokeObjectURL(source); }
}

const receiptLifetime = 10 * 60 * 1000;

export async function uploadNoteImages(ctx, layout, progress) {
  const photos = layout.filter(photo => photo.localId);
  if (!photos.length) return;
  const token = await ctx.authorize();
  for (const [i, photo] of photos.entries()) {
    ctx.signal.throwIfAborted();
    progress('正在上传配图 ' + (i + 1) + ' / ' + photos.length);
    const record = await readNoteImage(ctx.actorId, photo.localId);
    for (const variant of ['content', 'thumbnail']) {
      const receipt = variant + 'UploadedAt';
      if (Date.now() - record[receipt] < receiptLifetime) continue;
      const blob = variant === 'thumbnail' ? storedBlob(record, true) : await uploadOriginal(record);
      if (!blob) continue;
      // Persist derived content before PUT. A dropped response can be replayed with identical bytes.
      if (variant === 'content') {
        record.uploadAttempted = true;
        await imageStore(ctx.actorId, 'readwrite', store => store.put(record, photo.localId), ctx.signal);
      }
      const response = await fetch('/api/v1/workspace/note-images/' + encodeURIComponent(photo.id) + '/' + variant, {
        method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: ctx.signal,
        headers: { 'Content-Type': blob.type, 'X-Kapok-Actor': ctx.actorId, 'Idempotency-Key': photo.id + '-' + variant },
        body: blob,
      });
      if (!ctx.isCurrent(token)) throw Error('请重新确认登录账号。');
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Error(result?.error?.message || '配图上传未完成，请重试。');
      if (response.headers.get('X-Kapok-Actor') !== ctx.actorId || result?.data?.id !== photo.id)
        throw Error('请重新确认登录账号。');
      record[receipt] = Date.now();
      await imageStore(ctx.actorId, 'readwrite', store => store.put(record, photo.localId), ctx.signal);
    }
  }
}

// Reconcile a possibly committed write with its original key before requiring bytes from the device.
export async function saveIllustratedNote(ctx, operation, mark, progress) {
  if (operation.scope !== 'team' || !operation.layout?.some(photo => photo.localId)) return saveNote(ctx, operation);
  if (operation.uploadedAt || operation.uploaded) {
    try { return await saveNote(ctx, operation); }
    catch (error) {
      if (!error.beforeSave || !['VERSION_CONFLICT', 'INVALID_INPUT'].includes(error.code) ||
          Date.now() - (operation.uploadedAt || 0) < receiptLifetime) throw error;
      // The service confirmed refusal. Detached uploads may have expired while this draft was closed.
    }
  }
  try { await uploadNoteImages(ctx, operation.layout, progress); }
  catch (error) { error.beforeSave = true; throw error; }
  const sent = { ...operation, uploadedAt: Date.now() };
  mark(sent);
  progress('');
  return saveNote(ctx, sent);
}

export async function cancelDetachedNoteImages(ctx, ids) {
  // The DELETE is owner- and detached-only. Invalidate receipts before it, even if its response is lost.
  await Promise.allSettled([...new Set(ids)].map(async id => {
    const record = await readNoteImage(ctx.actorId, id);
    if (!record.uploadAttempted && !record.contentUploadedAt) return;
    delete record.contentUploadedAt;
    delete record.thumbnailUploadedAt;
    delete record.uploadAttempted;
    await imageStore(ctx.actorId, 'readwrite', store => store.put(record, id), ctx.signal);
    await ctx.write('workspace/note-images/' + encodeURIComponent(id), 'DELETE', {}, id + '-discard');
  }));
}

function accountLayouts(storage, actorId) {
  const prefix = layoutPrefix(actorId);
  const layouts = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) layouts.push(JSON.parse(storage.getItem(key)));
  }
  return layouts;
}

function draftFiles(draft) {
  return [...(draft.deviceImageIds || []), ...(draft.stagedImageIds || []),
    ...notePhotos(draft).map(p => p.localId), ...(draft.operation?.layout || []).map(p => p.localId)].filter(Boolean);
}

export async function discardLocalDraftFiles(ctx, draft) {
  const candidates = new Set(draftFiles(draft));
  if (!candidates.size) return;
  const drafts = readWorkspaceDrafts(localStorage, draftKey(ctx.actorId, 'bloom-notes'));
  for (const other of Object.values(drafts)) for (const id of draftFiles(other)) candidates.delete(id);
  for (const saved of accountLayouts(localStorage, ctx.actorId)) for (const p of saved.photos) candidates.delete(p.localId);
  if (candidates.size) await imageStore(ctx.actorId, 'readwrite', store => {
    for (const id of candidates) store.delete(id);
  }, ctx.signal);
}

export async function clearUnsavedNoteImages(actorId, storage, signal) {
  signal.throwIfAborted();
  const drafts = Object.values(readWorkspaceDrafts(storage, draftKey(actorId, 'bloom-notes')));
  const retained = new Set();
  const uncertain = [];
  for (const draft of drafts) {
    const op = draft.operation;
    if (op?.scope === 'private' && op.body?.hasLocalPhotos && op.layout?.length) {
      // Its private row might already exist even if the response never arrived.
      uncertain.push({ operation: op.key, noteId: op.id, photos: op.layout });
    }
  }
  const saved = accountLayouts(storage, actorId);
  for (const entry of [...saved, ...uncertain]) {
    for (const p of entry.photos) if (p.localId) retained.add(p.localId);
  }
  // These limited records survive ordinary text-draft removal and remain available to an authorized export.
  for (const entry of uncertain) {
    storage.setItem(layoutPrefix(actorId) + 'unconfirmed:' + entry.operation, JSON.stringify(entry));
  }
  if (typeof indexedDB === 'undefined') return;
  // A selection can finish writing just before its editor unmounts, without ever appearing in a draft.
  // Sweep this account's actual files and keep every known saved or not-yet-confirmed private layout.
  await imageStore(actorId, 'readwrite', store => {
    const scan = store.openKeyCursor();
    scan.onsuccess = () => {
      const cursor = scan.result;
      if (!cursor) return;
      if (!retained.has(cursor.primaryKey)) store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }, signal);
}

export async function pruneNoteImages(actorId) {
  // Only the owning actor's saved layouts and drafts participate. Allow another tab a day to finish staging.
  const daysAgo = Date.now() - 86400000;
  const db = readWorkspaceDrafts(localStorage, draftKey(actorId, 'bloom-notes'));
  const used = new Set(Object.values(db).flatMap(notePhotos).map(p => p.localId));
  for (const layout of accountLayouts(localStorage, actorId)) {
    for (const p of layout.photos) if (p.localId) used.add(p.localId);
  }
  await imageStore(actorId, 'readwrite', store => {
    const request = store.index('added').openKeyCursor(IDBKeyRange.upperBound(daysAgo));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!used.has(cursor.primaryKey)) store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

export async function localImageExport(actorId, reflections, drafts) {
  const layouts = {};
  const ids = new Set();
  for (const note of reflections) {
    if (!note.hasLocalPhotos) continue;
    const meta = JSON.parse(localStorage.getItem(layoutKey(actorId, note.id)));
    if (!meta || (Number.isInteger(note.version) && meta.edition !== localEdition(note))) continue;
    layouts[note.id] = meta.photos;
    for (const p of meta.photos) if (p.localId) ids.add(p.localId);
  }
  const unconfirmed = accountLayouts(localStorage, actorId).filter(layout => layout.operation);
  for (const entry of unconfirmed) for (const p of entry.photos) if (p.localId) ids.add(p.localId);
  const pictureDrafts = {};
  for (const [key, draft] of Object.entries(drafts)) {
    const photos = notePhotos(draft);
    if (!photos.length) continue;
    pictureDrafts[key] = { title: draft.title, text: draft.body, category: draft.category, parts: draft.parts };
    for (const p of photos) if (p.localId) ids.add(p.localId);
  }
  const files = {};
  for (const id of ids) {
    const blob = storedBlob(await readNoteImage(actorId, id));
    files[id] = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error('读取本机配图失败，请重试导出。'));
      reader.readAsDataURL(blob);
    });
  }
  return {
    ...(Object.keys(layouts).length && { privatePhotoLayouts: layouts }),
    ...(unconfirmed.length && { unconfirmedPrivatePhotoLayouts: unconfirmed }),
    ...(Object.keys(pictureDrafts).length && { pictureDrafts }),
    ...(ids.size && { noteImages: files }),
  };
}
