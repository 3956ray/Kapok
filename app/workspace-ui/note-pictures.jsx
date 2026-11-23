import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Images, X } from 'lucide-react';
import { TextLinks } from '../components/learning-text';
import { useData } from './store';
import { IconButton, Modal } from './ui';
import { maxNotePhotos, noteBody, noteParts, notePhotos } from './note-layout.js';
import { pruneNoteImages, readNoteImage, stageNoteImages, storedBlob } from './note-image-store.js';

export function NoteImage({ photo, alt = '', thumbnail = false, ...props }) {
  const { ctx: { actorId } } = useData();
  const [local, setLocal] = useState(null);
  const [failed, setFailed] = useState([]);
  const remote = [thumbnail && photo.thumb, photo.url].find(url => url && !failed.includes(url));
  const { localId } = photo;
  useEffect(() => {
    if (!localId || remote) return;
    let active = true, objectUrl;
    readNoteImage(actorId, localId).then(record => {
      if (!active) return;
      objectUrl = URL.createObjectURL((thumbnail && storedBlob(record, true)) || storedBlob(record));
      setLocal({ actorId, id: localId, src: objectUrl });
    }).catch(() => { if (active) setLocal({ actorId, id: localId, src: '' }); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [actorId, remote, localId, thumbnail]);
  const src = remote || (localId && local?.actorId === actorId && local.id === localId && local.src);
  if (src && !failed.includes(src))
    return <img {...props} src={src} alt={alt} onError={() => setFailed(old => [...old, src])} />;
  const loading = localId && (local?.actorId !== actorId || local.id !== localId);
  return <span className="note-image-status">{loading ? '正在读取图片…' : '图片暂不可用'}</span>;
}

export function NotePictureEditor({ draft, patch, saving, preparing, onPreparing }) {
  const { ctx } = useData();
  const { actorId } = ctx;
  const parts = noteParts(draft);
  const count = notePhotos(draft).length;
  const totalText = parts.reduce((sum, part) => sum + part.text.length, 0);
  const [issue, setIssue] = useState('');
  const cursor = useRef(null);
  const fields = useRef([]);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    pruneNoteImages(actorId).catch(() => {});
    return () => { mounted.current = false; };
  }, [actorId]);

  function update(next) {
    const deviceImageIds = [...new Set([...(draft.deviceImageIds || []),
      ...notePhotos(draft).map(p => p.localId).filter(Boolean),
      ...next.flatMap(part => part.photos.map(p => p.localId).filter(Boolean))])];
    patch({ body: noteBody(next), parts: next.some(part => part.photos.length) ? next : [], ...(deviceImageIds.length && { deviceImageIds }) });
  }
  function remember(element, index) {
    cursor.current = { index, at: element.selectionEnd };
  }
  async function insert(files) {
    if (!files.length || pending.current || saving) return;
    setIssue('');
    if (files.length + count > maxNotePhotos) {
      setIssue('每篇最多 9 张，本次还可以选择 ' + (maxNotePhotos - count) + ' 张。');
      return;
    }
    const index = Math.min(cursor.current?.index ?? parts.length - 1, parts.length - 1);
    const part = parts[index];
    const at = cursor.current
      ? Math.min(fields.current[index]?.selectionEnd ?? cursor.current.at, part.text.length)
      : part.text.length;
    pending.current = true;
    onPreparing(true);
    try {
      const photos = await stageNoteImages(actorId, files, ctx.signal);
      if (!mounted.current) return;
      const next = [...parts];
      let after = index;
      if (at === 0 && index > 0) {
        const previous = parts[index - 1];
        next[index - 1] = { ...previous, photos: [...previous.photos, ...photos] };
      } else if (at === part.text.length && part.photos.length) {
        next[index] = { ...part, photos: [...part.photos, ...photos] };
        after++;
      } else {
        next.splice(index, 1, { text: part.text.slice(0, at), photos },
          { text: part.text.slice(at), photos: part.photos });
        after++;
      }
      update(next);
      cursor.current = { index: after, at: 0 };
      requestAnimationFrame(() => {
        const field = fields.current[after];
        field?.focus({ preventScroll: true });
        field?.setSelectionRange(0, 0);
      });
    } catch (error) {
      if (mounted.current) setIssue(error.message || '图片未能加入，请重新选择。');
    } finally {
      pending.current = false;
      if (mounted.current) onPreparing(false);
    }
  }

  function changeGroup(index, photos) {
    const next = [...parts];
    const part = parts[index];
    if (photos.length || !parts[index + 1]) next[index] = { ...part, photos };
    else {
      const after = parts[index + 1];
      next.splice(index, 2, { text: part.text + after.text, photos: after.photos });
    }
    cursor.current = null;
    setIssue('');
    update(next);
  }
  const locked = saving || preparing;
  let number = 0;
  return <section className="note-composer" aria-label="图文正文" aria-busy={preparing}>
    <div className="note-tools">
      <label htmlFor="note-text-0">复盘内容</label>
      <label className="note-insert">
        <ImagePlus size={16} aria-hidden="true" />插入图片
        <input type="file" aria-label="插入图片" multiple accept="image/jpeg,image/png,image/webp"
          disabled={locked || count >= maxNotePhotos} aria-describedby="note-picture-help"
          onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; insert(files); }} />
      </label>
    </div>
    <p className="note-picture-help" id="note-picture-help">{count ? count + ' / 9 张' : '在光标处插入，可多选'} · JPG、PNG、WebP · 每张最多 8 MB</p>
    {preparing && <p role="status" className="field-hint">正在读取图片…</p>}
    {issue && <p role="alert" className="form-error">{issue}</p>}
    <div className={'note-draft-pages' + (count ? ' illustrated' : '')}>
      {parts.map((part, index) => <div key={index} className="note-draft-part">
        <textarea id={'note-text-' + index} ref={el => { fields.current[index] = el; }}
          aria-label={index ? '续写正文 ' + index : undefined}
          required={!count && index === 0} rows={count ? 2 : 5} readOnly={locked}
          maxLength={Math.max(part.text.length, 5000 - totalText + part.text.length)}
          className="writing-area" value={part.text}
          placeholder={index ? '继续写下你的观察…' : '你在想什么呢？'}
          onFocus={e => remember(e.currentTarget, index)} onSelect={e => remember(e.currentTarget, index)}
          onBlur={e => remember(e.currentTarget, index)}
          onChange={e => {
            remember(e.currentTarget, index);
            update(parts.map((p, i) => i === index ? { ...p, text: e.target.value } : p));
          }} />
        {part.photos.length > 0 && <div className="note-proof-grid">{part.photos.map((photo, i) => {
          const n = ++number;
          function move(to) {
            const next = [...part.photos];
            [next[i], next[to]] = [next[to], next[i]];
            changeGroup(index, next);
          }
          return <figure key={photo.id || photo.localId} className="note-proof">
            <div className="note-proof-photo"><NoteImage photo={photo} thumbnail alt={'配图 ' + n + ' 预览'} /></div>
            <div className="note-proof-actions">
              <span>{String(n).padStart(2, '0')}</span>
              {part.photos.length > 1 && <>
                <IconButton label={'前移图片 ' + n} icon={ArrowLeft} disabled={locked || !i} onClick={() => move(i - 1)} />
                <IconButton label={'后移图片 ' + n} icon={ArrowRight} disabled={locked || i === part.photos.length - 1} onClick={() => move(i + 1)} />
              </>}
              <IconButton label={'移除图片 ' + n} icon={X} disabled={locked} onClick={() => changeGroup(index, part.photos.filter((_, j) => j !== i))} />
            </div>
            <input aria-label={'图片说明 ' + n} placeholder="添加图注（选填）" maxLength={200}
              value={photo.alt} readOnly={locked} onChange={e => {
                update(parts.map((p, j) => j !== index ? p : { ...p, photos: p.photos.map((v, k) => k === i ? { ...v, alt: e.target.value } : v) }));
              }} />
          </figure>;
        })}</div>}
      </div>)}
    </div>
  </section>;
}

