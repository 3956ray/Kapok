import { ArrowUpRight, PenLine, Plus } from 'lucide-react';
import { useData, eventTime, kindName } from './store';
import { NavLink, useTitle } from './router';
import { DateMark } from './press';
import { noteCategoryLabel } from './categories.js';
import { Back, Empty, PageHead, Segments, usePreference, WriteNoteIcon } from './ui';

export function publishedRecords(trainings, collections, notes) {
  return [
    ...trainings
      .filter((t) => t.ownerId === 'me')
      .map((t) => ({
        id: t.id,
        title: t.title,
        type: kindName[t.kind],
        date: t.date,
        category: t.category,
        href: '/trainings/' + t.id,
      })),
    ...collections
      .filter((c) => c.ownerId === 'me')
      .map((c) => ({
        id: c.id,
        title: c.title,
        type: '合集',
        date: c.updated,
        category: c.category,
        href: '/collections/' + c.id,
      })),
    ...notes
      .filter((n) => n.scope === 'team')
      .map((n) => ({
        id: n.id,
        title: n.title,
        type: '复盘',
        date: n.created,
        category: noteCategoryLabel(n),
        href: '/notes/' + n.id,
      })),
  ].sort((a, b) => eventTime(b.date) - eventTime(a.date));
}
export function Published() {
  useTitle('我的发布');
  const { trainings, collections, db } = useData();
  const [filter, setFilter] = usePreference('published-filter', '全部');
  const list = publishedRecords(trainings, collections, db.notes).filter(
    (r) => filter === '全部' || r.type === filter,
  );
  function newPath() {
    if (filter === '合集') return '/collections/new';
    if (filter === '复盘') return '/notes/new';
    return (
      '/trainings/new' + (filter === '图文' ? '?kind=article' : filter === '视频' ? '?kind=video' : '')
    );
  }
  return (
    <div className="page-width published-page">
      <Back fallback="/account" />
      <PageHead
        title="我的发布"
        description={db.profile.name + '的队内作品'}
        action={
          <NavLink className="btn primary" to={newPath()}>
            {filter === '复盘' ? <WriteNoteIcon size={17} /> : <Plus size={15} />}
            {filter === '合集' ? '新建合集' : filter === '复盘' ? '写复盘' : '新增内容'}
          </NavLink>
        }
      />
      <Segments
        label="发布类型"
        items={['全部', '训练', '图文', '视频', '合集', '复盘']}
        value={filter}
        onChange={setFilter}
      >
        {list.length ? (
          <div className="publication-list">
            {list.map((r) => (
              <NavLink className="publication-row" to={r.href} key={r.href}>
                <DateMark value={r.date} />
                <div>
                  <small>
                    {r.type} · {r.category}
                  </small>
                  <h2>{r.title}</h2>
                </div>
                <ArrowUpRight size={18} />
              </NavLink>
            ))}
          </div>
        ) : (
          <Empty
            icon={PenLine}
            title={'还没有发布' + filter}
            text={
              filter === '复盘'
                ? '保存为「队内可读」的复盘会出现在这里。'
                : '从右上角开始，完成后可以在这里找到。'
            }
          />
        )}
      </Segments>
    </div>
  );
}
