import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareSave } from '../../app/workspace-ui/growth.js';
import { layoutPhotos, noteBody, notePhotos, splitLayout } from '../../app/workspace-ui/note-layout.js';
import { persistPrivateLayout, readPrivateLayout, savedParts } from '../../app/workspace-ui/note-image-store.js';

test('pair Unicode text with ordered inline photos and preserve the original untrimmed body', () => {
  const text = '  🥏先看\n后切  ';
  const photos = [
    { id: 'a', at: 0, caption: '开场' },
    { id: 'b', at: 4, caption: '接应' },
    { id: 'c', at: 4, caption: '后排' },
    { id: 'd', at: text.length, caption: '' },
  ];
  const parts = splitLayout(text, photos);
  assert.deepEqual(parts.map(p => p.text), ['', '  🥏', '先看\n后切  ', '']);
  assert.equal(noteBody(parts), text);
  assert.deepEqual(layoutPhotos(parts), photos);
  const op = prepareSave({ scope: 'team', title: '图文', body: text, parts, category: '战术' }, null, {}, '2026-11-24');
  assert.equal(op.body.text, text);
  assert.deepEqual(op.body.photos, photos);
});

test('private and shared write payloads keep associations and only send authorized image metadata', () => {
  const parts = splitLayout('观察', [
    { id: 'local', at: 0, caption: '本机', localId: 'local' },
    { id: 'remote', at: 1, caption: '已分享', url: '/api/v1/image/version' },
  ]);
  const existing = { id: 'n', date: '2026-11-12', version: 6, sharingVersion: 7, generation: 2 };
  const association = { sourceRef: { kind: 'topic_collection', id: 'topic' } };
  const draft = { title: '练习', body: '观察', category: '战术', parts, scope: 'private' };
  const closed = prepareSave(draft, existing, association);
  const opened = prepareSave({ ...draft, scope: 'team' }, existing, association);
  assert.equal(closed.body.hasLocalPhotos, true);
  assert.deepEqual(closed.body.photos, [{ id: 'remote', at: 1, caption: '已分享' }]);
  assert.deepEqual(closed.body.sourceRef, association.sourceRef);
  assert.equal(opened.body.hasLocalPhotos, false);
  assert.deepEqual(opened.body.photos.map(p => p.id), ['local', 'remote']);
  assert.ok(!JSON.stringify(opened.body.photos).includes('localId'));
  assert.equal(opened.body.expectedVersion, 6);
  assert.equal(opened.body.expectedSharingVersion, 7);
  const pure = prepareSave({ ...draft, body: '', parts: splitLayout('', [{ id: 'local', localId: 'local', at: 0, caption: '' }]) }, null, {}, existing.date);
  assert.equal(pure.body.text, '');
  assert.deepEqual(pure.body.photos, []);
  assert.equal(pure.body.hasLocalPhotos, true);
  const removed = prepareSave({ ...draft, parts: [] }, { ...existing, photos: [{ id: 'remote' }] }, association);
  assert.deepEqual(removed.body.photos, []);
  assert.equal(removed.body.hasLocalPhotos, false);
  const old = prepareSave({ ...draft, body: ' old ', parts: undefined }, existing, association);
  assert.equal(old.body.text, 'old');
  assert.ok(!Object.hasOwn(old.body, 'photos'));
});

test('private layouts follow the owner through restore; discarded versions and other actors cannot read them', t => {
  const data = new Map();
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  const note = { id: 'private', isAuthor: true, version: 1, generation: 1, hasLocalPhotos: true, text: '' };
  const photos = [{ id: 'photo', localId: 'photo', at: 0, caption: '配图' }];
  persistPrivateLayout('a', note, { body: { photos: [], hasLocalPhotos: true }, layout: photos });
  assert.deepEqual(readPrivateLayout('a', note), photos);
  assert.equal(readPrivateLayout('b', note), null);
  assert.equal(readPrivateLayout('a', { ...note, isAuthor: false }), null);
  assert.deepEqual(notePhotos({ parts: savedParts('a', { ...note, version: 3, generation: 3 }) })[0].localId, 'photo');
  assert.equal(readPrivateLayout('a', { ...note, version: 2 }), null);
  const shared = { ...note, hasLocalPhotos: false, photos: [{ id: 'photo', at: 0, caption: '配图', url: '/api/v1/image/current' }] };
  assert.equal(notePhotos({ parts: savedParts('a', shared) })[0].url, shared.photos[0].url);
  persistPrivateLayout('a', shared, { body: { photos: shared.photos }, layout: photos });
  assert.equal(readPrivateLayout('a', note), null);
});
