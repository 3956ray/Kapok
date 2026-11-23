import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Clapperboard,
  CornerDownRight,
  ExternalLink,
  Share2,
  Undo2,
  EyeOff,
  BookOpen,
  ChevronDown,
  Clock3,
  FileImage,
  ImagePlus,
  Link2,
  Pencil,
  Upload,
  Video,
  X,
  Play,
} from 'lucide-react';
import { NavLink, useNav, useTitle } from './router';
import { canEditMaterial, clock, day, eventTime, kindName, uid, useData } from './store';
import { LearningText } from '../components/learning-text';
import { loadMaterial, saveMaterial, selectVideo, attachClip } from './materials.js';
import { Back, IconButton, Modal, PageHead, WriteNoteIcon } from './ui';
import { DeleteMaterial, SavedButton } from './library';
import { linkedTime, parseVideo } from './video-source';
import { chapterDraft, chaptersFromDraft, playbackPoints, timeLabel } from './timepoints.js';
import { ChapterFields, ChapterList, useVideoPlayback } from './timepoint-controls.jsx';
import { useReferenceMedia, YouTubeFrame } from './reference-media.jsx';



import { CategoryField } from './category-field.jsx';
import { noteCategoryLabel } from './categories.js';
import { AddToCollection } from './collection-actions.jsx';


const Discussion = lazy(() => import('./discussion.jsx'));

