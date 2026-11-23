// The first source receives new top-level comments. Replies and deletions stay with their original thread.
export function discussionSources(kind, id, videoId, publishedVersion) {
  if (kind !== 'training') {
    const post = 'learning/posts/' + encodeURIComponent(id);
    return [{ kind: 'post', read: 'page-read/article-discussion/' + encodeURIComponent(id) + '?version=' + publishedVersion, write: post + '/comments' }];
  }
  const general = 'trainings/' + encodeURIComponent(id) + '/discussion';
  const sources = [{ kind: 'training', read: general, write: general }];
  if (videoId) sources.unshift({
    kind: 'video',
    read: 'page-read/video-discussion/' + encodeURIComponent(videoId),
    write: 'videos/' + encodeURIComponent(videoId) + '/comments',
  });
  return sources;
}

export async function readDiscussion(ctx, sources, mediaKey, signal) {
  const lists = await Promise.all(sources.map(async source => {
    const result = await ctx.read(source.read, signal);
    const rows = source.kind === 'training' ? result : result.value;
    return rows.map(c => {
      const author = c.authorId ?? c.author?.id;
      const seconds = c.referenceTimes ? JSON.parse(c.referenceTimes) : c.timestampSec != null ? [c.timestampSec] : [];
      return {
        id: c.id, source, version: c.version, root: c.rootId, at: c.createdAt, status: c.status,
        text: c.text ?? (c.status === 'deleted' ? '这条评论已删除。' : '评论已隐藏。'),
        author: author === ctx.account.user.id ? 'me' : author,
        authorName: c.authorName ?? c.author?.discName, replyName: c.replyTargetName ?? c.replyTarget?.authorName,
        videoRefs: seconds.length && c.status === 'active' ? {
          media: source.kind === 'video' || c.matchesCurrentMedia ? mediaKey : null, seconds,
        } : undefined,
      };
    });
  }));
  return lists.flat().sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
