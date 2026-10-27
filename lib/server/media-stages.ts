import { DomainError } from './domain.ts';
import { MEDIA_ENGINEERING_MAX_BYTES, MEDIA_LONG_MAX_SECONDS, MEDIA_LONG_METADATA_BYTES, MEDIA_LONG_SAMPLES, MEDIA_MAX_TOP_BOXES, MEDIA_MAX_VALIDATION_STEPS, MEDIA_STAGE_READS, MEDIA_STAGE_WORK, MEDIA_WINDOW_BYTES } from '../contracts/media.ts';
import type { MediaPolicy } from '../contracts/media';
type Box = { type: string; start: number; end: number };
type Frame = { cursor: number; end: number; path: string; track: number };
type Track = { boxes: Record<string, Box>; seen: string[] };
type Plan = {
    stts: Box; stsz: Box; stsc: Box; offsets: Box; count: number; fixed: number; scale: number;
    ctts?: Box; sync?: Box; cttsRows: number; cttsIndex: number; composedSamples: number; syncRows: number; syncIndex: number; previousSync: number;
    timingRows: number; rules: number; chunks: number; width: number;
    timingIndex: number; timedSamples: number; ticks: number; ruleIndex: number; previousFirst: number;
    chunkIndex: number; sampleIndex: number; cursor: number; remaining: number; ruleSamples: number; nextRule: number;
};
export type MetadataState = {
    steps: number; phase: 'top' | 'discover' | 'movie' | 'track' | 'timing' | 'composition' | 'sync' | 'rules' | 'chunks' | 'done';
    offset: number; top: Box[]; frames: Frame[]; boxCount: number; tracks: Track[]; movie: Box | null;
    trackIndex: number; samples: number; referenced: number; mdatBytes: number; duration: number; video: number; audio: number; plan: Plan | null;
};
const fail = (): never => { throw new DomainError('UNSUPPORTED_MEDIA', '暂时无法识别视频的格式或必要信息，请尝试重新导出 MP4。', 415); };
const codec = (): never => { throw new DomainError('UNSUPPORTED_CODEC', '已识别这个视频，但当前上传暂不支持它的编码。', 415); };
const add = (a: number, b: number, limit = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || b > limit - a) fail(); return a + b; };
const word = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
function boxHeader(v: DataView, at: number, end: number): Box {
    if (end - at < 8 || v.byteLength < 8) fail();
    let length = v.getUint32(0), header = 8;
    if (length === 1) { if (v.byteLength < 16) fail(); const wide = v.getBigUint64(8); if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail(); length = Number(wide); header = 16; }
    if (!length) length = end - at;
    if (length < header || length > end - at) fail();
    return { type: word(v, 4), start: at + header, end: at + length };
}
function required(track: Track, key: string) { const box = track.boxes[key]; if (!box) fail(); return box; }
function durationLimit(duration: number, limit: number) { if (!Number.isFinite(duration) || duration <= 0) fail(); if (duration > limit) throw new DomainError('UPLOAD_LIMIT', `视频时长超出当前${limit / 60}分钟上限。`, 413); }

