import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDraftRequest, reconcileDraft } from '../../lib/client/reflection-draft.ts';
const draft = {
    schema: 1,
    title: '',
    text: 'A',
    date: '2026-10-16',
    trainingId: '',
    videoId: '',
    updatedAt: 'now',
    cloud: null,
    pending: null
};
const cloud = {
    id: 'r1',
    title: '',
    text: 'A',
    date: draft.date,
    trainingId: null,
    videoId: null,
    version: 1,
    sharingVersion: 1,
    generation: 1
};
test(
    'unknown create survives serialization/cold start with identical key and input',
    () => {
        const first = prepareDraftRequest(draft, 'request-A');
        const restored = JSON.parse(JSON.stringify(first));
        const retry = prepareDraftRequest(restored, 'must-not-replace');
        assert.deepEqual(retry.pending, first.pending);
        assert.equal(retry.pending.key, 'request-A');
        assert.equal(retry.pending.targetId, null);
        assert.equal(reconcileDraft(retry, cloud).saved, true);
    }
);
test(
    'A committed late keeps B local draft and routes next save to original cloud ID',
    () => {
        const first = prepareDraftRequest(draft, 'request-A');
        const changed = {
            ...first,
            text: 'B'
        };
        const result = reconcileDraft(changed, cloud);
        assert.equal(result.saved, false);
        assert.equal(result.draft.text, 'B');
        assert.equal(result.draft.pending, null);
        const next = prepareDraftRequest(JSON.parse(JSON.stringify(result.draft)), 'request-B');
        assert.equal(next.pending.targetId, 'r1');
        assert.equal(next.pending.body.text, 'B');
        assert.equal(next.pending.body.expectedVersion, 1);
    }
);
test(
    'historical done retry exposing newer server state cannot discard old unsaved local text',
    () => {
        const pending = prepareDraftRequest(draft, 'request-A');
        const result = reconcileDraft(pending, {
            ...cloud,
            text: 'newer cloud',
            version: 2
        });
        assert.equal(result.saved, false);
        assert.equal(result.draft.text, 'A');
        assert.equal(result.draft.cloud.version, 2);
    }
);
