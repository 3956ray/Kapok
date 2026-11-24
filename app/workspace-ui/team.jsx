import { NoteFeedPhoto } from './note-pictures';
import { TextLinks } from '../components/learning-text';
import { createRequestKey } from '../../lib/client/api';
import { ProfileForm } from './profile-form';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Camera, ShieldCheck, RotateCcw, LockKeyhole,
  ChevronLeft, ChevronRight, RefreshCw,
  BookOpen,
  Layers,
  LogOut,
  ArrowUpRight,
  Quote,
  ExternalLink,
  MessageSquare,
  Pencil,
  Search,
  Users,
} from 'lucide-react';
import { NavLink, useNav, useTitle } from './router';
import { Avatar, Empty, Modal, PageHead, Segments, usePreference } from './ui';
import { DateMark, teamPhoto, Jersey, newspaperDate } from './press';
import { eventTime, kindName, localDay, shortDate, useData, useRoster } from './store';
import { noteCategoryLabel } from './categories.js';
import { catalogEntries } from './collection-model';
import { FeedStatus } from './collections';
import { publishedRecords } from './published';
const activityPageSize = 12;
function compareActivity(a, b) {
  return eventTime(b.date) - eventTime(a.date) || a.key.localeCompare(b.key, 'en');
}

function dispatchRow(row) {
  const id=encodeURIComponent(row.source);
  if(row.kind==='reflection') return {...row,title:row.title || '无标题复盘',type:'复盘',n:{id:row.source,body:row.snippet,title:row.title || '无标题复盘'},href:'/notes/'+id};
  if (row.kind === 'training_video') return {...row,type:'视频',href:'/trainings/'+id+'?video='+encodeURIComponent(row.video)};
  if (row.kind === 'article' || row.kind === 'video') return {...row, type:kindName[row.kind], href:'/trainings/'+id};
  if(row.kind==='announcement') return {...row,type:'公告',href:'/announcements/'+id};
  const params=new URLSearchParams({comment:row.comment});
  if(row.video)params.set('video',row.video);
  if(row.key.startsWith('tc:'))params.set('thread','training');
  const section = row.kind === 'reflection_discussion' ? 'notes' : row.kind === 'announcement_discussion' ? 'announcements' : 'trainings';
  return {...row,type:'讨论',title:row.snippet,t:{id:row.source,title:row.title || (section==='notes' ? '无标题复盘' : '')},href:'/'+section+'/'+id+'?'+params};
}
export function Activity() {
  useTitle('队内动态');
  const { ctx, trainings, collections, remoteCollections, refreshShares } = useData();
  const [board,setBoard] = useState(null);
  const [boardRevision,reloadBoard] = useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    ctx.read('workspace/bulletin',controller.signal).then(value=>{
      if (!controller.signal.aborted) setBoard({ctx,item:value.item,fallback:value.fallback});
    },e=>{
      if (!controller.signal.aborted) setBoard({ctx,error:e.message});
    });
    return ()=>controller.abort();
  },[ctx,boardRevision]);
  const [filter, setFilter] = usePreference('activity-filter', '全部');
  const [anchor, setAnchor] = usePreference('activity-anchor', null);
  const [refreshing, setRefreshing] = useState(false);
  const heading = useRef(null);
  const pendingIndexScroll = useRef(null);
  function scrollToIndex() {
    heading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    if (!history.state?.activityIndex) history.replaceState({ ...history.state, activityIndex: true }, '');
  }
  useLayoutEffect(() => {
    if (history.state?.activityIndex && performance.getEntriesByType('navigation')[0]?.type === 'reload') {
      scrollToIndex();
    }
  }, []);
  useLayoutEffect(() => {
    if (!pendingIndexScroll.current) return;
    if (pendingIndexScroll.current === 'page') heading.current?.focus({ preventScroll: true });
    pendingIndexScroll.current = null;
    scrollToIndex();
  }, [anchor, filter]);
  const [feed,setFeed]=useState([]), [feedError,setFeedError]=useState(''), [reading,setReading]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    async function read(){
      const rows=[];let cursor;
      do {
        const page=await ctx.read('workspace/dispatch'+(cursor?'?cursor='+encodeURIComponent(cursor):''),controller.signal);
        rows.push(...page.items.map(dispatchRow));cursor=page.next;
      } while(cursor && !controller.signal.aborted);
      if(!controller.signal.aborted){setFeed(rows);setFeedError('');}
    }
    read().catch(e=>{if(!controller.signal.aborted){setFeed([]);setFeedError(e.message);}}).finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return ()=>controller.abort();
  },[ctx]);
  const entries = useMemo(()=>[
    ...trainings.filter(t=>t.published && t.kind === 'training').map(t=>({key:'t:'+t.id,type:kindName[t.kind],date:t.date,who:t.author,title:t.title,href:'/trainings/'+t.id,t})),
    ...catalogEntries(collections.filter(c=>c.published),remoteCollections,trainings).map(volume=>({key:'v:'+volume.key,type:'合集',date:volume.date,who:volume.author,title:volume.title,href:volume.href,volume})),
    ...feed,
  ].sort(compareActivity),[trainings,collections,remoteCollections,feed]);
  const currentBoard = board?.ctx===ctx ? board : null;
  const pin = currentBoard?.item;
  const lead = pin || currentBoard?.fallback;
  const cover = lead?.cover || (lead?.type==='训练' ? '/workspace-assets/media/sideline-team.webp' : null);
  const photoKey = lead?.type==='训练' ? 'dispatch:'+lead.href.slice('/trainings/'.length) : undefined;
  const canEdit = ctx.account.membership.role==='admin' && ctx.account.membership.status==='active';
  const voices = entries.filter((e) => e.type === '讨论' || e.type === '复盘').slice(0, 2);
  const filtered = useMemo(() => filter === '全部' ? entries : entries.filter((e) => e.type === filter), [entries, filter]);
  const cursor = filtered.length > activityPageSize && anchor?.filter === filter ? anchor : null;
  const match = cursor ? filtered.findIndex((e) => compareActivity(e, cursor) >= 0) : 0;
  const start = match < 0 ? Math.max(0, filtered.length - activityPageSize) : match;
  const end = Math.min(start + activityPageSize, filtered.length);
  function turn(index) {
    pendingIndexScroll.current = 'page';
    const entry = filtered[index];
    setAnchor(index ? { key: entry.key, date: entry.date, filter } : null);
  }
  async function refresh() {
    scrollToIndex();
    setRefreshing(true);
    reloadBoard(n=>n+1);
    try { await refreshShares(); } catch(e){setFeedError(e.message);} finally { setRefreshing(false); }
  }
  const groups = new Map();
  for (const entry of filtered.slice(start, end)) {
    const date = localDay(entry.date);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(entry);
  }
  return (
    <div className="page-width dispatch-page">
      <PageHead
        title="队内动态"
        description="Kapok Bloom 队报"
        action={
          entries[0] && (
            <div className="edition-date">
              <span>最近更新</span>
              <time dateTime={entries[0].date}>{newspaperDate(entries[0].date)}</time>
            </div>
          )
        }
      />
      {canEdit && <div className="bulletin-edit"><NavLink className="desk-action" to="/account/manage/announcements?edit=bulletin"><Pencil size={15}/>编辑公告板</NavLink></div>}
      {currentBoard?.error && <p role="alert">公告板暂时无法读取。<button onClick={()=>reloadBoard(n=>n+1)}>重试</button></p>}
      {currentBoard && !currentBoard.error && !lead && <p className="quiet-box">公告板暂无内容。</p>}
      {currentBoard && lead && (
        <div className="front-page">
          <article className={cover ? "lead-story" : "lead-story bulletin-text"}>
            {cover && <NavLink
              className="lead-photo"
              to={lead.href}
              photoKey={photoKey}
              aria-label={'查看'+lead.type+'：'+lead.title}
            >
              <span data-photo-key={photoKey}>
                <img src={cover} referrerPolicy="no-referrer" alt="" fetchPriority="high" />
              </span>
              <i aria-hidden="true">
                <ArrowUpRight size={22} />
              </i>
            </NavLink>}
            <div className="lead-story-info">
              <div className="record-meta">
                <span className="press-section">{pin ? "公告板 · "+pin.type : "最新训练"}</span>
                <span>{lead.author}</span>
              </div>
              <h2>
                <NavLink to={lead.href} photoKey={photoKey}>
                  {lead.title}
                </NavLink>
              </h2>
              {lead.summary && <p><TextLinks text={lead.summary}/></p>}
            </div>
          </article>
          <section className="press-column" aria-labelledby="voices-title">
            <h2 id="voices-title">
              场边声音
              <Quote size={22} />
            </h2>
            {voices.length ? (
              voices.map((e) => (
                <article className="voice" key={e.key}>
                  <small>
                    {e.type} <i>/</i> {shortDate(e.date)}
                  </small>
                  <blockquote><TextLinks text={e.snippet} clipped={Array.from(e.snippet).length >= 160}/></blockquote>
                  <NavLink
                    to={e.href}
                    className="voice-by"
                    aria-label={'查看' + e.who + '的' + e.type + '：' + (e.n?.title || e.t?.title || e.title)}
                  >
                    <span>{e.who}</span>
                    <ArrowUpRight size={15} />
                  </NavLink>
                </article>
              ))
            ) : (
              <p className="quiet-box">队友的讨论与公开复盘会出现在这里。</p>
            )}
          </section>
        </div>
      )}
      <section className="dispatch-index" aria-labelledby="dispatch-title">
        <div className="section-line">
          <h2 id="dispatch-title" ref={heading} tabIndex={-1}>按日浏览</h2>
          <div className="dispatch-tools"><span aria-live="polite">{filtered.length > activityPageSize ? (start + 1) + '–' + end + ' / ' : ''}{filtered.length} 条动态</span>
            <button type="button" aria-label="刷新动态" title="刷新动态" disabled={refreshing} onClick={refresh}><RefreshCw size={15} /></button>
          </div>
        </div>
        <Segments
          items={['全部', '训练', '图文', '视频', '合集', '复盘', '讨论', ...(entries.some(e=>e.type==='公告')?['公告']:[])]}
          value={filter}
          onChange={(value) => {
            pendingIndexScroll.current = 'filter';
            setFilter(value);
            setAnchor(null);
          }}
          onReselect={scrollToIndex}
          label="队内动态筛选"
        >
          {filtered.length ? (
            [...groups].map(([d, items]) => (
              <section className="dispatch-day" key={d} aria-label={d}>
                <div className="dispatch-dateline"><DateMark value={d} />
                  {start > 0 && localDay(filtered[start - 1].date) === d && <small>接上页</small>}
                </div>
                <div>
                  {items.map((e) => (
                    <NavLink
                      className="newswire"
                      to={e.href}
                      key={e.key}
                      photoKey={
                        e.n
                          ? 'dispatch-note:' + e.n.id
                          : e.type === '训练'
                            ? 'wire:' + e.t.id
                            : undefined
                      }
                    >
                      <div className="wire-body">
                        <div className="record-meta">
                          <span className={'wire-type type-' + e.type}>{e.type}</span>
                          {e.n && <span>{noteCategoryLabel(e.n)}</span>}
                          <span>{e.who}</span>
                        </div>
                        <h3>
                          {e.n ? (
                            <span data-photo-key={'dispatch-note:' + e.n.id}>{e.title}</span>
                          ) : (
                            e.title
                          )}
                        </h3>
                        {e.n && e.snippet && <p className="note-wire-excerpt">{e.snippet}</p>}
                        {e.type === '讨论' && <p>{e.t.title}</p>}
                        {e.volume && (
                          <p>
                            {e.volume.count} 项内容 · {e.volume.category}
                          </p>
                        )}
                      </div>
                      {e.n && e.firstPhoto && <NoteFeedPhoto photo={e.firstPhoto} count={e.photoCount} />}
                      {e.type === '训练' && (
                        <span className="wire-thumb" data-photo-key={'wire:' + e.t.id}>
                          <img loading="lazy" alt="" src={teamPhoto(e.t)} />
                        </span>
                      )}
                      <ArrowUpRight size={17} />
                    </NavLink>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <Empty
              icon={MessageSquare}
              title="还没有这类动态"
              text="队员发布内容后，会按日期收录在这里。"
            />
          )}
          {filtered.length > activityPageSize && <nav aria-label="动态分页" className="dispatch-pager">
            <button type="button" disabled={!start} onClick={() => turn(Math.max(0, start - activityPageSize))}><ChevronLeft size={16} />上一页</button>
            <span>{start + 1}–{end} / {filtered.length}</span>
            <button type="button" disabled={end === filtered.length} onClick={() => turn(end)}>下一页<ChevronRight size={16} /></button>
          </nav>}
        </Segments>
        {reading && <p role="status">正在读取队内动态…</p>}{feedError && <p role="alert">{feedError}</p>}<FeedStatus />
      </section>
    </div>
  );
}
export function Members() {
  useTitle('队伍成员');
  const { ctx } = useData();
  const people = useRoster();
  const {params} = useNav();
  const requested = params.get('person');
  const [query, setQuery] = useState(''),
    [selectedId,setSelectedId] = useState(requested === ctx.account.user.id ? 'me' : requested);
  const person = people.find(p=>p.id===selectedId);
  const visible = people.filter((p) => (p.name + p.number + p.position).includes(query.trim()));
  return (
    <div className="page-width roster-page">
      <PageHead title="队伍成员" description={'Kapok Bloom · ' + people.length + ' 位成员'} />
      <div className="roster-layout">
        <section className="roster-sheet" aria-label="队员名册">
          <label className="member-search">
            <Search size={18} />
            <input
              type="search"
              aria-label="搜索成员"
              placeholder="搜索盘名、背号或位置"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {visible.length ? (
            <div className="roster-table">
              <div className="roster-legend" aria-hidden="true">
                <span>背号</span>
                <span>盘名</span>
                <span>场上位置</span>
              </div>
              {visible.map((p) => (
                <button type="button" key={p.id} className="member" onClick={() => setSelectedId(p.id)}>
                  <b className="jersey-num" data-wide={String(p.number).length > 2}>
                    {p.number || '—'}
                  </b>
                  <span className="member-name">
                    <Avatar person={p}/><span><strong>{p.name}</strong>
                    <small>{p.role}</small></span>
                  </span>
                  <span className="position">{p.position}</span>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={Users} title="没有匹配的成员" text="换一个盘名或背号试试。" />
          )}
        </section>
        <div className="roster-folio" aria-hidden="true">
          <img src="/workspace-assets/media/sideline-team.webp" alt="" />
          <strong>
            Kapok
            <br />
            <i>Bloom</i>
          </strong>
        </div>
      </div>
      <Modal
        open={!!person}
        onOpenChange={(v) => {
          if (!v) setSelectedId(null);
        }}
        title="队员档案"
        className="member-modal"
      >
        {person && (
          <div className="member-profile">
            <Jersey person={person} compact />
            <div>
              <div className="member-portrait"><Avatar person={person} large/></div>
              <h2>
                {person.name}
                {person.number && <span className="sr">，背号 {person.number}</span>}
              </h2>
              <p>
                {person.role} · {person.position}
              </p>
              <p><TextLinks text={person.bio || '尚未填写简介。'}/></p>
              <MemberReflections key={person.id} id={person.id === 'me' ? ctx.account.user.id : person.id} close={() => setSelectedId(null)} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
function MemberReflections({ id, close }) {
  const { ctx } = useData();
  const [result,setResult] = useState(null);
  const [attempt,retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    ctx.read('page-read/members/' + encodeURIComponent(id), controller.signal).then(
      ({value}) => { if (!controller.signal.aborted) setResult({items:value.reflections}); },
      error => { if (!controller.signal.aborted) setResult({error:error.message}); },
    );
    return () => controller.abort();
  },[ctx,id,attempt]);
  if (!result) return <p role="status">正在读取队内可读的复盘…</p>;
  if (result.error) return <p role="alert">{result.error} <button onClick={() => retry(n=>n+1)}>重试</button></p>;
  if (!result.items.length) return null;
  return <section aria-label="分享给全队的复盘"><h3>分享给全队的复盘</h3><ul>{result.items.map(note =>
    <li key={note.id}><NavLink to={'/notes/' + encodeURIComponent(note.id)} onClick={close}>{note.title || '无标题复盘'}</NavLink></li>
  )}</ul></section>;
}
export function Account() {
  useTitle('我的账户');
  const { db, ctx, notify, trainings, collections, logout } = useData(),
    p = db.profile;
  const { params } = useNav();
  const [editor,setEditor] = useState(()=>params.get('edit') === '1' ? {profile:p,version:ctx.account.profile.version} : null);
  const [saving,setSaving] = useState(false);
  const requestKey = useRef(createRequestKey()).current;
  function openEditor() {setEditor({profile:p,version:ctx.account.profile.version});}
  async function save(form,avatar) {
    const fields = {discName:form.name,jerseyNumber:form.number.trim(),position:form.position,bio:form.bio,
      expectedVersion:editor.version,...(avatar !== undefined && {avatar})};
    try {
      await ctx.write(avatar === undefined ? 'me' : 'me/profile','PATCH',fields,requestKey(ctx.actorId,fields));
    } catch (error) {
      if (error.code !== 'VERSION_CONFLICT') throw error;
      await ctx.refresh();
      throw new Error('资料已在其他页面更新。请重新打开编辑框后保存。');
    }
    await ctx.refresh();
    setEditor(null);
    notify('个人资料已保存');
  }
  return (
    <div className="page-width account-page">
      <PageHead title="我的账户" description={[p.role, p.position].filter(Boolean).join(' · ')} />
      <div className="account-layout">
        <div className="account-pass">
          <Jersey person={p} />
        </div>
        <div className="account-copy">
          <div className="identity-mid">
            <button type="button" className="account-avatar" onClick={openEditor} aria-label="修改头像" title="修改头像">
              <Avatar person={p} large/><span className="avatar-camera"><Camera size={13} aria-hidden="true"/></span>
            </button>
            <h2>{p.name}</h2>
            <span>{p.number ? '#' + p.number : '未设置背号'}</span>
          </div>
          <p className="identity-bio"><TextLinks text={p.bio || '尚未填写简介。'}/></p>
          <button
            type="button"
            className="btn"
            onClick={openEditor}
          >
            <Pencil size={15} />
            编辑个人资料
          </button>
          {ctx.account.membership.role === 'admin' && <NavLink className="desk-gateway" to="/account/manage"><ShieldCheck size={21}/><span><strong>队伍管理</strong><small>训练、公告、成员与精选合集</small></span><ArrowUpRight size={18}/></NavLink>}
          <div className="profile-rows">
            <NavLink to="/account/published">
              <Layers size={18} />
              <span>
                我的发布
                <small>
                  {publishedRecords(trainings, collections, db.notes).length}{' '}
                  条训练、图文、视频、合集与公开复盘
                </small>
              </span>
              <ArrowUpRight size={18} />
            </NavLink>
            <NavLink to="/growth">
              <BookOpen size={18} />
              <span>
                成长记录
                <small>
                  {db.notes.length} 篇复盘 ·{' '}
                  {Object.keys(db.saved).length + Object.keys(db.savedCollections).length} 条收藏
                </small>
              </span>
              <ArrowUpRight size={18} />
            </NavLink>
            <NavLink to="/members">
              <Users size={18} />
              <span>队伍成员</span>
              <ArrowUpRight size={18} />
            </NavLink>
            <NavLink to="/account/recycle"><RotateCcw size={18}/><span>复盘回收站<small>恢复最近删除的个人复盘</small></span><ArrowUpRight size={18}/></NavLink>
            <NavLink to="/account/data"><LockKeyhole size={18}/><span>个人数据<small>导出本人的记录与资料</small></span><ArrowUpRight size={18}/></NavLink>
            <a href={ctx.logoutHref} target="_top" aria-busy={logout.busy} onClick={logout.logout}><LogOut size={17} />退出当前登录</a>
          </div>
        </div>
      </div>
      <footer className="account-foot">
        <span>Kapok Bloom</span>
        <a href="/workspace-assets/media/CREDITS.md" target="_blank" rel="noreferrer">
          摄影来源
          <ExternalLink size={13} />
        </a>
      </footer>
      <Modal title="编辑个人资料" open={!!editor} onOpenChange={open=>{if (!open && !saving) setEditor(null);}}>
        {editor && <ProfileForm profile={editor.profile} onSave={save} onBusy={setSaving} onCancel={()=>setEditor(null)}/>}
      </Modal>
    </div>
  );
}