// Each invocation bounds both range I/O and table work. Checkpoints contain box
// coordinates/counters, never media bytes or per-sample arrays. A budget yield
// occurs before a read, leaving the current atomic row/phase safe to repeat.
export async function inspectMP4Stage(size: number, source: (offset: number, length: number) => Promise<ArrayBuffer>, checkpoint: MetadataState | null, policy: Pick<MediaPolicy, 'maxBytes' | 'maxSeconds'> = { maxBytes: MEDIA_ENGINEERING_MAX_BYTES, maxSeconds: MEDIA_LONG_MAX_SECONDS }) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > policy.maxBytes) fail();
    const state: MetadataState = checkpoint ? structuredClone(checkpoint) : { steps: 0, phase: 'top', offset: 0, top: [], frames: [], boxCount: 0, tracks: [], movie: null, trackIndex: 0, samples: 0, referenced: 0, mdatBytes: 0, duration: 0, video: 0, audio: 0, plan: null };
    if (state.steps >= MEDIA_MAX_VALIDATION_STEPS) throw new DomainError('UNSUPPORTED_MEDIA', '视频信息结构超出当前处理范围，请尝试重新导出 MP4。', 415);
    state.steps++;
    let reads = 0, readBytes = 0, work = 0;
    const exhausted = Symbol('metadata-budget');
    const windows: { start: number; end: number; bytes: ArrayBuffer }[] = [];
    async function read(at: number, length: number, end = size, exact = false): Promise<DataView> {
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 1 || length > MEDIA_WINDOW_BYTES || at > end - length || end > size) fail();
        const cached = windows.find(w => at >= w.start && at + length <= w.end);
        if (cached) return new DataView(cached.bytes, at - cached.start, length);
        if (reads >= MEDIA_STAGE_READS) throw exhausted;
        const n = exact ? length : Math.min(MEDIA_WINDOW_BYTES, end - at);
        const bytes = await source(at, n); reads++; readBytes += n;
        if (bytes.byteLength !== n) fail();
        if (windows.length === 8) windows.shift();
        windows.push({ start: at, end: at + n, bytes });
        return new DataView(bytes, 0, length);
    }
    async function header(at: number, end: number, exact = false) { return boxHeader(await read(at, Math.min(16, end - at), end, exact), at, end); }
    async function timeline(box: Box) {
        const v = await read(box.start, Math.min(32, box.end - box.start), box.end);
        const version = v.getUint8(0), scaleAt = version === 1 ? 20 : 12, ticksAt = scaleAt + 4;
        if ((version !== 0 && version !== 1) || ticksAt + (version === 1 ? 8 : 4) > v.byteLength) fail();
        const scale = v.getUint32(scaleAt), ticks = version === 1 ? Number(v.getBigUint64(ticksAt)) : v.getUint32(ticksAt);
        if (!scale || !Number.isSafeInteger(ticks) || ticks <= 0) fail();
        return { scale, ticks };
    }
    async function table(box: Box, width: number, allowZero = false) {
        const v = await read(box.start, 8, box.end);
        const n = v.getUint32(4);
        if ((!n && !allowZero) || n > MEDIA_LONG_SAMPLES || n * width > box.end - box.start - 8) fail();
        return n;
    }
    async function inspectCodec(stsd: Box, handler: string) {
        if (stsd.end - stsd.start > MEDIA_WINDOW_BYTES || stsd.end - stsd.start < 16) fail();
        const v = await read(stsd.start, stsd.end - stsd.start, stsd.end);
        if (v.getUint32(4) !== 1) fail();
        const entry = boxHeader(new DataView(v.buffer, v.byteOffset + 8, Math.min(16, v.byteLength - 8)), 8, v.byteLength);
        if (entry.end !== v.byteLength) fail();
        const nested: Box[] = [];
        const initial = entry.start + (handler === 'vide' ? 78 : 28);
        if (initial > entry.end) fail();
        for (let at = initial; at < entry.end;) {
            if (nested.length >= 64) fail();
            const b = boxHeader(new DataView(v.buffer, v.byteOffset + at, Math.min(16, entry.end - at)), at, entry.end); nested.push(b); at = b.end;
        }
        if (nested.some(b => b.type === 'sinf')) codec();
        const requiredBox = (type: string) => { const bs = nested.filter(b => b.type === type); if (bs.length !== 1) fail(); return bs[0]; };
        if (handler === 'vide') {
            if (entry.type !== 'avc1') codec();
            if (!v.getUint16(entry.start + 24) || !v.getUint16(entry.start + 26)) fail();
            const avcc = requiredBox('avcC');
            if (avcc.end - avcc.start < 7 || v.getUint8(avcc.start) !== 1 || (v.getUint8(avcc.start + 4) & 252) !== 252 || (v.getUint8(avcc.start + 5) & 224) !== 224 || (v.getUint8(avcc.start + 4) & 3) === 2) fail();
            let cursor = avcc.start + 6;
            function sets(count: number, type: number) { if (!count) fail(); for (let i = 0; i < count; i++) { if (cursor + 2 > avcc.end) fail(); const n = v.getUint16(cursor); cursor += 2; if (!n || cursor + n > avcc.end || (v.getUint8(cursor) & 31) !== type) fail(); cursor += n; } }
            sets(v.getUint8(avcc.start + 5) & 31, 7); if (cursor >= avcc.end) fail(); const count = v.getUint8(cursor++); sets(count, 8);
        } else {
            if (entry.type !== 'mp4a') codec();
            const esds = requiredBox('esds');
            function descriptor(at: number, end: number) {
                if (at >= end) fail(); const tag = v.getUint8(at++); let length = 0, done = false;
                for (let i = 0; i < 4 && at < end; i++) { const n = v.getUint8(at++); length = length * 128 + (n & 127); if (!(n & 128)) { done = true; break; } }
                if (!done || length > end - at) fail(); return { tag, start: at, end: at + length };
            }
            const es = descriptor(esds.start + 4, esds.end); if (es.tag !== 3 || es.start + 3 > es.end) fail();
            const flags = v.getUint8(es.start + 2); let at = es.start + 3;
            if (flags & 128) at += 2;
            if (flags & 64) { if (at >= es.end) fail(); at += 1 + v.getUint8(at); }
            if (flags & 32) at += 2;
            const decoder = descriptor(at, es.end); if (decoder.tag !== 4 || decoder.start + 13 > decoder.end || v.getUint8(decoder.start) !== 0x40 || (v.getUint8(decoder.start + 1) >> 2) !== 5) fail();
            const config = descriptor(decoder.start + 13, decoder.end); if (config.tag !== 5 || config.end - config.start < 2 || (v.getUint8(config.start) >> 3) !== 2) fail();
            const frequency = ((v.getUint8(config.start) & 7) << 1) | (v.getUint8(config.start + 1) >> 7), channels = (v.getUint8(config.start + 1) >> 3) & 15;
            if (frequency > 12 || channels < 1 || channels > 7) fail();
        }
    }
    try {
        while (work < MEDIA_STAGE_WORK && state.phase !== 'done') {
            work++;
            if (state.phase === 'top') {
                if (state.offset < size) {
                    if (state.top.length >= MEDIA_MAX_TOP_BOXES) fail();
                    const b = await header(state.offset, size, true); state.top.push(b); state.offset = b.end;
                    continue;
                }
                const moov = state.top.filter(b => b.type === 'moov'), ftyp = state.top.filter(b => b.type === 'ftyp');
                if (moov.length !== 1 || ftyp.length !== 1 || ftyp[0].end - ftyp[0].start < 8 || state.top.some(b => b.type === 'moof') || moov[0].end - moov[0].start > MEDIA_LONG_METADATA_BYTES) fail();
                for (const b of state.top.filter(b => b.type === 'mdat')) state.mdatBytes = add(state.mdatBytes, b.end - b.start, size);
                if (!state.mdatBytes) fail();
                state.frames.push({ cursor: moov[0].start, end: moov[0].end, path: 'moov', track: -1 }); state.phase = 'discover';
            } else if (state.phase === 'discover') {
                const frame = state.frames.at(-1);
                if (!frame) { state.phase = 'movie'; continue; }
                if (frame.cursor === frame.end) { state.frames.pop(); continue; }
                const b = await header(frame.cursor, frame.end);
                if (++state.boxCount > 4096 || b.type === 'mvex') fail();
                let track = frame.track;
                if (frame.path === 'moov' && b.type === 'trak') { if (state.tracks.length >= 8) fail(); track = state.tracks.length; state.tracks.push({ boxes: {}, seen: [] }); }
                if (frame.path === 'moov' && b.type === 'mvhd') { if (state.movie) fail(); state.movie = b; }
                const path = `${frame.path}/${b.type}`;
                const container = ['moov/trak', 'moov/trak/mdia', 'moov/trak/mdia/minf', 'moov/trak/mdia/minf/stbl'].includes(path);
                if (track >= 0) {
                    const t = state.tracks[track];
                    if (container) { if (t.seen.includes(path)) fail(); t.seen.push(path); }
                    if (['moov/trak/mdia/mdhd', 'moov/trak/mdia/hdlr'].includes(path) || (frame.path === 'moov/trak/mdia/minf/stbl' && ['stsd', 'stts', 'stsz', 'stsc', 'stco', 'co64', 'ctts', 'stss'].includes(b.type))) {
                        if (t.boxes[b.type]) fail(); t.boxes[b.type] = b;
                    }
                }
                frame.cursor = b.end;
                if (container) state.frames.push({ cursor: b.start, end: b.end, path, track });
            } else if (state.phase === 'movie') {
                if (!state.movie || !state.tracks.length) fail();
                const movie = await timeline(state.movie!); state.duration = movie.ticks / movie.scale; durationLimit(state.duration, policy.maxSeconds); state.phase = 'track';
            } else if (state.phase === 'track') {
                if (state.trackIndex >= state.tracks.length) {
                    if (state.video !== 1 || state.audio > 1) fail(); durationLimit(state.duration, policy.maxSeconds); state.phase = 'done'; continue;
                }
                const t = state.tracks[state.trackIndex], handlerBox = required(t, 'hdlr');
                const handler = word(await read(handlerBox.start, 12, handlerBox.end), 8);
                if (['tmcd', 'meta', 'mdta', 'text', 'sbtl', 'subt', 'clcp'].includes(handler)) { state.trackIndex++; continue; }
                if (handler !== 'vide' && handler !== 'soun') fail();
                const timing = await timeline(required(t, 'mdhd'));
                const stsz = required(t, 'stsz'), stts = required(t, 'stts'), stsc = required(t, 'stsc');
                if (!!t.boxes.stco === !!t.boxes.co64) fail(); const offsets = t.boxes.stco ?? t.boxes.co64, width = offsets.type === 'co64' ? 8 : 4;
                const sizes = await read(stsz.start, 12, stsz.end), fixed = sizes.getUint32(4), count = sizes.getUint32(8);
                if (!count || (!fixed && count * 4 > stsz.end - stsz.start - 12)) fail();
                const timingRows = await table(stts, 8), rules = await table(stsc, 12), chunks = await table(offsets, width);
                if (chunks > count || rules > chunks) fail();
                const ctts = t.boxes.ctts, sync = t.boxes.stss;
                const cttsRows = ctts ? await table(ctts, 8, true) : 0, syncRows = sync ? await table(sync, 4, true) : 0;
                if (cttsRows > count || syncRows > count) fail();
                if (ctts && (await read(ctts.start, 1, ctts.end)).getUint8(0) > 1) fail();
                await inspectCodec(required(t, 'stsd'), handler);
                const totalSamples = add(state.samples, count, MEDIA_LONG_SAMPLES), duration = Math.max(state.duration, timing.ticks / timing.scale); durationLimit(duration, policy.maxSeconds);
                state.samples = totalSamples; state.duration = duration; if (handler === 'vide') state.video++; else state.audio++;
                state.plan = { ctts, sync, cttsRows, cttsIndex: 0, composedSamples: 0, syncRows, syncIndex: 0, previousSync: 0, stts, stsz, stsc, offsets, count, fixed, scale: timing.scale, timingRows, rules, chunks, width, timingIndex: 0, timedSamples: 0, ticks: 0, ruleIndex: 0, previousFirst: 0, chunkIndex: 0, sampleIndex: 0, cursor: 0, remaining: 0, ruleSamples: 0, nextRule: 1 };
                state.phase = 'timing';
            } else if (state.phase === 'timing') {
                const p = state.plan!;
                if (p.timingIndex === p.timingRows) { if (p.timedSamples !== p.count) fail(); state.duration = Math.max(state.duration, p.ticks / p.scale); durationLimit(state.duration, policy.maxSeconds); state.phase = 'composition'; continue; }
                const row = await read(p.stts.start + 8 + p.timingIndex * 8, 8, p.stts.end), n = row.getUint32(0), delta = row.getUint32(4);
                if (!n || !delta) fail(); const samples = add(p.timedSamples, n, p.count), ticks = add(p.ticks, n * delta);
                p.timedSamples = samples; p.ticks = ticks; p.timingIndex++;
            } else if (state.phase === 'composition') {
                const p = state.plan!;
                if (p.cttsIndex === p.cttsRows) { if (p.cttsRows && p.composedSamples !== p.count) fail(); state.phase = 'sync'; continue; }
                const row = await read(p.ctts!.start + 8 + p.cttsIndex * 8, 8, p.ctts!.end), n = row.getUint32(0);
                if (!n) fail(); p.composedSamples = add(p.composedSamples, n, p.count); p.cttsIndex++;
            } else if (state.phase === 'sync') {
                const p = state.plan!;
                if (p.syncIndex === p.syncRows) { state.phase = 'rules'; continue; }
                const sample = (await read(p.sync!.start + 8 + p.syncIndex * 4, 4, p.sync!.end)).getUint32(0);
                if (sample <= p.previousSync || sample > p.count) fail(); p.previousSync = sample; p.syncIndex++;
            } else if (state.phase === 'rules') {
                const p = state.plan!;
                if (p.ruleIndex === p.rules) { p.ruleIndex = 0; state.phase = 'chunks'; continue; }
                const row = await read(p.stsc.start + 8 + p.ruleIndex * 12, 12, p.stsc.end), first = row.getUint32(0), samples = row.getUint32(4);
                if (!first || !samples || samples > p.count || row.getUint32(8) !== 1 || (p.ruleIndex === 0 && first !== 1) || first <= p.previousFirst || first > p.chunks) fail();
                p.previousFirst = first; p.ruleIndex++;
            } else if (state.phase === 'chunks') {
                const p = state.plan!;
                if (!p.remaining) {
                    if (p.chunkIndex === p.chunks) { if (p.sampleIndex !== p.count) fail(); state.trackIndex++; state.plan = null; state.phase = 'track'; continue; }
                    const chunk = p.chunkIndex + 1;
                    // Read all necessary fields before changing checkpoint counters.
                    let rule = p.ruleIndex;
                    if (chunk >= p.nextRule && p.ruleSamples) rule++;
                    const row = await read(p.stsc.start + 8 + rule * 12, 12, p.stsc.end);
                    const remaining = row.getUint32(4);
                    let nextRule = Number.MAX_SAFE_INTEGER;
                    if (rule + 1 < p.rules) nextRule = (await read(p.stsc.start + 8 + (rule + 1) * 12, 4, p.stsc.end)).getUint32(0);
                    const at = await read(p.offsets.start + 8 + p.chunkIndex * p.width, p.width, p.offsets.end), cursor = p.width === 8 ? Number(at.getBigUint64(0)) : at.getUint32(0);
                    if (!Number.isSafeInteger(cursor) || remaining > p.count - p.sampleIndex) fail();
                    p.ruleIndex = rule; p.ruleSamples = remaining; p.nextRule = nextRule; p.cursor = cursor; p.remaining = remaining; p.chunkIndex++;
                }
                const number = p.fixed ? p.remaining : 1;
                const bytes = p.fixed ? number * p.fixed : (await read(p.stsz.start + 12 + p.sampleIndex * 4, 4, p.stsz.end)).getUint32(0);
                if (!bytes) fail(); const end = add(p.cursor, bytes, size), referenced = add(state.referenced, bytes, state.mdatBytes);
                if (!state.top.some(b => b.type === 'mdat' && p.cursor >= b.start && end <= b.end)) fail();
                p.cursor = end; p.sampleIndex += number; p.remaining -= number; state.referenced = referenced;
            }
        }
    } catch (error) { if (error !== exhausted) { if (error instanceof RangeError) fail(); throw error; } }
    return { state, media: state.phase === 'done' ? { mime: 'video/mp4', durationSec: state.duration } : null, metrics: { reads, readBytes, work } };
}
