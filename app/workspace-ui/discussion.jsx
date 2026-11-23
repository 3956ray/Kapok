import { TextLinks } from '../components/learning-text';
import { useEffect, useRef, useState } from 'react';
import { Clock3, CornerDownRight, Play, Send, X } from 'lucide-react';
import { useNav } from './router';
import { shortDate, uid, useData, useRoster } from './store';
import { Avatar, Modal } from './ui';

import { isReferenceSecond, maxTimepoints, parseTimeLabel, referenceTimeError, timeLabel } from './timepoints.js';
import { ReferenceTime } from './reference-time.jsx';

export default function Discussion(props) {
  const { params } = useNav();
  const [general,setGeneral]=useState(() => params.get('thread') === 'training');
  const multi=props.t.kind==='training' && !!props.t.selectedVideo;
  return <div>{multi && <div className="segments" aria-label="讨论范围">
    <button className="btn" aria-pressed={!general} onClick={()=>setGeneral(false)}>本视频讨论</button>
    <button className="btn" aria-pressed={general} onClick={()=>setGeneral(true)}>整场训练讨论</button>
  </div>}
  <DiscussionThread key={general?'training':'source'} {...props} general={general && multi} mediaKey={general && multi?null:props.mediaKey}/></div>;
}
function DiscussionThread({ t, mediaKey, measure, capture, play, general }) {
  const { duration } = measure;
  const { db, ctx, notify } = useData();
  const people = useRoster();
  const video=general?null:t.selectedVideo;
  const trainingThread=t.kind==='training' && !video;
  const readPath=trainingThread?'trainings/'+t.id+'/discussion':video?'page-read/video-discussion/'+video.id:'page-read/article-discussion/'+t.id+'?version='+t.publishedVersion;
  const writePath=trainingThread?readPath:video?'videos/'+video.id+'/comments':'learning/posts/'+t.id+'/comments';
  const [view,setView]=useState(null);
  const [refresh,setRefresh]=useState(0);
  const readOnly=t.kind==='training' && t.status!=='published';
  useEffect(()=>{
    const abort=new AbortController();
    ctx.read(readPath,abort.signal).then(result=>{
      const rows=(trainingThread?result:result.value).map(c=>{
        const author=c.authorId ?? c.author?.id;
        const seconds=c.referenceTimes ? JSON.parse(c.referenceTimes) : c.timestampSec!=null ? [c.timestampSec] : [];
        return {id:c.id,version:c.version,root:c.rootId,text:c.text ?? (c.status==='deleted'?'这条评论已删除。':'评论已隐藏。'),at:c.createdAt,status:c.status,
          author:author===ctx.account.user.id?'me':author,authorName:c.authorName ?? c.author?.discName,replyName:c.replyTargetName ?? c.replyTarget?.authorName,
          videoRefs:seconds.length && c.status==='active' ? {media:video || c.matchesCurrentMedia ? mediaKey : null,seconds} : undefined};
      });
      if (!abort.signal.aborted) setView({ctx,readPath,rows});
    }).catch(error=>{if (!abort.signal.aborted) setView({ctx,readPath,error:error.message});});
    return ()=>abort.abort();
  },[ctx,readPath,mediaKey,video,trainingThread,refresh]);
  const current=view?.ctx===ctx && view.readPath===readPath?view:null;
  const catalogReady=!!current,sharesError=current?.error;
  const comments=current?.rows ?? [];
  const { params } = useNav();
  const [replyId, selectReply] = useState(null);
  const reply=comments.find(c=>c.id===replyId && c.status==='active');
  const setReply=row=>selectReply(row?.id ?? null);
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
  const reference = mediaKey && referenceDraft?.media === mediaKey ? referenceDraft : null;
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
  const selected = params.get('comment');

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
    if (inFlight.current || (replyId && !reply)) return;
    const seconds = requestedTimes();
    if (!seconds || (!body && !seconds.length)) return;
    const root = reply ? reply.root || reply.id : null;
    const payload={text:body,...(root && {rootId:root,replyToId:reply.id}),
      ...(seconds.length && {timestampSec:seconds[0],referenceTimes:seconds,...(!video && {mediaUrl:t.video?.url || mediaKey})})};
    const signature=JSON.stringify(payload);
    if (pending.current?.signature!==signature) pending.current={id:uid(),signature};
    inFlight.current=true;
    setError(''); setSending(true);
    try {
      await ctx.write(writePath,'POST',payload,pending.current.id);
      setRefresh(n=>n+1);
      pending.current = null;
      if (mounted.current) {
        setReply(null);
        setText('');
        setReferenceDraft(null);
        setTimeError('');
      }
      notify(root ? '回复已发布' : '讨论已发布');
    } catch (err) {
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
      await ctx.write(writePath+'/'+removing.id,'PATCH',{action:'delete',expectedVersion:removing.version});
      setRefresh(n=>n+1);
      if (mounted.current) {
        setRemoving(null);
        requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
      }
      notify('评论已删除');
    } catch (err) {
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
    const target = c.root ? personFor(c.replyTo, c.replyName).name : '';
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
              disabled={sending || readOnly || c.status!=='active' || (c.root && threads.get(c.root)?.root?.status!=='active')}
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
      {sharesError && <p role="alert">{sharesError} <button onClick={()=>setRefresh(n=>n+1)}>重试</button></p>}
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
        <p className="quiet-box">还没有讨论。可以记下观察到的动作，和队友聊聊。</p>
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
            placeholder={reply ? '写下回复…' : '说说你观察到的细节…'}
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
          {mediaKey && <button type="button" className="reference-trigger" disabled={sending}
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
