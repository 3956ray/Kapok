import { TextLinks } from '../components/learning-text';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Download,
  Layers,
  ListOrdered,
  Pencil,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Share2,
} from 'lucide-react';
import { NavLink, useNav, useTitle } from './router';
import { MediaCover } from './press';
import { kindName, shortDate, useData } from './store';
import { Back, Empty, IconButton, Modal, PageHead, Segments, Tip, usePreference } from './ui';
import { trainingCategory, trainingCategoryNames } from './categories.js';
import { catalogEntries, inTrainingCatalog, matchText } from './collection-model';
import { chapterPath, presentTopic, readChapter } from './topics.js';
import { DeleteCollection } from './collection-actions';
import { TrainingReader } from './training';

export function LibraryNav({ active }) {
  return (
    <nav className="library-switch" aria-label="训练室分区">
      <NavLink to="/trainings" aria-current={active === 'archive' ? 'page' : undefined}>
        训练档案
      </NavLink>
      <NavLink to="/collections" aria-current={active === 'collections' ? 'page' : undefined}>
        训练合集
      </NavLink>
    </nav>
  );
}

export function FeedStatus() {
  const { sharesError, refreshShares } = useData();
  return sharesError ? (
    <p className="feed-status" role="status">
      {sharesError} <button onClick={refreshShares}>重新读取</button>
    </p>
  ) : null;
}

export function Collections() {
  useTitle('训练合集');
  const { collections, remoteCollections, trainings, categoryNames, ctx } = useData();
  const [filter, setFilter] = usePreference('collection-category', '全部');
  const [query, setQuery] = usePreference('collection-search', '');
  const [featured,setFeatured] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    ctx.read('learning/featured', controller.signal).then(data => {
      if (!controller.signal.aborted) setFeatured(data.collections.map(c=>c.id));
    }).catch(()=>{ if (!controller.signal.aborted) setFeatured([]); });
    return () => controller.abort();
  },[ctx]);
  const entries = catalogEntries(collections.filter(inTrainingCatalog), remoteCollections, trainings);
  const categories = ['全部', ...trainingCategoryNames([...categoryNames, ...entries.map(c => c.category)])];
  const activeFilter = categories.includes(trainingCategory(filter)) ? trainingCategory(filter) : '全部';
  const createPath =
    '/collections/new' +
    (activeFilter === '全部' ? '' : '?category=' + encodeURIComponent(activeFilter));
  const visible = entries.filter(
    (c) =>
      (activeFilter === '全部' || c.category === activeFilter) &&
      matchText(query, c.title, c.summary, c.author, c.category, c.contents),
  );
  return (
    <div className="page-width collection-page">
      <PageHead
        title="训练合集"
        action={
          <NavLink to={createPath} className="btn primary">
            <Plus size={16} />
            新建合集
          </NavLink>
        }
      />
      <LibraryNav active="collections" />
      {featured.some(key => entries.some(e=>e.key===key && e.count)) && <section className="desk-picks" aria-label="队内精选合集">
        <h2>队内精选</h2>{featured.map(key => {
          const entry=entries.find(e=>e.key===key && e.count);
          return entry && <NavLink key={key} to={entry.href}>{entry.title}<ArrowUpRight size={16}/></NavLink>;
        })}
      </section>}
      <div className="catalog-controls">
        <span>{entries.length} 份合集</span>
        <label className="folio-search">
          <Search size={16} />
          <input
            type="search"
            aria-label="搜索合集"
            placeholder="搜索合集或编者"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <Segments label="合集类别" value={activeFilter} onChange={setFilter} items={categories}>
        <div className="collection-shelf">
          {visible.map((c, i) => (
            <article key={c.key} className={'shelf-entry' + (i === 0 ? ' shelf-first' : '')}>
              <NavLink
                className="shelf-cover"
                to={c.href}
                photoKey={'collection:' + c.key}
                aria-label={'打开合集：' + c.title}
                tabIndex={-1}
                aria-hidden="true"
              >
                <MediaCover item={c.cover} collectionCover={c.coverUrl}
                  alt=""
                  loading={i === 0 ? 'eager' : 'lazy'}
                  data-photo-key={'collection:' + c.key}
                />
              </NavLink>
              <div className="shelf-description">
                <div className="folio-byline">
                  <span>{c.category}</span>
                  <i />共 {c.count} 项
                </div>
                <h2>
                  <NavLink to={c.href} photoKey={'collection:' + c.key}>
                    {c.title}
                  </NavLink>
                </h2>
                {c.summary && <p><TextLinks text={c.summary}/></p>}
                <div className="shelf-signature">
                  <span>{c.author} 编选</span>
                  <NavLink to={c.href + '?view=contents'} aria-label={'翻开目录：' + c.title}>
                    <ArrowRight size={20} />
                  </NavLink>
                </div>
              </div>
            </article>
          ))}
        </div>
        {!visible.length && (
          <Empty
            icon={Layers}
            title={query ? '没有找到这份合集' : '这个类别还没有合集'}
            text={query ? '试试内容名称、类别或编者的名字。' : undefined}
            action={
              query ? (
                <button className="btn" onClick={() => setQuery('')}>
                  清除搜索
                </button>
              ) : (
                <NavLink
                  className="btn"
                  to={'/collections/new?category=' + encodeURIComponent(activeFilter)}
                >
                  新建合集
                </NavLink>
              )
            }
          />
        )}
      </Segments>
      <FeedStatus />
    </div>
  );
}

