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
