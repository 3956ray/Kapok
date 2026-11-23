import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
const Router = createContext(null);
const base = '/trainings';
function currentPath(initialPath = base) {
  const raw = window.location.hash.slice(1);
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return normalizeLegacyAnchor(initialPath, raw);
}
function normalizeLegacyAnchor(path, anchor) {
  const url = new URL(path, 'http://kapok.local');
  if (url.pathname.startsWith('/videos/') && /^comment-[a-zA-Z0-9_-]+$/.test(anchor)) url.searchParams.set('comment', anchor.slice(8));
  if (url.pathname.startsWith('/announcements/') && anchor === 'body') url.searchParams.set('anchor', 'body');
  return url.pathname + url.search;
}
function index() {
  return Number.isInteger(history.state?.kapokIndex) ? history.state.kapokIndex : 0;
}

function commentTarget(path) {
  const url = new URL(path, 'http://kapok.local');
  const id = url.searchParams.get('comment');
  const element = id && url.pathname.startsWith('/trainings/') ? document.getElementById('comment-' + id) : null;
  // A cold or stale feed may replace its unavailable notice with the actual reply.
  return element?.hasAttribute('data-comment-unavailable') ? null : element;
}
function focusComment(el) {
  const frame = document.documentElement;
  const padding = getComputedStyle(frame);
  const available =
    frame.clientHeight - parseFloat(padding.scrollPaddingTop) - parseFloat(padding.scrollPaddingBottom);
  const align = el.getBoundingClientRect().height > available ? 'start' : 'center';
  el.scrollIntoView({ block: align, behavior: 'instant' });
  el.focus({ preventScroll: true });
}

// A shared discussion can arrive after the route's first render.
function followComment(path) {
  const url = new URL(path, 'http://kapok.local');
  if (!url.pathname.startsWith('/trainings/') || !url.searchParams.get('comment')) return null;
  const target = commentTarget(path);
  if (target) {
    focusComment(target);
    return null;
  }
  const main = document.querySelector('main');
  if (!main) return null;
  const observer = new MutationObserver(() => {
    const el = commentTarget(path);
    if (el) {
      observer.disconnect();
      focusComment(el);
    }
  });
  observer.observe(main, { childList: true, subtree: true });
  return observer;
}

function returnFocusFor(control) {
  const root = control?.closest('main');
  if (!root) return null;
  const attribute = control.matches('a[href]') ? 'href' : 'aria-label';
  const value = control.getAttribute(attribute);
  if (!value) return null;
  const selector =
    control.localName + '[' + attribute + '="' + CSS.escape(value) + '"]:not([tabindex="-1"])';
  const candidates = Array.from(root.querySelectorAll(selector));
  return { selector, occurrence: Math.max(0, candidates.indexOf(control)) };
}

