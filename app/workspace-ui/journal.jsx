import { DiscussionPanel } from './discussion-panel.jsx';
import { IllustratedNote, NotePictureEditor } from './note-pictures';
import { notePhotos } from './note-layout.js';
import { persistPrivateLayout, readPrivateLayout, savedParts, saveIllustratedNote, cancelDetachedNoteImages, discardLocalDraftFiles } from './note-image-store.js';
import { TextLinks } from '../components/learning-text';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  Check,
  ArrowUpRight,
  ChevronDown,
  FilePenLine,
  Pencil,
  Tag,
  Trash2,
} from 'lucide-react';
import { Back, DeleteAction, Empty, IconButton, Modal, PageHead, Segments, Tip, usePreference, WriteNoteIcon } from './ui';
import { NavLink, useNav, useTitle } from './router';
import { day, eventTime, localDay, useData } from './store';
import { DateMark, FieldPrint, fieldPhoto } from './press';
import { editRemark, removeBookmark, prepareSave, reflectionSeedPath } from './growth.js';
import { ReflectionSharingControls } from '../components/reflection-sharing-controls';
import { listDeviceDrafts } from '../../lib/client/reflection-draft';
import { CategoryField } from './category-field';
import { noteCategoryLabel } from './categories.js';
function PrivateRemark({ text }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const firstLine = text.trim().split(/\r?\n/, 1)[0];
  const letters = Array.from(firstLine);
  const canExpand = letters.length > 48 || firstLine !== text.trim();
  if (!canExpand) return <p><TextLinks text={text}/></p>;
  return (
    <div className="private-remark">
      <button
        type="button"
        aria-controls={id}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起备注' : '展开备注'}
        <ChevronDown size={13} />
      </button>
      <p id={id}>{expanded ? <TextLinks text={text}/> : <><TextLinks text={letters.slice(0, 48).join('')} clipped={letters.length > 48}/>…</>}</p>
    </div>
  );
}
export function Growth() {
  useTitle('成长记录');
  const { db, trainings, collections, setDb, notify, ctx, refreshShares, catalogReady, sharesError } = useData(),
    { go, params } = useNav();
  const [preferredFilter, setPreferredFilter] = usePreference('growth-filter', '全部');
  const requestedFilter = params.get('filter');
  const filter = requestedFilter === 'reflections' ? '复盘' : requestedFilter === 'bookmarks' ? '收藏' : preferredFilter;
  function setFilter(value) {
    setPreferredFilter(value);
    if (requestedFilter) go('/growth', { replace: true });
  }
  const [legacyDrafts, setLegacyDrafts] = useState(() => {
    try { return listDeviceDrafts(localStorage, ctx.actorId); } catch { return []; }
  });
  useEffect(() => {
    function reread() {
      try { setLegacyDrafts(listDeviceDrafts(localStorage, ctx.actorId)); } catch { /* Local-only. */ }
    }
    window.addEventListener('storage', reread);
    window.addEventListener('pageshow', reread);
    return () => { window.removeEventListener('storage', reread); window.removeEventListener('pageshow', reread); };
  }, [ctx.actorId]);
  const [chosenCategory, setChosenCategory] = usePreference('growth-note-category', '');
  const [editing, setEditing] = useState(null),
    [noteText, setNoteText] = useState(''),
    [remove, setRemove] = useState(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  async function commit(work, done) {
    if (working) return;
    setWorking(true);
    setActionError('');
    try {
      await work();
      await refreshShares();
      done();
    } catch (err) {
      setActionError(err.message || '操作失败，请重试。');
    } finally { setWorking(false); }
  }
  const rows = [
    ...db.notes.map((n) => ({ type: '复盘', id: n.id, at: n.created, n })),
    ...Object.entries(db.savedCollections).map(([id, saved]) => {
      const current = collections.find((c) => c.id === id);
      return {
        type: '收藏',
        id,
        at: saved.date,
        volume: { ...saved, title: current?.title || saved.title },
        s: saved,
      };
    }),
    ...Object.entries(db.saved)
      .map(([id, s]) => ({ type: '收藏', id, at: s.date, t: s.source && trainings.find((t) => t.id === id), s })),
  ].sort((a, b) => eventTime(b.at) - eventTime(a.at));
  const usedCategories = [...new Set(db.notes.map(noteCategoryLabel))];
  const category = usedCategories.includes(chosenCategory) ? chosenCategory : '';
  const filtered = rows.filter((r) => {
    if (filter === '全部') return true;
    if (r.type !== filter) return false;
    return filter !== '复盘' || !category || noteCategoryLabel(r.n) === category;
  });
  const latest = rows.find((r) => r.n)?.n;
  const linked = latest && trainings.find((t) => t.id === latest.training);
  const drafts = Object.entries(db.drafts).filter(([, v]) => v.title?.trim() || v.body?.trim() || notePhotos(v).length);
  const scopeText = (n) => (n.scope === 'team' ? '队内可读' : '仅自己可见');
  return (
    <div className="page-width journal-page">
      <PageHead
        title="成长记录"
        description={db.profile.name + '的场边手记'}
        action={
          <NavLink to="/notes/new" className="btn primary">
            <WriteNoteIcon size={17} />
            想和写
          </NavLink>
        }
      />
      {latest && (
        <article className="journal-spread" aria-label="最近一篇复盘">
          <FieldPrint training={linked} date={latest.created} />
          <div className="spread-copy">
            <div className="spread-dateline">
              <time dateTime={latest.created}>{localDay(latest.created).replaceAll('-', '.')}</time>
              <span>{noteCategoryLabel(latest)}</span>
              <span>{scopeText(latest)}</span>
            </div>
            <h2>
              <NavLink
                to={'/notes/' + latest.id}
                photoKey={'lead-note:' + latest.id}
                aria-label={'阅读复盘：' + latest.title}
              >
                <span data-photo-key={'lead-note:' + latest.id}>{latest.title || '训练复盘'}</span>
              </NavLink>
            </h2>
            <p><TextLinks text={latest.body || latest.photos?.[0]?.caption || (latest.hasLocalPhotos || latest.photos?.length ? '图文复盘' : '')}/></p>
            <NavLink className="ink-link" to={'/notes/' + latest.id} photoKey={'lead-note:' + latest.id}>
              阅读全文
              <ArrowRight size={18} />
            </NavLink>
          </div>
        </article>
      )}
      {(drafts.length > 0 || legacyDrafts.length > 0) && (
        <section className="drafts">
          <h2>
            <FilePenLine size={16} />
            继续草稿
          </h2>
          {legacyDrafts.map(d => (
            <div className="draft-record" key={d.href}>
              <a href={d.href + (d.href.includes('?') ? '&' : '?') + 'resumeDraft=1'} className="draft-link">
                {d.title} · {d.pending ? '确认上次保存' : '继续本机草稿'} <ArrowRight size={15} />
              </a>
            </div>
          ))}
          {drafts.map(([key, d]) => (
            <div className="draft-record" key={key}>
              <NavLink to={d.resume} className="draft-link">
                {d.title.trim() || '未命名复盘'} <ArrowRight size={15} />
              </NavLink>
              <DeleteAction label="删除草稿" disabled={!!d.operation} title={d.title.trim() || '未命名复盘'}
                description="的未保存修改将被清除。" onDelete={async () => {
                  let discarded;
                  setDb(old => {
                    const drafts = { ...old.drafts };
                    if (drafts[key]?.operation) throw Error('请先核对上次保存结果。');
                    discarded = drafts[key];
                    delete drafts[key];
                    return { ...old, drafts };
                  }, true);
                  if (discarded) {
                    await cancelDetachedNoteImages(ctx, discarded.stagedImageIds || []);
                    await discardLocalDraftFiles(ctx, discarded);
                  }
                }} />
            </div>
          ))}
        </section>
      )}
      <section className="records-index" aria-labelledby="records-title">
        <div className="section-line">
          <h2 id="records-title">手记索引</h2>
          <span>
            {db.notes.length} 篇复盘 <i>/</i>{' '}
            {Object.keys(db.saved).length + Object.keys(db.savedCollections).length} 条收藏
          </span>
        </div>
        <Segments
          items={['全部', '收藏', '复盘']}
          value={filter}
          onChange={setFilter}
          label="成长记录筛选"
        >
          {filter === '复盘' && usedCategories.length > 0 && (
            <div className="journal-category-filter">
              <label htmlFor="journal-category">复盘类别</label>
              <div className="journal-category-picker">
                <select
                  id="journal-category"
                  value={category}
                  onChange={(e) => setChosenCategory(e.target.value)}
                >
                  <option value="">全部类别</option>
                  {usedCategories.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </div>
              <output>{filtered.length} 篇</output>
            </div>
          )}
          {filtered.length ? (
            <div className="ledger">
              {filtered.map((r) => (
                <article className="ledger-row" key={r.type + r.id}>
                  <DateMark value={r.at} />
                  <div className="ledger-entry">
                    <div className="record-meta">
                      {r.n ? (
                        <>
                          <BookOpen size={13} />
                          {filter === '全部' && <span>复盘 ·</span>}
                          <span>{noteCategoryLabel(r.n)}</span>
                          <span aria-hidden="true">·</span>
                          {scopeText(r.n)}
                        </>
                      ) : (
                        <>
                          <Bookmark size={13} />
                          收藏<span>·</span>
                          {r.volume ? '训练合集' : '私人备注'}
                        </>
                      )}
                    </div>
                    <h3>
                      {r.n ? (
                        <NavLink to={'/notes/' + r.id} photoKey={'index-note:' + r.id}>
                          <span data-photo-key={'index-note:' + r.id}>{r.n.title || '训练复盘'}</span>
                        </NavLink>
                      ) : r.volume?.missing ? (
                        <span>{r.volume.title} <small>分享已失效</small></span>
                      ) : r.volume ? (
                        <NavLink to={r.volume.href}>{r.volume.title}</NavLink>
                      ) : r.s.href ? (
                        <NavLink to={r.s.href}>{r.s.title}</NavLink>
                      ) : (
                        <span>{r.s.title || '收藏的内容'} <small>{!catalogReady ? '正在读取' : sharesError ? '暂时无法读取' : '原内容已移除'}</small></span>
                      )}
                    </h3>
                    {r.s?.note && <PrivateRemark text={r.s.note} />}
                  </div>
                  {r.n ? (
                    <NavLink
                      to={'/notes/' + r.id}
                      photoKey={'index-note:' + r.id}
                      className="record-open"
                      aria-label={'打开复盘：' + r.n.title}
                    >
                      <ArrowUpRight size={19} />
                    </NavLink>
                  ) : (
                    <div className="record-actions">
                      <IconButton
                        label="编辑私人备注"
                        icon={Pencil}
                        onClick={() => {
                          setNoteText(r.s.note);
                          setEditing(r.s);
                          setActionError('');
                        }}
                      />
                      <IconButton
                        label="转为复盘"
                        disabled={!r.s.note.trim()}
                        icon={WriteNoteIcon}
                        onClick={() => go('/notes/new?bookmark=' + encodeURIComponent(r.id))}
                      />
                      <IconButton
                        label="删除收藏"
                        className="danger"
                        icon={Trash2}
                        onClick={() => { setRemove(r.s); setActionError(''); }}
                      />
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <Empty
              icon={filter === '收藏' ? Bookmark : BookOpen}
              title={
                filter === '收藏' ? '还没有收藏' : filter === '复盘' ? '还没有复盘' : '还没有成长记录'
              }
              text={
                filter === '收藏'
                  ? '在训练封面点一下书签，就能在这里找到。'
                  : '写下这次训练里想记住的细节。'
              }
              action={
                <NavLink className="btn" to={filter === '收藏' ? '/trainings' : '/notes/new'}>
                  {filter !== '收藏' && <WriteNoteIcon size={17} />}
                  {filter === '收藏' ? '浏览训练' : '想和写'}
                  {filter === '收藏' && <ArrowRight size={15} />}
                </NavLink>
              }
            />
          )}
        </Segments>
      </section>
      <Modal
        open={Boolean(editing)}
        onOpenChange={(v) => {
          if (!v && !working) setEditing(null);
        }}
        title="编辑私人备注"
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void commit(() => editRemark(ctx, editing, noteText.trim()), () => {
              setEditing(null);
              notify('私人备注已保存');
            });
          }}
        >
          <label>
            备注内容
            <textarea
              rows={4}
              maxLength={2000}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="记下值得回看的细节…"
            />
          </label>
          <div className="form-buttons">
            <button type="button" className="btn" disabled={working} onClick={() => setEditing(null)}>
              取消
            </button>
            {actionError && <p role="alert">{actionError}</p>}
            <button type="submit" className="btn primary" disabled={working}>
              保存备注
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(remove)}
        onOpenChange={(v) => {
          if (!v && !working) setRemove(null);
        }}
        title="删除这条收藏？"
        description={
          '这条收藏及其私人备注将从你的账号移除。'
        }
      >
        <div className="form-buttons">
          {actionError && <p role="alert">{actionError}</p>}
          <button type="button" disabled={working} className="btn" onClick={() => setRemove(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn danger-solid"
            disabled={working}
            onClick={() => void commit(() => removeBookmark(ctx, remove), () => {
              setRemove(null);
              notify('已删除收藏');
            })}
          >
            删除收藏
          </button>
        </div>
      </Modal>
    </div>
  );
}
function editorDraftKey(note, params) {
  if (note) return 'edit:' + note.id;
  for (const [param, prefix] of [['bookmark', 'saved:'], ['collection', 'collection:'], ['video', 'video:']])
    if (params.has(param)) return 'new:' + prefix + params.get(param);
  if (params.has('sourceKind')) return 'new:' + params.get('sourceKind') + ':' + params.get('sourceId');
  return 'new:' + (params.get('training') || '');
}
export function NoteEditor({ n }) {
  const { db, ctx } = useData();
  const { params } = useNav();
  const key = params.get('bookmark');
  const bookmark = key && (db.saved[key] || db.savedCollections[key]);
  const local = db.drafts[editorDraftKey(n, params)];
  const [source, setSource] = useState(null);
  const [attempt, retry] = useState(0);
  const read = ctx.read;
  let endpoint, invalid;
  try { endpoint = reflectionSeedPath(params, bookmark); } catch (e) { invalid = e.message; }
  const training = params.get('training');
  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    read(endpoint, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (endpoint.startsWith('videos/') && training && value.trainingId !== training)
        throw new Error('该视频不属于关联训练。');
      const seed = endpoint.startsWith('videos/') ? { trainingId: value.trainingId, videoId: value.id, text: '' } : value;
      setSource({ endpoint, seed });
    }).catch(e => { if (!controller.signal.aborted) setSource({ endpoint, error: e.message, missing: ['FORBIDDEN','NOT_FOUND'].includes(e.code) }); });
    return () => controller.abort();
  }, [endpoint, training, read, attempt]);
  if (local && ((key && !bookmark) || (source?.endpoint === endpoint && source?.missing)))
    return <Writer n={n} seed={null} sourceUnavailable />;
  if (invalid) return <div className="page-width"><Back fallback="/growth" /><p>{invalid}</p></div>;
  if (endpoint && source?.endpoint !== endpoint) return <p className="page-width" role="status">正在读取关联来源…</p>;
  if (endpoint && source?.error) return <p className="page-width" role="alert">{source.error} <button onClick={() => { setSource(null); retry(v => v + 1); }}>重试</button></p>;
  return <Writer n={n} seed={endpoint ? source.seed : null} />;
}

function Writer({ n, seed, sourceUnavailable = false }) {
  useTitle(n ? '编辑复盘' : '想和写');
  const { params, path, back } = useNav(),
    { db, setDb, ctx, refreshShares, notify, trainings, noteCategoryNames, addNoteCategory, storageError } = useData();
  const key = editorDraftKey(n, params);
  const savedDraft = db.drafts[key];
  const originalSource = n?.sourceRef || seed?.sourceRef;
  const topic = originalSource?.kind === 'topic_collection' ? originalSource.id : null;
  const topicValue = topic ? 'topic:' + topic : '';
  const training = topicValue || n?.training || seed?.trainingId || originalSource?.id || params.get('training') || '';
  const missingPictures = n?.hasLocalPhotos && !savedDraft?.operation && !readPrivateLayout(ctx.actorId, n);
  const initial = { title: n?.title || '', body: n?.body || seed?.text || '',
    ...((n?.hasLocalPhotos || n?.photos?.length > 0) && { parts: savedParts(ctx.actorId, n) }),
    scope: params.get('share') === 'team' ? 'team' : 'private', publish: false, category: n?.category || '', training, base: n };
  const draft = { ...initial, ...savedDraft };
  if (sourceUnavailable && !draft.associationChanged) draft.training = '';
  const [attempt, setAttempt] = useState(false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState('');
  const hasContent = Boolean(draft.body.trim() || notePhotos(draft).length);
  const active = useRef(false);
  function patch(changes) {
    setDb(d => ({
      ...d, drafts: { ...d.drafts, [key]: { ...initial, ...d.drafts[key], ...changes, resume: path } },
    }));
  }
  async function save(e) {
    e.preventDefault();
    setAttempt(true);
    if (active.current || preparing || missingPictures || !hasContent || !draft.title.trim() || !draft.category) return;
    active.current = true;
    setSaving(true);
    setError('');
    try {
      const linked = trainings.find(t => t.id === draft.training);
      const original = draft.base || seed;
      const association = (draft.training === topicValue && topic) ? { sourceRef: originalSource } : !draft.associationChanged && original ? {
        trainingId: original.trainingId, videoId: original.videoId, sourceRef: original.sourceRef ?? null,
      } : linked && linked.kind !== 'training' ? { sourceRef: { kind: 'learning_post', id: linked.id } }
        : { trainingId: draft.training || null, videoId: null, sourceRef: null };
      const operation = draft.operation || prepareSave(draft, draft.base, association, day());
      const localIds = operation.scope === 'team' ? operation.layout?.flatMap(p => p.localId ? [p.localId] : []) || [] : [];
      const staged = [...new Set([...(draft.stagedImageIds || []), ...localIds])];
      patch({ operation, ...(staged.length && { stagedImageIds: staged }) });
      const saved = await saveIllustratedNote(ctx, operation, next => patch({ operation: next }), setProgress);
      ctx.signal.throwIfAborted();
      persistPrivateLayout(ctx.actorId, saved, operation);
      const kept = new Set(saved.photos?.map(p => p.id));
      await cancelDetachedNoteImages(ctx, staged.filter(id => !kept.has(id)));
      await refreshShares();
      let message = '复盘已保存';
      try {
        setDb(d => {
          const drafts = { ...d.drafts };
          delete drafts[key];
          return { ...d, drafts };
        }, true);
      } catch { message = '复盘已保存，本机草稿暂未清除。'; }
      notify(message);
      if (location.hash.slice(1) === path) back('/growth');
    } catch (e) {
      if (ctx.signal.aborted) return;
      setError(e.message || '保存失败，草稿已保留。');
      if (e.beforeSave)
        patch({ operation: null });
    } finally {
      active.current = false;
      setSaving(false);
    }
  }
  if (missingPictures) return <div className="page-width writer-page">
    <Back fallback={'/notes/' + encodeURIComponent(n.id)} />
    <PageHead title="编辑复盘" />
    <p>这篇复盘有保存在另一台设备或浏览器里的配图。请回到保存配图的浏览器编辑或分享。</p>
  </div>;
  const locked = saving || preparing || Boolean(draft.operation);
  return (
    <div className="page-width form-page writer-page">
      <Back fallback="/growth" />
      <PageHead title={n ? '编辑复盘' : '想和写'} description={db.profile.name + '的训练手记'} />
      <form className="edit-form writing-sheet" onSubmit={save}>
        <div className="writing-main">
          <label>
            标题
            <input
              required
              maxLength={60}
              readOnly={locked}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="写个标题吧"
            />
          </label>
          <NotePictureEditor draft={draft} patch={patch} saving={locked} preparing={preparing} onPreparing={setPreparing} />
        </div>
        <aside className="writing-side">
          <div className="editor-date">
            <DateMark value={n?.created || new Date().toISOString()} />
          </div>
          <div className="form-pair">
            <CategoryField
              label="复盘类别"
              value={draft.category}
              onChange={(category) => patch({ category })}
              names={noteCategoryNames}
              onCreate={addNoteCategory}
              disabled={locked}
              required
            />
            <label>
              关联来源<span className="label-lite" aria-hidden="true">选填</span>
              <select
                disabled={locked}
                value={draft.training || ''}
                onChange={(e) => patch({ training: e.target.value, associationChanged: true })}
              >
                <option value="">不关联来源</option>
                {topic && <option value={topicValue}>{n?.link?.title || db.collections?.find(c => c.id === topic)?.title || '原关联专题合集'}</option>}
                {draft.training && draft.training !== topicValue && !trainings.some((t) => t.id === draft.training) && (
                  <option disabled value={draft.training}>
                    原关联内容暂不可用
                  </option>
                )}
                {trainings.map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="note-publish-options">
              <label className="note-scope">
                可见范围
                <select disabled={locked} value={draft.scope} onChange={e => patch({ scope: e.target.value })}>
                  <option value="private">仅自己可见</option>
                  <option value="team">队内可读</option>
                </select>
              </label>
              {draft.scope === 'team' && (
                <label className="note-feed-choice">
                  <input type="checkbox" disabled={locked} checked={!!draft.publish}
                    onChange={e => patch({ publish: e.target.checked })} />
                  <span>同时发布到队内动态</span>
                </label>
              )}
            </div>
          </div>
          {attempt && (!hasContent || !draft.title.trim()) && (
            <p role="alert" className="form-error">
              请填写标题和复盘内容。
            </p>
          )}
          {notePhotos(draft).some(p => p.localId) && <p className="field-hint">{draft.scope === 'team'
            ? '保存时会先上传本机配图，再开放队内阅读。'
            : '新加入的配图仅保存在当前浏览器，其他设备暂时看不到。'}</p>}
          <div className="form-end">
            <span>{storageError ? '本机暂存失败，请保留本页并保存复盘。' : db.drafts[key] ? '草稿已暂存于本机' : '草稿将自动暂存'}</span>
            <button className="btn primary" type="submit" disabled={saving || preparing}>
              <Check size={16} />
              {saving ? progress || '正在保存…' : draft.operation ? '确认保存结果' : '保存复盘'}
            </button>
          </div>
          {sourceUnavailable && <p role="status">原来源已不可用，你仍可保存本机草稿。</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </aside>
      </form>
    </div>
  );
}
export function NoteSharing({note}) {
  const {ctx} = useData();
  const [confirmed,setConfirmed] = useState(note);
  useTitle('分享与发布');
  return <div className="page-width writer-page note-sharing-page">
    <Back fallback={'/notes/' + encodeURIComponent(note.id)} />
    <PageHead title="分享与发布" />
    {confirmed.hasLocalPhotos ? <section className="sharing-card">
      <h2>分享图文复盘</h2>
      {readPrivateLayout(ctx.actorId, confirmed) ? <>
        <p>保存后，本机配图将随正文一起开放给队友阅读。</p>
        <NavLink className="btn primary" to={'/notes/' + encodeURIComponent(note.id) + '/edit?share=team'}>上传配图并设置分享</NavLink>
      </> : <p>配图保存在另一台设备或浏览器。请从保存配图的浏览器分享。</p>}
    </section> : <ReflectionSharingControls actorId={ctx.actorId} reflection={confirmed} authorize={ctx.authorize}
      isCurrent={ctx.isCurrent} subscribe={ctx.subscribe} refresh={ctx.refresh}
      onVerified={next=>{setConfirmed(next);void ctx.refresh().catch(()=>{});}} />}
  </div>;
}

export function NoteDetail({ n }) {
  const title = n.title || '训练复盘';
  useTitle(title);
  const { db, trainings, deleteNote, ctx, refreshShares, notify } = useData(),
    t = trainings.find((t) => t.id === n.training);
  const href = n.link?.href.replace(/^\/learn\/posts\//, '/trainings/').replace(/^\/learn\/collections\//, '/collections/');
  return (
    <div className="page-width prose-page">
      <Back fallback="/growth" />
      <article className="reader">
        <div className="reader-meta">
          <span>
            <DateMark value={n.created} />
          </span>
          <span>
            {n.author || db.profile.name}
            <small>{n.scope === 'team' ? '队内可读' : '仅自己可见'}
              {n.ownerId === 'me' && <> · <NavLink className="reader-sharing" to={'/notes/' + encodeURIComponent(n.id) + '/sharing'}>分享设置</NavLink></>}
            </small>
          </span>
          {n.ownerId !== 'me' && <IconButton icon={Bookmark}
            label={db.saved['reflection:' + n.id] ? '移除收藏' : '收藏复盘'}
            onClick={async () => {
              try {
                const existing = db.saved['reflection:' + n.id];
                if (existing) await removeBookmark(ctx, existing);
                else await ctx.write('collections', 'POST', { sourceKind: 'reflection', sourceId: n.id, privateNote: '' });
                await refreshShares();
                notify(existing ? '已移除收藏' : '已收藏复盘');
              } catch (err) { notify(err.message); }
            }} />}
          {n.ownerId === 'me' && (
            <div className="detail-management">
              <Tip label="编辑复盘">
                <NavLink className="icon-button" aria-label="编辑复盘" to={'/notes/' + encodeURIComponent(n.id) + '/edit'}>
                  <Pencil size={18} aria-hidden="true" />
                </NavLink>
              </Tip>
              <DeleteAction iconOnly label="删除复盘" title={n.title} description={n.scope === 'team'
                ? '将从成长记录和队内动态移除，原来的复盘链接也将失效。' : '将从你的成长记录中移除。'}
                onDelete={() => deleteNote(n)} to="/growth" />
            </div>
          )}
        </div>
        <div className="reader-topic" role="group" aria-label="复盘类别">
          <Tag size={14} aria-hidden="true" />
          <span>{noteCategoryLabel(n)}</span>
        </div>
        <h1>
          <span data-photo-destination={'note:' + n.id}>{title}</span>
        </h1>
        <IllustratedNote key={n.id} note={{ parts: savedParts(ctx.actorId, n) }} />
        {n.hasLocalPhotos && <p className="field-hint">{readPrivateLayout(ctx.actorId, n)
          ? '私人配图保存在当前浏览器。'
          : '私人配图保存在原来的设备或浏览器，可在那里查看。'}</p>}
      </article>
      {href && (
        <NavLink className="reader-related" to={href}>
          <img src={fieldPhoto(t)} alt="" />
          <span>
            关联来源<strong>{n.link.title}</strong>
          </span>
          <ArrowUpRight size={21} />
        </NavLink>
      )}
      {n.scope === 'team' && <DiscussionPanel kind="reflection" id={n.id} />}
    </div>
  );
}