function Sharing({ collection, close }) {
  const { ctx } = useData();
  const [id,setId] = useState(collection.editionId || ''), [attempt,retry] = useState(0);
  const operation = useRef(null);
  const input = useRef(null);
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exporter = useRef(null);
  useEffect(() => () => exporter.current?.abort(), []);
  async function download() {
    if (!id || exporter.current) return;
    const controller = new AbortController();
    exporter.current = controller;
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    setExporting(true);
    setExportError('');
    try {
      const { exportTopicHtml } = await import('./topic-export.js');
      const {file,name} = await exportTopicHtml(ctx,id,signal);
      signal.throwIfAborted();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href=url; anchor.download=name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (!signal.aborted) setExportError(err.message || '暂时无法导出，请重试。');
    } finally {
      exporter.current = null;
      if (!signal.aborted) setExporting(false);
    }
  }
  useEffect(() => {
    if (id) return;
    let active = true;
    operation.current ??= crypto.randomUUID();
    ctx.write('workspace/topics/' + collection.id + '/share','POST',{expectedPublishedVersion:collection.version},operation.current)
      .then(row => { if (active) setId(row.id); }).catch(e => { if (active) setError(e.message || '暂时无法生成分享链接。'); });
    return () => { active = false; };
  },[ctx,collection.id,collection.version,id,attempt]);
  const address = id && new URL('/learn/shares/' + encodeURIComponent(id), location.origin).href;
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true); setError(''); }
    catch { input.current?.select(); setError('链接已选中，可以手动复制。'); }
  }
  return <Modal open onOpenChange={open => { if (!open) close(); }} title="分享合集" description="队友登录后可按此版目录阅读。条目内容和访问权限会随来源更新。">
    <div className="share-choices"><section>
      <h3>队内分享链接</h3>
      {id ? <>
      <label className="sr" htmlFor="collection-share-link">分享链接</label>
      <input id="collection-share-link" ref={input} readOnly value={address} onFocus={e => e.currentTarget.select()} />
      <div className="share-buttons">
        <button type="button" className="btn primary" onClick={copy}>{copied ? <Check size={15}/> : <Copy size={15}/>}{copied ? '已复制链接' : '复制链接'}</button>
        <a className="ink-link" href={address} target="_blank" rel="noreferrer">预览分享 <ExternalLink size={14}/></a>
      </div></> : error ? <button className="btn" onClick={() => {setError('');retry(n=>n+1);}}>重新生成</button> : <p role="status">正在生成分享链接…</p>}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section>
      <h3>离线阅读</h3>
      <p>下载单份 HTML，离线阅读你已发布的文字、配图和上传视频。队友的资料保留队内链接，外部视频需联网观看。下载后的文件保留导出时的内容。</p>
      <button type="button" className="btn" disabled={!id || exporting} onClick={download}>
        <Download size={15}/>{exporting ? '正在整理文件…' : '导出离线版'}
      </button>
      {exportError && <p className="form-error" role="alert">{exportError}</p>}
    </section></div>
  </Modal>;
}

