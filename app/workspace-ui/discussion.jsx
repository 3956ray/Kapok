import { TextLinks } from '../components/learning-text';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, CornerDownRight, Play, Send, X } from 'lucide-react';
import { useNav } from './router';
import { shortDate, uid, useData, useRoster } from './store';
import { Avatar, Modal } from './ui';

import { isReferenceSecond, maxTimepoints, parseTimeLabel, referenceTimeError, timeLabel } from './timepoints.js';
import { ReferenceTime } from './reference-time.jsx';
import { discussionSources, isReaderDiscussion, readDiscussion, readReaderDiscussion } from './discussion-sources.js';

export default function Discussion({ t, subject = t, ...media }) {
  return <DiscussionResource key={[subject.kind, subject.id, subject.selectedVideo?.id].join(':')} item={subject} {...media} />;
}

function DiscussionResource({ item, mediaKey, ...media }) {
  const { ctx } = useData();
  const { params } = useNav();
  const selected = params.get('comment');
  const videoId = item.selectedVideo?.id;
  const sources = useMemo(() => discussionSources(item.kind, item.id, videoId, item.publishedVersion),
    [item.kind, item.id, videoId, item.publishedVersion]);
  const reader = isReaderDiscussion(item.kind);
  const [view, setView] = useState(null);
  const [revision, setRevision] = useState(0);
  function reload(invalidate = false) {
    if (invalidate) setView(null);
    setRevision(n => n + 1);
  }
  useEffect(() => {
    const abort = new AbortController();
    const reading = reader ? readReaderDiscussion(ctx, sources[0], abort.signal)
      : readDiscussion(ctx, sources, mediaKey, abort.signal).then(rows => ({ rows }));
    reading.then(result => {
      if (!abort.signal.aborted) setView({ ctx, sources, ...result });
    }).catch(error => { if (!abort.signal.aborted) setView({ ctx, sources, error }); });
    return () => abort.abort();
  }, [ctx, sources, mediaKey, revision, reader]);
  const current = view?.ctx === ctx && view.sources === sources ? view : null;
  if (reader && !current?.expected) {
    if (['FORBIDDEN', 'NOT_FOUND'].includes(current?.error?.code)) {
      return selected ? <p id={'comment-' + selected} tabIndex={-1} data-comment-unavailable="" role="status">这条留言暂不可用。</p> : null;
    }
    return <section className="discussion" aria-busy={!current}>
      <h2>队内讨论</h2>
      {current?.error ? <p role="alert">{current.error.message} <button type="button" onClick={() => reload()}>重试</button></p>
        : <p role="status">正在读取留言…</p>}
    </section>;
  }
  // A newly readable publication or membership gets a new composer, including a new idempotency key.
  const epoch = current?.expected;
  return <DiscussionThread key={epoch ? epoch.expectedDiscussionEpoch + ':' + epoch.expectedMembershipEpoch : 'material'}
    item={item} sources={sources} view={current} reload={reload} selected={selected} mediaKey={mediaKey} {...media} />;
}

