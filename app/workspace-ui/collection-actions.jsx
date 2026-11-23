import { useRef, useState } from 'react';
import { Check, FolderPlus, Plus } from 'lucide-react';
import { useData } from './store';
import { NavLink } from './router';
import { DeleteAction, IconButton, Modal } from './ui';


export function DeleteCollection({ collection, disabled }) {
  const { deleteCollection } = useData();
  return <DeleteAction label="删除合集" title={collection.title} disabled={disabled}
    description="的目录及其历次在线分享链接将一起撤下。收录的训练、视频和图文仍保留在各自的发布者名下。"
    onDelete={() => deleteCollection(collection)} to="/collections" />;
}

export function AddToCollection({ id, sharedItem }) {
  const { collections, trainings, ctx, refreshShares, notify } = useData();
  const [open, setOpen] = useState(false);
  const origin = useRef(null);
  const operation = useRef(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const own = collections.filter(c => c.draft).map(c => c.draft);
  const incoming = sharedItem || trainings.find(t => t.id === id);
  async function add(target) {
    const before = own.find(c => c.id === target);
    if (!incoming || !before || pending || before.itemIds.includes(id)) return;
    setPending(true);
    setError('');
    try {
      // Add to the author's draft only; edits already pending there remain private.
      const input = {expectedVersion: before.version, items: [incoming.reference || { kind: incoming.kind === 'training' ? 'training' : 'post', id }]};
      const fingerprint = JSON.stringify([target,input]);
      if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, key: crypto.randomUUID() };
      const result = await ctx.write('learning/collections/' + target + '/items', 'POST', input, operation.current.key);
      if (!['duplicate','added'].includes(result.outcomes?.[0]?.status)) throw new Error('这项内容暂时无法加入合集。');
      await refreshShares();
      setOpen(false);
      notify('已加入合集草稿');
    } catch (e) { setError(e.message || '暂时无法更新合集。'); }
    finally { setPending(false); }
  }
  return (
    <>
      <IconButton
        ref={origin}
        label="加入合集"
        icon={FolderPlus}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      />
      <Modal open={open} onOpenChange={setOpen} title="加入合集">
        {own.length ? (
          <ul className="choose-collection">
            {own.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={pending || c.itemIds.includes(id)}
                  onClick={() => add(c.id)}
                >
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.itemIds.length} 项内容 · {c.category}
                    </small>
                  </span>
                  {c.itemIds.includes(id) ? (
                    <>
                      <span>已收录</span>
                      <Check size={16} />
                    </>
                  ) : (
                    <Plus size={17} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>新建第一份合集，就可以把这条内容收进去。</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <NavLink
          className="btn"
          returnFocusRef={origin}
          to={'/collections/new?item=' + encodeURIComponent(id)}
          onClick={() => {
            setOpen(false);
          }}
        >
          <Plus size={15} />
          新建合集
        </NavLink>
      </Modal>
    </>
  );
}
