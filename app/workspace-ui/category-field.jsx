import { useEffect, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

export function CategoryField({
  value, onChange, names, onCreate, label = '类别', required = false, disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const input = useRef(null),
    select = useRef(null),
    id = useId();
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  function close() {
    setOpen(false);
    setError('');
    setName('');
    select.current?.focus();
  }
  function create() {
    try {
      onChange(onCreate(name));
      close();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="category-field">
      <div className="field-label-line">
        <label htmlFor={id}>
          {label}
          {required && <span className="label-lite" aria-hidden="true">必选</span>}
        </label>
        <button
          type="button"
          className="field-action"
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
          aria-expanded={open}
        >
          <Plus size={13} />
          新增类别
        </button>
      </div>
      <select
        ref={select}
        id={id}
        value={value}
        required={required}
        disabled={disabled}
        aria-invalid={(attempted && !value) || undefined}
        aria-describedby={attempted && !value ? id + '-missing' : undefined}
        onInvalid={() => setAttempted(true)}
        onChange={(e) => onChange(e.target.value)}
      >
        {required && <option value="" disabled>选择{label}</option>}
        {names.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      {attempted && !value && (
        <p id={id + '-missing'} className="form-error">请选择或新增{label}。</p>
      )}
      {open && (
        <div className="new-category">
          <label htmlFor={id + '-new'}>新类别名称</label>
          <input
            id={id + '-new'}
            ref={input}
            disabled={disabled}
            value={name}
            maxLength={40}
            aria-invalid={!!error}
            aria-describedby={error ? id + '-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
              e.target.setCustomValidity(e.target.value.trim() ? '请先添加或取消新增类别。' : '');
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                create();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          {error && (
            <p role="alert" id={id + '-error'} className="form-error">
              {error}
            </p>
          )}
          <div className="category-buttons">
            <button type="button" className="btn quiet" disabled={disabled} onClick={close}>
              取消新增
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={create}>
              添加类别
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
