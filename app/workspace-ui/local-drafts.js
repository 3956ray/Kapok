// Each draft has its own storage key so another tab editing a different draft cannot restore it.
export function readWorkspaceDrafts(storage, base) {
  const drafts = JSON.parse(storage.getItem(base)) || {};
  const prefix = base + ':';
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const id = decodeURIComponent(key.slice(prefix.length));
    const value = JSON.parse(storage.getItem(key));
    if (value === null) delete drafts[id];
    else drafts[id] = value;
  }
  return drafts;
}

export function writeWorkspaceDrafts(storage, base, changed, next) {
  const legacy = JSON.parse(storage.getItem(base)) || {};
  const keyFor = id => base + ':' + encodeURIComponent(id);
  for (const id of changed) {
    if (Object.hasOwn(next, id)) storage.setItem(keyFor(id), JSON.stringify(next[id]));
    else if (Object.hasOwn(legacy, id)) storage.setItem(keyFor(id), 'null');
    else storage.removeItem(keyFor(id));
  }
  // Remove the old account-wide snapshot once all its entries have a replacement.
  const ids = Object.keys(legacy);
  if (ids.length && ids.every(id => storage.getItem(keyFor(id)) !== null)) storage.removeItem(base);
}