export function RouterProvider({ children, initialPath = base }) {
  const [path, setPath] = useState(() => currentPath(initialPath));
  const current = useRef({ path: currentPath(initialPath), index: index(), photo: history.state?.kapokPhoto });
  const positions = useRef(new Map());
  const transition = useRef(null);
  const pendingComment = useRef(null);
  const version = useRef(0);
  const change = useCallback((to, id, back, restore, nextPhoto) => {
    const ticket = ++version.current;
    pendingComment.current?.disconnect();
    const previous = current.current;
    const photo = back ? previous.photo : nextPhoto;
    const [kind, ...idParts] = photo?.split(':') ?? [];
    const idPart = idParts.join(':');
    const isNote = kind?.endsWith('-note');
    const isCollection = kind === 'collection';
    const destKey = isNote ? 'note:' + idPart : isCollection ? 'collection:' + idPart : idPart;
    const listPath = (back ? to : previous.path).split('?')[0];
    const detailPath = (back ? previous.path : to).split('?')[0];
    const paired = Boolean(
      idPart &&
      ['/trainings', '/growth', '/activity', '/collections'].includes(listPath) &&
      detailPath ===
        (isCollection
          ? idPart.startsWith('shared:')
            ? '/shared/' + idPart.slice(7)
            : '/collections/' + idPart
          : (isNote ? '/notes/' : '/trainings/') + idPart),
    );
    const transitionName = isNote ? 'kapok-title' : 'kapok-media';
    const lookup = (detail) =>
      paired
        ? document.querySelector(
            detail
              ? '[data-photo-destination="' + CSS.escape(destKey) + '"]'
              : '[data-photo-key="' + CSS.escape(photo) + '"]',
          )
        : null;
    positions.current.set(current.current.index, window.scrollY);
    const y = restore ? (positions.current.get(id) ?? history.state?.kapokY ?? 0) : 0;
    const marker = back && restore ? history.state?.kapokReturnFocus : null;
    current.current = { path: to, index: id, photo: nextPhoto };
    const update = () => {
      if (ticket !== version.current) return;
      flushSync(() => setPath(to));
      window.scrollTo({ top: y, behavior: 'instant' });
      const targetComment = !restore && commentTarget(to);
      if (!targetComment) {
        const main = document.querySelector('main');
        const origin = marker && main?.querySelectorAll(marker.selector)[marker.occurrence];
        (origin || main)?.focus({ preventScroll: true });
      }
      if (!restore) pendingComment.current = followComment(to);
      const target = lookup(!back);
      if (
        target &&
        document.startViewTransition &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        target.style.viewTransitionName = transitionName;
    };
    transition.current?.skipTransition();
    document
      .querySelectorAll('[data-photo-key],[data-photo-destination]')
      .forEach((el) => el.style.removeProperty('view-transition-name'));
    document.documentElement.dataset.direction = back ? 'back' : 'forward';
    document.documentElement.dataset.section = to.split('/')[1].split('?')[0];
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const origin = lookup(back);
      if (origin) origin.style.viewTransitionName = transitionName;
      transition.current = document.startViewTransition(update);
      transition.current.ready.catch(() => {});
      transition.current.finished.finally(() => {
        if (ticket === version.current) lookup(!back)?.style.removeProperty('view-transition-name');
      });
    } else update();
  }, []);
  const go = useCallback(
    (to, opts = {}) => {
      if (!to.startsWith('/') || to.startsWith('//')) return;
      if (to === current.current.path) {
        window.scrollTo({
          top: 0,
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        });
        return;
      }
      const newIndex = opts.replace ? current.current.index : current.current.index + 1;
      const from = opts.replace ? history.state?.kapokFrom : current.current.path;
      if (!opts.replace)
        history.replaceState(
          {
            ...history.state,
            kapokY: window.scrollY,
            kapokReturnFocus: returnFocusFor(opts.trigger || document.activeElement),
          },
          '',
        );
      history[opts.replace ? 'replaceState' : 'pushState'](
        { kapokIndex: newIndex, kapokFrom: from, kapokPhoto: opts.photoKey },
        '',
        '#' + to,
      );
      change(to, newIndex, false, false, opts.photoKey);
    },
    [change],
  );
  const back = useCallback(
    (fallback = base) => {
      if (index() > 0 && history.state?.kapokFrom) history.back();
      else go(fallback, { replace: true });
    },
    [go],
  );
  useLayoutEffect(() => {
    const scrollMode = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    if (location.pathname !== '/home' || !history.state || history.state.kapokIndex == null || !location.hash)
      history.replaceState({ ...history.state, kapokIndex: 0 }, '', '/home#' + currentPath(initialPath));
    pendingComment.current = followComment(currentPath());
    const pop = () => {
      const to = currentPath();
      // A newly entered fragment has no saved scroll or focus position.
      if (!Number.isInteger(history.state?.kapokIndex)) {
        const id = current.current.index + 1;
        history.replaceState({ ...history.state, kapokIndex: id }, '');
        change(to, id, false, false);
        return;
      }
      const id = index();
      if (to !== current.current.path || id !== current.current.index)
        change(to, id, id < current.current.index, true, history.state?.kapokPhoto);
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('hashchange', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('hashchange', pop);
      history.scrollRestoration = scrollMode;
      pendingComment.current?.disconnect();
    };
  }, [change,initialPath]);
  const url = new URL(path, 'http://kapok.local');
  return (
    <Router.Provider value={{ path, pathname: url.pathname, params: url.searchParams, go, back }}>
      {children}
    </Router.Provider>
  );
}
export const useNav = () => useContext(Router);
export function NavLink({ to: destination, onClick, children, photoKey, returnFocusRef, ...props }) {
  const { go } = useNav();
  const [path, anchor] = destination.split('#');
  const to = /^\/(announcements|videos)\//.test(path) ? normalizeLegacyAnchor(path, anchor || '') : destination;
  if (/^\/(reflections|learn)\//.test(to)) return <a {...props} href={to} onClick={onClick}>{children}</a>;
  return (
    <a
      {...props}
      href={'#' + to}
      onClick={(e) => {
        onClick?.(e);
        if (
          !e.defaultPrevented &&
          e.button === 0 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey
        ) {
          e.preventDefault();
          go(to, { photoKey, trigger: returnFocusRef?.current || e.currentTarget });
        }
      }}
    >
      {children}
    </a>
  );
}
export function useTitle(title) {
  useEffect(() => {
    document.title = title + ' · Kapok Bloom';
  }, [title]);
}
