import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearUnsavedNoteImages, saveIllustratedNote, stageNoteImages } from '../../app/workspace-ui/note-image-store.js';

test('resolve a sent photo save by its original key without requiring files from this device', async () => {
  const op = { scope: 'team', uploaded: true, key: 'original-key', body: {},
    layout: [{ id: 'photo', localId: 'photo', at: 0, caption: '' }] };
  const calls = [];
  const saved = { id: 'result', version: 1, sharingVersion: 2, generation: 1, scope: 'team' };
  const ctx = { write: async (...args) => { calls.push(args); return saved; } };
  const unexpected = () => assert.fail('An unknown result must be reconciled before touching files');
  assert.equal(await saveIllustratedNote(ctx, op, unexpected, unexpected), saved);
  assert.deepEqual(calls, [['reflections', 'POST', {}, op.key]]);
  ctx.write = async () => { throw Object.assign(Error('response lost'), { code: 'REQUEST_TIMEOUT' }); };
  await assert.rejects(saveIllustratedNote(ctx, op, unexpected, unexpected), /response lost/);
});

test('an interrupted sign-out or expired upload leaves local storage untouched', async () => {
  const controller = new AbortController();
  controller.abort();
  const noRead = { getItem() { assert.fail('interrupted logout read storage'); } };
  await assert.rejects(clearUnsavedNoteImages('owner', noRead, controller.signal), { name: 'AbortError' });
  await assert.rejects(stageNoteImages('owner', [{}], controller.signal), { name: 'AbortError' });
});

test('preserve saved and possibly committed private photos on sign-out without blocking logout', async () => {
  const photo = id => ({ id, localId: id, at: 0, caption: '' });
  const db = new Map([
    ['kapok:private-note-layout:owner:saved', JSON.stringify({ edition: 0, photos: [photo('saved')] })],
    ['kapok:reflection-draft:owner:bloom-notes', JSON.stringify({ draft: {
      parts: [{ text: '', photos: [photo('saved'), photo('unknown')] }],
      operation: { key: 'attempt', scope: 'private', id: null, body: { hasLocalPhotos: true }, layout: [photo('unknown')] },
    } })],
    ['kapok:private-note-layout:other:saved', JSON.stringify({ edition: 0, photos: [photo('other')] })],
  ]);
  const storage = { get length() { return db.size; }, key: i => [...db.keys()][i],
    getItem: k => db.get(k) ?? null, setItem: (k, value) => db.set(k, value) };
  await clearUnsavedNoteImages('owner', storage, new AbortController().signal);
  assert.deepEqual(JSON.parse(db.get('kapok:private-note-layout:owner:unconfirmed:attempt')).photos, [photo('unknown')]);
  assert.ok(db.has('kapok:private-note-layout:other:saved'));
});
