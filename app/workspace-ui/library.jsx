import {
  ArrowDownWideNarrow,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  Clapperboard,
  Grid2X2,
  List,
  Play,
  Plus,
} from 'lucide-react';
import { NavLink, useTitle } from './router';
import { canEditMaterial, clock, kindName, media, shortDate, useData } from './store';
import { LibraryNav } from './collections';
import { DeleteAction, Dropdown, Empty, IconButton, PageHead, Segments, usePreference } from './ui';
export function DeleteMaterial({ item, disabled, returnFocusId }) {
  const { deleteMaterial } = useData();
  if (item.kind!=='training' && !item.published) return null;
  async function remove() {
    await deleteMaterial(item);
    if (returnFocusId) requestAnimationFrame(() => {
      (document.getElementById(returnFocusId) || document.getElementById('archive-title'))?.focus({ preventScroll: true });
    });
  }
  return (
    <DeleteAction iconOnly label={(item.kind==='training'?'删除':'撤回')+kindName[item.kind]} title={item.title} disabled={disabled}
      description="将从队内可读内容中移除。"
      onDelete={remove} to={returnFocusId ? undefined : '/trainings'} />
  );
}

export function SavedButton({ id, kind = 'training', overlay = false }) {
  const { db, bookmark } = useData();
  const saved = Boolean(db.saved[id]);
  return (
    <IconButton
      icon={Bookmark}
      label={saved ? '取消收藏' : '收藏' + kindName[kind]}
      aria-pressed={saved}
      className={'bookmark ' + (overlay ? 'on-photo ' : '') + (saved ? 'saved' : '')}
      onClick={() => bookmark(id)}
    />
  );
}
export function Cover({ t, lazy = true }) {
  return (
    <img
      className={'cover cover-' + t.id}
      src={t.photos?.[0]?.url || t.platformCover || media((t.image || 'defense') + '.webp')}
      loading={lazy ? 'lazy' : 'eager'}
      decoding="async"
      alt=""
    />
  );
}
function TrainingCard({ t, mode, neighbor }) {
  const titleId = 'archive-title-' + t.id;
  return (
    <article className={'training-card ' + mode} aria-labelledby={titleId}>
      <div className="card-visual" data-photo-key={'card:' + t.id}>
        <NavLink
          tabIndex={-1}
          aria-hidden="true"
          photoKey={'card:' + t.id}
          to={'/trainings/' + t.id}
          className="photo-link"
        >
          <Cover t={t} />
        </NavLink>
        <SavedButton id={t.id} kind={t.kind} overlay />
        {t.duration > 0 && (
          <span className="timecode">
            <Play size={10} fill="currentColor" />
            {clock(t.duration)}
          </span>
        )}
      </div>
      <div className="card-body">
        <div className="card-meta">
          <span className={'category cat-' + t.category}>
            <i />
            {t.category}
          </span>
          <span className="meta-rule" />
          <span>{t.format}</span>
        </div>
        <h3>
          <NavLink id={titleId} to={'/trainings/' + t.id} photoKey={'card:' + t.id} className="card-title">
            {t.title}
            <ArrowRight size={15} />
          </NavLink>
        </h3>
        <div className="card-byline">
          <p><time dateTime={t.date}>{shortDate(t.date)}</time><span>·</span>{t.author}</p>
          {canEditMaterial(t) && <DeleteMaterial item={t}
            returnFocusId={neighbor ? 'archive-title-' + neighbor.id : 'archive-title'} />}
        </div>
      </div>
    </article>
  );
}
export function Library() {
  useTitle('训练室');
  const { ctx, trainings, categoryNames } = useData();
  const createLabel = ctx.account.membership.role==='admin'?'新建训练':'发布资料';
  const featured = trainings.find((t) => t.kind === 'training' && t.published);
  const [filter, setFilter] = usePreference('training-filter', '全部'),
    [mode, setMode] = usePreference('training-view', 'grid');
  const [sort, setSort] = usePreference('training-sort', '最新优先');
  const visible = trainings.filter((t) => (t.published || t.status==='archived') && (filter === '全部' || t.category === filter));
  const createPath =
    '/trainings/new' + (categoryNames.includes(filter) ? '?category=' + encodeURIComponent(filter) : '');
  if (sort === '最早优先') visible.reverse();
  return (
    <div className="page-width library-page">
      <PageHead
        title="训练室"
        description="Kapok Bloom 影像档案"
        action={
          <NavLink to={createPath} className="btn primary">
            <Plus size={17} />
            {createLabel}
          </NavLink>
        }
      />
      <LibraryNav active="archive" />
      {featured && (
        <section className="feature" aria-label="最新训练">
          <NavLink
            className="feature-image"
            to={'/trainings/' + featured.id}
            photoKey={'feature:' + featured.id}
            aria-label={'查看最新训练：' + featured.title}
          >
            <span className="feature-frame" data-photo-key={'feature:' + featured.id}>
              <Cover t={featured} lazy={false} />
            </span>
            {featured.duration > 0 && (
              <span className="feature-runtime">
                <Play size={11} fill="currentColor" />
                {clock(featured.duration)}
              </span>
            )}
          </NavLink>
          <div className="feature-copy">
            <div className="feature-meta">
              <span className="press-section">最新训练</span>
              <time dateTime={featured.date}>{featured.date.replaceAll('-', '.')}</time>
            </div>
            <div>
              <h2>{featured.title}</h2>
              <p>{featured.summary}</p>
            </div>
            <NavLink
              className="screen-link"
              photoKey={'feature:' + featured.id}
              to={'/trainings/' + featured.id}
            >
              <i>
                <Play size={15} fill="currentColor" />
              </i>
              查看训练
              <ArrowRight size={18} />
            </NavLink>
          </div>
        </section>
      )}
      <section className="archive" aria-labelledby="archive-title">
        <div className="archive-head">
          <div className="heading-line">
            <h2 id="archive-title" tabIndex={-1}>训练档案</h2>
            <span className="count">{trainings.filter(t=>t.published || t.status==='archived').length}</span>
          </div>
          <div className="archive-tools">
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                <button type="button" className="sort" aria-label={'排序，' + sort}>
                  <ArrowDownWideNarrow size={16} />
                  <span>{sort}</span>
                  <ChevronDown size={13} />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content align="end" sideOffset={6} className="menu">
                  {['最新优先', '最早优先'].map((v) => (
                    <Dropdown.Item key={v} onSelect={() => setSort(v)}>
                      {v}
                      {sort === v && <Check size={15} />}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            <div className="view-mode" role="group" aria-label="档案布局">
              <IconButton
                icon={Grid2X2}
                label="网格视图"
                aria-pressed={mode === 'grid'}
                onClick={() => setMode('grid')}
              />
              <IconButton
                icon={List}
                label="列表视图"
                aria-pressed={mode === 'list'}
                onClick={() => setMode('list')}
              />
            </div>
          </div>
        </div>
        <Segments
          label="训练类别"
          items={['全部', ...categoryNames]}
          value={filter}
          onChange={setFilter}
        >
          {visible.length ? (
            <div className={'training-results ' + mode} key={mode + sort}>
              {visible.map((t, i) => (
                <TrainingCard t={t} mode={mode} key={t.id} neighbor={visible[i + 1] || visible[i - 1]} />
              ))}
            </div>
          ) : (
            <Empty
              icon={Clapperboard}
              title="这个分类还没有训练"
              action={
                <NavLink to={createPath} className="btn">
                  {createLabel}
                </NavLink>
              }
            />
          )}
        </Segments>
      </section>
    </div>
  );
}
