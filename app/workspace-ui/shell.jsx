import { useEffect, useRef, useState } from 'react';
import { Dialog, Tooltip } from 'radix-ui';
import {
  Activity,
  BookOpen,
  ChevronRight,
  Clapperboard,
  Layers,
  CornerDownLeft,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { NavLink, useNav } from './router';
import { kindName, useData } from './store';
import { noteCategoryLabel } from './categories.js';
import { catalogEntries, matchText } from './collection-model';
import { Avatar, IconButton, Mark, Modal, Status, Tip, usePreference, WriteNoteIcon } from './ui';
const dests = [
  { to: '/trainings', name: '训练室', icon: Clapperboard },
  { to: '/growth', name: '成长记录', icon: BookOpen },
  { to: '/activity', name: '队内动态', icon: Activity },
  { to: '/members', name: '队伍成员', icon: Users },
];
const teamChannels = [
  { name: '小红书', icon: 'xiaohongshu', width: 32, href: 'https://xhslink.cn/o/AYxeURNRZD1' },
  { name: '微信公众号', icon: 'wechat', width: 22, href: 'https://mp.weixin.qq.com/s/DGLCJAcWE-qvA6B19WNRnw' },
  { name: '哔哩哔哩', icon: 'bilibili', width: 22, href: 'https://space.bilibili.com/3546573850019973' },
];
function NavBody({ narrow = false, mobile = false, onClose }) {
  const { pathname } = useNav(),
    { db } = useData();
  function link({ to, name, icon: Icon }) {
    const selected =
      pathname.startsWith(to) ||
      (to === '/trainings' &&
        (pathname.startsWith('/collections') || pathname.startsWith('/shared/'))) ||
      (to === '/growth' && pathname.startsWith('/notes') && pathname !== '/notes/new');
    const node = (
      <NavLink
        to={to}
        aria-label={name}
        aria-current={selected ? 'page' : undefined}
        onClick={onClose}
        className={'nav-link' + (selected ? ' current' : '')}
      >
        <Icon size={19} />
        <span className="nav-label">{name}</span>
        {selected && <i className="active-dot" />}
      </NavLink>
    );
    return narrow ? (
      <Tip key={to} label={name} side="right">
        {node}
      </Tip>
    ) : (
      <span key={to} className="nav-item">
        {node}
      </span>
    );
  }
  const compose = (
    <NavLink
      to="/notes/new"
      className={'compose-link' + (pathname === '/notes/new' ? ' writing' : '')}
      onClick={onClose}
      aria-label="写复盘"
    >
      <WriteNoteIcon size={18} />
      <span className="nav-label">写复盘</span>
    </NavLink>
  );
  return (
    <>
      <div className="brand-line">
        <NavLink to="/trainings" aria-label="Kapok 训练室" className="brand" onClick={onClose}>
          <Mark />
          <b>Kapok</b>
        </NavLink>
        {mobile && (
          <Dialog.Close asChild>
            <button className="icon-button" aria-label="关闭导航">
              <X size={19} />
            </button>
          </Dialog.Close>
        )}
      </div>
      <div className="side-nav">
        <div className="nav-caption">队伍工作区</div>
        <nav aria-label="工作区导航">{dests.map(link)}</nav>
        <div className="compose-wrap">
          {narrow ? (
            <Tip label="写复盘" side="right">
              {compose}
            </Tip>
          ) : (
            compose
          )}
        </div>
      </div>
      <div className="side-bottom">
        <div className="club-sign">
          <span className="club-line" />
          <span>Kapok Bloom</span>
        </div>
        <nav className="club-channels" aria-label="队伍社交平台">
          {teamChannels.map(({ name, icon, width, href }) => (
            <Tip key={icon} label={name + '（新窗口打开）'} side={narrow ? 'right' : 'top'}>
              <a href={href} target="_blank" rel="noopener noreferrer" aria-label={name + '（新窗口打开）'}>
                <img src={'/workspace-assets/media/' + icon + '.svg'} width={width} height={width} alt="" />
              </a>
            </Tip>
          ))}
        </nav>
        <NavLink
          to="/account"
          onClick={onClose}
          className={'profile-link' + (pathname.startsWith('/account') ? ' current' : '')}
          aria-label="我的账户"
        >
          <Avatar person={db.profile} />
          <span className="profile-copy">
            <strong>{db.profile.name}</strong>
            <small>我的账户</small>
          </span>
          <ChevronRight size={15} className="account-arrow" />
        </NavLink>
      </div>
    </>
  );
}
function Command({ open, setOpen }) {
  const { go } = useNav(),
    { trainings, allNotes, collections, remoteCollections } = useData();
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const input = useRef(null);
  const entries = [
    ...trainings.map((t) => ({
      title: t.title,
      to: '/trainings/' + t.id,
      tag: kindName[t.kind],
      text: [t.summary, t.body, t.author, t.category].join(' '),
      icon: Clapperboard,
    })),
    ...catalogEntries(collections, remoteCollections, trainings).map((c) => ({
      title: c.title,
      to: c.href,
      tag: '合集',
      text: [c.author, c.category, c.summary, c.contents].join(' '),
      icon: Layers,
    })),
    ...allNotes.map((n) => ({
      title: n.title,
      to: '/notes/' + n.id,
      tag: '复盘',
      text: [n.author, n.body, noteCategoryLabel(n)].join(' '),
      icon: BookOpen,
    })),
    ...dests.map((n) => ({ title: n.name, to: n.to, tag: '页面', icon: n.icon })),
    { title: '写复盘', to: '/notes/new', tag: '操作', icon: WriteNoteIcon },
    { title: '训练合集', to: '/collections', tag: '页面', icon: Layers },
    { title: '新建合集', to: '/collections/new', tag: '操作', icon: Layers },
    { title: '新建训练', to: '/trainings/new', tag: '操作', icon: Clapperboard },
    { title: '我的发布', to: '/account/published', tag: '页面', icon: Layers },
  ];
  const normalized = query.trim().toLowerCase();
  const matches = entries.filter((e) => matchText(normalized, e.title, e.tag, e.text));
  useEffect(() => {
    if (open) document.getElementById('cmd-' + active)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, query]);
  function visit(index) {
    if (matches[index]) {
      setOpen(false);
      go(matches[index].to);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="搜索工作区"
      className="search-modal"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        input.current?.focus();
      }}
    >
      <div className="command-input">
        <Search size={20} />
        <input
          ref={input}
          aria-label="搜索训练、复盘或页面"
          placeholder="搜索内容、合集或作者…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          role="combobox"
          aria-controls="command-list"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={matches.length ? 'cmd-' + active : undefined}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) =>
                Math.max(0, Math.min(matches.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))),
              );
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              visit(active);
            }
          }}
        />
      </div>
      <div id="command-list" role="listbox" aria-label="搜索结果" className="command-results">
        {matches.map((r, i) => (
          <button
            id={'cmd-' + i}
            key={r.to}
            type="button"
            role="option"
            aria-selected={active === i}
            className={active === i ? 'highlight' : ''}
            onFocus={() => setActive(i)}
            onClick={() => visit(i)}
          >
            <r.icon size={17} />
            <span>{r.title}</span>
            <small>{r.tag}</small>
          </button>
        ))}
        {!matches.length && (
          <p className="command-empty">没有找到「{query}」。试试训练名称或队内页面。</p>
        )}
      </div>
      <div className="command-foot">
        <span>↑ ↓ 选择</span>
        <span>
          <CornerDownLeft size={13} /> 打开
        </span>
        <span>Esc 关闭</span>
      </div>
    </Modal>
  );
}
export function Shell({ children }) {
  const { pathname } = useNav();

  const [collapsed, setCollapsed] = usePreference('collapsed', false);
  const [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(false);
  const menuButton = useRef(null),
    drawerOrigin = useRef(null);
  const inCollections = pathname.startsWith('/collections') || pathname.startsWith('/shared/');

  let group =
    dests.find((n) => pathname.startsWith(n.to))?.name ??
    (pathname.startsWith('/account')
      ? '我的账户'
      : inCollections
        ? '训练室'
        : pathname.startsWith('/notes')
          ? '成长记录'
          : '工作区');
  if (pathname === '/notes/new') group = '写复盘';
  const detail =
    pathname === '/trainings/new'
      ? '发布内容'
      : pathname.endsWith('/edit')
        ? '编辑'
        : pathname.startsWith('/trainings/')
          ? '训练详情'
          : pathname.startsWith('/notes/') && pathname !== '/notes/new'
            ? '复盘详情'
            : pathname === '/account/published'
              ? '我的发布'
              : inCollections
                ? '训练合集'
                : '';
  const [lastPath,setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMobile(false);
    setSearch(false);
  }
  useEffect(() => {
    function shortcut(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setMobile(false);
        setSearch((v) => !v);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    const q = matchMedia('(min-width: 821px)');
    const reset = () => {
      if (q.matches) setMobile(false);
    };
    q.addEventListener('change', reset);
    return () => q.removeEventListener('change', reset);
  }, []);
  return (
    <Tooltip.Provider delayDuration={180} skipDelayDuration={300}>
      <a
        className="skip"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.querySelector('main')?.focus();
        }}
      >
        跳到内容
      </a>
      <div className={'frame' + (collapsed ? ' narrow' : '')}>
        <aside className="sidebar">
          <NavBody narrow={collapsed} />
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="crumb">
              <div className="desktop-toggle">
                <IconButton
                  label={collapsed ? '展开侧栏' : '收起侧栏'}
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed(!collapsed)}
                  icon={collapsed ? PanelLeftOpen : PanelLeftClose}
                />
              </div>
              <button
                className="mobile-toggle icon-button"
                aria-label="打开导航"
                ref={menuButton}
                aria-expanded={mobile}
                onClick={() => setMobile(true)}
              >
                <Menu size={20} />
              </button>
              <span className="crumb-team">Kapok Bloom</span>
              <span className="crumb-slash">/</span>
              <span>{group}</span>
              {detail && (
                <>
                  <span className="crumb-slash">/</span>
                  <span className="crumb-detail">{detail}</span>
                </>
              )}
            </div>
            <div className="top-actions">
              <button className="search-button" aria-label="搜索工作区" onClick={() => setSearch(true)}>
                <Search size={16} />
                <span>搜索</span>
                <kbd>⌘ K</kbd>
              </button>
            </div>
          </header>
          <main id="main-content" className="route-page" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <Dialog.Root open={mobile} onOpenChange={setMobile}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim" />
          <Dialog.Content
            className="mobile-drawer"
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              drawerOrigin.current = location.hash;
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (location.hash === drawerOrigin.current)
                menuButton.current?.focus({ preventScroll: true });
            }}
          >
            <Dialog.Title className="sr">队伍导航</Dialog.Title>
            <NavBody mobile onClose={() => setMobile(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <nav className="phone-nav" aria-label="手机快捷导航">
        {[
          {
            to: '/trainings',
            name: '训练',
            Icon: Clapperboard,
            on: pathname.startsWith('/trainings') || inCollections,
          },
          { to: '/activity', name: '动态', Icon: Activity, on: pathname === '/activity' },
          { to: '/notes/new', name: '写复盘', Icon: WriteNoteIcon, on: pathname === '/notes/new' },
          {
            to: '/growth',
            name: '成长',
            Icon: BookOpen,
            on: pathname === '/growth' || (pathname.startsWith('/notes/') && pathname !== '/notes/new'),
          },
          { to: '/account', name: '我的', Icon: UserRound, on: pathname.startsWith('/account') },
        ].map(({ to, name, Icon, on }) => (
          <NavLink to={to} key={to} aria-current={on ? 'page' : undefined}>
            <span>
              <Icon size={18} />
            </span>
            {name}
          </NavLink>
        ))}
      </nav>
      <Command key={search ? 'open' : 'closed'} open={search} setOpen={setSearch} />
      <Status />
    </Tooltip.Provider>
  );
}
