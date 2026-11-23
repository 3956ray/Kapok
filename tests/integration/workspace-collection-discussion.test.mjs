import assert from 'node:assert/strict';
import test from 'node:test';
import { discussionSources, readDiscussion } from '../../app/workspace-ui/discussion-sources.js';

const media = 'https://example.test/video';
const trainingRows = [
  {id:'general', rootId:null, createdAt:'2026-11-22T00:00:00Z', status:'active', text:'General', authorId:'member'},
  {id:'reply', rootId:'general', createdAt:'2026-11-24T00:00:00Z', status:'active', text:'Reply', authorId:'reader', replyTargetName:'作者'},
];
const videoRows = [
  {id:'clip', rootId:null, createdAt:'2026-11-23T00:00:00Z', status:'active', text:'Video', authorId:'reader', referenceTimes:'[0,5]'},
];

test('merged training discussion keeps original destinations, threads and playable citations', async () => {
  const sources = discussionSources('training', 'session', 'clip-1');
  const controller = new AbortController();
  const reads = [];
  const ctx = {account:{user:{id:'reader'}}, read:async(path,signal)=>{
    assert.equal(signal,controller.signal);
    reads.push(path);
    if (path === 'trainings/session/discussion') return trainingRows;
    assert.equal(path,'page-read/video-discussion/clip-1');
    return {value:videoRows};
  }};
  const rows = await readDiscussion(ctx, sources, media, controller.signal);
  assert.equal(reads.length,2);
  assert.equal(sources[0].write,'videos/clip-1/comments');
  assert.deepEqual(rows.map(c=>[c.id,c.source.write]), [
    ['general','trainings/session/discussion'], ['clip','videos/clip-1/comments'], ['reply','trainings/session/discussion'],
  ]);
  assert.equal(rows[2].root, rows[0].id);
  assert.equal(rows[2].replyName, '作者');
  assert.equal(rows[1].author, 'me');
  assert.deepEqual(rows[1].videoRefs,{media,seconds:[0,5]});
});

test('training without a video and learning posts retain their existing discussion endpoints', async () => {
  assert.deepEqual(discussionSources('training', 'session', undefined), [
    {kind:'training',read:'trainings/session/discussion',write:'trainings/session/discussion'},
  ]);
  const sources = discussionSources('video', 'post', undefined, 7);
  const ctx = {account:{user:{id:'reader'}},read:async(path)=>{
    assert.equal(path,'page-read/article-discussion/post?version=7');
    return {value:[{...videoRows[0],matchesCurrentMedia:false}]};
  }};
  const [comment] = await readDiscussion(ctx, sources, media, new AbortController().signal);
  assert.equal(comment.source.write,'learning/posts/post/comments');
  assert.deepEqual(comment.videoRefs,{media:null,seconds:[0,5]});
});
