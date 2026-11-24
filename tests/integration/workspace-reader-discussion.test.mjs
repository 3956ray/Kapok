import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discussionSources, readReaderDiscussion } from '../../app/workspace-ui/discussion-sources.js';

for (const [kind, prefix] of [['reflection', 'reflections'], ['announcement', 'announcements']]) {
  test(kind + ' binds roots and replies to their original reader and both write epochs', async () => {
    const [source] = discussionSources(kind, 'shared-id');
    const path = prefix + '/shared-id/discussion';
    assert.deepEqual(source, { kind, read: path, write: path });
    const controller = new AbortController();
    const items = [
      { id: 'two', rootId: 'one', text: '回应', authorId: 'other', authorName: '队友',
        replyTargetName: '作者', createdAt: '2026-11-24T09:00:00Z', version: 3, status: 'active' },
      { id: 'one', rootId: null, text: null, authorId: 'me', authorName: '作者',
        createdAt: '2026-11-24T08:00:00Z', version: 2, status: 'deleted' },
    ];
    const ctx = { account: { user: { id: 'me' } }, read: async (url, signal) => {
      assert.equal(url, path);
      assert.equal(signal, controller.signal);
      return { discussionEpoch: 4, membershipEpoch: 7, items };
    } };
    const { rows, expected } = await readReaderDiscussion(ctx, source, controller.signal);
    assert.deepEqual(expected, { expectedDiscussionEpoch: 4, expectedMembershipEpoch: 7 });
    assert.deepEqual(rows.map(r => [r.id, r.source.write]), [['one', path], ['two', path]]);
    assert.equal(rows[0].text, '这条评论已删除。');
    assert.equal(rows[1].root, 'one');
    assert.equal(rows[1].replyName, '作者');
    assert.equal(rows[1].videoRefs, undefined);
  });
}

test('even an empty reader thread requires a verified discussion and membership epoch', async () => {
  const [source] = discussionSources('reflection', 'id');
  const ctx = { account: { user: { id: 'me' } } };
  for (const value of [{ items: [], membershipEpoch: 1 }, { items: [], discussionEpoch: 9, membershipEpoch: 0 }, []]) {
    await assert.rejects(readReaderDiscussion({ ...ctx, read: async () => value }, source), /核对留言权限/);
  }
  const accepted = await readReaderDiscussion({ ...ctx, read: async () => ({ items: [], discussionEpoch: 1, membershipEpoch: 1 }) }, source);
  assert.deepEqual(accepted.rows, []);
  assert.deepEqual(accepted.expected, { expectedDiscussionEpoch: 1, expectedMembershipEpoch: 1 });
});
