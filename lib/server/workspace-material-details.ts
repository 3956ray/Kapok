import { DomainError } from './domain.ts';

export function materialDetails(raw: unknown) {
    if (raw === undefined) return undefined;
    const invalid = () => new DomainError('INVALID_INPUT', '请检查训练内容与视频章节。');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(k => !['category', 'date', 'body', 'chapters', 'photos'].includes(k))) throw invalid();
    if (input.category !== undefined && (typeof input.category !== 'string' || input.category.length > 32)) throw invalid();
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 10000)) throw invalid();
    if (input.date !== undefined && (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))) throw invalid();
    if (input.photos !== undefined) {
        if (!Array.isArray(input.photos) || input.photos.length > 6) throw invalid();
        const ids = new Set();
        for (const photo of input.photos) {
            if (!photo || typeof photo.id !== 'string' || !/^[a-f0-9-]{36}$/.test(photo.id) || ids.has(photo.id) ||
                typeof photo.alt !== 'string' || photo.alt.length>240 || Object.keys(photo).some(key=>key!=='id' && key!=='alt')) throw invalid();
            ids.add(photo.id);
        }
    }
    const chapters = input.chapters;
    if (chapters !== undefined) {
        if (!chapters || typeof chapters !== 'object' || Array.isArray(chapters) || Object.keys(chapters).length > 100) throw invalid();
        for (const [media, points] of Object.entries(chapters)) {
            if (!media || media.length > 512 || !Array.isArray(points) || points.length > 100) throw invalid();
            let previous = -1;
            for (const point of points) {
                if (!point || !Number.isSafeInteger(point.at) || point.at <= previous || point.at > 359999 ||
                    typeof point.title !== 'string' || !point.title.trim() || point.title.length > 120 ||
                    Object.keys(point).some(k => k !== 'at' && k !== 'title')) throw invalid();
                previous = point.at;
            }
        }
    }
    const stored = JSON.stringify(input);
    if (stored.length > 24000) throw invalid();
    return stored;
}

export function referenceTimes(raw: unknown, first: unknown, duration: number | null = null) {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || !raw.length || raw.length > 100 || raw[0] !== first ||
        new Set(raw).size !== raw.length || raw.some(n => !Number.isSafeInteger(n) || n < 0 || n > (duration ?? 359999))) {
        throw new DomainError('INVALID_INPUT', '请检查引用的视频时刻。');
    }
    return JSON.stringify(raw);
}

export function materialPhotoGuard(db: D1Database, op: string, parent: 'training'|'post', id: string, team:string, details?:string) {
    const photos = JSON.parse(details ?? '{}').photos;
    if (!photos?.length) return [];
    return [db.prepare(`INSERT INTO write_guards(op_id,phase,pass)
        SELECT ?,'material-photos',count(*)=?
        FROM material_assets WHERE team_id=? AND parent_kind=? AND parent_id=? AND ready=1 AND mime LIKE 'image/%'
        AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`)
        .bind(op,photos.length,team,parent,id,JSON.stringify(photos))];
}

// Index cards need a cover and date. Keep body text, remaining photos and chapter lists in detail reads.
export function materialIndexDetails(column:'workspace_details'|'lp.workspace_details'|'lpub.workspace_details') {
    return `json_object('category',json_extract(${column},'$.category'),'date',json_extract(${column},'$.date'),
        'photos',json(CASE WHEN json_type(${column},'$.photos[0]')='object' THEN json_array(json_extract(${column},'$.photos[0]')) ELSE '[]' END))`;
}
