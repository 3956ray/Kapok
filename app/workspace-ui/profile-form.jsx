import { useEffect, useRef, useState } from 'react';
import { fieldPositions } from '../../lib/contracts/profile-position';
import { ImagePlus } from 'lucide-react';
import { Avatar } from './ui.jsx';
import { prepareAvatar, imageDataUrl } from './profile-avatar.js';

export function ProfileForm({ profile: p, onSave, onCancel, onBusy }) {
  const saved = p.avatarUrl || '';

  const [form, setForm] = useState(p);
  // Undefined keeps the saved photo. Null explicitly restores the name avatar.
  const [draft, setDraft] = useState(undefined);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const selecting = useRef(0);
  const pending = useRef(false);
  const picker = useRef(null);
  useEffect(
    () => () => {
      selecting.current++;
    },
    [],
  );
  useEffect(
    () => () => {
      if (draft?.url) URL.revokeObjectURL(draft.url);
    },
    [draft],
  );

  async function choose(file) {
    if (!file) return;
    const version = ++selecting.current;
    setReading(true);
    setError('');
    try {
      const image = await prepareAvatar(file);
      if (version === selecting.current) setDraft({ file: image, url: URL.createObjectURL(image) });
    } catch (err) {
      if (version === selecting.current) setError(err.message);
    } finally {
      if (version === selecting.current) setReading(false);
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (pending.current || reading || !form.name.trim()) return;
    pending.current = true;
    setSaving(true);
    onBusy(true);
    setError('');
    try {

      const fields = {
        name: form.name.trim(),
        number: form.number,
        position: form.position,
        bio: form.bio.trim(),
      };
      await onSave(fields, draft === undefined ? undefined : draft ? await imageDataUrl(draft.file) : null);
    } catch (err) {
      setError(err.message || '头像未保存，请重试。');
    } finally {
      pending.current = false;
      setSaving(false);
      onBusy(false);
    }
  }
  const preview = draft === undefined ? saved : draft?.url || '';
  return (
    <form className="modal-form" onSubmit={submit} aria-busy={saving}>
      <fieldset className="profile-fields" disabled={saving}>
        <div className="avatar-editor">
          <Avatar person={form} preview={preview} large />
          <div className="avatar-options">
            <strong>个人头像</strong>
            <div className="avatar-actions">
              <button type="button" onClick={() => picker.current.click()}>
                <ImagePlus size={15} />
                {preview ? '更换图片' : '选择图片'}
              </button>
              {preview && (
                <button
                  type="button"
                  onClick={() => {
                    selecting.current++;
                    setReading(false);
                    setDraft(null);
                    setError('');
                  }}
                >
                  恢复默认
                </button>
              )}
            </div>
            <input
              type="file"
              hidden
              ref={picker}
              aria-label="选择头像图片"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
          <small className="avatar-hint">
            {reading ? '正在生成预览…' : 'JPG、PNG 或 WebP，最多 8 MB。头像居中裁切。'}
          </small>
        </div>
        <label>
          盘名
          <input
            required
            maxLength={20}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <div className="form-pair">
          <label>
            背号
            <input
              required
              maxLength={4}
              value={form.number}
              onChange={(e) => setForm({ ...form, number: e.target.value })}
            />
          </label>
          <label>
            场上位置
            <select value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}>
              <option value="">尚未选择</option>
              {fieldPositions.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          简介
          <textarea
            rows={3}
            maxLength={160}
            value={form.bio}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-buttons">
        <button type="button" className="btn" disabled={saving} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={!form.name.trim() || reading || saving}>
          {saving ? '正在保存…' : '保存资料'}
        </button>
      </div>
    </form>
  );
}
