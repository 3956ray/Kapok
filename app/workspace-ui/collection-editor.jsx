import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Search, X } from 'lucide-react';
import { isDailyArticle } from '../../lib/contracts/learning.ts';
import { CategoryField } from './category-field';
import { matchText } from './collection-model';
import { DeleteCollection } from './collection-actions';
import { saveTopic } from './topics';
import { kindName, uid, useData } from './store';
import { NavLink, useNav, useTitle } from './router';
import { Back, IconButton, PageHead } from './ui';
import { prepareCollectionCover } from './profile-avatar.js';
import { MediaCover } from './press';

const videoEntry = id => typeof id === 'string' && /^video:[\w-]{1,128}$/.test(id);

function readDraft(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

export function CollectionEditor({ collection: entry }) {
  const collection = entry?.draft || entry;
  const { trainings, ctx, refreshShares, notify, categoryNames, addCategory } = useData();
  const { pathname, params, go, back } = useNav();
  const heading = collection ? '编辑合集' : '新建合集';
  useTitle(heading);
  const key = 'kapok:topic-draft:' + ctx.actorId + ':' + pathname;
  const pickKey = 'kapok:topic-pick:' + ctx.actorId + ':' + pathname;
  const [form, setForm] = useState(() => {
    const stored = readDraft(key);
    const saved = stored?.baseVersion === (collection?.version || 0) ? stored : null;
    const incoming = params.get('item');
    const initial = saved || {
      title: collection?.title || '',
      summary: collection?.summary || '',
      category:
        collection?.category ||
        (categoryNames.includes(params.get('category')) ? params.get('category') : '基础'),
      itemIds: collection?.itemIds || [],
    };
    let returned;
    try {
      returned = sessionStorage.getItem(pickKey);
    } catch {}
    const requested = [incoming !== saved?.originItem && incoming, returned, params.get('added')].filter(
      (id) => videoEntry(id) || (id && trainings.some((t) => t.id === id && !isDailyArticle(t))),
    );
    return {
      ...initial,
      baseVersion: collection?.version || 0,
      draftId: initial.draftId || collection?.id || uid(),
      originItem: incoming,
      itemIds: [...new Set([...initial.itemIds, ...requested])],
    };
  });
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all');
  const [error, setError] = useState(''),
    [announcement, setAnnouncement] = useState('');
  const [emptyError, setEmptyError] = useState(false);
  const [sending, setSending] = useState(false);
  const request = useRef(null);
  const coverRequest = useRef(null);
  const [preparing, setPreparing] = useState(false);
  const coverUrl = form.cover === undefined ? collection?.coverUrl : form.cover;
  useEffect(() => () => coverRequest.current?.abort(), []);
  async function pickCover(file) {
    if (!file || coverRequest.current || request.current) return;
    const controller = new AbortController();
    coverRequest.current = controller;
    setPreparing(true);
    try {
      const cover = await prepareCollectionCover(file);
      if (!controller.signal.aborted) patch({ cover });
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message);
    } finally {
      coverRequest.current = null;
      if (!controller.signal.aborted) setPreparing(false);
    }
  }
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    try {
      sessionStorage.removeItem(pickKey);
    } catch {}
  }, [pickKey]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(form));
    } catch {}
  }, [form, key]);
  const available = new Map([...trainings, ...(collection?.items || [])].map(item => [item.id, item]));
  // A directory can include one specific clip from a multi-video training.
  // Restore those selections from the member API even after leaving the editor and returning to its draft.
  const unresolved = form.itemIds.filter(id => videoEntry(id) && !available.has(id)).join(',');
  const [resolved, setResolved] = useState(null);
  const [clipAttempt, retryClips] = useState(0);
  useEffect(() => {
    if (!unresolved) return;
    const controller = new AbortController();
    Promise.all(unresolved.split(',').map(async id => {
      const clipId = id.slice(6);
      const clip = await ctx.read('videos/' + encodeURIComponent(clipId),controller.signal);
      if (!clip.trainingId || clip.status !== 'active') throw new Error('所选视频已不可用。');
      return { id, title:clip.title, kind:'video', reference:{kind:'video', id:clipId},
        href:'/trainings/' + clip.trainingId + '?video=' + clipId,
        platformCover:'/api/v1/video-covers/video/' + clipId };
    })).then(rows => {
      if (!controller.signal.aborted) setResolved({ctx,unresolved,rows});
    }, err => {
      if (!controller.signal.aborted) setResolved({ctx,unresolved,error:err.message || '所选视频暂时无法读取。'});
    });
    return () => controller.abort();
  }, [ctx,unresolved,clipAttempt]);
  const clips = resolved?.ctx === ctx && resolved.unresolved === unresolved ? resolved : null;
  for (const item of clips?.rows || []) available.set(item.id,item);
  const selected = form.itemIds.map(id => available.get(id)).filter(Boolean);
  const choices = [...available.values()].filter(t => t.reference || (t.kind === 'training' ? ['published','archived'].includes(t.status) : !t.isDraft)).filter(
    (t) =>
      !isDailyArticle(t) && (kind === 'all' || t.kind === kind) &&
      matchText(query, t.title, t.summary, t.author, t.category, t.body),
  );
  function patch(changes) {
    setForm((old) => ({ ...old, ...changes }));
    setError('');
    if (changes.itemIds?.length) setEmptyError(false);
  }
  function focusOrder(id, action) {
    requestAnimationFrame(() => {
      const row = document.getElementById('ordered-' + id);
      const target =
        row?.querySelector('button[data-order="' + action + '"]:not(:disabled)') ||
        row?.querySelector('button:not(:disabled)') ||
        document.getElementById('collection-picks');
      target?.focus();
    });
  }
  function toggle(t, fromOrder = false) {
    const wasSelected = form.itemIds.includes(t.id);
    patch({ itemIds: wasSelected ? form.itemIds.filter((id) => id !== t.id) : [...form.itemIds, t.id] });
    setAnnouncement(t.title + (wasSelected ? '已移出目录' : '已加入目录'));
    if (fromOrder) {
      const pos = form.itemIds.indexOf(t.id);
      focusOrder(form.itemIds[pos + 1] || form.itemIds[pos - 1], 'remove');
    }
  }
  function move(index, delta) {
    const ids = [...form.itemIds],
      next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    patch({ itemIds: ids });
    setAnnouncement(selected[index].title + '已移到第 ' + (next + 1) + ' 项');
    focusOrder(ids[next], delta < 0 ? 'up' : 'down');
  }
  function clear() {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  }
  function jump(id) {
    const heading = document.getElementById(id);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  async function save(e) {
    e.preventDefault();
    if (request.current || coverRequest.current || (unresolved && !clips?.rows)) return;
    if (!form.title.trim()) {
      setError('请填写合集名称。');
      return;
    }
    if (!selected.length) {
      setEmptyError(true);
      document.getElementById('collection-picks')?.focus();
      return;
    }
    if (selected.length !== form.itemIds.length) { setError('部分内容已失效，请重新打开合集。'); return; }
    let result;
    const controller = new AbortController();
    request.current = controller;
    setSending(true);
    setError('');
    try {
      const fingerprint = JSON.stringify([form.draftId, form.baseVersion, form.title, form.summary, form.category, form.itemIds, ...(form.cover !== undefined ? [form.cover] : [])]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
      const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
      result = await saveTopic(ctx, collection, form, selected, key);
      await refreshShares();
      if (controller.signal.aborted) return;
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message || '暂时无法发布，可以重试。');
      return;
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setSending(false);
    }
    clear();
    notify(collection ? '合集已更新' : '合集已发布');
    const dest = '/collections/' + result.id;
    if (history.state?.kapokFrom?.split('?')[0] === dest) back(dest);
    else go(dest, { replace: true });
  }
  return (
    <div className="page-width collection-editor form-page">
      <Back fallback={collection ? '/collections/' + collection.id : '/collections'} />
      <PageHead title={heading} />
      <form className="edit-form folio-form" onSubmit={save}>
        <section className="folio-fields" aria-label="合集资料">
          <label>
            合集名称
            <input
              value={form.title}
              required
              pattern={'.*\\S.*'}
              title="请填写合集名称"
              maxLength={80}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="给这一组练习起个名字"
            />
          </label>
          <CategoryField
            value={form.category}
            onChange={(category) => patch({ category })}
            names={categoryNames}
            onCreate={addCategory}
          />
          <label className="folio-intro">
            合集简介<span className="label-lite">选填</span>
            <textarea
              rows={2}
              maxLength={1200}
              value={form.summary}
              onChange={(e) => patch({ summary: e.target.value })}
              placeholder="队友可以按什么顺序看？"
            />
          </label>
          <div className="collection-cover-field">
            {coverUrl && <img src={coverUrl} alt="自选合集封面" />}
            <div><strong>合集封面 <small>选填</small></strong>
              <p>{coverUrl ? '仅用于这份合集。' : '默认使用目录第一项的封面。'}</p>
            </div>
            <label className="media-chooser">{preparing ? '处理中…' : coverUrl ? '更换图片' : '选择图片'}
              <input type="file" aria-label="选择合集封面" accept="image/jpeg,image/png,image/webp"
                disabled={preparing || sending} onChange={e => { pickCover(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {coverUrl && <button type="button" className="ink-link" disabled={preparing || sending}
              onClick={() => patch({ cover:null })}>恢复默认</button>}
          </div>
        </section>
        <div className="edit-spread">
          <section className="material-picker" aria-label="选择内容">
            <div className="folio-subhead">
              <h2
                id="collection-picks"
                tabIndex={-1}
                aria-describedby={emptyError ? 'pick-error' : undefined}
              >
                选择内容
              </h2>
              <button type="button" className="order-jump" onClick={() => jump('collection-order')}>
                查看已选 {selected.length} 项
              </button>
              <NavLink
                className="ink-link"
                to={'/trainings/new?returnTo=' + encodeURIComponent(pathname)}
              >
                <Plus size={14} />
                新增内容
              </NavLink>
            </div>
            {unresolved && !clips?.rows && (clips?.error
              ? <p role="alert">{clips.error} <button type="button" className="ink-link" onClick={() => retryClips(n => n + 1)}>重试</button>
                  <button type="button" className="ink-link" onClick={() => patch({itemIds:form.itemIds.filter(id => !unresolved.split(',').includes(id))})}>移出未读取的视频</button></p>
              : <p role="status">正在读取所选视频…</p>)}
            {emptyError && (
              <p id="pick-error" className="form-error" role="alert">
                请至少选一项内容，再发布合集。
              </p>
            )}
            <div className="picker-tools">
              <label className="folio-search">
                <Search size={16} />
                <input
                  type="search"
                  aria-label="搜索可选内容"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索内容、类别或作者"
                />
              </label>
              <select aria-label="筛选内容形式" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">所有形式</option>
                {Object.entries(kindName).map(([v, label]) => (
                  <option value={v} key={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="pick-list">
              {choices.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  aria-label={'收录：' + t.title}
                  aria-pressed={form.itemIds.includes(t.id)}
                  onClick={() => toggle(t)}
                >
                  <MediaCover item={t} alt="" loading="lazy" />
                  <span>
                    <strong>{t.title}</strong>
                    <small>
                      {kindName[t.kind]} · {t.author} · {t.category}
                    </small>
                  </span>
                  <i>{form.itemIds.includes(t.id) ? <Check size={15} /> : <Plus size={15} />}</i>
                </button>
              ))}
            </div>
            {!choices.length && (
              <p className="folio-empty">没有找到匹配的内容。可以换个关键词，或新增一条内容。</p>
            )}
          </section>
          <section className="selected-column" aria-label="已选目录">
            <div className="folio-subhead">
              <h2 id="collection-order" tabIndex={-1}>
                阅读顺序
              </h2>
              <span>{selected.length} 项</span>
              <button type="button" className="order-jump" onClick={() => jump('collection-picks')}>
                继续选内容
              </button>
            </div>
            {selected.length ? (
              <ol className="selected-list">
                {selected.map((t, i) => (
                  <li key={t.id} id={'ordered-' + t.id}>
                    <span className="folio-index">{String(i + 1).padStart(2, '0')}</span>
                    <strong>{t.title}</strong>
                    <div>
                      <IconButton
                        label={'上移：' + t.title}
                        data-order="up"
                        icon={ArrowUp}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      />
                      <IconButton
                        label={'下移：' + t.title}
                        data-order="down"
                        icon={ArrowDown}
                        disabled={i === selected.length - 1}
                        onClick={() => move(i, 1)}
                      />
                      <IconButton
                        label={'移除：' + t.title}
                        data-order="remove"
                        icon={X}
                        onClick={() => toggle(t, true)}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="folio-empty">从内容列表选取第一项，目录会依次排在这里。</p>
            )}
          </section>
        </div>
        <span className="sr" role="status">
          {announcement}
        </span>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-end">
          {collection && <DeleteCollection collection={collection} disabled={sending} />}
          <button
            className="btn"
            disabled={sending}
            type="button"
            onClick={() => {
              clear();
              back(collection ? '/collections/' + collection.id : '/collections');
            }}
          >
            取消编辑
          </button>
          <button className="btn primary" disabled={sending || preparing || Boolean(unresolved && !clips?.rows)} type="submit">
            <Check size={16} />
            {sending ? '正在发布…' : collection ? '保存合集修改' : '发布合集'}
          </button>
        </div>
      </form>
    </div>
  );
}
