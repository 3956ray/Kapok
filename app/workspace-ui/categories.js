export const noteTopics = ['技术动作', '战术判断', '团队配合', '临场心态'];
export const pendingNoteCategory = '待归类';

export function noteCategoryLabel(note) {
  return note.category || pendingNoteCategory;
}

export function categoryName(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (!name || Array.from(name).length > 20) throw new Error('类别名称需要 1 到 20 个字。');
  return name;
}

export function noteCategoryName(raw) {
  const name = categoryName(raw);
  if (['全部', '全部类别', pendingNoteCategory].includes(name))
    throw new Error('这个名称用于筛选，请换一个复盘类别名称。');
  return name;
}
