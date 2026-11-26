import { BulletinSettings } from './bulletin';
import { localImageExport } from './note-image-store.js';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  ClipboardList,
  Download,
  Layers,
  LockKeyhole,
  Megaphone,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { downloadOwnData } from '../../lib/client/data-export';
import { NavLink, useTitle } from './router';
import { Avatar, Back, Empty, Modal, PageHead } from './ui';
import { day, shortDate, useData, useRoster } from './store';
import { catalogEntries, matchText } from './collection-model';
import { MediaCover, fieldPhoto } from './press';
const sections = [
  ['trainings', '训练管理', ClipboardList],
  ['announcements', '公告管理', Megaphone],
  ['members', '成员角色与状态', Users],
  ['featured', '精选合集管理', Layers],
];
const pathFor = (slug) => '/account/manage' + (slug ? '/' + slug : '');

function useDeskRead(path) {
  const { ctx } = useData();
  const [resource,setResource] = useState(null);
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    ctx.read(path,controller.signal).then(value=>{
      if (!controller.signal.aborted) setResource({ctx,path,attempt,value});
    },error=>{
      if (!controller.signal.aborted) setResource({ctx,path,attempt,error});
    });
    return () => controller.abort();
  },[ctx,path,attempt]);
  const current = resource?.ctx === ctx && resource.path === path && resource.attempt === attempt ? resource : null;
  return {value:current?.value,error:current?.error,reload:()=>setAttempt(n=>n+1)};
}
function AwaitDesk({resource,children}) {
  if (resource.error) return <p role="alert">{resource.error.message} <button className="btn" onClick={resource.reload}>重新读取</button></p>;
  if (!resource.value) return <p role="status">正在读取…</p>;
  return children(resource.value);
}
function useDeskAction() {
  const {notify} = useData();
  const lock = useRef(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function run(work) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try { await work(); }
    catch (e) {setError(e.message); notify(e.message);}
    finally {lock.current=false; setBusy(false);}
  }
  return {run,busy,error};
}
function DeskNav({ section }) {
  const nav = useRef(null);
  useLayoutEffect(() => {
    const el = nav.current;
    const tab = el.querySelector('[aria-current="page"]');
    if (tab && el.scrollWidth > el.clientWidth) {
      const left = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      el.scrollLeft = left - (el.clientWidth - tab.offsetWidth) / 2;
    }
  }, [section]);
  return (
    <nav ref={nav} className="desk-nav" aria-label="队伍管理导航">
      {[['', '总览'], ...sections].map(([slug, name]) => (
        <NavLink key={slug} to={pathFor(slug)} aria-current={slug === section ? 'page' : undefined}>
          {name}
        </NavLink>
      ))}
    </nav>
  );
}
function DeskIndex() {
  const { trainings, people: profiles } = useData();
  const people = profiles;
  const records = trainings.filter((t) => t.kind === 'training');
  const descriptions = [
    records.length + ' 条训练 · 查看与维护训练记录',
    '管理动态顶部公告板，编写与发布队内通知',
    people.length + ' 位队员 · 设置管理权限与状态',
    '挑选并排列训练合集',
  ];
  const latest = records[0];
  return (
    <div className="desk-index">
      <div className="desk-directory">
        {sections.map(([slug, name, Icon], i) => (
          <NavLink key={slug} to={pathFor(slug)}>
            <Icon size={20} />
            <span>
              <strong>{name}</strong>
              <small>{descriptions[i]}</small>
            </span>
            <ArrowUpRight size={17} />
          </NavLink>
        ))}
      </div>
      <div className="desk-spotlight">
        <div className="desk-training-cover">
          <MediaCover
            item={latest}
            alt=""
            fallback={latest ? fieldPhoto(latest) : '/workspace-assets/media/sideline-team.webp'}
          />
        </div>
        {latest && (
          <NavLink to={'/trainings/' + latest.id}>
            <small>最近一次训练 · {shortDate(latest.date)}</small>
            <strong>{latest.title}</strong>
            <ArrowUpRight size={22} />
          </NavLink>
        )}
      </div>
    </div>
  );
}
function TrainingDesk() {
  const { trainings, refreshShares, sharesError } = useData();
  // A teammate may have published since the administrator opened the workspace.
  useEffect(() => { void refreshShares().catch(() => {}); }, [refreshShares]);
  const [query, setQuery] = useState('');
  const items = trainings.filter(
    (t) => t.kind === 'training' && matchText(query, t.title, t.author, t.category),
  );
  return (
    <>
      {sharesError && <p role="alert">{sharesError} <button onClick={()=>refreshShares().catch(()=>{})}>重新读取</button></p>}
      <div className="desk-tools">
        <label className="desk-search">
          <Search size={17} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索训练"
            placeholder="搜索训练、作者或类别"
          />
        </label>
        <Link className="desk-action" prefetch={false} href="/admin/trainings?settings=1">训练档案设置</Link>
        <NavLink className="btn primary" to="/trainings/new">
          <Plus size={16} />
          新建
        </NavLink>
      </div>
      {items.map((t) => (
        <article className="desk-row" key={t.id}>
          <MediaCover className="desk-thumb" item={t} fallback={fieldPhoto(t)} alt="" loading="lazy" />
          <div className="desk-copy">
            <small>
              {shortDate(t.date)} · {t.category}
            </small>
            <NavLink to={'/trainings/' + t.id}>{t.title}</NavLink>
            <small>{t.author}</small>
          </div>
          <Link className="desk-action" prefetch={false} href={'/admin/trainings/'+encodeURIComponent(t.id)}>视频与可见性</Link>
          <NavLink
            className="desk-action"
            to={'/trainings/' + t.id + '/edit' + (t.ownerId === 'me' ? '' : '?manage=1')}
            aria-label={'编辑训练：' + t.title}
          >
            <Pencil size={15} />
            编辑
          </NavLink>
        </article>
      ))}
      {!items.length && <Empty icon={Search} title="没有匹配的训练" text="可以更换关键词，或点击「新建」。" />}
    </>
  );
}
function Notices({rows,reload}) {
  const {ctx,notify} = useData();
  const action = useDeskAction();
  const [draft,edit] = useState(null);
  const notices = rows.map(row=>({...row,title:row.revisionTitle ?? row.title,body:row.revisionText ?? row.text.trim(),
    live:row.status === 'published' ? {title:row.title,body:row.text} : null}));
  function save(status) {
    const record = status === 'deleted' ? notices.find(n => n.id === draft.id) : draft;
    if (!record) return;
    const title = record.title.trim(), text = record.body.trim();
    if (!title || (status === 'published' && !text)) return;
    return action.run(async()=>{
      const endpoint = draft.id ? 'announcements/'+encodeURIComponent(draft.id) : 'announcements';
      await ctx.write(endpoint,draft.id ? 'PATCH' : 'POST',{title,text,status,...(draft.id && {expectedVersion:draft.version})});
      edit(null);
      notify(status === 'deleted' ? '公告已删除' : status === 'published' ? '公告已发布到队内动态' : status === 'draft' ? '公告已撤回' : '草稿已保存');
      reload();
    });
  }
  return (
    <>
      <div className="desk-tools">
        <span>{notices.length} 条公告</span>
        <button className="btn primary" onClick={() => edit({ title: '', body: '', live: null })}>
          <Plus size={16} />
          新建公告
        </button>
      </div>
      {notices.map((n) => (
        <article className="desk-row" key={n.id}>
          <div className="desk-copy">
            <small>
              {!n.live
                ? '草稿'
                : n.title !== n.live.title || n.body !== n.live.body
                  ? '已发布 · 有修改待发布'
                  : '已发布'}
            </small>
            <strong>{n.title}</strong>
          </div>
          <button className="desk-action" onClick={() => edit(n)} aria-label={'编辑公告：' + n.title}>
            <Pencil size={15} />
            编辑
          </button>
        </article>
      ))}
      {!notices.length && (
        <Empty icon={Megaphone} title="还没有公告" text="可以先存草稿，发布后队员会在动态里看到。" />
      )}
      <Modal
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) edit(null);
        }}
        title="编辑公告"
      >
        {draft && (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              save('published');
            }}
          >
            <label>
              公告标题
              <input
                value={draft.title}
                maxLength={80}
                onChange={(e) => edit({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              公告正文
              <textarea
                rows={5}
                value={draft.body}
                maxLength={5000}
                onChange={(e) => edit({ ...draft, body: e.target.value })}
              />
            </label>
            {action.error && <p role="alert">{action.error} <button type="button" onClick={reload}>读取最新版本</button></p>}
            <div className="form-buttons">
              {draft.id && <button type="button" className="btn danger" disabled={action.busy} onClick={()=>{
                if(window.confirm('删除这条公告？各阅读入口将立即停止展示。')) save('deleted');
              }}>删除公告</button>}
              {draft.live && <button type="button" className="btn" disabled={action.busy} onClick={()=>{if(window.confirm('撤回后队员将无法阅读这条公告，确定撤回？')) save('draft');}}>撤回公告</button>}
              <button
                type="button"
                className="btn"
                disabled={action.busy || !draft.title.trim()}
                onClick={() => save(draft.live ? 'revision' : 'editorDraft')}
              >
                保存草稿
              </button>
              <button className="btn primary" disabled={action.busy || !draft.title.trim() || !draft.body.trim()}>
                发布公告
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
const roleNames = {member:'队员',coach:'教练',admin:'管理员'};
const statusNames = {active:'正常',paused:'暂停',left:'离队'};
function MemberDesk({rows,reload}) {
  const roster = useRoster();
  const {ctx,notify} = useData();
  const [edit,setEdit] = useState(null);
  const action = useDeskAction();
  const people = rows.map(row=>({...row,id:row.userId,name:row.discName,number:row.jerseyNumber}));
  const admins = people.filter(p=>p.role==='admin' && p.status==='active' && p.canSignIn);
  const lastAdmin = edit && admins.length === 1 && admins[0].id === edit.id;
  const blocked = lastAdmin && (edit.role !== 'admin' || edit.status !== 'active');
  function submit(event) {
    event.preventDefault();
    if (blocked) return;
    return action.run(async()=>{
      await ctx.write('admin/members/'+encodeURIComponent(edit.id),'PATCH',{
        role:edit.role,status:edit.status,expectedVersion:edit.version,expectedEpoch:edit.epoch});
      setEdit(null);
      notify('成员设置已更新');
      if (edit.id===ctx.account.user.id) await ctx.refresh();
      reload();
    });
  }
  return (
    <>
      <div className="desk-tools">
        <span>{people.length} 位队员</span>
        <small>{admins.length} 位可登录的有效管理员</small>
      </div>
      {people.map((p) => {
        const rights = p;
        return (
          <article className="desk-row" key={p.id}>
            <Avatar person={p} preview={roster.find(person=>person.id===(p.id===ctx.account.user.id?'me':p.id))?.avatarUrl}/>
            <div className="desk-copy">
              <strong>
                {p.name}
                {p.id === ctx.account.user.id && '（我）'}
              </strong>
              <small>
                {p.number ? '背号 ' + p.number + ' · ' : ''}
                {roleNames[p.role]}{!p.canSignIn && ' · 尚未绑定本站登录'}
              </small>
            </div>
            <span className="desk-state">
              {roleNames[rights.role]} · {statusNames[rights.status]}
            </span>
            <button
              className="desk-action"
              aria-label={'调整成员：' + p.name}
              onClick={() => {
                setEdit({ id: p.id, name: p.name, ...rights });
              }}
            >
              <Pencil size={15} />
            </button>
          </article>
        );
      })}
      <Modal
        title={edit ? '调整' + edit.name + '的成员设置' : '成员设置'}
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) setEdit(null);
        }}
      >
        {edit && (
          <form className="modal-form" onSubmit={submit}>
            <label>
              管理权限
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                {Object.entries(roleNames).map(([v,name])=><option key={v} value={v}>{name}</option>)}
              </select>
            </label>
            <label>
              成员状态
              <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                {Object.entries(statusNames).map(([v,name])=><option key={v} value={v}>{name}</option>)}
              </select>
            </label>
            {lastAdmin && (
              <p className="field-hint">请先提升另一位可登录的队员。队伍至少需要一位状态正常的管理员。</p>
            )}
            {action.error && (
              <p className="form-error" role="alert">
                {action.error} <button type="button" onClick={reload}>读取最新设置</button>
              </p>
            )}
            <div className="form-buttons">
              <button type="button" className="btn" onClick={() => setEdit(null)}>
                取消
              </button>
              <button className="btn primary" disabled={blocked || action.busy}>
                {action.busy ? '正在保存…' : '确认更改'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
function FeaturedDesk({current,reload}) {
  const { collections, remoteCollections, trainings, ctx, notify } = useData();
  const entries = catalogEntries(collections.filter(c=>c.published),remoteCollections,trainings).filter(e=>e.count || current.collections.some(c=>c.id===e.key));
  const [pending, setPending] = useState(null);
  const action = useDeskAction();
  const keys = (pending || current.collections.map(c=>c.id)).filter((k) => entries.some((e) => e.key === k));
  function move(i, delta) {
    const order = [...keys];
    [order[i], order[i + delta]] = [order[i + delta], order[i]];
    setPending(order);
  }
  const selected = keys.map((k) => entries.find((e) => e.key === k));
  return (
    <>
      <div className="desk-tools">
        <span>已选 {keys.length} 份合集</span>
        <button
          className="btn primary"
          disabled={pending === null || action.busy}
          onClick={() => action.run(async () => {
            await ctx.write('learning/featured','PATCH',{expectedVersion:current.version,collectionIds:keys});
            notify('精选顺序已保存');
            reload();
          })}
        >
          保存精选
        </button>
      </div>
      {action.error && <p role="alert">{action.error} <button onClick={reload}>读取最新设置</button></p>}
      {[...selected, ...entries.filter((e) => !keys.includes(e.key))].map((e) => {
        const i = keys.indexOf(e.key);
        return (
          <article className="desk-row" key={e.key}>
            <MediaCover className="desk-thumb" item={e.cover} collectionCover={e.coverUrl} alt="" />
            <div className="desk-copy">
              <NavLink to={e.href}>{e.title}</NavLink>
              <small>
                {e.category} · {e.count} 项内容
              </small>
            </div>
            <div className="desk-actions">
              {i >= 0 && (
                <>
                  <button disabled={!i} aria-label={'上移：' + e.title} onClick={() => move(i, -1)}>
                    <ArrowUp size={16} />
                  </button>
                  <button
                    disabled={i === keys.length - 1}
                    aria-label={'下移：' + e.title}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                </>
              )}
              <button
                disabled={action.busy || (i < 0 && keys.length >= current.maxFeatured)}
                className="desk-select"
                aria-pressed={i >= 0}
                aria-label={(i >= 0 ? '移出精选：' : '加入精选：') + e.title}
                onClick={() =>
                  setPending(i >= 0 ? keys.filter((k) => k !== e.key) : [...keys, e.key])
                }
              >
                {i >= 0 ? <Check size={17} /> : <Plus size={17} />}
              </button>
            </div>
          </article>
        );
      })}
    </>
  );
}
export function Management({ section = '' }) {
  const {ctx} = useData();
  const allowed = ctx.account.membership.role === 'admin' && ctx.account.membership.status === 'active';
  const endpoint = {announcements:'announcements?view=editor',members:'admin/members',featured:'learning/featured?view=admin'}[section];
  const resource = useDeskRead(allowed ? endpoint : null);
  const board = useDeskRead(allowed && section === 'announcements' ? 'workspace/bulletin' : null);
  const item = sections.find(([key]) => key === section);
  const { db } = useData();
  const title = item?.[1] || '队伍管理';
  useTitle(title);
  if (!allowed || (section && !item))
    return (
      <div className="page-width">
        <Back fallback="/account" />
        <Empty
          icon={ShieldCheck}
          title={allowed ? '没有这个管理页面' : '此页面仅管理员可访问'}
          level={1}
          action={
            <NavLink className="btn" to="/account">
              我的账户
            </NavLink>
          }
        />
      </div>
    );
  return (
    <div className="page-width desk-page">
      <NavLink className="desk-crumb" to="/account">
        <ArrowLeft size={14} />
        我的账户
      </NavLink>
      <PageHead
        title={title}
        description={
          section === 'trainings'
            ? '队员维护自己的发布，管理员可以修订全队训练，署名保留给原作者。'
            : undefined
        }
        action={
          <span className="desk-person">
            <ShieldCheck size={16} />
            {db.profile.name} · 管理员
          </span>
        }
      />
      <DeskNav section={section} />
      {!section && <DeskIndex />}
      {section === 'trainings' && <TrainingDesk />}
      {section === 'announcements' && <AwaitDesk resource={board}>{current=><BulletinSettings current={current} reload={board.reload}/>}</AwaitDesk>}
      {section === 'announcements' && <AwaitDesk resource={resource}>{rows=><Notices rows={rows} reload={resource.reload}/>}</AwaitDesk>}
      {section === 'members' && <AwaitDesk resource={resource}>{rows=><MemberDesk rows={rows} reload={resource.reload}/>}</AwaitDesk>}{' '}
      {section === 'featured' && <AwaitDesk resource={resource}>{current=><FeaturedDesk current={current} reload={resource.reload}/>}</AwaitDesk>}
    </div>
  );
}
export function PersonalTools({ recycle }) {
  const {db,ctx,notify} = useData();
  const title = recycle ? '复盘回收站' : '个人数据';
  useTitle(title);
  const resource = useDeskRead(recycle ? 'me/recycle' : null);
  const action = useDeskAction();
  const removed = (resource.value || []).map(note=>({note,until:note.recoverUntil}));
  function restore(note) {
    return action.run(async()=>{
      await ctx.write('reflections/'+encodeURIComponent(note.id)+'/restore','POST',{
        expectedVersion:note.version,expectedSharingVersion:note.sharingVersion,expectedGeneration:note.generation});
      notify('复盘已恢复到成长记录，仅自己可见');
      resource.reload();
      await ctx.refresh();
    });
  }
  function exportData() {
    return action.run(async () => {
      const session = await ctx.authorize();
      let data;
      await downloadOwnData(ctx.actorId, ctx.authorize, ctx.isCurrent, value => { data = value; });
      const local = await localImageExport(ctx.actorId, data.reflections, db.drafts);
      const after = await ctx.authorize();
      if (after !== session || !ctx.isCurrent(session) || ctx.signal.aborted) throw Error('账号已变化，请重新确认后导出。');
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...data, ...local },null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'Kapok-个人数据-'+day()+'.json';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      notify('已生成个人数据文件');
    });
  }
  return (
    <div className="page-width desk-page">
      <NavLink className="desk-crumb" to="/account">
        <ArrowLeft size={14} />
        我的账户
      </NavLink>
      <PageHead title={title} />
      {action.error && <p role="alert">{action.error}</p>}
      {recycle && !resource.value ? <AwaitDesk resource={resource}>{()=>null}</AwaitDesk> : recycle ? (
        <>
          <div className="desk-tools">
            <span>{removed.length} 篇可恢复</span>
            <small>保留 7 天 · 恢复后仅自己可见</small>
          </div>
          {removed.length ? (
            removed.map(({ note, until }) => (
              <article className="desk-row" key={note.id}>
                <BookOpen size={18} />
                <div className="desk-copy">
                  <strong>{note.title}</strong>
                  <small>
                    {note.category || '复盘'}{note.hasLocalPhotos ? ' · 本机配图' : note.photos?.length ? ' · ' + note.photos.length + ' 张配图' : ''} · {shortDate(new Date(until).toISOString())} 到期
                  </small>
                </div>
                <button className="desk-action" disabled={action.busy} onClick={() => restore(note)}>
                  <RotateCcw size={15} />
                  恢复私稿
                </button>
              </article>
            ))
          ) : (
            <Empty
              icon={RotateCcw}
              title="回收站是空的"
              text="你删除的复盘会在这里保留七天。"
              action={
                <NavLink className="btn" to="/growth">
                  查看成长记录
                </NavLink>
              }
            />
          )}
        </>
      ) : (
        <>
          <div className="desk-data">
            <LockKeyhole size={24} />
            <div>
              <h2>{db.profile.name}的个人存档</h2>
              <p>仅本人可导出</p>
            </div>
          </div>
          <div className="desk-row">
            <div className="desk-copy">
              <strong>导出本人数据</strong>
              <small>个人资料、复盘、收藏备注和自己的发布记录 · JSON</small>
            </div>
            <button className="btn" disabled={action.busy} onClick={exportData}>
              <Download size={15} />
              导出
            </button>
          </div>
          <div className="desk-row">
            <div className="desk-copy">
              <strong>私人复盘与备注</strong>
              <small>登录账号后，可在成长记录中查看。</small>
            </div>
            <NavLink className="desk-action" to="/growth">
              查看
              <ChevronRight size={15} />
            </NavLink>
          </div>
          <a className="desk-action" href="/me/data?settings=1">账户与队伍访问设置 <ChevronRight size={15}/></a>
        </>
      )}
    </div>
  );
}
