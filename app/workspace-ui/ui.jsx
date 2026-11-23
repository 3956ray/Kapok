import { useEffect, useRef, useState } from 'react';
import { Dialog, Tabs, Tooltip, DropdownMenu as Dropdown } from 'radix-ui';
import { ArrowLeft, Check, Trash2, X } from 'lucide-react';
import { useNav } from './router';
import { useData } from './store';

export { Dropdown };
export { NotebookPen as WriteNoteIcon } from 'lucide-react';
export function Mark({ small = false }) {
  return (
    <span aria-hidden="true" className={'flower-mark' + (small ? ' small' : '')}>
      {[0, 1, 2, 3, 4].map((n) => (
        <i key={n} style={{ '--petal': n }} />
      ))}
    </span>
  );
}
export function Avatar({ person, large = false }) {
  return (
    <span aria-hidden="true" className={'avatar tone-' + person.tone + (large ? ' large' : '')}>
      {person.name.slice(-1)}
    </span>
  );
}
export function Tip({ label, children, side = 'top' }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function IconButton({ label, icon: Icon, children, className = '', ...props }) {
  return (
    <Tip label={label}>
      <button className={'icon-button ' + className} type="button" {...props} aria-label={label}>
        <Icon size={18} aria-hidden="true" />
        {children}
      </button>
    </Tip>
  );
}
export function Modal({ open, onOpenChange, title, description, children, className = '', ...events }) {
  const opener = useRef(null),
    origin = useRef('');
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim" />
        <Dialog.Content
          className={'modal ' + className}
          {...(!description && { 'aria-describedby': undefined })}
          {...events}
          onOpenAutoFocus={(e) => {
            opener.current = document.activeElement;
            origin.current = location.hash;
            events.onOpenAutoFocus?.(e);
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (location.hash === origin.current && opener.current?.isConnected)
              opener.current.focus({ preventScroll: true });
          }}
        >
          <header className="modal-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="关闭" type="button">
                <X size={19} />
              </button>
            </Dialog.Close>
          </header>
          {description && <Dialog.Description>{description}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DeleteAction({ label, title, description, onDelete, to, disabled = false, iconOnly = false }) {
  const { go } = useNav();
  const { notify } = useData();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const cancel = useRef(null);
  async function confirm() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const origin = location.hash;
    try {
      await onDelete();
      setOpen(false);
      notify('已' + label);
      if (to && location.hash === origin) go(to, { replace: true });
    } catch (e) {
      setError(e.message || '暂时无法删除，请重试。');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function show() {
    setError('');
    setOpen(true);
  }
  return (
    <>
      {iconOnly ? (
        <IconButton label={label} icon={Trash2} className="delete-icon" disabled={disabled} onClick={show} />
      ) : (
        <button className="delete-action" type="button" disabled={disabled} onClick={show}>
          <Trash2 size={15} aria-hidden="true" />{label}
        </button>
      )}
      <Modal open={open} onOpenChange={(next) => { if (!running.current) setOpen(next); }}
        title={label + '？'} description={'《' + title + '》' + description}
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="form-buttons">
          <button type="button" ref={cancel} className="btn" disabled={busy} onClick={() => setOpen(false)}>取消</button>
          <button type="button" className="btn danger-solid" disabled={busy} onClick={confirm}>
            {busy ? '正在删除…' : '确认删除'}
          </button>
        </div>
      </Modal>
    </>
  );
}
export function Segments({ label, items, value, onChange, onReselect, children, aside }) {
  const list = useRef(null);
  useEffect(() => {
    const el = list.current,
      active = el?.querySelector('[aria-selected="true"]');
    if (!active || !el.clientWidth) return;
    const x = active.offsetLeft,
      right = x + active.offsetWidth;
    if (x < el.scrollLeft) el.scrollLeft = x;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [value]);
  return (
    <Tabs.Root className="seg-section" value={value} onValueChange={onChange}>
      <div className="seg-row">
        <Tabs.List aria-label={label} className="segments" ref={list}>
          {items.map((v) => (
            <Tabs.Trigger key={v} className="seg" value={v} onClick={v === value ? onReselect : undefined}>
              {v}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {aside}
      </div>
      <Tabs.Content key={value} value={value} className="seg-content">
        {children}
      </Tabs.Content>
    </Tabs.Root>
  );
}
export function Back({ fallback = '/trainings', children }) {
  const { back } = useNav();
  const dest = (history.state?.kapokFrom || fallback).split('?')[0];
  const label =
    {
      '/trainings': '训练室',
      '/growth': '成长记录',
      '/activity': '队内动态',
      '/members': '队伍成员',
      '/account': '我的账户',
      '/account/published': '我的发布',
      '/collections': '训练合集',
      '/collections/new': '合集编辑',
    }[dest] ??
    (dest.startsWith('/collections/') || dest.startsWith('/shared/')
      ? dest.endsWith('/edit')
        ? '合集编辑'
        : '合集'
      : dest.startsWith('/trainings/')
        ? '训练详情'
        : dest.startsWith('/notes/')
          ? '复盘'
          : '');
  return (
    <button type="button" className="back-link" onClick={() => back(fallback)}>
      <ArrowLeft size={15} />
      {children ?? '返回' + label}
    </button>
  );
}
export function Empty({ icon: Icon, title, text, action, level = 2 }) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section className="empty">
      <span className="empty-glyph">
        <Icon size={24} />
      </span>
      <Heading>{title}</Heading>
      {text && <p>{text}</p>}
      {action}
    </section>
  );
}
export function PageHead({ title, description, action }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Status() {
  const { toast, storageError } = useData();
  return (
    <>
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.key}>
            <Check size={16} />
            {toast.text}
          </div>
        )}
      </div>
      {storageError && (
        <p role="alert" className="storage-error">
          此浏览器无法保存数据。当前操作仅在本次打开期间有效。
        </p>
      )}
    </>
  );
}
export function usePreference(key, initial) {
  const {ctx} = useData();
  const storageKey = "kapok:ui:"+ctx.actorId+":"+key;
  const [value, setValue] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey)) ?? initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* Use memory if storage is unavailable. */
    }
  }, [storageKey, value]);
  return [value, setValue];
}