export function Missing({ label = '页面' }) {
  useTitle('找不到' + label);
  return (
    <div className="page-width">
      <Back />
      <PageHead title={'找不到这条' + label} description="可以从训练室重新查找，或向分享者确认链接。" />
      <NavLink to="/trainings" className="btn primary">
        回到训练室
      </NavLink>
    </div>
  );
}
function RelatedNotes({ trainingId }) {
  const { allNotes } = useData();
  const [expanded, setExpanded] = useState(false);
  const notes = allNotes
    .filter((n) => n.training === trainingId && (n.ownerId === 'me' || n.scope === 'team'))
    .sort((a, b) => eventTime(b.created) - eventTime(a.created));
  return (
    <section className="training-notes" aria-labelledby="training-notes-title">
      <div className="heading-line">
        <h2 id="training-notes-title">关联复盘</h2>
        <span className="count">{notes.length}</span>
      </div>
      {notes.length === 0 ? (
        <p className="notes-empty">
          这条内容还没有复盘。
          <NavLink to={'/notes/new?training=' + trainingId}>
            <WriteNoteIcon size={15} aria-hidden="true" />写第一篇
          </NavLink>
        </p>
      ) : (
        <ul id="training-note-list">
          {(expanded ? notes : notes.slice(0, 4)).map((n) => (
            <li key={n.id}>
              <div>
                <span className="related-byline">
                  {noteCategoryLabel(n)} · {n.author} · {n.scope === 'team' ? '队内可读' : '仅自己可见'}
                </span>
                <NavLink className="related-note-title" to={'/notes/' + n.id}>
                  {n.title}
                </NavLink>
              </div>
              {n.ownerId === 'me' && (
                <NavLink
                  className="icon-button"
                  aria-label={'编辑复盘：' + n.title}
                  title="编辑复盘"
                  to={'/notes/' + n.id + '/edit'}
                >
                  <Pencil size={16} />
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 4 && (
        <button
          type="button"
          className="text-link"
          aria-expanded={expanded}
          aria-controls="training-note-list"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起复盘' : '查看全部 ' + notes.length + ' 篇'}
        </button>
      )}
    </section>
  );
}

function MaterialStory({ t, photoDestination }) {
  const photos = t.photos?.filter((p) => p.url) ?? [];
  if (!t.body && !photos.length) return null;
  return (
    <div className="material-story">
      {t.body && (
        <div className="material-prose">
          {t.body.split(/\n\s*\n/).map((p, i) => (
            <LearningText key={i} text={p}/>
          ))}
        </div>
      )}
      {photos.length > 0 && (
        <div className={'material-photos' + (photos.length === 1 ? ' single' : '')}>
          {photos.map((photo, i) => (
            <figure key={photo.url + i}>
              <img
                src={photo.url}
                alt={photo.alt || t.title + '的配图 ' + (i + 1)}
                data-photo-destination={photoDestination && i === 0 ? t.id : undefined}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
              />
              {photo.alt && <figcaption>{photo.alt}</figcaption>}
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function ContentLink({ id,videoId }) {
  const { notify } = useData();
  const [manual, setManual] = useState(false);
  const input = useRef(null);
  const url = new URL('/home', location.origin);
  url.hash = '/trainings/' + id+(videoId?'?video='+encodeURIComponent(videoId):'');
  useEffect(() => {
    if (manual) {
      input.current?.focus();
      input.current?.select();
    }
  }, [manual]);
  return (
    <div className="content-link">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url.href);
            setManual(false);
            notify('内容链接已复制');
          } catch {
            setManual(true);
          }
        }}
      >
        <Link2 size={15} />
        复制内容链接
      </button>
      {manual && (
        <input
          ref={input}
          aria-label="可复制的内容链接"
          readOnly
          value={url.href}
          onFocus={(e) => e.target.select()}
        />
      )}
    </div>
  );
}

function WatchChapters({ item, playback, duration, capture, saved }) {
  const { ctx, notify } = useData();
  const [rows, setRows] = useState(null);
  const [issue, setIssue] = useState(null);
  const [saving, setSaving] = useState(false);
  const form = useRef(null);
  const trigger = useRef(null);
  const busy = useRef(false);
  const baseline = useRef('');
  const points = playbackPoints(item);
  function close() {
    setRows(null);
    setIssue(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  async function save(event) {
    event.preventDefault();
    if (busy.current) return;
    if (JSON.stringify(points) !== baseline.current) {
      setIssue({ message: '章节刚刚有更新。取消后重新打开，即可编辑最新目录。' });
      return;
    }
    try {
      const timepoints = chaptersFromDraft(rows, duration);
      if (JSON.stringify(timepoints) !== baseline.current) {
        busy.current = true;
        setSaving(true);
        const media = item.source?.url || item.videoAsset;
        const extra = { ...item.extra, chapters: { ...item.extra?.chapters, [media]: timepoints } };
        if (item.kind === 'training') {
          await ctx.write('trainings/'+item.id,'PATCH',{title:item.title,description:item.summary,date:item.date,status:item.status,expectedVersion:item.version,workspaceDetails:extra});
        } else {
          const draft = await loadMaterial(ctx,item,ctx.signal,true);
          if (draft.version !== item.publishedVersion) throw Error('资料已有未发布修改，请在编辑页编排章节后发布。');
          await saveMaterial(ctx,draft,{...draft,source:item.source,timepoints},ctx.signal,{key:uid()});
        }
        saved();
      }
      close();
      notify('章节已保存');
    } catch (e) {
      setIssue({ message: e.message || '暂时无法保存章节，请重试。', input: e.input });
      requestAnimationFrame(() => form.current?.elements.namedItem(e.input)?.focus());
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  if (rows !== null && canEditMaterial(item)) return (
    <form className="watch-chapter-editor" ref={form} onSubmit={save} aria-label="编排章节" aria-busy={saving}>
      <ChapterFields rows={rows} onChange={(next) => { setRows(next); setIssue(null); }}
        currentTime={capture} duration={duration} issue={issue} saving={saving} onCancel={close} />
    </form>
  );
  return <ChapterList points={points} playback={playback} action={canEditMaterial(item) && (
    <button type="button" className="chapter-tool" ref={trigger} onClick={() => {
      baseline.current = JSON.stringify(points);
      setRows(chapterDraft(points));
      requestAnimationFrame(() => form.current?.elements.namedItem('point-time-0')?.focus({ preventScroll: true }));
    }}>
      <Pencil size={15} />{points.length ? '编辑章节' : '添加章节'}
    </button>
  )} />;
}

function LearningActions({ item, reload }) {
  const {ctx,notify}=useData();
  const {go}=useNav();
  const [confirm,setConfirm]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const request=useRef(null);
  const lock=useRef(false);
  const shared=Boolean(item.activity?.event);
  const shareLabel=shared?'撤回队内动态':'分享到队内动态';
  async function change(hide) {
    if (lock.current) return;
    lock.current=true;
    setBusy(true);
    setError('');
    const path='learning/posts/'+item.id+(hide?'/hide':'/activity');
    const method=hide || !shared ? 'POST':'DELETE';
    const payload=hide ? {expectedVersion:item.publishedVersion} : {
      expectedPublishedVersion:item.publishedVersion,expectedMembershipEpoch:ctx.account.membership.epoch,expectedEventId:item.activity.lastEventId,
    };
    const signature=JSON.stringify([path,method,payload]);
    if (request.current?.signature!==signature) request.current={signature,key:uid()};
    try {
      await ctx.write(path,method,payload,request.current.key);
      request.current=null;
      if (hide) {
        setConfirm(false); go('/trainings',{replace:true});
        await ctx.refresh();
      } else { reload(); }
      notify(hide?'内容已隐藏':shared?'已撤回队内动态':'已分享到队内动态');
    } catch(e){setError(e.message);}
    finally {lock.current=false;setBusy(false);}
  }
  return <>
    {item.activity && <IconButton label={shareLabel} icon={shared?Undo2:Share2} disabled={busy} onClick={()=>change(false)} />}
    {ctx.account.membership.role==='admin' && <IconButton label="隐藏内容" icon={EyeOff} disabled={busy} onClick={()=>setConfirm(true)} />}
    {error && !confirm && <span role="alert">{error}</span>}
    <Modal open={confirm} onOpenChange={value=>{if(!busy)setConfirm(value);}} title="隐藏这份资料？" description="隐藏后队员将无法查看，作者也无法重新发布。">
      {error && <p role="alert">{error}</p>}
      <div className="form-buttons"><button type="button" className="btn" disabled={busy} onClick={()=>setConfirm(false)}>取消</button>
        <button type="button" className="btn danger-solid" disabled={busy} onClick={()=>change(true)}>确认隐藏</button></div>
    </Modal>
  </>;
}

function MaterialLoader({ item, edit, children }) {
  const { ctx } = useData();
  const { params } = useNav();
  const [round,setRound] = useState(0);
  const [result,setResult] = useState(null);
  const reload = () => setRound(n=>n+1);
  useEffect(() => {
    const controller = new AbortController();
    loadMaterial(ctx,item,controller.signal,edit)
      .then(value => {if (!controller.signal.aborted) setResult({value,item,ctx,round});})
      .catch(error => {if (!controller.signal.aborted) setResult({error,item,ctx,round});});
    return () => controller.abort();
  },[ctx,item,edit,round]);
  if (result?.item!==item || result.ctx!==ctx || result.round!==round) return <p className="page-width" role="status">正在读取内容…</p>;
  if (result.error) return <section className="page-width"><p role="alert">{result.error.message}</p><button onClick={reload}>重新读取</button></section>;
  const videoId=params.get('video');
  if (videoId && !result.value.videos?.some(v=>v.id===videoId)) return <Missing label="视频" />;
  const selected = selectVideo(result.value,videoId);
  return children(selected,reload);
}
export function TrainingDetail({ t }) {
  const {params}=useNav();
  return <MaterialLoader item={t}>{(item,reload)=><TrainingReader key={[item.id,item.selectedVideo?.id,params.get('t')].join(':')} t={item} reload={reload}/>}</MaterialLoader>;
}
function TrainingReader({ t,reload }) {
  const { go,params } = useNav();
  const rawTime=params.get('t');
  const start=rawTime && /^\d+$/.test(rawTime) && Number(rawTime)<=359999 && (!t.duration || Number(rawTime)<=t.duration) ? Number(rawTime) : null;
  useTitle(t.title);
  const label = kindName[t.kind] ?? '训练';
  const sourceLabel =
    t.source?.platform === 'B 站' ? '在 B 站打开（新标签）' : '在 YouTube 打开（新标签）';
  const {stage:attachStage,native,play,capture:readTime,reloadNative,focusStage,started,error,playhead,
    nativeSrc,duration:playerDuration,embedKey,embed,original}=useVideoPlayback(t.source,start);
  const [readingFrom, setReadingFrom] = useState(null);
  const external = Boolean(t.source?.embed);
  const local = t.videoAsset || '';
  const mediaKey = t.source?.url || local;
  const nativeDuration = local && nativeSrc === local ? playerDuration : 0;
  const measure = useReferenceMedia(mediaKey, t.source, nativeDuration || t.duration, reloadNative);
  const capture = nativeDuration > 0 ? readTime : null;
  const youtube = t.source?.platform === 'YouTube';
  const showPlayer = started || (youtube && measure.attempt > 0);
  const cover = t.photos?.[0]?.url || t.platformCover || '';
  const editable = canEditMaterial(t);

  function playCitation(at, origin, savedDuration) {
    setReadingFrom({ at, origin, mediaKey });
    focusStage();
    play(at, measure.duration || savedDuration);
  }
  function returnToDiscussion() {
    const target = readingFrom.origin.isConnected ? readingFrom.origin : document.getElementById('discussion-heading');
    setReadingFrom(null);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  return (
    <div className="page-width detail-page">
      <div className="detail-toolbar">
        <Back />
        <div className="detail-management">{editable && (
          <><IconButton
            label={'编辑' + label}
            icon={Pencil}
            onClick={() => go('/trainings/' + t.id + '/edit'+(t.selectedVideo ? '?video='+encodeURIComponent(t.selectedVideo.id) : ''))}
          />
          <DeleteMaterial item={t} /></>
        )}
        {t.kind!=='training' && !t.isDraft && <LearningActions item={t} reload={reload}/>}</div>
      </div>
      {t.videos?.length>1 && <nav className="segments" aria-label="选择视频">{t.videos.map(v=><NavLink className="btn" key={v.id} aria-current={v.id===t.selectedVideo?.id ? 'page' : undefined} to={'/trainings/'+t.id+'?video='+v.id}>{v.title}</NavLink>)}</nav>}
      {(local || external) && (
        <section ref={attachStage} tabIndex={-1} data-photo-destination={t.id} className="player-stage" aria-label="训练播放器">
          {local && (
            <video
              {...native}
              controls={Boolean(t.videoAsset) || started}
              playsInline
              preload="metadata"
              poster={cover || undefined}
              src={local}
            >
            </video>
          )}
          {youtube && showPlayer && <YouTubeFrame
            key={mediaKey + ':' + embedKey + ':' + Math.max(0, measure.attempt - 1)}
            title={t.title + ' · YouTube 播放器'} src={embed} report={measure.report} failed={measure.failed} />}
          {external && !youtube && started && (
            <iframe
              title={t.title + ' · ' + t.source.platform + ' 播放器'}
              key={embedKey}
              src={embed}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          )}
          {!showPlayer && !t.videoAsset && (
            <div
              className="player-cover"
              style={cover ? { backgroundImage: 'url("' + cover + '")' } : undefined}
            >
              <div className="player-cover-top">
                <Clapperboard size={15} />
                {external ? t.source.platform : '战术演示'}
              </div>
              <button
                type="button"
                className="player-activate"
                onClick={() => play(start,measure.duration)}
                aria-label={(external ? '载入视频：' : '播放训练：') + t.title}
              >
                <span>
                  <Play size={27} fill="currentColor" />
                </span>
                {external ? '载入' + t.source.platform + '视频' : '播放训练'}
              </button>
            </div>
          )}
        </section>
      )}
      {readingFrom && readingFrom.mediaKey === mediaKey && (
        <div className="citation-return">
          <span><Clock3 size={16} aria-hidden="true" />讨论引用 {timeLabel(readingFrom.at)}</span>
          <button type="button" onClick={returnToDiscussion}>返回这条发言 <CornerDownRight size={16} /></button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="detail-head">
        <div>
          <span className={'category cat-' + t.category}>
            <i />
            {t.category} · {t.format || label}
          </span>
          <h1 data-photo-destination={!local && !external && !t.photos?.length ? t.id : undefined}>
            {t.title}
          </h1>
          <div className="details-meta">
            <time dateTime={t.date}>{t.date}</time>
            <span>·</span>
            {t.author}
          </div>
        </div>
        <div className="icon-actions material-actions">
          {external && (
            <a
              className="icon-button"
              href={original}
              target="_blank"
              rel="noopener noreferrer"
              title={sourceLabel}
              aria-label={sourceLabel}
            >
              <ExternalLink size={18} />
            </a>
          )}
          <SavedButton id={t.id} kind={t.kind} />
          <IconButton
            label="写复盘"
            icon={WriteNoteIcon}
            onClick={() => go('/notes/new?training=' + t.id)}
          />
          <AddToCollection id={t.id} />
        </div>
      </div>
      {t.summary && <div className="detail-summary"><LearningText text={t.summary}/></div>}
      <MaterialStory t={t} photoDestination={!local && !external} />
      {t.published && <ContentLink id={t.id} videoId={t.selectedVideo?.id} />}
      <div className="detail-columns material-columns">
        <aside className="training-margins">
          {(local || external) && <WatchChapters saved={reload} key={mediaKey} item={t} playback={{started,play,playhead}} duration={measure.duration} capture={capture} />}
          <RelatedNotes trainingId={t.id} />
        </aside>
        <Suspense fallback={<section className="discussion" aria-busy="true"><h2>队内讨论</h2></section>}>
          {(t.kind==='training' ? ['published','archived'].includes(t.status) : !t.isDraft) ? <Discussion t={t} mediaKey={mediaKey} measure={measure} capture={capture} play={playCitation} /> : <section className="discussion"><h2>队内讨论</h2><p>资料发布后可参与讨论。</p></section>}
        </Suspense>
      </div>
    </div>
  );
}

const kindChoices = [
  { id: 'training', icon: Clapperboard },
  { id: 'article', icon: BookOpen },
  { id: 'video', icon: Video },
];
const fileTypes = {
  photo: { list: 'image/jpeg,image/png,image/webp', limit: 2 },
  video: { list: 'video/mp4,video/webm', limit: 64 },
};
function fileIssue(file, type) {
  const allow = fileTypes[type];
  const maxMiB=type==='video' && file.type==='video/mp4' ? 100 : allow.limit;
  const extensions = type === 'photo' ? /\.(jpe?g|png|webp)$/i : /\.(mp4|webm)$/i;
  if (file.type ? !allow.list.split(',').includes(file.type) : !extensions.test(file.name)) {
    return type === 'photo' ? '请选择 JPEG、PNG 或 WebP 图片。' : '请选择 MP4 或 WebM 视频。';
  }
  if (file.size > maxMiB * 1024 * 1024) return '单个文件不能超过 ' + maxMiB + ' MB。';
  if (!file.size) return '这个文件是空的，请重新选择。';
  return '';
}

function PhotoFields({ photos, choose, remove, describe, issue, linkedVideo }) {
  return (
    <div className="photo-fields">
      <div className="file-heading">
        <span>
          照片<span className="label-lite">选填</span>
        </span>
        {photos.length > 0 && <small>{photos.length} 张</small>}
      </div>
      {linkedVideo && <p className="field-hint">默认使用视频原封面。上传照片后，第一张将作为封面。</p>}
      {photos.length > 0 && (
        <ul className="photo-proof-list">
          {photos.map((p, i) => (
            <li key={p.key}>
              <img decoding="async" src={p.url} alt={'第 ' + (i + 1) + ' 张照片预览'} />
              <div>
                <label htmlFor={'photo-description-' + p.key}>照片说明 {i + 1}</label>
                <input
                  type="text"
                  id={'photo-description-' + p.key}
                  maxLength={240}
                  value={p.alt}
                  onChange={(e) => describe(p.key, e.target.value)}
                  placeholder="可写下画面中的发现"
                />
              </div>
              <IconButton label={'移除照片 ' + (i + 1)} icon={X} onClick={() => remove(p.key)} />
            </li>
          ))}
        </ul>
      )}
      <div className="file-choose-row">
        <label className="media-chooser">
          <ImagePlus size={16} />
          选择照片
          <input
            type="file"
            name="photos"
            aria-label="选择照片"
            multiple
            accept={fileTypes.photo.list}
            onChange={(e) => {
              choose(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
            aria-describedby={issue ? 'photo-error' : 'photo-hint'}
          />
        </label>
        <p id="photo-hint" className="field-hint">
          JPEG、PNG 或 WebP · 每张 2 MB 以内
        </p>
      </div>
      {issue && (
        <p id="photo-error" role="alert" className="form-error">
          {issue}
        </p>
      )}
    </div>
  );
}

function FieldIssue({ issue, name }) {
  return issue?.field === name ? (
    <p role="alert" className="form-error" id={'issue-' + name}>
      {issue.message}
    </p>
  ) : null;
}

export function TrainingForm({ t }) {
  if (t) return <MaterialLoader item={t} edit>{item=><MaterialEditor t={item}/>}</MaterialLoader>;
  return <MaterialEditor />;
}
function MaterialEditor({ t }) {
  const { go, back, params } = useNav();
  const { ctx, notify, categoryNames, addCategory } = useData();
  const edit = Boolean(t);
  const initial=t;
  const admin = ctx.account.membership.role==='admin';
  const initialKind=params.get('kind');
  const [kind,setKind]=useState(t?.kind ?? (['article','video'].includes(initialKind)?initialKind:admin?'training':'article'));
  const label = kindName[kind];
  const formTitle = (edit ? '编辑' : '新建') + label;
  useTitle(formTitle);
  const returnParam = params.get('returnTo') ?? '';
  const returnTo = /^\/collections\/(?:new|[a-zA-Z0-9_-]+\/edit)$/.test(returnParam)
    ? returnParam
    : null;
  const fallback = returnTo ?? (edit ? '/trainings/' + t.id : '/trainings');
  const titleLabel = kind === 'training' ? '训练名称' : label + '标题';
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? day());
  const [category, setCategory] = useState(
    initial?.category ??
      (categoryNames.includes(params.get('category')) ? params.get('category') : categoryNames.find(v=>v==='战术') || categoryNames[0]),
  );
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [photos, setPhotos] = useState(() =>
    (initial?.photos ?? []).filter((p) => p.url).map((p) => ({ ...p, key: uid() })),
  );
  const [videoMode, setVideoMode] = useState(initial?.videoAsset ? 'file' : 'link');
  const [link, setLink] = useState(initial?.source?.url ?? '');
  const [clip, setClip] = useState(
    initial?.videoAsset ? { url: initial.videoAsset, name: '已上传的视频' } : null,
  );
  const [keepFilm, setKeepFilm] = useState(
    Boolean(initial?.duration && !initial.source && !initial.videoAsset),
  );
  const clipPreview = useRef(null);
  const [clipInfo, setClipInfo] = useState(null);
  const [pointDrafts, setPointDrafts] = useState(() => {
    const key = initial?.source?.url || initial?.videoAsset || 'builtin';
    return { [key]: chapterDraft(playbackPoints(initial)) };
  });
  const [more, setMore] = useState(Boolean(initial?.body || initial?.photos?.length));
  const [issue, setIssue] = useState(null);
  const [progress, setProgress] = useState('');
  const form = useRef(null);
  const request = useRef(null);
  const mounted = useRef(false);
  const [publishing,setPublishing]=useState(false);
  const previews = useRef(new Set());
  const attempted=useRef(null);
  useLayoutEffect(() => {
    if (!progress && issue?.input) form.current?.elements.namedItem(issue.input)?.focus();
  }, [issue, progress]);
  useEffect(() => {
    const urls = previews.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  function preview(file) {
    const url = URL.createObjectURL(file);
    previews.current.add(url);
    return url;
  }
  function release(url) {
    if (previews.current.delete(url)) URL.revokeObjectURL(url);
  }
  function clearIssue(field) {
    setIssue((s) => (s?.field === field ? null : s));
  }
  function choosePhotos(files) {
    if (!files.length) return;
    const invalid = files.map((file) => fileIssue(file, 'photo')).find(Boolean);
    if (invalid || photos.length + files.length > 6) {
      setIssue({ field: 'photos', message: invalid || '一次发布最多可收录 6 张照片。' });
      return;
    }
    const additions = files.map((file) => ({ key: uid(), file, url: preview(file), alt: '' }));
    setPhotos((list) => [...list, ...additions]);
    setIssue(null);
  }
  function chooseClip(file) {
    if (!file) return;
    const invalid = fileIssue(file, 'video');
    if (invalid) {
      setIssue({ field: 'clip', message: invalid });
      return;
    }
    if (clip) release(clip.url);
    setClip({ file, url: preview(file), name: file.name });
    setIssue(null);
  }
  function fail(field, message) {
    if (field === 'photos' || field === 'body') setMore(true);
    if (field === 'link') setVideoMode('link');
    if (field === 'clip') setVideoMode('file');
    setIssue({ field, message, input: field });
  }
  const hasLink = kind !== 'article' && Boolean(link.trim());
  const hasFile = kind !== 'article' && Boolean(clip);
  const usingLink = hasLink && (videoMode === 'link' || !hasFile);
  const usingFile = hasFile && (videoMode === 'file' || !hasLink);
  const otherSource = (usingLink && videoMode === 'file') || (usingFile && videoMode === 'link');
  let pointKey = usingFile ? clip.url : keepFilm ? 'builtin' : '';
  if (usingLink) {
    try {
      pointKey = parseVideo(link)?.url || '';
    } catch {
      pointKey = '';
    }
  }
  const pointRows = pointDrafts[pointKey] || [];
  const duration = usingFile && clipInfo?.url === clip.url ? clipInfo.duration
    : pointKey === 'builtin' ? initial?.duration : 0;
  async function save(e) {
    e.preventDefault();
    if (request.current || progress) return;
    if (!title.trim()) return fail('title', '请填写' + titleLabel + '。');
    if (kind === 'article' && !body.trim() && !photos.length) {
      return fail('body', '请填写图文正文或添加照片。');
    }
    if (kind === 'video' && !hasLink && !hasFile && !keepFilm) {
      return fail(videoMode === 'file' ? 'clip' : 'link', '请填写观看链接或选择视频文件。');
    }
    let timepoints;
    try {
      if (kind !== 'article' && pointKey) timepoints = chaptersFromDraft(pointRows, duration);
    } catch (err) {
      setIssue({ field: 'timepoints', message: err.message, input: err.input });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setIssue(null);
    setProgress('正在保存…');
    try {
      let source = usingLink ? parseVideo(link) : null;
      if (source?.platform === 'short') {
        const resolved = await ctx.read('media/bilibili-link?url='+encodeURIComponent(source.url),controller.signal);
        source = parseVideo(resolved.url);
      }
      const picked=photos;
      const input={kind,title:title.trim(),date,category,summary:summary.trim(),body:body.trim(),photos:picked,source,clipFile:usingFile && clip.file || null,timepoints:timepoints || []};
      const signature=JSON.stringify([input,picked.map(p=>p.key),usingFile && clip.url]);
      if (attempted.current?.signature!==signature) attempted.current={signature,key:uid()};
      const attempt=attempted.current;
      if (kind==='training' && usingFile && clip.file?.type==='video/mp4') {
        attempt.uploadId ??= await attachClip(ctx,clip.file,controller.signal,attempt.key,setProgress);
        input.uploadId=attempt.uploadId;
      }
      setPublishing(true);
      const id=await saveMaterial(ctx,t,input,controller.signal,attempt);
      if (!mounted.current) return;
      await ctx.refresh();
      if (ctx.signal.aborted) return;
      notify(label+(edit?'已更新':'已发布'));
      go(returnTo ? returnTo+'?added='+encodeURIComponent(id) : '/trainings/'+encodeURIComponent(id),{replace:true});
    } catch(err) {
      if (!controller.signal.aborted && mounted.current) {
        fail('publication',err.message || '暂时无法保存，请重试。');
        setProgress('');
      }
    } finally {
      setPublishing(false);
      if (request.current === controller) request.current = null;
    }
  }
  const busy = Boolean(progress);
  function cancel() {
    if (publishing) return;
    request.current?.abort();
    back(fallback);
  }
  return (
    <div className="page-width form-page training-form-page">
      <Back fallback={fallback} />
      <PageHead title={formTitle} description={returnTo ? '发布后会回到正在编辑的合集。' : undefined} />
      <form ref={form} className="edit-form material-form" onSubmit={save} aria-busy={busy}>
        <fieldset className="material-fields" disabled={busy}>
          {!edit && (
            <fieldset className="kind-switch">
              <legend className="sr">内容形式</legend>
              <div className="kind-line">
                <span aria-hidden="true">内容形式</span>
                <div className="kind-options">
                  {kindChoices.filter(choice=>admin || choice.id!=='training').map(({ id, icon: Icon }) => (
                    <label key={id}>
                      <input
                        type="radio"
                        name="kind"
                        checked={kind === id}
                        onChange={() => {
                          setKind(id); setVideoMode('link');
                          setIssue(null);
                        }}
                      />
                      <Icon size={16} aria-hidden="true" />
                      {kindName[id]}
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>
          )}
          <label>
            {titleLabel}
            <input
              autoComplete="off"
              name="title"
              required
              maxLength={kind==='training'?80:120}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearIssue('title');
              }}
              aria-describedby={issue?.field === 'title' ? 'issue-title' : undefined}
              placeholder={kind === 'training' ? '例如：边线接盘练习' : '给这次记录一个标题'}
            />
          </label>
          <FieldIssue issue={issue} name="title" />
          <div className="form-pair">
            <label className="publication-date">
              <span>{kind === 'training' ? '训练日期' : '记录日期'}</span>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <CategoryField
              value={category}
              onChange={setCategory}
              names={categoryNames}
              onCreate={addCategory}
            />
          </div>
          <label>
            {label}简介<span className="label-lite">选填</span>
            <textarea
              name="summary"
              rows={2}
              maxLength={kind==='training'?2000:240}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={kind === 'training' ? '这次重点练什么？' : '简短介绍这条内容'}
            />
          </label>
          {kind !== 'article' && (
            <fieldset className="video-fields">
              <legend className="sr">视频来源</legend>
              <div className="video-mode-line">
                <span>
                  {videoMode === 'link' ? '观看链接' : '视频文件'}
                  {kind !== 'video' && <span className="label-lite">选填</span>}
                </span>
                {<button
                  type="button"
                  onClick={() => {
                    setVideoMode(videoMode === 'link' ? 'file' : 'link');
                    setIssue(null);
                  }}
                >
                  {videoMode === 'link' ? <Upload size={14} /> : <Link2 size={14} />}
                  {videoMode === 'link' ? '上传视频' : '粘贴链接'}
                </button>}
              </div>
              {videoMode === 'link' ? (
                <div className="watch-link-field">
                <label>
                  <span className="sr">观看链接</span>
                  <input
                    name="link"
                    type="text"
                    inputMode="url"
                    maxLength={2000}
                    value={link}
                    aria-label="观看链接"
                    aria-describedby={issue?.field === 'link' ? 'issue-link' : undefined}
                    placeholder="粘贴 B 站、YouTube 分享链接，或填写 BV 号"
                    onChange={(e) => {
                      setLink(e.target.value);
                      clearIssue('link');
                    }}
                  />
                </label>
                {hasLink && <button type="button" className="ink-link" onClick={() => {
                  setLink('');
                  setIssue(null);
                  form.current?.elements.namedItem('link')?.focus();
                }}><X size={14} />移除视频链接</button>}
                </div>
              ) : (
                <div className="clip-upload">
                  {clip && (
                    <div className="selected-clip">
                      <video
                        aria-label="所选视频预览"
                        ref={clipPreview}
                        onLoadedMetadata={(e) => setClipInfo({ url: clip.url, duration: e.currentTarget.duration })}
                        src={clip.url}
                        controls
                        preload="metadata"
                        playsInline
                      />
                      <div>
                        <strong>{clip.name}</strong>
                        <IconButton
                          label="移除视频文件"
                          icon={X}
                          onClick={() => {
                            release(clip.url);
                            setClip(null);
                            clearIssue('clip');
                          }}
                        />
                      </div>
                    </div>
                  )}
                  <div className="file-choose-row">
                    <label className="media-chooser">
                      <Upload size={16} />
                      {clip ? '更换文件' : '选择文件'}
                      <input
                        type="file"
                        name="clip"
                        aria-label="选择视频文件"
                        accept={fileTypes.video.list}
                        aria-describedby={issue?.field === 'clip' ? 'issue-clip' : 'clip-hint'}
                        onChange={(e) => {
                          chooseClip(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <p className="field-hint" id="clip-hint">
                      MP4 ≤ 100 MiB · WebM ≤ 64 MiB
                    </p>
                  </div>
                </div>
              )}
              {kind==='training' && t?.selectedVideo && <p className="field-hint">填写新链接或选择新文件会追加一个视频，原有视频及讨论会保留。</p>}
              <FieldIssue issue={issue} name="link" />
              <FieldIssue issue={issue} name="clip" />
              {otherSource && (
                <div className="retained-film">
                  <span>
                    {usingLink ? <Link2 size={15} /> : <Video size={15} />}
                    {usingLink ? '保留已填写的观看链接' : '保留已选择的视频文件'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (usingLink) setLink('');
                      else {
                        release(clip.url);
                        setClip(null);
                      }
                      setIssue(null);
                    }}
                  >
                    {usingLink ? '移除链接' : '移除视频文件'}
                  </button>
                </div>
              )}
              {keepFilm && !hasLink && !hasFile && (
                <div className="retained-film">
                  <span>
                    <Clapperboard size={15} />
                    保留当前战术片 · {clock(t.duration)}
                  </span>
                  <button type="button" onClick={() => setKeepFilm(false)}>
                    移除视频
                  </button>
                </div>
              )}
            </fieldset>
          )}
          {kind !== 'article' && pointKey && (
            <ChapterFields optional rows={pointRows} duration={Number.isFinite(duration) ? duration : 0}
              fromLink={usingLink ? linkedTime(link) : null}
              currentTime={usingFile && videoMode === 'file' && duration > 0 ? () => clipPreview.current.currentTime : undefined}
              onChange={(rows) => {
                setPointDrafts((drafts) => ({ ...drafts, [pointKey]: rows }));
                clearIssue('timepoints');
              }}
              issue={issue?.field === 'timepoints' ? issue : null} />
          )}
          {kind !== 'article' && (
            <button
              type="button"
              className="story-disclosure"
              aria-expanded={more}
              aria-controls="story-fields"
              onClick={() => setMore((v) => !v)}
            >
              <FileImage size={16} />
              正文与照片
              <ChevronDown size={16} />
            </button>
          )}
          {(more || kind === 'article') && (
            <div className="story-fields" id="story-fields">
              <label>
                正文{kind !== 'article' && <span className="label-lite">选填</span>}
                <textarea
                  name="body"
                  rows={kind === 'article' ? 6 : 3}
                  maxLength={10000}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    clearIssue('body');
                  }}
                  aria-describedby={issue?.field === 'body' ? 'issue-body' : undefined}
                  placeholder="记下场上的动作、观察或下一次练习的重点"
                />
              </label>
              <FieldIssue issue={issue} name="body" />
              {<PhotoFields
                linkedVideo={kind !== 'article' && Boolean(usingLink || t?.source)}
                photos={photos}
                choose={choosePhotos}
                issue={issue?.field === 'photos' ? issue.message : ''}
                describe={(key, alt) =>
                  setPhotos((list) => list.map((p) => (p.key === key ? { ...p, alt } : p)))
                }
                remove={(key) => {
                  const photo = photos.find((p) => p.key === key);
                  if (photo) release(photo.url);
                  setPhotos((list) => list.filter((p) => p.key !== key));
                  clearIssue('photos');
                  requestAnimationFrame(() => form.current?.elements.namedItem('photos')?.focus());
                }}
              />}
            </div>
          )}
        </fieldset>
        <FieldIssue issue={issue} name="publication" />
        <div className="form-end material-form-end">
          {edit && <DeleteMaterial item={t} disabled={busy} />}
          <span role="status">{progress}</span>
          <button type="button" className="btn" disabled={publishing} onClick={cancel}>
            取消
          </button>
          <button className="btn primary" disabled={busy} type="submit">
            {edit ? '保存修改' : '发布' + label}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
