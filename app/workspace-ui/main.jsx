'use client';
import { canEditMaterial, DataProvider, useData } from './store';
import { RouterProvider, useNav } from './router';
import { Shell } from './shell';
import { Library } from './library';
import { TrainingDetail, TrainingForm, Missing } from './training';
import { Growth, NoteEditor, NoteDetail, NoteSharing } from './journal';
import { Activity, Members, Account } from './team';
import { Collections, CollectionView, SharedCollection } from './collections';
import { CollectionEditor } from './collection-editor';
import { Published } from './published';
import { lazy, Suspense, useEffect, useState } from 'react';
import { AnnouncementReader, LegacyVideo } from './legacy-readers';
import { loadNote } from './growth.js';
const desk = () => import('./manage');
const Management = lazy(() => desk().then(m => ({default:m.Management})));
const PersonalTools = lazy(() => desk().then(m => ({default:m.PersonalTools})));
function ReadError({ retry }) {
  return (
    <div className="page-width">
      <h1>暂时无法读取内容</h1>
      <button className="btn" onClick={retry}>
        重新读取
      </button>
    </div>
  );
}

function Route() {
  const { pathname, path, params } = useNav(),
    { allNotes, trainings, collections, catalogReady, sharesError, refreshShares } = useData();
  if (pathname === '/trainings' || pathname === '/') return <Library />;
  if (pathname === '/growth') return <Growth />;
  if (pathname === '/activity') return <Activity />;
  if (pathname === '/members') return <Members />;
  if (pathname === '/account') return <Account />;
  if (pathname === '/account/manage' || pathname.startsWith('/account/manage/'))
    return <Management key={pathname} section={pathname.slice('/account/manage/'.length)}/>;
  if (pathname === '/account/recycle' || pathname === '/account/data')
    return <PersonalTools key={pathname} recycle={pathname.endsWith('/recycle')}/>;
  if (pathname === '/account/published') return <Published />;
  if (pathname === '/collections') return <Collections />;
  const [group, id, mode, ...extras] = pathname.split('/').slice(1);
  if (id && !mode && group === 'videos') return <LegacyVideo key={id} id={id}/>;
  if (id && !mode && (group === 'announcements' || group === 'notices')) return <AnnouncementReader key={id} id={id}/>;
  if ((group === 'collections' || group === 'shared') && id) {
    const chapter = mode === 'items' && extras.length === 1 && extras[0];
    if (mode && !chapter && !(group === 'collections' && mode === 'edit' && !extras.length))
      return <Missing />;
    if (group === 'shared') return <SharedCollection id={id} itemId={chapter} key={id} />;
    if (id === 'new' && !mode) return <CollectionEditor key={path} />;
    const collection = collections.find((c) => c.id === id);
    if (!collection || (mode === 'edit' && collection.ownerId !== 'me'))
      return <Missing label="可访问的合集" />;
    if (mode === 'edit') return <CollectionEditor key={path} collection={collection} />;
    return <CollectionView collection={collection} itemId={chapter} key={id} />;
  }
  if (group === 'notes' && id && mode === 'sharing' && !extras.length) {
    const note = allNotes.find(n => n.id === id && n.ownerId === 'me');
    return note ? <NoteSharing key={id} note={note}/> : <Missing label="分享设置"/>;
  }
  if (extras.length || !id || (mode && mode !== 'edit')) return <Missing />;
  if (group === 'trainings') {
    if (id === 'new' && !mode) return <TrainingForm key={path} />;
    const item = trainings.find((t) => t.id === id);
    if (!item && !catalogReady)
      return (
        <p className="page-width pending-reader" role="status">
          正在读取训练室…
        </p>
      );
    if (!item && sharesError) return <ReadError retry={refreshShares} />;
    if (item && mode && !(canEditMaterial(item) || (params.get('manage')==='1' && item.canManageArchive)))
      return <Missing label="可编辑的内容" />;
    return item ? (
      mode ? (
        <TrainingForm t={item} key={path} />
      ) : (
        <TrainingDetail t={item} key={id} />
      )
    ) : (
      <Missing label="训练" />
    );
  }
  if (group === 'notes') {
    if (id === 'new' && !mode) return <NoteEditor key={path} />;
    const n = allNotes.find((x) => (x.id === id || x.publicId === id) && (!mode || x.ownerId === 'me'));
    return n ? mode ? <NoteEditor n={n} key={path}/> : <NoteDetail n={n}/> : <RemoteNote key={id} id={id} edit={mode==='edit'}/>;

  }
  return <Missing />;
}

function RemoteNote({id,edit}) {
  const {ctx} = useData();
  const [item,setItem] = useState(null), [error,setError] = useState(''), [attempt,retry] = useState(0);
  useEffect(()=>{
    const c=new AbortController();
    loadNote({...ctx,signal:c.signal},id).then(n=>{if(!c.signal.aborted)setItem(n);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});
    return ()=>c.abort();
  },[ctx,id,attempt]);
  if(error)return <div role="alert">{error}<button onClick={()=>{setError('');retry(n=>n+1);}}>重新读取</button></div>;
  if(!item)return <p role="status">正在读取复盘…</p>;
  if(edit && item.ownerId!=='me')return <Missing/>;
  return edit?<NoteEditor n={item}/>:<NoteDetail n={item}/>;
}
export default function Workspace(props) {
  return <div data-bloom-workspace>
    <link rel="stylesheet" href="/workspace-assets/workspace.css"/>
    <DataProvider {...props}><RouterProvider initialPath={props.initialPath}><Shell><Suspense fallback={<p className="page-width" role="status">正在打开页面…</p>}><Route/></Suspense></Shell></RouterProvider></DataProvider>
  </div>;
}
