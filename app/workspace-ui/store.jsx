'use client';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSignOut } from '../components/signout';
import { draftKey } from '../../lib/client/session-guard';
import { api } from '../../lib/client/api';
import { readWorkspaceDrafts, writeWorkspaceDrafts } from './local-drafts.js';
import { acknowledgeMutation } from '../../lib/client/navigation-state';
import { SecureStatus, useSecureResource } from '../components/secure-resource';
import { presentGrowth, bookmark, saveCollection, deleteNote } from './growth.js';
import { presentMaterials, deleteMaterial } from './materials.js';
import { presentTopics, deleteCollection } from './topics.js';
import { newTrainingCategory, trainingCategoryNames, noteCategoryName, noteTopics } from './categories.js';

export const kindName = { training: '训练', article: '图文', video: '视频' };
export const categories = ['全部','进攻','防守','基础'];
export const canEditMaterial = item => Boolean(item?.canEdit);
export const uid = () => crypto.randomUUID();
export const media = name => '/workspace-assets/media/' + name;
export const day = (value = new Date()) => {
  const d = new Date(value);
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
};
export const localDay = value => value?.length === 10 ? value : day(value);
export const eventTime = value => new Date(value?.length === 10 ? value+'T00:00:00' : value).getTime();
export const shortDate = value => { const [,m,d] = localDay(value).split('-'); return Number(m)+' 月 '+Number(d)+' 日'; };
export const clock = seconds => Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
const Store = createContext(null);
export const useData = () => useContext(Store);

const roleNames = { member:'队员', coach:'教练', admin:'管理员' };
function person(row, ownId) {
  return { id: row.id === ownId ? 'me' : row.id, name: row.discName, number: row.jerseyNumber,
    avatarUrl: row.avatarDigest ? '/api/v1/profile-avatars/'+encodeURIComponent(row.id)+'/'+row.avatarDigest : '',
    position: row.position || '', bio: row.bio || '', role: roleNames[row.role] || '队员', tone: 'forest' };
}
const workspaceRead = { confirmedPath: 'workspace' };

function snapshot(payload) {
  const { account, members } = payload;
  const materials = presentMaterials(account, payload.trainings, payload.posts, payload.categories, payload.drafts);
  const growth = presentGrowth(payload);
  const topics = presentTopics(payload.topics, materials.trainings);
  const people = members.map(row=>person(row,account.user.id));
  const own = members.find(row => row.id === account.user.id);
  const profile = person({ ...account.profile, avatarDigest:own?.avatarDigest, id:account.user.id, role:account.membership.role },account.user.id);
  return { ...materials,...growth,...topics,profile,people,account };
}

// Reopening a roster or discussion resolves current identities, including on an already-open teammate tab.
export function useRoster() {
  const {ctx,people} = useData();
  const [result,setResult] = useState(null);
  useEffect(()=>{
    const controller = new AbortController();
    ctx.read('members',controller.signal).then(rows=>{
      if (!controller.signal.aborted) setResult({ctx,people:rows.map(row=>person(row,ctx.account.user.id))});
    }).catch(()=>{});
    return ()=>controller.abort();
  },[ctx]);
  return result?.ctx === ctx ? result.people : people;
}

export function DataProvider({actorId,logoutHref,children}) {
  const logout = useSignOut({actorId,href:logoutHref});
  const { data:payload, attach, locked, checking, error, verify, authorize, isCurrent, subscribe, authorizationStamp } = useSecureResource(actorId, workspaceRead);
  const data = useMemo(() => payload ? snapshot(payload) : null, [payload]);
  return <>
    {logout.error && <p role="alert">{logout.error}</p>}
    {locked && <main id="main-content" tabIndex={-1}><SecureStatus locked={locked} checking={checking} error={error} retry={verify} /></main>}
    <div data-kapok-sensitive ref={attach} hidden={locked}>
      {!locked && data && <Verified key={authorizationStamp} actorId={actorId} logoutHref={logoutHref} initial={data} logout={logout} session={{verify,authorize,isCurrent,subscribe}}>{children}</Verified>}
    </div>
  </>;
}

