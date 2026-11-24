import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { createRequestKey } from '../../lib/client/api';
import { useNav } from './router';
import { shortDate, useData } from './store';
import { Modal } from './ui';


function BulletinEditor({ current, close, saved, reload }) {
  const {ctx} = useData();
  const [choice, choose] = useState(current.item);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState([]);
  const [result, setResult] = useState(null);
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const locked = useRef(false);
  const requestKey = useRef(createRequestKey()).current;
  const params = new URLSearchParams({q:query.trim()});
  if (pages.length) params.set('cursor',pages.at(-1));
  const path = 'workspace/bulletin/options?' + params;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const value = await ctx.read(path,controller.signal);
        if (!controller.signal.aborted) setResult({path, value});
      } catch (e) {
        if (!controller.signal.aborted) setResult({path,error:e.message});
      }
    }, query ? 170 : 0);
    return () => {clearTimeout(timer); controller.abort();};
  },[ctx,path,query,attempt]);
  const page = result?.path === path ? result : null;
  async function save() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    const fields = {key:choice?.key ?? null,expectedVersion:current.version};
    try {
      await ctx.write('workspace/bulletin','PUT',fields,requestKey(ctx.actorId,fields));
      saved();
    } catch(e) { setError(e); }
    finally {locked.current=false;setBusy(false);}
  }
  return <Modal open onOpenChange={open=>{if (!open && !locked.current) close();}} title="编辑公告板">
    <div className="bulletin-picker">
      <label className="bulletin-choice">
        <input disabled={busy} type="radio" name="board-item" checked={!choice} onChange={()=>choose(null)}/>
        <span>自动展示最新训练</span>
      </label>
      <label className="bulletin-query">指定队内内容
        <input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPages([]);}} placeholder="搜索标题或留言" />
      </label>
      <div className="bulletin-options" aria-label="可选内容">
        {!page ? <p role="status">正在读取…</p> : page.error ? <p role="alert">{page.error} <button onClick={()=>{setResult(null);retry(n=>n+1);}}>重试</button></p> :
          page.value.items.length ? page.value.items.map(item=><label key={item.key} className="bulletin-choice">
            <input disabled={busy} type="radio" name="board-item" checked={choice?.key===item.key} onChange={()=>choose(item)} />
            <span><small>{item.type}{item.date && ' · '+shortDate(item.date)}</small>{item.title}{item.type==='讨论' && item.summary && <span className="bulletin-excerpt">{item.summary}</span>}</span>
          </label>) : <p>没有匹配的队内内容。</p>}
      </div>
      {(pages.length>0 || page?.value?.next) && <div className="bulletin-pages">
        <button type="button" className="desk-action" disabled={!pages.length} onClick={()=>setPages(p=>p.slice(0,-1))}>上一页</button>
        <button type="button" className="desk-action" disabled={!page?.value?.next} onClick={()=>setPages(p=>[...p,page.value.next])}>下一页</button>
      </div>}
      <p className="bulletin-selection" aria-live="polite">{choice ? '已选 · '+choice.type+' · '+choice.title+(choice.type==='讨论' && choice.summary ? ' · '+choice.summary : '') : '已选 · 自动展示最新训练'}</p>
      {error && <p role="alert">{error.message} <button onClick={reload}>重新读取设置</button></p>}
      <div className="form-buttons"><button className="btn" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy || (!current.unavailable && (choice?.key ?? null)===(current.item?.key ?? null))} onClick={save}>{busy?'正在保存…':'保存公告板'}</button></div>
    </div>
  </Modal>;
}

export function BulletinSettings({ current, reload }) {
  const {notify} = useData();
  const {params,go} = useNav();
  const [open, setOpen] = useState(()=>params.get('edit')==='bulletin');
  function closeEditor() {
    setOpen(false);
    if (params.get('edit')==='bulletin') go('/account/manage/announcements',{replace:true});
  }
  return <section className="desk-row bulletin-settings" aria-label="队内动态公告板">
    <div className="desk-copy"><h2>队内动态公告板</h2>
      <p>{current.item ? current.item.type+' · '+current.item.title : current.unavailable ? '原指定内容已不可见，已回到最新训练。' : '自动展示最新训练'}</p></div>
    <button className="desk-action" onClick={()=>setOpen(true)}><Pencil size={15}/>编辑公告板</button>
    {open && <BulletinEditor current={current} close={closeEditor} reload={reload}
      saved={()=>{closeEditor();notify('公告板已更新');reload();}} />}
  </section>;
}
