import Link from 'next/link';

/** Presentation only: dates remain the service-provided record dates. */
export function DateGroup({ date }: { date: string }) {
    const [year, month] = date.slice(0, 7).split('-');
    return <h2 className="date-group">{year}年{month}月</h2>;
}
export function RecordRow({ date, title, href, detail }: { date: string; title: string; href: string; detail: React.ReactNode }) {
    const [, month, day] = date.slice(0, 10).split('-');
    return <article className="record-row">
        <time className="record-date" dateTime={date}><b>{day}</b>{month}月</time>
        <div><Link href={href}><h3>{title}</h3><span className="record-detail">{detail}</span></Link></div>
    </article>;
}
export function ProfileSummary({ name, number, role, large = false }: { name: string; number: string; role?: string; large?: boolean }) {
    return <div className={'profile-summary' + (large ? ' large' : '')}>
        <span className="default-avatar" aria-label="默认头像">{Array.from(name)[0] || '我'}</span>
        <div><h2>{name}</h2><p>背号 {number}{role ? ` · ${role}` : ''}</p></div>
    </div>;
}
