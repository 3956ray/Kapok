'use client';
import { ReflectionIcon } from './reflection-icon';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { controlledBackSource } from '../../lib/client/navigation-state';
import { BookOpen, CalendarDays, ChevronLeft, ChevronRight, Clock, House, LoaderCircle, PanelLeft, Sprout, UserRound } from 'lucide-react';

function NavigationGlyph({ Icon, size }: { Icon: typeof House; size: number }) {
    const { pending } = useLinkStatus();
    return pending
        ? <LoaderCircle size={size} className="navigation-pending" role="status" aria-label="正在打开页面" />
        : <Icon size={size} aria-hidden="true" />;
}

const home = { href: '/', text: '首页', Icon: House };
const trainings = { href: '/trainings', text: '训练', Icon: CalendarDays };
const growth = { href: '/growth', text: '成长', Icon: Sprout };
const account = { href: '/me', text: '我的', Icon: UserRound };
const mobileItems = [home, trainings, { href: '/reflections/new', text: '写复盘', Icon: ReflectionIcon }, growth, account];
const desktopItems = [home, { href: '/activity', text: '队内动态', Icon: Clock }, trainings, { href: '/learn', text: '学习库', Icon: BookOpen }, growth];

function destination(path: string) {
    const root = '/' + (path.split('/')[1] ?? '');
    if (root === '/home') return '/';
    if (root === '/videos') return '/trainings';
    if (root === '/reflections') return '/growth';
    if (root === '/members') return '/';
    if (root === '/announcements') return '/activity';
    return root;
}

export function Navigation({ canCompose = false }: { canCompose?: boolean }) {
  const pathname = usePathname();
  const current = destination(pathname);
  const owner = current === '/members' || current === '/activity' ? '/' : current;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => {
      const height = entries[0].target.getBoundingClientRect().height;
      if (height) document.documentElement.style.setProperty('--nav-height', `${height}px`);
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--nav-height');
    };
  }, []);
  return <nav className="bottom-nav" aria-label="主要导航" ref={ref}>{mobileItems.filter(item => canCompose || item.href !== '/reflections/new').map(({ href, text, Icon }) => {
    const selected = pathname === '/reflections/new' && canCompose ? href === '/reflections/new' : href === owner;
    return <Link href={href} prefetch={false} key={href} aria-current={selected ? 'page' : undefined} className={selected ? 'selected' : ''}><NavigationGlyph Icon={Icon} size={22} /><span>{text}</span></Link>;
  })}</nav>;
}

// Device-only visual preference. Read after mount so SSR and hydration start expanded.
const sidebarPreferenceKey = 'kapok:sidebar-collapsed';
let collapsed = false;
let preferenceLoaded = false;
const sidebarListeners = new Set<() => void>();
const sidebarSnapshot = () => collapsed;
const initialSidebarSnapshot = () => false;
function subscribeSidebar(listener: () => void) {
    if (!preferenceLoaded && typeof window !== 'undefined') {
        preferenceLoaded = true;
        try { collapsed = window.localStorage.getItem(sidebarPreferenceKey) === 'true'; } catch { /* Storage may be disabled; in-memory preference still works. */ }
    }
    sidebarListeners.add(listener);
    return () => { sidebarListeners.delete(listener); };
}
function toggleSidebar() {
    collapsed = !collapsed;
    try { window.localStorage.setItem(sidebarPreferenceKey, String(collapsed)); } catch { /* A blocked preference write must not block navigation. */ }
    for (const listener of sidebarListeners) listener();
}

