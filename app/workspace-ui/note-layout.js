export const maxNotePhotos = 9;

export function noteParts(note) {
  return note.parts?.length ? note.parts : [{ text: note.body || '', photos: [] }];
}

export function notePhotos(note) {
  return note.parts?.flatMap(part => part.photos) || [];
}

export function noteBody(parts) {
  return parts.map(part => part.text).join('');
}

export function layoutPhotos(parts) {
  let at = 0;
  return parts.flatMap(part => {
    at += part.text.length;
    return part.photos.map(photo => ({ id: photo.id || photo.localId, at, caption: photo.alt || '',
      ...(photo.localId && !photo.url && { localId: photo.localId }) }));
  });
}

export function splitLayout(body, photos) {
  const parts = [];
  let start = 0;
  for (const photo of photos) {
    const at = Math.max(start, Math.min(photo.at, body.length));
    if (!parts.length || at !== start) parts.push({ text: body.slice(start, at), photos: [] });
    parts.at(-1).photos.push({ id: photo.id, alt: photo.caption, ...(photo.localId && { localId: photo.localId }),
      ...(photo.url && { url: photo.url, thumb: photo.url + '?size=thumb' }) });
    start = at;
  }
  parts.push({ text: body.slice(start), photos: [] });
  return parts;
}
