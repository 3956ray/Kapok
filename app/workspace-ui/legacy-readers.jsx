import { DiscussionPanel } from './discussion-panel.jsx';
import { TextLinks } from '../components/learning-text';
import { useEffect, useRef, useState } from 'react';
import { DateMark } from './press';
import { useNav, useTitle } from './router';
import { useData } from './store';
import { Back } from './ui';

function useReader(path) {
  const { ctx } = useData();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    ctx.read(path, controller.signal).then(
      value => { if (!controller.signal.aborted) setResult({ value, path, ctx, attempt }); },
      error => { if (!controller.signal.aborted) setResult({ error, path, ctx, attempt }); },
    );
    return () => controller.abort();
  }, [ctx, path, attempt]);
  const current = result?.path === path && result.ctx === ctx && result.attempt === attempt;
  return { ...(current ? result : {}), retry: () => setAttempt(n => n + 1) };
}

function ReaderStatus({ error, retry, fallback, label }) {
  return <div className="page-width prose-page">
    <Back fallback={fallback} />
    {error ? <section className="reader-problem">
      <h1>{label}暂时无法打开</h1>
      <p role="alert">{error.message}</p>
      {retry && <button className="btn" type="button" onClick={retry}>重新读取</button>}
    </section> : <p className="pending-reader" role="status">正在读取{label}…</p>}
  </div>;
}

export function LegacyVideo({ id }) {
  const { value: video, error, retry } = useReader('videos/' + encodeURIComponent(id));
  const { params, go } = useNav();
  const seconds = params.get('t');
  const comment = params.get('comment');
  const visible = video?.status === 'active' && ['published', 'archived'].includes(video.training?.status);
  useEffect(() => {
    if (!visible) return;
    const search = new URLSearchParams({ video: id });
    if (seconds !== null && /^\d+$/.test(seconds) && Number.isSafeInteger(Number(seconds))) {
      search.set('t', String(Number(seconds)));
    }
    if (comment && /^[a-zA-Z0-9_-]{1,80}$/.test(comment)) search.set('comment', comment);
    go('/trainings/' + encodeURIComponent(video.trainingId) + '?' + search, { replace: true });
  }, [visible, video?.trainingId, id, seconds, comment, go]);
  const unavailable = video && !visible ? new Error('该视频目前不可观看。') : error;
  return <ReaderStatus label="视频" fallback="/trainings" error={unavailable} retry={retry} />;
}

export function AnnouncementReader({ id }) {
  const { value: article, error, retry } = useReader('announcements/' + encodeURIComponent(id));
  const { params } = useNav();
  const anchor = params.get('anchor');
  const body = useRef(null);
  useTitle(article?.title || '队伍公告');
  useEffect(() => {
    if (anchor === 'body' && article) {
      body.current?.focus({ preventScroll: true });
      body.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [anchor, article]);
  if (!article) return <ReaderStatus label="公告" fallback="/activity" error={error} retry={retry} />;
  return <div className="page-width prose-page">
    <Back fallback="/activity" />
    <article className="reader">
      <div className="reader-meta">
        <span><DateMark value={article.updatedAt} /></span>
        <span>队伍公告<small>{article.status === 'published' ? '全队可读' : '管理员草稿'}</small></span>
      </div>
      <h1>{article.title}</h1>
      <div id="body" ref={body} tabIndex={-1} className="note-prose">
        <p><TextLinks text={article.text}/></p>
      </div>
    </article>
    {article.status === 'published' && <DiscussionPanel kind="announcement" id={article.id} />}
  </div>;
}
