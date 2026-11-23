import { useCallback, useId, useRef, useState } from 'react';
import { Crosshair, Play, Plus, X } from 'lucide-react';
import { IconButton } from './ui';
import { maxTimepoints, timeLabel } from './timepoints.js';
import { videoAt } from './video-source.js';

export function useVideoPlayback(source, initialTime=null) {
  const player = useRef(null);
  const stage = useRef(null);
  const pendingSeek = useRef(initialTime);
  const [started, setStarted] = useState(false);
  const [current, setCurrent] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [embedKey, setEmbedKey] = useState(0);
  const [error, setError] = useState('');

  async function play(at, limit) {
    setError('');
    if (at != null) (stage.current || player.current)?.scrollIntoView({ block: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    if (source) {
      // Embedded players can reset an exact end offset to an earlier position.
      // Start their final playable second for an end-of-video reference.
      setCurrent(at != null && at === limit ? Math.max(0, at - 1) : at ?? null);
      setEmbedKey((value) => value + 1);
      setStarted(true);
    } else {
      const el = player.current;
      if (!el) return;
      try {
        if (at != null) {
          if (at === el.duration || (el.readyState < 1 && at === limit)) {
            el.pause();
            if (el.readyState >= 1) el.currentTime = el.duration;
            else pendingSeek.current = at;
            setStarted(true);
            return;
          }
          if (el.readyState >= 1) el.currentTime = at;
          else pendingSeek.current = at;
        }
        await el.play();
        setStarted(true);
      } catch {
        setError('视频暂时未能播放，可使用播放器的播放键重试。');
      }
    }
  }
  function readDuration(event) {
    const el = event.currentTarget;
    setMetadata({ src: el.getAttribute('src'), duration: Number.isFinite(el.duration) ? el.duration : 0 });
  }
  const attachPlayer=useCallback(element=>{player.current=element;},[]);
  const attachStage=useCallback(element=>{stage.current=element;},[]);
  const native = {
    ref: attachPlayer,
    onPlay: () => setStarted(true),
    onEmptied: () => { setMetadata(null); setCurrent(null); setStarted(false); },
    onDurationChange: readDuration,
    onLoadedMetadata: (e) => {
      readDuration(e);
      if (pendingSeek.current == null) return;
      if (pendingSeek.current<=e.currentTarget.duration) e.currentTarget.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    },
    onTimeUpdate: (e) => setCurrent(e.currentTarget.currentTime),
    onError: () => setError('无法读取视频，请检查文件或重新载入。'),
  };
  const capture=()=>Math.floor(player.current?.currentTime ?? 0);
  const reloadNative=()=>player.current?.load();
  const focusStage=()=>stage.current?.focus({preventScroll:true});
  return { stage:attachStage, native, play, capture, reloadNative, focusStage, started, error, playhead:current, duration: metadata?.duration || 0, nativeSrc: metadata?.src, embedKey,
    embed: source && videoAt(source, current, true), original: source && videoAt(source, current) };
}

export function ChapterList({ points, playback, action }) {
  if (!points.length && !action) return null;
  return (
    <section className={points.length ? 'chapters' : 'chapter-empty'} aria-label="章节">
      <div className="chapter-heading"><h2>章节</h2>{action}</div>
      {points.length > 0 && (
        <ol className="chapter-index">
          {points.map(({ at, title }, i) => {
            const current = playback.started && playback.playhead != null && playback.playhead >= at
              && (!points[i + 1] || playback.playhead < points[i + 1].at);
            return (
              <li key={at}>
                <button type="button" className="chapter-entry" aria-current={current ? 'true' : undefined}
                  aria-label={'跳到 ' + timeLabel(at) + '，' + title} onClick={() => playback.play(at)}>
                  <time>{timeLabel(at)}</time><span>{title}</span><Play size={15} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const emptyChapter = () => ({ key: crypto.randomUUID(), time: '', title: '' });

export function ChapterFields({ rows, onChange, currentTime, fromLink, duration, issue, optional = false, onCancel, saving = false }) {
  const [first] = useState(emptyChapter);
  const prefix = useId();
  const entries = rows.length ? rows : [first];
  const timeId = (key) => prefix + '-time-' + key;
  const nameId = (key) => prefix + '-name-' + key;
  function focus(id) {
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  function add(at) {
    const blank = entries.find((r) => !r.time.trim() && (!r.title.trim() || at != null));
    if (!blank && entries.length >= maxTimepoints) return;
    const next = { ...(blank || emptyChapter()), time: at == null ? '' : timeLabel(at) };
    onChange(blank ? entries.map((r) => r.key === blank.key ? next : r) : [...entries, next]);
    focus(at == null ? timeId(next.key) : nameId(next.key));
  }
  function change(key, field, value) {
    onChange(entries.map((r) => r.key === key ? { ...r, [field]: value } : r));
  }
  function remove(index) {
    const remaining = entries.filter((_, i) => i !== index);
    onChange(remaining);
    focus(timeId((remaining[Math.min(index, remaining.length - 1)] || first).key));
  }
  const count = entries.filter((r) => r.time.trim() || r.title.trim()).length;
  return (
    <fieldset className="chapter-fields" disabled={saving}>
      <legend className="sr">章节</legend>
      <div className="chapter-heading">
        <h2>章节</h2>
        <span className="chapter-detail">
          {duration > 0 ? '片长 ' + timeLabel(duration) : optional ? '选填' : ''}
        </span>
      </div>
      <div className="chapter-colnames" aria-hidden="true">
        <span>开始时间</span><span>章节名称</span>
      </div>
      <ol className="chapter-rows">
        {entries.map((r, i) => {
          const invalidTime = issue?.input === 'point-time-' + i;
          const invalidName = issue?.input === 'point-title-' + i;
          return (
            <li key={r.key}>
              <input id={timeId(r.key)} name={'point-time-' + i} type="text" className="chapter-time"
                aria-label={'第 ' + (i + 1) + ' 章开始时间'} value={r.time} placeholder="00:00"
                aria-invalid={invalidTime || undefined} aria-describedby={invalidTime ? prefix + '-error' : undefined}
                autoComplete="off" spellCheck={false} maxLength={12}
                onChange={(e) => change(r.key, 'time', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault(); document.getElementById(nameId(r.key))?.focus();
                  }
                }} />
              <input id={nameId(r.key)} name={'point-title-' + i} type="text" className="chapter-name"
                aria-label={'第 ' + (i + 1) + ' 章名称'} value={r.title} placeholder="例如：弱侧启动"
                aria-invalid={invalidName || undefined} aria-describedby={invalidName ? prefix + '-error' : undefined}
                maxLength={120} onChange={(e) => change(r.key, 'title', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (!r.time.trim()) focus(timeId(r.key));
                  else if (r.title.trim()) {
                    if (entries[i + 1]) focus(timeId(entries[i + 1].key));
                    else add();
                  }
                }} />
              <IconButton label={'移除第 ' + (i + 1) + ' 章'} icon={X} disabled={!rows.length}
                onClick={() => remove(i)} />
            </li>
          );
        })}
      </ol>
      {issue && <p role="alert" id={prefix + '-error'} className="form-error">{issue.message}</p>}
      <div className="chapter-tools">
        <button type="button" className="chapter-tool" disabled={count >= maxTimepoints}
          onClick={() => add()}><Plus size={17} />添加章节</button>
        {currentTime && <button type="button" className="chapter-tool" disabled={count >= maxTimepoints}
          onClick={() => add(currentTime())}><Crosshair size={16} />取当前播放时间</button>}
        {fromLink != null && <button type="button" className="chapter-tool" disabled={count >= maxTimepoints}
          onClick={() => add(fromLink)}><Crosshair size={16} />使用链接时间 {timeLabel(fromLink)}</button>}
      </div>
      {onCancel && <div className="chapter-save">
        <button type="button" className="btn" onClick={onCancel}>取消</button>
        <button type="submit" className="btn primary">{saving ? '正在保存…' : '保存章节'}</button>
      </div>}
    </fieldset>
  );
}
