import { isDailyArticle } from '../../lib/contracts/learning.ts';

export function inTrainingCatalog(collection) {
  return !collection.items.length || collection.items.some(item => !isDailyArticle(item));
}

export function catalogEntries(collections, remoteCollections, trainings) {
  return [
    ...collections.map((c) => ({
      key: c.id,
      href: '/collections/' + c.id,
      title: c.title,
      summary: c.summary,
      category: c.category,
      author: c.author,
      date: c.updated || c.created,
      count: c.itemIds.length,
      coverUrl: c.coverUrl,
      cover: c.items?.[0] || trainings.find((t) => t.id === c.itemIds[0]),
      contents: c.items
        .map(item => item.title)
        .filter(Boolean)
        .join(' '),
    })),
    ...remoteCollections.map((s) => ({
      key: 'shared:' + s.id,
      href: '/shared/' + s.id,
      title: s.title,
      summary: s.summary,
      category: s.category,
      author: s.author,
      date: s.created,
      count: s.count,
      cover: s.cover,
      contents: s.contents,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function matchText(query, ...parts) {
  const clean = (s) =>
    String(s || '')
      .normalize('NFKC')
      .toLocaleLowerCase();
  const text = clean(parts.join(' '));
  return clean(query)
    .trim()
    .split(/\s+/)
    .every((word) => text.includes(word));
}
