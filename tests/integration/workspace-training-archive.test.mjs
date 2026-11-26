import assert from 'node:assert/strict';
import test from 'node:test';
import { isDailyArticle } from '../../lib/contracts/learning.ts';
import { noteCategoryName, newTrainingCategory, trainingCategoryNames } from '../../app/workspace-ui/categories.js';
import { chapterPath, presentTopic } from '../../app/workspace-ui/topics.js';

test('daily shares stay readable independently of the training catalog and personal note taxonomy', () => {
    const article = { kind: 'article', category: '随谈' };
    const training = { kind: 'training', category: '基本功' };
    assert.equal(isDailyArticle(article), true);
    assert.equal(isDailyArticle(training), false);
    const {items} = presentTopic({items:[
        {kind:'post', mediaKind:'article', category:'随谈', id:'daily', title:'队内相册'},
        {kind:'reflection', mediaKind:'reflection', id:'note', title:'赛后观察'},
    ]});
    assert.equal(isDailyArticle(items[0]), true);
    assert.equal(items[0].href, '/trainings/daily');
    assert.equal(items[1].href, '/notes/note');
    assert.equal(chapterPath(items[1], '/shared/edition'), '/shared/edition/items/reflection:note');
    assert.deepEqual(trainingCategoryNames(['战术', '基本概念', '随谈', '基本功', '进攻']), ['战术', '基本功', '进攻']);
    assert.throws(() => newTrainingCategory(' 随谈 '));
    assert.equal(newTrainingCategory('基本概念'), '基本功');
    assert.equal(noteCategoryName('随谈'), '随谈');
});

test('withdrawn publications cannot re-enter the workspace through the owner draft list or stale edit link', async () => {
    const { presentMaterials, loadMaterial, deleteMaterial } = await import('../../app/workspace-ui/materials.js');
    const account = { user: { id: 'author' }, membership: { role: 'member' } };
    const draft = { id: 'draft', kind: 'article', category: '战术', images: [], status: 'draft', updatedAt: '2026-01-01' };
    const withdrawn = { ...draft, id: 'removed', status: 'withdrawn' };
    assert.deepEqual(presentMaterials(account, [], [], [], [draft, withdrawn]).trainings.map(item => item.id), ['draft']);
    const ctx = { account, read: async () => withdrawn, write: () => assert.fail('must not withdraw an unseen revision') };
    await assert.rejects(loadMaterial(ctx, { ...withdrawn, isDraft: true }, undefined, true), /已移除/);
    await assert.rejects(deleteMaterial(ctx, { ...withdrawn, publishedVersion: 3, canEdit: true }), /已变化/);
});

test('deleting an old device draft survives an overlapping write from another tab', async () => {
    const { JSDOM } = await import('jsdom');
    const { readWorkspaceDrafts, writeWorkspaceDrafts } = await import('../../app/workspace-ui/local-drafts.js');
    const dom = new JSDOM('', { url: 'https://kapok.test' });
    const storage = dom.window.localStorage;
    storage.setItem('notes', JSON.stringify({ a: { body: 'first' }, b: { body: 'second' } }));
    const stale = readWorkspaceDrafts(storage, 'notes');
    writeWorkspaceDrafts(storage, 'notes', ['a'], { b: stale.b });
    writeWorkspaceDrafts(storage, 'notes', ['b'], { ...stale, b: { body: 'new' } });
    assert.deepEqual(readWorkspaceDrafts(storage, 'notes'), { b: { body: 'new' } });
    assert.equal(storage.getItem('notes'), null);
    dom.window.close();
});