export function CollectionView({ collection, sharedId, itemId, materialId }) {
  const { db, saveCollection } = useData();
  const { go, back, params } = useNav();
  const [share, setShare] = useState(false);
  const [full, setFull] = useState(false);
  const navigatorPosition = useRef(null);
  const returning = useRef(false);
  const takePosition = useCallback(index => {
    const previous = navigatorPosition.current;
    navigatorPosition.current = null;
    return previous?.index === index ? previous : null;
  }, []);
  const contentsRequested = params.get('view') === 'contents';
  const contentsRef = useRef(null);
  const { title, summary, category, author, items, created } = collection;
  const base = sharedId ? '/shared/' + sharedId : '/collections/' + collection.id;
  const savedKey = collection.id;
  const saved = !!db.savedCollections[savedKey];
  const index = itemId ? items.findIndex((t) => t.id === itemId) : -1;
  const item = items[index];
  function showContents() {
    const el = contentsRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  useEffect(() => {
    if (!itemId && (contentsRequested || returning.current)) {
      returning.current = false;
      const frame = requestAnimationFrame(showContents);
      return () => cancelAnimationFrame(frame);
    }
  }, [itemId, contentsRequested]);
  useTitle(item ? item.title + ' · ' + title : title);
  if (itemId && (!item || (materialId && item.href.split('?')[0] !== '/trainings/' + materialId)))
    return (
      <ReaderProblem title="合集里没有这一项" to={base} text="打开目录可以查看这个版本的全部内容。" />
    );
  function returnToIndex() {
    if (history.state?.kapokFrom?.split('?')[0] === base) {
      returning.current = true;
      back(base);
    } else go(base + '?view=contents', { replace:true });
  }
  if (item) {
    const video = item.reference.kind === 'video' ? item.reference.id : params.get('video');
    return <ChapterLoader key={item.id} collection={collection} item={item} video={video} base={base}
      backControl={<button className="back-link" type="button" onClick={returnToIndex}><ArrowLeft size={15} />返回目录</button>}
      videoPath={id => item.reference.kind === 'video' && id !== video ? item.href.split('?')[0] + '?video=' + encodeURIComponent(id) : chapterPath(item,base,id)}
      collectionNav={<CollectionNavigator title={title} items={items} index={index} takePosition={takePosition}
        onChoose={(i,position) => {
          navigatorPosition.current = position;
          go(chapterPath(items[i],base), {replace:true});
        }} onContents={returnToIndex} />} />;
  }
  const cover = items[0];
  return (
    <div className="page-width collection-detail">
      <div className="detail-toolbar">
        <Back fallback="/collections" />
        {!sharedId && collection.ownerId === 'me' && <DeleteCollection collection={collection} />}
      </div>
      <article className="folio-jacket">
        <div className="folio-jacket-print">
          <MediaCover item={cover} collectionCover={collection.coverUrl}
            alt=""
            data-photo-destination={'collection:' + (collection.id)}
          />
        </div>
        <div className="jacket-copy">
          <div className="jacket-top">
            <div className="folio-byline">
              <span>{category}</span>
              <i />
              {sharedId ? '分享版本' : '训练合集'}
            </div>
            <button type="button" onClick={showContents}>
              <ListOrdered size={14} />
              跳至目录
            </button>
          </div>
          <h1>{title}</h1>
          {summary && (
            <p id="jacket-summary" className={full ? '' : 'jacket-excerpt'}>
              <TextLinks text={summary}/>
            </p>
          )}
          {(summary?.length > 90 || summary?.split('\n').length > 3) && (
            <button
              type="button"
              className="jacket-disclosure"
              aria-expanded={full}
              aria-controls="jacket-summary"
              onClick={() => setFull(!full)}
            >
              {full ? '收起简介' : '展开简介'}
            </button>
          )}
          <div className="jacket-imprint">
            <span>{author} 编选</span>
            <time dateTime={created}>{shortDate(created)}</time>
          </div>
        </div>
      </article>
      <div className="contents-bar" ref={contentsRef} tabIndex={-1} role="region" aria-label="合集目录">
        <div>
          <h2>目录</h2>
          <span>{items.length} 项</span>
        </div>
        <div className="contents-actions icon-actions material-actions">
          {!sharedId && collection.ownerId === 'me' && (
            <Tip label="编辑合集"><NavLink className="icon-button" to={base + '/edit'} aria-label="编辑合集">
              <Pencil size={18} aria-hidden="true" />
            </NavLink></Tip>
          )}
          <IconButton
            disabled={!collection.published}
            icon={Bookmark}
            label={saved ? '取消收藏合集' : '收藏合集'}
            aria-pressed={saved}
            className={saved ? 'saved' : ''}
            onClick={() => saveCollection(savedKey, { title, category, author, href: base })}
          />
          <IconButton icon={Share2} label="分享" disabled={!collection.published || !items.length} onClick={() => setShare(true)} />
        </div>
      </div>
      <ol className="folio-contents">
        {items.map((t, i) => (
          <li key={t.id}>
            <NavLink
              to={chapterPath(t,base)}
              className="contents-entry"
              aria-label={'阅读第 ' + (i + 1) + ' 项：' + t.title}
            >
              <span className="folio-index">{String(i + 1).padStart(2, '0')}</span>
              <MediaCover item={t} alt="" loading="lazy" />
              <div>
                <small>
                  {kindName[t.kind]} <i>/</i> {t.author}
                </small>
                <h3>{t.title}</h3>
              </div>
              <ArrowUpRight size={21} />
            </NavLink>
          </li>
        ))}
      </ol>
      {!items.length && <p className="folio-empty">目录暂时为空。{collection?.ownerId === 'me' && '打开「编辑合集」可以添加内容。'}</p>}
      {share && (
        <Sharing collection={collection} close={() => setShare(false)} />
      )}
    </div>
  );
}

function ChapterLoader({ collection, item, video, base, ...controls }) {
  const { ctx } = useData();
  const { params } = useNav();
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt(n => n + 1);
  useEffect(() => {
    const controller = new AbortController();
    const commit = value => {
      if (!controller.signal.aborted) setResult({ctx, item, collection, video, attempt, ...value});
    };
    readChapter(ctx, item, collection, controller.signal, video)
      .then(data => commit({data}), e => commit({error:e.message || '暂时无法读取这项内容。'}));
    return () => controller.abort();
  }, [ctx, item, collection, video, attempt]);
  if (result?.ctx !== ctx || result.item !== item || result.collection !== collection || result.video !== video || result.attempt !== attempt)
    return <p className="page-width pending-reader" role="status">正在读取内容…</p>;
  if (result.error) return <ReaderProblem title="暂时打不开这一项" text={result.error} to={base} retry={reload} />;
  return <TrainingReader key={[result.data.id, result.data.selectedVideo?.id, params.get('t')].join(':')}
    t={result.data} reload={reload} {...controls} />;
}

function CollectionNavigator({ title, items, index, takePosition, onChoose, onContents }) {
  const bar = useRef(null);
  const touch = useRef(null);
  const count = items.length;
  const start = Math.max(0, Math.min(index - 1, count - 3));
  const titleAction = index === count - 1 ? '读完，返回目录' : '打开合集目录：' + title;

  useLayoutEffect(() => {
    const previous = takePosition(index);
    if (!previous) return;
    const target = bar.current;
    if (previous.wasScrolled || target.getBoundingClientRect().bottom > window.innerHeight)
      window.scrollBy({ top: target.getBoundingClientRect().top - previous.top, behavior: 'instant' });
    const control = previous.step && target.querySelector('[data-step="' + previous.step + '"]:not(:disabled)');
    (control || target.querySelector('[aria-current="page"]'))?.focus({ preventScroll: true });
  }, [index, takePosition]);

  function choose(next) {
    if (next < 0 || next >= count || next === index) return;
    const top = bar.current.getBoundingClientRect().top;
    const wasScrolled = window.scrollY > 0;
    const step = document.activeElement?.dataset.step;
    onChoose(next, { index:next, top, wasScrolled, step });
  }

  function arrowKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  }

  function endSwipe(event) {
    const from = touch.current;
    touch.current = null;
    if (!from || event.touches.length || event.changedTouches.length !== 1) return;
    const point = event.changedTouches[0];
    const dx = point.clientX - from.x;
    if (Math.abs(dx) < 40 || Math.abs(dx) < 1.5 * Math.abs(point.clientY - from.y)) return;
    event.preventDefault();
    choose(index + (dx < 0 ? 1 : -1));
  }

  return (
    <nav ref={bar} className="collection-navigator" aria-label="合集翻页" onKeyDown={arrowKey}
      onTouchStart={event => {
        const point = event.touches[0];
        touch.current = event.touches.length === 1 ? { x: point.clientX, y: point.clientY } : null;
      }}
      onTouchEnd={endSwipe} onTouchCancel={() => { touch.current = null; }}>
      <Tip label="查看合集目录">
        <button className="collection-location" type="button" aria-label={titleAction} onClick={onContents}>
          <small>合集 · {index + 1} / {count}</small>
          <strong>{title}</strong>
        </button>
      </Tip>
      <div className="collection-controls">
        {count > 1 && <div className="collection-switch">
          <IconButton label="上一项" data-step="prev" icon={ChevronLeft} disabled={index === 0}
            onClick={() => choose(index - 1)} />
          <div className="collection-numbers">
            {items.slice(start, start + 3).map((item, offset) => {
              const i = start + offset;
              return <Tip key={i} label={item.title}>
                <button type="button" className="collection-number" aria-label={'第 ' + (i + 1) + ' 项：' + item.title}
                  aria-current={i === index ? 'page' : undefined} onClick={() => choose(i)}>
                  <span>{String(i + 1).padStart(2, '0')}</span>
                </button>
              </Tip>;
            })}
          </div>
          <IconButton label="下一项" data-step="next" icon={ChevronRight} disabled={index === count - 1}
            onClick={() => choose(index + 1)} />
        </div>}
        <IconButton className="collection-directory" label="查看合集目录" icon={ListOrdered} onClick={onContents} />
      </div>
    </nav>
  );
}