function Verified({actorId,logoutHref,initial,session,logout,children}) {
  const [data,setData] = useState(initial);
  const storage = draftKey(actorId,'bloom-notes');
  const [drafts,setDrafts] = useState(()=>{try{return readWorkspaceDrafts(localStorage,storage);}catch{return {};}});
  const [storageError,setStorageError] = useState(false);
  const currentDrafts = useRef(drafts);
  const pendingDraftKeys = useRef(new Set());
  useEffect(() => {
    function sync(event) {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== storage && !event.key.startsWith(storage + ':'))) return;
      try {
        const merged = readWorkspaceDrafts(localStorage,storage);
        for (const key of pendingDraftKeys.current) {
          if (Object.hasOwn(currentDrafts.current,key)) merged[key] = currentDrafts.current[key];
          else delete merged[key];
        }
        currentDrafts.current=merged;
        setDrafts(merged);
      } catch { setStorageError(true); }
    }
    window.addEventListener('storage',sync);
    return () => window.removeEventListener('storage',sync);
  },[storage]);
  const [toast,setToast] = useState(null);
  const [sharesError,setError] = useState('');
  const [extra,setExtra] = useState({category:[],note:[]});
  const latest = useRef(session);
  useLayoutEffect(() => { latest.current = session; }, [session]);
  const lifecycle = useRef(new AbortController());
  const subscribe = session.subscribe;
  const revision = useRef(0);
  const timer = useRef();
  useLayoutEffect(() => {
    const controller = lifecycle.current.signal.aborted ? new AbortController() : lifecycle.current;
    lifecycle.current = controller;
    const unsubscribe = subscribe(() => controller.abort());
    return () => { unsubscribe(); controller.abort(); clearTimeout(timer.current); };
  }, [subscribe]);
  const refresh = useCallback(async () => {
    const signal = lifecycle.current.signal;
    const serial = ++revision.current;
    try {
      const {value,after} = await api('page-read/workspace',undefined,actorId,signal);
      const next = snapshot(value);
      if (initial.account.user.id !== after.me.user?.id ||
          JSON.stringify(initial.account.membership) !== JSON.stringify(after.me.membership)) {
        void latest.current.verify(); throw Error('成员权限已变化，请重新确认。');
      }
      if (!signal.aborted && serial===revision.current) {setData(next);setError('');}
    } catch(error) {
      if (!signal.aborted && serial===revision.current) {setError(error.message);void latest.current.verify();}
      throw error;
    }
  },[actorId,initial.account.membership,initial.account.user.id]);
  const ctx = useMemo(()=>({actorId,account:data.account,refresh,logoutHref,
    authorize:() => latest.current.authorize(),
    isCurrent:token => latest.current.isCurrent(token),
    subscribe,
    get signal() { return lifecycle.current.signal; },
    read:(path,signal) => api(path,undefined,actorId,signal ?? lifecycle.current.signal),
    write:async(path,method,body,key) => {
      const signal = lifecycle.current.signal;
      signal.throwIfAborted();
      const token = await latest.current.authorize();
      const result = await api(path,{actorId,method,body,key:key ?? crypto.randomUUID()},actorId,signal);
      if (!latest.current.isCurrent(token)) throw Error('账号已变化，请重新确认。');
      acknowledgeMutation(actorId,method,path,body);
      return result;
    }}),[actorId,data.account,refresh,logoutHref,subscribe]);
  const notify = useCallback(text=>{clearTimeout(timer.current);setToast({key:uid(),text});timer.current=setTimeout(()=>setToast(null),3000);},[]);
  const db = {...data,drafts,imported:[],overrides:{},comments:data.allComments ?? []};
  const setDb = (update, requireStored = false) => {
    if(lifecycle.current.signal.aborted) throw Error('请重新确认账号。');
    const before=currentDrafts.current;
    const next=update({...db,drafts:before}).drafts;
    if (!next) return;
    const changed=new Set(pendingDraftKeys.current);
    for (const key of new Set([...Object.keys(before),...Object.keys(next)])) {
      if (before[key]!==next[key]) changed.add(key);
    }
    let result=next;
    try {
      writeWorkspaceDrafts(localStorage,storage,changed,next);
      result=readWorkspaceDrafts(localStorage,storage);
      pendingDraftKeys.current.clear();
      setStorageError(false);
    } catch {
      setStorageError(true);
      if (requireStored) throw Error('未能从本机移除草稿，请检查浏览器存储后重试。');
      pendingDraftKeys.current=changed;
    }
    currentDrafts.current=result;
    setDrafts(result);
  };
  const busy = useRef(new Set());
  async function toggle(key, action, message) {
    if(busy.current.has(key)) return;
    busy.current.add(key);
    try { await action(); await refresh(); notify(message); } catch(error){ notify(error.message); }
    finally {busy.current.delete(key);}
  }
  const categoryNames = trainingCategoryNames([...(data.categoryNames??[]),...data.collections.map(c=>c.category),...extra.category]);
  const noteCategoryNames = [...new Set([...noteTopics,...data.notes.map(n=>n.category),...extra.note].filter(Boolean))];
  function register(field,raw,names,normalize) {
    const name=normalize(raw);
    if(names.includes(name)) throw Error('这个类别已存在，请从列表中选择。');
    setExtra(prev=>({...prev,[field]:[...prev[field],name]})); return name;
  }
  async function remove(action,item) {await action(ctx,item);await refresh();}
  return <Store.Provider value={{...data,db,setDb,ctx,logout,notify,toast,categoryNames,noteCategoryNames,
    addCategory:name=>register('category',name,categoryNames,newTrainingCategory),
    addNoteCategory:name=>register('note',name,noteCategoryNames,noteCategoryName),
    refreshShares:refresh,sharesError,catalogReady:true,storageError,allComments:data.allComments ?? [],
    bookmark:id=>{const item=typeof id==='object'?id:data.trainings.find(t=>t.id===id);if(item)return toggle('item:'+item.id,()=>bookmark(ctx,item,data.saved[item.id]),data.saved[item.id]?'已取消收藏':'已收藏到成长记录');},
    saveCollection:(key,info)=>toggle('topic:'+key,()=>saveCollection(ctx,key,info,data.savedCollections[key]),data.savedCollections[key]?'已取消收藏':'合集已收藏到成长记录'),
    deleteMaterial:item=>remove(deleteMaterial,item), deleteCollection:item=>remove(deleteCollection,item), deleteNote:item=>remove(deleteNote,item),
  }}>{children}</Store.Provider>;
}