function DiscussionThread({ item, sources, view, reload, selected, mediaKey, measure, capture, play }) {
  const duration = measure?.duration;
  const { db, ctx, notify } = useData();
  const people = useRoster();
  const reader = isReaderDiscussion(item.kind);
  const readOnly = item.kind === 'training' && item.status !== 'published';
  const catalogReady = !!view, sharesError = view?.error?.message;
  const comments = view?.rows ?? [];
  const [replyId, selectReply] = useState(null);
  const reply=comments.find(c=>c.id===replyId && c.status==='active');
  const destination = reply?.source ?? sources[0];
  const canReference = destination.kind !== 'training' && Boolean(mediaKey);
  function setReply(row) {
    selectReply(row?.id ?? null);
    if (row?.source.kind === 'training') {
      setReferenceDraft(null);
      setTimeError('');
      setInspectTime(false);
    }
  }
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const removingNow = useRef(false);
  const cancelDelete = useRef(null);
  const heading = useRef(null);
  const input = useRef(null);
  const timeInput = useRef(null);
  const [referenceDraft, setReferenceDraft] = useState(null);
  const [timeError, setTimeError] = useState('');
  const [inspectTime, setInspectTime] = useState(false);
  const reference = canReference && referenceDraft?.media === mediaKey ? referenceDraft : null;
  const times = reference?.seconds ?? [];
  const timeText = reference?.input ?? null;
  const hasTime = !!timeText?.trim();
  const draftError = hasTime ? referenceTimeError(timeText, duration, times) : '';
  const fieldError = timeError || (hasTime && !inspectTime
    ? referenceTimeError(timeText, duration, times, false) : draftError);
  function changeReference(seconds, value) {
    setReferenceDraft({ media: mediaKey, seconds, input: value });
    setTimeError('');
    setInspectTime(false);
  }
  function requestedTimes(requireTime = false) {
    if (!times.length && !requireTime && !timeText?.trim()) return [];
    if (!duration) {
      setTimeError('请先读到视频片长，再插入或发送时间。');
      timeInput.current?.focus();
      return null;
    }
    const invalid = times.find((second) => !isReferenceSecond(second, duration));
    if (invalid !== undefined) {
      setTimeError('引用的 ' + timeLabel(invalid) + ' 已超出片长，请移除后再发送。');
      return null;
    }
    if (!timeText?.trim() && !requireTime) return times;
    if (times.length >= maxTimepoints) {
      setTimeError('每条发言最多可引用 ' + maxTimepoints + ' 个时间。');
      return null;
    }
    const message = referenceTimeError(timeText ?? '', duration, times);
    if (message) {
      setTimeError(message);
      timeInput.current?.focus();
      return null;
    }
    return [...times, parseTimeLabel(timeText)];
  }
  function insertTime() {
    const seconds = requestedTimes(true);
    if (seconds) {
      changeReference(seconds, null);
      input.current?.focus();
    }
  }
  const pending = useRef(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const threads = new Map();
  for (const c of comments) {
    const id = c.root || c.id;
    if (!threads.has(id)) threads.set(id, { id, root: null, replies: [] });
    const thread = threads.get(id);
    if (c.root) thread.replies.push(c);
    else thread.root = c;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function personFor(id, savedName) {
    if (id === 'me') return db.profile;
    const member = people.find((p) => p.id === id);
    return { avatarUrl:member?.avatarUrl, name: savedName || member?.name || '队友', tone: member?.tone || 'sage' };
  }
  async function add(e) {
    e.preventDefault();
    const body = text.trim();
    if (inFlight.current || !catalogReady || sharesError || readOnly || (replyId && !reply)) return;
    const seconds = requestedTimes();
    if (!seconds || (!body && !seconds.length)) return;
    const root = reply ? reply.root || reply.id : null;
    const payload={text:body,...view.expected,...(root && {rootId:root,replyToId:reply.id}),
      ...(seconds.length && {timestampSec:seconds[0],referenceTimes:seconds,...(destination.kind === 'post' && {mediaUrl:item.video?.url || mediaKey})})};
    const signature=JSON.stringify([destination.write,payload]);
    if (pending.current?.signature!==signature) pending.current={id:uid(),signature};
    inFlight.current=true;
    setError(''); setSending(true);
    try {
      await ctx.write(destination.write,'POST',payload,pending.current.id);
      reload();
      pending.current = null;
      if (mounted.current) {
        setReply(null);
        setText('');
        setReferenceDraft(null);
        setTimeError('');
      }
      notify(root ? '回复已发布' : '讨论已发布');
    } catch (err) {
      if (reader && ['FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'READ_ONLY'].includes(err.code)) {
        notify(err.message || '留言权限已变化，请重新确认。');
        reload(true);
        return;
      }
      const message = err.message || '讨论暂时无法发布，请重试。';
      if (mounted.current) setError(message);
      else notify(message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function confirmDelete() {
    if (!removing || removingNow.current) return;
    removingNow.current = true;
    setDeleting(true);
    setDeleteError('');
    try {
      await ctx.write(removing.source.write+'/'+removing.id,'PATCH',{action:'delete',expectedVersion:removing.version,...view.expected});
      reload();
      if (mounted.current) {
        setRemoving(null);
        requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
      }
      notify('评论已删除');
    } catch (err) {
      if (reader && ['FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'READ_ONLY'].includes(err.code)) {
        notify(err.message || '留言权限已变化，请重新确认。');
        reload(true);
        return;
      }
      const message = err.message || '删除失败，请重试。';
      if (mounted.current) setDeleteError(message);
      else notify(message);
    } finally {
      removingNow.current = false;
      if (mounted.current) setDeleting(false);
    }
  }
  function entry(c) {
    const author = personFor(c.author, c.authorName);
    const target = c.root ? c.replyName || '队友' : '';
    return (
      <div
        id={'comment-' + c.id}
        tabIndex={-1}
        className={'comment' + (c.root ? ' reply' : '') + (selected === c.id ? ' targeted' : '')}
        key={c.id}
      >
        <Avatar person={author} />
        <div>
          <div className="comment-meta">
            <div className="comment-byline">
              <strong>{author.name}</strong>
              <time dateTime={c.at}>{shortDate(c.at)}</time>
            </div>
            {c.videoRefs?.seconds?.length > 0 && (
              <div className="comment-cues" role="group" aria-label="这条发言引用的时间">
                {c.videoRefs.media !== mediaKey && <span className="cue-caption">原视频</span>}
                {c.videoRefs.seconds.map((at) => c.videoRefs.media === mediaKey
                  && (duration ? isReferenceSecond(at, duration) : Number.isSafeInteger(at) && at >= 0) ? (
                  <button className="cue-link" type="button" key={at} onClick={(e) => play(at, e.currentTarget, c.videoRefs.duration)}
                    aria-label={'播放引用片段 ' + timeLabel(at)}>
                    <Play size={14} aria-hidden="true" />{timeLabel(at)}
                  </button>
                ) : <span className="cue-unavailable" key={at}>{timeLabel(at)}</span>)}
              </div>
            )}
          </div>
          {(target || c.text) && <p>
            {target && <span className="reply-target">回复 {target} · </span>}
            {c.text && <TextLinks text={c.text}/>}
          </p>}
          <div className="comment-actions">
            <button
              type="button"
              className="reply-button"
              disabled={sending || readOnly || c.status!=='active' || (!reader && c.root && threads.get(c.root)?.root?.status!=='active')}
              onClick={() => {
                setReply(c);
                input.current?.focus();
              }}
            >
              回复
            </button>
            {c.author === 'me' && c.status!=='deleted' && !readOnly && (
              <button
                type="button"
                className="reply-button delete-comment"
                aria-label="删除评论"
                disabled={sending}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setDeleteError('');
                  setRemoving(c);
                }}
              >
                删除
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <section className="discussion" aria-labelledby="discussion-heading">
      <div className="heading-line">
        <h2 id="discussion-heading" ref={heading} tabIndex={-1}>队内讨论</h2>
        <span className="count">{comments.length}</span>
      </div>
      {sharesError && <p role="alert">{sharesError} <button onClick={() => reload()}>重试</button></p>}
      {selected && catalogReady && !sharesError && !threads.has(selected) && !comments.some((c) => c.id === selected) && (
        <p id={'comment-' + selected} data-comment-unavailable="" tabIndex={-1} role="status" className="removed-comment">
          这条评论已删除或暂不可用。
        </p>
      )}
      {threads.size ? (
        [...threads.values()].map(({ id, root, replies }) => (
          <div className="thread" key={id}>
            {root ? entry(root) : (
              <p className="removed-comment" id={'comment-' + id} tabIndex={-1}>原评论已删除</p>
            )}
            {replies.map(entry)}
          </div>
        ))
      ) : (
        <p className="quiet-box">{reader ? '还没有留言。' : '还没有讨论。可以记下观察到的动作，和队友聊聊。'}</p>
      )}
      <form onSubmit={add} className="comment-form" aria-busy={sending}>
        {replyId && !reply && <p role="status">原评论已不可回复。<button type="button" onClick={()=>setReply(null)}>取消回复</button></p>}
        {reply && (
          <div className="reply-banner">
            <CornerDownRight size={14} />
            回复 {personFor(reply.author, reply.authorName).name}
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                setReply(null);
                input.current?.focus();
              }}
            >
              取消回复
            </button>
          </div>
        )}
        <label htmlFor="comment-text" className="sr">
          {reply ? '回复内容' : '讨论内容'}
        </label>
        <div className="discussion-composer">
          <textarea
            id="comment-text"
            ref={input}
            rows={timeText !== null && !text ? 1 : 2}
            maxLength={1000}
            readOnly={sending}
            aria-describedby={error ? 'discussion-error' : undefined}
            placeholder={reply ? '写下回复…' : item.kind === 'reflection' ? '聊聊这篇复盘…'
              : item.kind === 'announcement' ? '关于这条公告，你想说什么？' : '说说你观察到的细节…'}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError('');
            }}
          />
          {times.length > 0 && (
            <div className="draft-cues" aria-label="待发送的时间引用">
              {times.map((at) => (
                <button type="button" className="cue-token" key={at} disabled={sending}
                  aria-label={'移除引用 ' + timeLabel(at)} onClick={() => {
                    changeReference(times.filter((second) => second !== at), timeText);
                    input.current?.focus();
                  }}>
                  <Clock3 size={15} aria-hidden="true" />{timeLabel(at)}<X size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {timeText !== null && <ReferenceTime value={timeText} input={timeInput} measure={measure}
            capture={capture} disabled={sending} canInsert={hasTime && duration > 0 && !draftError && times.length < maxTimepoints}
            error={fieldError} inspect={() => setInspectTime(true)}
            change={(value) => changeReference(times, value)} insert={insertTime}
            close={() => { changeReference(times, null); input.current?.focus(); }} />}
          {reference && timeText === null && timeError && <p className="form-error" role="alert">{timeError}</p>}
          <div className="composer-tools">
          {canReference && <button type="button" className="reference-trigger" disabled={sending}
            aria-expanded={timeText !== null} aria-controls={timeText !== null ? 'discussion-time-fields' : undefined}
            onClick={() => {
              if (timeText !== null) { changeReference(times, null); input.current?.focus(); }
              else {
                measure.read();
                const at = capture?.();
                changeReference(times, at > 0 ? timeLabel(at) : '');
              }
            }}>
            <Clock3 size={17} aria-hidden="true" />{timeText !== null ? '收起时间' : '引用时间'}
          </button>}
          <button
            type="submit"
            aria-label={reply ? '发送回复' : '发送讨论'}
            title={reply ? '发送回复' : '发送讨论'}
            className="discussion-send btn primary"
            disabled={sending || readOnly || !catalogReady || !!sharesError || !!draftError || (!duration && (times.length > 0 || hasTime))
              || (!text.trim() && !times.length && !hasTime)}
          >
            <span>{sending ? '发送中' : '发送'}</span><Send size={16} aria-hidden="true" />
          </button>
          </div>
        </div>
        {error && (
          <p id="discussion-error" role="alert" className="form-error">
            {error}
          </p>
        )}
        {sending && (
          <span role="status" className="field-hint">
            正在发送…
          </span>
        )}
      </form>
      <Modal
        open={Boolean(removing)}
        title={removing?.root ? '删除这条回复？' : '删除这条评论？'}
        description={threads.get(removing?.id)?.replies.length ? '这条评论会被删除，已有回复会保留。' : '删除后无法恢复。'}
        onOpenChange={(open) => { if (!open && !removingNow.current) setRemoving(null); }}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelDelete.current?.focus(); }}
      >
        <blockquote className="comment-excerpt">{[removing?.text, removing?.videoRefs?.seconds.map(timeLabel).join('、')].filter(Boolean).join('　')}</blockquote>
        {deleteError && <p role="alert" className="form-error">{deleteError}</p>}
        <div className="form-buttons">
          <button className="btn" type="button" ref={cancelDelete} disabled={deleting} onClick={() => setRemoving(null)}>取消</button>
          <button className="btn danger-solid" type="button" disabled={deleting} onClick={confirmDelete}>
            {deleting ? '正在删除…' : '删除评论'}
          </button>
        </div>
      </Modal>
    </section>
  );
}