function ReaderProblem({ title, text, to = '/collections', retry }) {
  useTitle(title);
  return (
    <div className="page-width reader-problem">
      <Empty
        level={1}
        icon={BookOpen}
        title={title}
        text={text}
        action={
          <div className="share-buttons">
            {retry && (
              <button type="button" className="btn" onClick={retry}>
                重试
              </button>
            )}
            <NavLink className="btn" to={to}>
              {to === '/collections' ? '浏览训练合集' : '查看合集目录'}
            </NavLink>
          </div>
        }
      />
    </div>
  );
}

export function SharedCollection({ id, itemId, materialId }) {
  const { collections, ctx, trainings } = useData();
  const [edition,setEdition] = useState(null), [error,setError] = useState(''), [attempt,retry] = useState(0);
  // Links copied before versioned directories were introduced still resolve by publication id.
  const current = collections.find(c => c.id === id && c.published);
  useEffect(() => {
    if (current) return;
    const controller = new AbortController();
    ctx.read('workspace/topic-shares/' + encodeURIComponent(id),controller.signal).then(row => {
      if (!controller.signal.aborted) setEdition({ ...presentTopic(row,trainings,id), published:true, editionId:id });
    }).catch(e => { if (!controller.signal.aborted) {setEdition(null);setError(e.message || '分享已撤下。');} });
    return () => controller.abort();
  },[ctx,id,current,attempt,trainings]);
  if (error && !current) return <ReaderProblem title="暂时打不开这份分享" text={error} retry={() => {setError('');retry(n=>n+1);}} />;
  const collection = current || edition;
  if (!collection) return <p className="page-width pending-reader" role="status">正在打开合集…</p>;
  return <CollectionView collection={collection} sharedId={id} materialId={materialId} itemId={itemId}/>;
}
