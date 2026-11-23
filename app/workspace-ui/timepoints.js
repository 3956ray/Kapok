export const maxTimepoints = 100;

export function timeLabel(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const tail = String(whole % 60).padStart(2, '0');
  return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + tail : minutes + ':' + tail;
}

export function parseTimeLabel(input) {
  const text = input.trim().normalize('NFKC');
  if (!/^\d{1,6}(?::[0-5]?\d){0,2}$/.test(text)) return NaN;
  return text.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function isPlaybackSecond(at, duration = 0) {
  return Number.isSafeInteger(at) && at >= 0 && at <= 359999 && !(duration > 0 && at >= duration);
}

// A discussion can point at the last frame. A chapter must start before it.
export function isReferenceSecond(at, duration) {
  return Number.isSafeInteger(at) && at >= 0 && Number.isFinite(duration) && duration > 0 && at <= duration;
}

export function referenceTimeError(value, duration, selected, complete = true) {
  const text = value.trim().normalize('NFKC');
  if (!text) return complete ? '先填写时间，或拖动时间轴。' : '';
  if (/^-/.test(text)) return '时间从 0:00 开始，请输入正数或零。';
  if (/[.,]/.test(text)) return '请用整秒，例如 15 或 0:15。';
  const parts = text.split(':');
  if (parts.length > 3 || /[^0-9:]/.test(text) || parts[0] === '' || parts.slice(0, -1).includes(''))
    return '格式应为分:秒或时:分:秒，例如 1:05。';
  if (!parts.at(-1)) return complete ? '请把冒号后的时间补完整，例如 1:05。' : '';
  if (parts.length === 3 && !/^[0-5]?\d$/.test(parts[1])) return '小时后的分钟应在 00 到 59 之间。';
  if (parts.length > 1 && !/^[0-5]?\d$/.test(parts.at(-1))) return '秒位应在 00 到 59 之间。';
  const at = parseTimeLabel(text);
  if (!Number.isSafeInteger(at)) return '请用秒数、分:秒或时:分:秒填写。';
  if (duration > 0 && at > duration) return '超过视频总时长，最晚可引用 ' + timeLabel(duration) + '。';
  if (selected.includes(at)) return '这段时间已经引用过了。';
  return '';
}

export function chapterDraft(points) {
  return points.map(({ at, title }) => ({ key: crypto.randomUUID(), time: timeLabel(at), title }));
}

export function chaptersFromDraft(rows, duration) {
  const indices = [];
  const points = [];
  rows.forEach((row, i) => {
    if (!row.time.trim() && !row.title.trim()) return;
    indices.push(i);
    points.push({ at: parseTimeLabel(row.time), title: row.title });
  });
  return validateTimepoints(points, duration, indices);
}

export function validateTimepoints(points, duration = 0, indices = []) {
  if (!Array.isArray(points) || points.length > maxTimepoints)
    throw new Error('每个视频最多可添加 ' + maxTimepoints + ' 个章节。');
  const seen = new Set();
  return points.map((p, i) => {
    const index = indices[i] ?? i;
    const field = '第 ' + (index + 1) + ' 章';
    const invalid = (message, part = 'time') =>
      Object.assign(new Error(message), { input: 'point-' + part + '-' + index });
    if (!isPlaybackSecond(p?.at))
      throw invalid(field + '的开始时间格式有误，例如 01:35 或 1:02:03。');
    if (duration > 0 && p.at >= duration)
      throw invalid(field + '须早于片尾 ' + timeLabel(duration) + '。');
    if (seen.has(p.at)) throw invalid(field + '与已有时间重复，请调整或移除。');
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.trim().length > 120)
      throw invalid('请为' + field + '填写 1 至 120 字的章节名称。', 'title');
    seen.add(p.at);
    return { at: p.at, title: p.title.trim() };
  }).sort((a, b) => a.at - b.at);
}

export function playbackPoints(item) {
  if (Array.isArray(item?.timepoints)) return item.timepoints;
  if (item?.source || item?.videoAsset || !item?.duration || !item.steps?.length) return [];
  return item.steps.map((title, i) => ({ at: Math.floor(i * item.duration / item.steps.length), title }));
}
