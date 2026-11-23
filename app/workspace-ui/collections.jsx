import { useEffect, useRef, useState } from 'react';
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
  Play,
  Plus,
  Search,
  Share2,
} from 'lucide-react';
import { NavLink, useNav, useTitle } from './router';
import { fieldPhoto } from './press';
import { kindName, shortDate, useData } from './store';
import { Back, Empty, IconButton, Modal, PageHead, Segments, usePreference } from './ui';
import { trainingCategory, trainingCategoryNames } from './categories.js';
import { catalogEntries, inTrainingCatalog, matchText } from './collection-model';
import { presentTopic, readChapter } from './topics.js';
import { AddToCollection, DeleteCollection } from './collection-actions';
import { playbackPoints } from './timepoints.js';
import { ChapterList, useVideoPlayback } from './timepoint-controls.jsx';

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
                <img
                  src={fieldPhoto(c.cover)}
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
                {c.summary && <p>{c.summary}</p>}
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

export function CollectionView({ collection, sharedId, itemId }) {
  const { db, saveCollection } = useData();
  const { go, back, params } = useNav();
  const [share, setShare] = useState(false);
  const [full, setFull] = useState(false);
  const landing = useRef(true);
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
    if (!landing.current) return;
    landing.current = false;
    if (!itemId && contentsRequested) {
      const frame = requestAnimationFrame(showContents);
      return () => cancelAnimationFrame(frame);
    }
  }, [itemId, contentsRequested]);
  useTitle(item ? item.title + ' · ' + title : title);
  if (itemId && !item)
    return (
      <ReaderProblem title="合集里没有这一项" to={base} text="打开目录可以查看这个版本的全部内容。" />
    );
  function returnToIndex() {
    if (history.state?.kapokFrom?.split('?')[0] === base) back(base);
    else go(base, { replace: true });
  }
  if (item)
    return (
      <ChapterLoader collection={collection}
        key={item.id}
        item={item}
        base={base}
        index={index}
        items={items}
        title={title}
        sharedId={sharedId}
        onContents={returnToIndex}
      />
    );
  const cover = items[0];
  return (
    <div className="page-width collection-detail">
      <div className="detail-toolbar">
        <Back fallback="/collections" />
        {!sharedId && collection.ownerId === 'me' && <DeleteCollection collection={collection} />}
      </div>
      <article className="folio-jacket">
        <div className="folio-jacket-print">
          <img
            src={fieldPhoto(cover)}
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
              {summary}
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
        <div className="contents-actions">
          {!sharedId && collection.ownerId === 'me' && (
            <NavLink className="btn" to={base + '/edit'}>
              <Pencil size={14} />
              编辑合集
            </NavLink>
          )}
          <IconButton
            disabled={!collection.published}
            icon={Bookmark}
            label={saved ? '取消收藏合集' : '收藏合集'}
            aria-pressed={saved}
            className={saved ? 'saved' : ''}
            onClick={() => saveCollection(savedKey, { title, category, author, href: base })}
          />
          <button type="button" className="btn" disabled={!collection.published} onClick={() => setShare(true)}>
            <Share2 size={15} />
            分享
          </button>
        </div>
      </div>
      <ol className="folio-contents">
        {items.map((t, i) => (
          <li key={t.id}>
            <NavLink
              to={base + '/items/' + t.id}
              className="contents-entry"
              aria-label={'阅读第 ' + (i + 1) + ' 项：' + t.title}
            >
              <span className="folio-index">{String(i + 1).padStart(2, '0')}</span>
              <img src={fieldPhoto(t)} alt="" loading="lazy" />
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

function ChapterLoader({ collection, item, ...props }) {
  const { ctx } = useData();
  const [value, setValue] = useState(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readChapter(ctx,item,collection,controller.signal).then(data => {
      if (!controller.signal.aborted) setValue({ item, data });
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || '暂时无法读取这项内容。'); });
    return () => controller.abort();
  }, [ctx, item, collection, attempt]);
  if (error) return <ReaderProblem title="暂时打不开这一项" text={error} to={props.base}
    retry={() => { setError(''); setAttempt(n => n + 1); }} />;
  if (value?.item !== item) return <p className="page-width pending-reader" role="status">正在读取内容…</p>;
  return <Chapter {...props} item={value.data} />;
}

function Chapter({ item, items, index, title, base, sharedId, onContents }) {
  const { go } = useNav();
  const {stage,native,play,playhead,started,embedKey,embed,original,error} = useVideoPlayback(item.source);
  const file = item.videoAsset;
  const cover = fieldPhoto(item);
  function step(delta) {
    const next = items[index + delta];
    if (next) go(base + '/items/' + next.id, { replace: true });
  }
  return (
    <div className="page-width chapter-page">
      <button className="back-link" type="button" onClick={onContents}>
        <ArrowLeft size={15} />
        返回目录
      </button>
      <article className="chapter-reader">
        <div className="chapter-dateline">
          <span>{title}</span>
          <span>
            第 {index + 1} 项 / 共 {items.length} 项
          </span>
        </div>
        <header>
          <div className="folio-byline">
            <span>{kindName[item.kind]}</span>
            <i />
            {item.category}
          </div>
          <h1>{item.title}</h1>
          <div className="chapter-author">
            <span>{item.author}</span>
            <time dateTime={item.date}>{shortDate(item.date)}</time>
          </div>
        </header>
        {item.summary && <p className="chapter-intro">{item.summary}</p>}
        {item.source ? (
          <div className="chapter-media" ref={stage}>
            {started ? (
              <iframe
                key={embedKey}
                src={embed}
                title={item.title + ' 播放器'}
                allow="autoplay; fullscreen; picture-in-picture"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            ) : (
              <button type="button" onClick={() => play()}>
                <img src={cover} alt="" />
                <span>
                  <Play size={16} />
                  载入{item.source.platform}视频
                </span>
              </button>
            )}
            <a href={original} target="_blank" rel="noreferrer">
              在{item.source.platform}打开 <ExternalLink size={13} />
            </a>
          </div>
        ) : file ? (
          <video
            {...native}
            aria-label={item.title}
            controls
            playsInline
            preload="metadata"
            poster={cover}
            src={file}
          >
          </video>
        ) : null}
        {item.body && <div className="chapter-text">{item.body}</div>}
        {item.photos?.map((p, i) => (
          <figure key={p.url + i}>
            <img src={p.url} alt={p.alt || item.title + '配图 ' + (i + 1)} />
            {p.alt && <figcaption>{p.alt}</figcaption>}
          </figure>
        ))}
        {error && <p className="form-error" role="alert">{error}</p>}
        {(file || item.source) && <ChapterList points={playbackPoints(item)} playback={{play,playhead,started}} />}
        {!file && !item.source && item.steps?.length > 0 && (
          <section className="chapter-steps">
            <h2>动作要点</h2>
            <ol>
              {item.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        )}
        <div className="chapter-actions">
          {sharedId ? (
            <AddToCollection
              id={item.id}
              sharedItem={item}
            />
          ) : (
            <NavLink className="ink-link" to={item.href}>
              查看原内容与复盘 <ArrowUpRight size={15} />
            </NavLink>
          )}
        </div>
      </article>
      <nav className="chapter-nav" aria-label="合集翻页">
        <button type="button" disabled={index === 0} onClick={() => step(-1)}>
          <ArrowLeft size={15} />
          上一项
        </button>
        <button type="button" onClick={onContents}>
          <ListOrdered size={15} />
          目录
        </button>
        {index === items.length - 1 ? (
          <button type="button" onClick={onContents}>
            读完，返回目录
            <Check size={15} />
          </button>
        ) : (
          <button type="button" onClick={() => step(1)}>
            下一项
            <ArrowRight size={15} />
          </button>
        )}
      </nav>
    </div>
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

export function SharedCollection({ id, itemId }) {
  const { collections, ctx } = useData();
  const [edition,setEdition] = useState(null), [error,setError] = useState(''), [attempt,retry] = useState(0);
  // Links copied before versioned directories were introduced still resolve by publication id.
  const current = collections.find(c => c.id === id && c.published);
  useEffect(() => {
    if (current) return;
    const controller = new AbortController();
    ctx.read('workspace/topic-shares/' + encodeURIComponent(id),controller.signal).then(row => {
      if (!controller.signal.aborted) setEdition({ ...presentTopic(row), published:true, editionId:id });
    }).catch(e => { if (!controller.signal.aborted) {setEdition(null);setError(e.message || '分享已撤下。');} });
    return () => controller.abort();
  },[ctx,id,current,attempt]);
  if (error && !current) return <ReaderProblem title="暂时打不开这份分享" text={error} retry={() => {setError('');retry(n=>n+1);}} />;
  const collection = current || edition;
  if (!collection) return <p className="page-width pending-reader" role="status">正在打开合集…</p>;
  return <CollectionView collection={collection} sharedId={id} itemId={itemId}/>;
}