export function IllustratedNote({ note }) {
  const parts = noteParts(note);
  const photos = parts.flatMap(part => part.photos);
  const [selected, select] = useState(null);
  const current = photos[selected];
  return <div className="note-prose">
    {parts.map((part, i) => {
      const start = photos.indexOf(part.photos[0]);
      return <div key={i} className="note-read-part">
        {part.text && part.text.split(/\n\s*\n/).map((para, j) => <p key={j}><TextLinks text={para}/></p>)}
        {part.photos.length > 0 && <div className={'note-plates' + (part.photos.length === 1 ? ' single' : '')}>
          {part.photos.map((photo, j) => <figure key={j}>
            <button type="button" aria-label={'放大第 ' + (start + j + 1) + ' 张图片'} onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              select(start + j);
            }}>
              <NoteImage photo={photo} thumbnail={part.photos.length > 1} alt={photo.alt || '训练配图 ' + (start + j + 1)} loading="lazy" decoding="async" />
            </button>
            {photo.alt && <figcaption>{photo.alt}</figcaption>}
          </figure>)}
        </div>}
      </div>;
    })}
    <Modal open={!!current} onOpenChange={v => { if (!v) select(null); }} title="查看配图" className="note-lightbox"
      onKeyDown={e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          select(Math.min(photos.length - 1, Math.max(0, selected + (e.key === 'ArrowLeft' ? -1 : 1))));
        }
      }}>
      {current && <><div className="note-lightbox-image"><NoteImage photo={current} alt={current.alt || '训练配图 ' + (selected + 1)} /></div>
        <div className="note-lightbox-footer">
          <span aria-live="polite">{selected + 1} / {photos.length}{current.alt && '　' + current.alt}</span>
          {photos.length > 1 && <div>
            <IconButton label="上一张图片" icon={ArrowLeft} disabled={selected === 0} onClick={() => select(selected - 1)} />
            <IconButton label="下一张图片" icon={ArrowRight} disabled={selected === photos.length - 1} onClick={() => select(selected + 1)} />
          </div>}
        </div></>}
    </Modal>
  </div>;
}

export function NoteFeedPhoto({ photo, count }) {
  return <span className="wire-thumb note-wire-photo">
    <NoteImage photo={photo} thumbnail alt="" loading="lazy" decoding="async" />
    {count > 1 && <span aria-label={count + ' 张图片'}><Images size={12} aria-hidden="true" />{count}</span>}
  </span>;
}
