import assert from 'node:assert/strict';
import test from 'node:test';
import { isDailyArticle } from '../../lib/contracts/learning.ts';
import { noteCategoryName, newTrainingCategory, trainingCategoryNames } from '../../app/workspace-ui/categories.js';
import { inTrainingCatalog } from '../../app/workspace-ui/collection-model.js';

test('daily shares stay readable independently of the training catalog and personal note taxonomy', () => {
    const article = { kind: 'article', category: '随谈' };
    const training = { kind: 'training', category: '基本功' };
    assert.equal(isDailyArticle(article), true);
    assert.equal(isDailyArticle(training), false);
    assert.equal(inTrainingCatalog({ items: [article] }), false);
    assert.equal(inTrainingCatalog({ items: [article, training] }), true);
    assert.equal(inTrainingCatalog({ items: [] }), true);
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
