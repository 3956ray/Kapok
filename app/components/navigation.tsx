'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createElement, useEffect, useRef, useState } from 'react';
import { controlledBackSource } from '../../lib/client/navigation-state';
import { House, CalendarDays, Sprout, UserRound } from 'lucide-react';

const items = [ { href: '/', text: '首页', Icon: House }, { href: '/trainings', text: '训练', Icon: CalendarDays }, { href: '/growth', text: '成长', Icon: Sprout }, { href: '/me', text: '我的', Icon: UserRound } ];
export function Navigation() {
  const path = usePathname();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => document.documentElement.style.setProperty('--nav-height', `${entries[0].target.getBoundingClientRect().height}px`));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <nav className="bottom-nav" aria-label="主要导航" ref={ref}>{items.map(({ href, text, Icon }) => {
    const owner = path.startsWith('/videos/') ? '/trainings' : path.startsWith('/reflections/') ? '/growth' : /^\/(members|activity|announcements)(\/|$)/.test(path) ? '/' : path;
    const selected = href === '/' ? owner === '/' : owner === href || owner.startsWith(href + '/');
    return <Link href={href} key={href} aria-current={selected ? 'page' : undefined} className={selected ? 'selected' : ''}><Icon size={22} strokeWidth={2} aria-hidden="true" /><span>{text}</span></Link>;
  })}</nav>;
}

export function ControlledBack({ fallback }: { fallback: string }) {
    const [href, setHref] = useState(fallback);
    useEffect(() => {
        const source = controlledBackSource();
        const timer = setTimeout(() => { if (source) setHref(source); }, 0);
        return () => clearTimeout(timer);
    }, [fallback]);
    const label = href === '/me' ? '我的' : href === '/growth' ? '成长' : href === '/trainings' ? '训练列表' : href === '/members' ? '队伍成员' : href === '/me/data' ? '个人数据' : href === '/activity' ? '队内动态' : href === '/' ? '首页' : '来源页面';
    return createElement(Link, { href, className: 'back-link' }, `返回 · ${label}`);
}


export function AccessLink({ href, returnTo, param, children, target }: { href: string; returnTo: string; param: 'return_to' | 'returnTo'; children: React.ReactNode; target?: string }) {
    const anchor = useRef<HTMLAnchorElement>(null);
    useEffect(() => {
        const hash = window.location.hash;
        if (!/^#comment-[a-zA-Z0-9_-]{1,80}$/.test(hash) || !window.location.pathname.startsWith('/videos/')) return;
        const destination = new URL(returnTo, window.location.origin);
        if (destination.pathname !== window.location.pathname) return;
        destination.hash = hash;
        const login = new URL(href, window.location.origin);
        login.searchParams.set(param, destination.pathname + destination.search + hash);
        if (anchor.current) anchor.current.href = login.pathname + login.search;
    }, [href, returnTo, param]);
    return <a ref={anchor} href={href} className="button" target={target}>{children}</a>;
}
