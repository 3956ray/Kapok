import { ArrowUpRight } from 'lucide-react';
import { localDay, media } from './store';
import { NavLink } from './router';

const pitchPhotos = { 'weak-side': 'sideline-catch', zone: 'sideline-team' };
export function fieldPhoto(training) {
  if (training?.photos?.[0]?.url) return training.photos[0].url;
  if (training?.platformCover) return training.platformCover;
  return media((pitchPhotos[training?.id] || training?.image || 'sideline-team') + '.webp');
}
export function teamPhoto(training) {
  return training.id === 'weak-side' ? media('reset.webp') : fieldPhoto(training);
}
export function MediaCover({item, fallback, ...props}) {
  const local = fallback || fieldPhoto();
  const youtube = item?.source?.platform === 'YouTube' && /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/.exec(item.source.url)?.[1];
  const src = item?.photos?.[0]?.url || item?.platformCover || (youtube && 'https://i.ytimg.com/vi/'+youtube+'/hqdefault.jpg') || local;
  return <img {...props} src={src} referrerPolicy="no-referrer" onError={e=>{
    if (e.currentTarget.getAttribute('src') !== local) e.currentTarget.src=local;
  }}/>;
}
export function DateMark({ value }) {
  const [year, month, date] = localDay(value).split('-');
  return (
    <time
      className="date-mark"
      dateTime={value}
      aria-label={year + '年' + Number(month) + '月' + Number(date) + '日'}
    >
      <b>{date}</b>
      <span>
        {year}.{month}
      </span>
    </time>
  );
}
export function newspaperDate(iso) {
  const [y, m, d] = localDay(iso).split('-').map(Number);
  return m + ' 月 ' + d + ' 日 · 星期' + '日一二三四五六'[new Date(y, m - 1, d).getDay()];
}
export function FieldPrint({ training, date }) {
  const content = (
    <>
      <span className="print-mount">
        <img src={fieldPhoto(training)} alt="" decoding="async" />
      </span>
      {training ? (
        <span className="print-caption">
          <span>关联训练</span>
          <strong>{training.title}</strong>
          <ArrowUpRight size={15} />
        </span>
      ) : (
        <span className="print-caption">
          <span>场边手记</span>
          <strong>{localDay(date).replaceAll('-', '.')}</strong>
        </span>
      )}
    </>
  );
  return training ? (
    <NavLink
      to={'/trainings/' + training.id}
      className="field-print"
      aria-label={'关联训练：' + training.title}
    >
      {content}
    </NavLink>
  ) : (
    <div className="field-print">{content}</div>
  );
}
export function Jersey({ person, compact = false }) {
  return (
    <div
      className={'jersey-print' + (compact ? ' compact' : '')}
      data-wide={String(person.number).length > 2}
      aria-hidden="true"
    >
      <span className="jersey-insignia">
        Kapok <i>Bloom</i>
      </span>
      <b>{person.number || '—'}</b>
      <span className="jersey-bottom">
        {person.name}
        <i>{person.position}</i>
      </span>
    </div>
  );
}