export function WorkspaceSidebar({ canCompose }: { canCompose: boolean }) {
    const current = destination(usePathname());
    const compact = useSyncExternalStore(subscribeSidebar, sidebarSnapshot, initialSidebarSnapshot);
    const toggleLabel = compact ? '展开侧栏' : '缩小侧栏';
    return <aside className="workspace-sidebar" data-collapsed={compact}>
        <div className="workspace-sidebar-inner">
            <div className="workspace-brand">
                <Link href="/" prefetch={false} aria-label="Kapok 首页" title="Kapok 首页"><b>K<span>.</span></b><strong>Kapok</strong></Link>
                <button className="workspace-toggle" type="button" aria-label={toggleLabel} aria-expanded={!compact} title={toggleLabel} onClick={toggleSidebar}><PanelLeft size={18} aria-hidden="true" /></button>
            </div>
            <div className="workspace-team">
                <span aria-hidden="true">K</span><div><strong>Kapok</strong><small>队内训练空间</small></div>
            </div>
            {canCompose && <Link className="workspace-compose" href="/reflections/new" aria-label="写复盘" title="写复盘"><ReflectionIcon size={17} aria-hidden="true" /><span>写复盘</span></Link>}
            <p className="workspace-nav-label">工作区</p>
            <nav className="workspace-nav" aria-label="工作区导航">{desktopItems.map(({ href, text, Icon }) =>
                <Link key={href} href={href} prefetch={false} title={text} aria-label={text} aria-current={href === current ? 'page' : undefined}>
                    <NavigationGlyph Icon={Icon} size={19} /><span>{text}</span>
                </Link>
            )}</nav>
            <div className="workspace-account">
                <small>Kapok Bloom</small>
                <Link href="/me" aria-label="我的账号" title="我的账号" aria-current={current === '/me' ? 'page' : undefined}>
                    <span className="workspace-account-icon"><UserRound size={17} aria-hidden="true" /></span>
                    <span className="workspace-account-text"><strong>我的账号</strong><small>账号与资料</small></span>
                    <ChevronRight className="workspace-account-arrow" size={14} aria-hidden="true" />
                </Link>
            </div>
        </div>
    </aside>;
}

export function ControlledBack({ fallback, compact = false }: { fallback: string; compact?: boolean }) {
    const route = usePathname();
    const [href, setHref] = useState(fallback);
    useEffect(() => {
        const source = controlledBackSource();
        const timer = setTimeout(() => setHref(source ?? fallback), 0);
        return () => clearTimeout(timer);
    }, [fallback, route]);
    const label = href === '/me' ? '我的' : href === '/growth' ? '成长' : href === '/trainings' ? '训练列表' : href === '/members' ? '队伍成员' : href === '/me/data' ? '个人数据' : href === '/activity' ? '队内动态' : href === '/' || href === '/home' ? '首页' : '来源页面';
    if (compact) return <Link href={href} prefetch={false} className="back-link video-back" aria-label={`返回 · ${label}`} title={`返回 · ${label}`}><ChevronLeft size={16} aria-hidden="true" /></Link>;
    return <Link href={href} prefetch={false} className="back-link">返回 · {label}</Link>;
}


export function preserveTargetHash(returnTo: string) {
    const { hash, pathname } = window.location;
    const comment = pathname.startsWith('/videos/') && /^#comment-[a-zA-Z0-9_-]{1,80}$/.test(hash);
    const announcement = pathname.startsWith('/announcements/') && hash === '#body';
    if (!comment && !announcement) return returnTo;
    const destination = new URL(returnTo, window.location.origin);
    if (destination.pathname !== pathname) return returnTo;
    return destination.pathname + destination.search + hash;
}

export function AccessLink({ href, returnTo, param, children, target }: { href: string; returnTo: string; param?: 'return_to' | 'returnTo'; children: React.ReactNode; target?: string }) {
    const anchor = useRef<HTMLAnchorElement>(null);
    useEffect(() => {
        const destination = preserveTargetHash(returnTo);
        if (destination === returnTo) return;
        const login = new URL(href, window.location.origin);
        if (param) login.searchParams.set(param, destination);
        else login.hash = new URL(destination, window.location.origin).hash;
        if (anchor.current) anchor.current.href = login.pathname + login.search + login.hash;
    }, [href, returnTo, param]);
    return <a ref={anchor} href={href} className="button" target={target}>{children}</a>;
}
