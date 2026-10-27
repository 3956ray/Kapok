import { DomainError } from './domain.ts';
import { MEDIA_MAX_BYTES, MEDIA_MAX_SECONDS, MEDIA_MAX_METADATA_BYTES, MEDIA_MAX_SAMPLES, MEDIA_MAX_TOP_BOXES } from '../contracts/media.ts';
type Box = {
    type: string;
    start: number;
    end: number;
};
// Container/codec identification only; payload decoding belongs to the browser.
function inspectMetadata(buffer: ArrayBuffer, top: Box[]) {
    const maxBytes = MEDIA_MAX_BYTES;
    const maxSamples = MEDIA_MAX_SAMPLES;
    function workloadLimit(): never {
        throw new DomainError('UNSUPPORTED_MEDIA', '此短片结构超出当前私有版本支持范围，请换用其他短片。', 415);
    }
    function boundedAdd(total: number, value: number, limit: number): number {
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value) || value < 0 || total < 0 || value > limit - total)
            workloadLimit();
        return total + value;
    }
    if (buffer.byteLength > maxBytes) workloadLimit();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    function fail(): never {
        throw new DomainError('UNSUPPORTED_MEDIA', '暂时无法识别这个视频的格式或必要信息，未完成上传。请尝试用原视频工具重新导出 MP4 后再上传。', 415);
    }
    const word = (p: number) => String.fromCharCode(...bytes.subarray(p, p + 4));
    let boxCount = 0;
    function boxes(start: number, end: number): Box[] {
        const result: Box[] = [];
        while(start < end) {
            if (++boxCount > 4096) workloadLimit();
            if(start + 8 > end)
                fail();
            let size = view.getUint32(start);
            let header = 8;
            if(size === 1) {
                if(start + 16 > end)
                    fail();
                const wide = view.getBigUint64(start + 8);
                if(wide > BigInt(Number.MAX_SAFE_INTEGER))
                    fail();
                size = Number(wide);
                header = 16;
            }
            if(size === 0)
                size = end - start;
            if(size < header || start + size > end)
                fail();
            result.push({ type: word(start + 4), start: start + header, end: start + size });
            start += size;
        }
        return result;
    }
    function required(list: Box[], type: string): Box {
        const matches = list.filter(b => b.type === type);
        if(matches.length !== 1)
            fail();
        return matches[0];
    }
    function table(box: Box, width: number): number {
        if(box.start + 8 > box.end)
            fail();
        const n = view.getUint32(box.start + 4);
        if(!n || n > 1000000 || box.start + 8 + n * width > box.end)
            fail();
        return n;
    }

    required(top, 'ftyp');
    if(!top.some(b => b.type === 'mdat') || top.some(b => b.type === 'moof'))
        fail();
    const children = boxes(0, bytes.length);
    if(children.some(b => b.type === 'mvex'))
        fail();
    function timeline(box: Box) {
        const version = bytes[box.start];
        const scaleAt = box.start + (version === 1 ? 20 : 12);
        const ticksAt = scaleAt + 4;
        if ((version !== 0 && version !== 1) || ticksAt + (version === 1 ? 8 : 4) > box.end) fail();
        const scale = view.getUint32(scaleAt);
        const ticks = version === 1 ? Number(view.getBigUint64(ticksAt)) : view.getUint32(ticksAt);
        if (!scale || !Number.isSafeInteger(ticks) || ticks <= 0) fail();
        return { scale, ticks };
    }
    const { scale: movieScale, ticks: movieTicks } = timeline(required(children, 'mvhd'));
    const allTracks = children.filter(b => b.type === 'trak');
    if (!allTracks.length || allTracks.length > 8) workloadLimit();
    const tracks = allTracks.filter(track => {
        const mdia = required(boxes(track.start, track.end), 'mdia');
        const hdlr = required(boxes(mdia.start, mdia.end), 'hdlr');
        if (hdlr.start + 12 > hdlr.end) fail();
        const handler = word(hdlr.start + 8);
        // Timecode and descriptive metadata are not media payloads we claim to decode.
        if (['tmcd', 'meta', 'mdta', 'text', 'sbtl', 'subt', 'clcp'].includes(handler)) return false;
        if (handler !== 'vide' && handler !== 'soun') fail();
        return true;
    });
    let mdatBytes = 0;
    for (const data of top.filter(b => b.type === 'mdat')) {
        mdatBytes = boundedAdd(mdatBytes, data.end - data.start, maxBytes);
    }
    const plans: { stsz: Box; stts: Box; stsc: Box; offsets: Box; count: number }[] = [];
    let totalSamples = 0;
    // First pass counts all media tracks before bounded table traversal; no per-sample allocations.
    for (const track of tracks) {
        const mdia = required(boxes(track.start, track.end), 'mdia');
        const minf = required(boxes(mdia.start, mdia.end), 'minf');
        const stbl = required(boxes(minf.start, minf.end), 'stbl');
        const tables = boxes(stbl.start, stbl.end);
        const stsz = required(tables, 'stsz');
        if (stsz.start + 12 > stsz.end) fail();
        const count = view.getUint32(stsz.start + 8);
        if (!count) fail();
        totalSamples = boundedAdd(totalSamples, count, maxSamples);
        const offsets = tables.filter(b => b.type === 'stco' || b.type === 'co64');
        if (offsets.length !== 1) fail();
        plans.push({
            stsz,
            stts: required(tables, 'stts'),
            stsc: required(tables, 'stsc'),
            offsets: offsets[0],
            count,
        });
    }
    let referencedBytes = 0;
    // Declared samples bound the later chunk traversal. Offsets may repeat, but their work
    // still consumes this one budget shared across all tracks, never a per-chunk allowance.
    for (const plan of plans) {
        let timedSamples = 0;
        let timedTicks = 0;
        for (let i = 0, count = table(plan.stts, 8); i < count; i++) {
            const at = plan.stts.start + 8 + i * 8;
            const samples = view.getUint32(at);
            const delta = view.getUint32(at + 4);
            if (!samples || !delta) fail();
            timedSamples = boundedAdd(timedSamples, samples, plan.count);
            timedTicks = boundedAdd(timedTicks, samples * delta, Number.MAX_SAFE_INTEGER);
        }
        if (timedSamples !== plan.count) fail();
        const offsetWidth = plan.offsets.type === 'co64' ? 8 : 4;
        if (table(plan.offsets, offsetWidth) > plan.count || table(plan.stsc, 12) > plan.count)
            workloadLimit();
        const fixedSize = view.getUint32(plan.stsz.start + 4);
        if (!fixedSize && plan.stsz.start + 12 + plan.count * 4 > plan.stsz.end) fail();
        for (let sample = 0; sample < plan.count; sample++) {
            const size = fixedSize || view.getUint32(plan.stsz.start + 12 + sample * 4);
            if (!size) fail();
            referencedBytes = boundedAdd(referencedBytes, size, mdatBytes);
        }
    }
    let video = 0;
    let audio = 0;
    let duration = movieTicks / movieScale;
    for(const track of tracks) {
        const mdia = required(boxes(track.start, track.end), 'mdia');
        const parts = boxes(mdia.start, mdia.end);
        const hdlr = required(parts, 'hdlr');
        const mdhd = required(parts, 'mdhd');
        const minf = required(parts, 'minf');
        if(hdlr.start + 12 > hdlr.end)
            fail();
        const handler = word(hdlr.start + 8);
        if(handler !== 'vide' && handler !== 'soun')
            fail();
        const { scale, ticks } = timeline(mdhd);
        duration = Math.max(duration, ticks / scale);
        const stbl = required(boxes(minf.start, minf.end), 'stbl');
        const tables = boxes(stbl.start, stbl.end);
        const stsd = required(tables, 'stsd');
        const stts = required(tables, 'stts');
        const stsz = required(tables, 'stsz');
        const stsc = required(tables, 'stsc');
        if(stsd.start + 8 > stsd.end || view.getUint32(stsd.start + 4) !== 1)
            fail();
        const entries = boxes(stsd.start + 8, stsd.end);
        if(entries.length !== 1)
            fail();
        const entry = entries[0];

        if(handler === 'vide') {
            if(entry.type !== 'avc1') unsupportedCodec();
            if(entry.start + 78 > entry.end || !view.getUint16(entry.start + 24) || !view.getUint16(entry.start + 26)) fail();
            const codecBoxes = boxes(entry.start + 78, entry.end);
            if (codecBoxes.some(box => box.type === 'sinf')) unsupportedCodec();
            const avcc = required(codecBoxes, 'avcC');
            if(avcc.end - avcc.start < 7 || bytes[avcc.start] !== 1)
                fail();
            if((bytes[avcc.start + 4] & 252) !== 252 || (bytes[avcc.start + 5] & 224) !== 224 || (bytes[avcc.start + 4] & 3) === 2)
                fail();
            let cursor = avcc.start + 6;
            const spsCount = bytes[avcc.start + 5] & 31;
            function parameterSets(count: number, type: number) {
                if(!count)
                    fail();
                for(let i = 0;i < count;i++) {
                    if(cursor + 2 > avcc.end)
                        fail();
                    const length = view.getUint16(cursor);
                    cursor += 2;
                    if(!length || cursor + length > avcc.end || (bytes[cursor] & 31) !== type)
                        fail();
                    cursor += length;
                }
            }
            parameterSets(spsCount, 7);
            if(cursor >= avcc.end)
                fail();
            const ppsCount = bytes[cursor++];
            parameterSets(ppsCount, 8);
            // Optional profile extensions remain bounded by avcC; no handwritten SPS decoder.
            video++;
        }
        else {
            if(entry.type !== 'mp4a') unsupportedCodec();
            if(entry.start + 28 > entry.end) fail();
            const codecBoxes = boxes(entry.start + 28, entry.end);
            if (codecBoxes.some(box => box.type === 'sinf')) unsupportedCodec();
            const esds = required(codecBoxes, 'esds');
            function descriptor(at: number, end: number) {
                if(at >= end)
                    fail();
                const tag = bytes[at++];
                let length = 0;
                let done = false;
                for(let i = 0;i < 4 && at < end;i++) {
                    const n = bytes[at++];
                    length = length * 128 + (n & 127);
                    if(!(n & 128)) {
                        done = true;
                        break;
                    }
                }
                if(!done || at + length > end)
                    fail();
                return { tag, start: at, end: at + length };
            }
            const es = descriptor(esds.start + 4, esds.end);
            if(es.tag !== 3 || es.start + 3 > es.end)
                fail();
            let at = es.start + 3;
            const flags = bytes[es.start + 2];
            if(flags & 128)
                at += 2;
            if(flags & 64) {
                if(at >= es.end)
                    fail();
                at += 1 + bytes[at];
            }
            if(flags & 32)
                at += 2;
            const decoder = descriptor(at, es.end);
            if(decoder.tag !== 4 || decoder.start + 13 > decoder.end || bytes[decoder.start] !== 0x40 || (bytes[decoder.start + 1] >> 2) !== 5)
                fail();
            const config = descriptor(decoder.start + 13, decoder.end);
            if(config.tag !== 5 || config.end - config.start < 2 || (bytes[config.start] >> 3) !== 2)
                fail();
            const frequency = ((bytes[config.start] & 7) << 1) | (bytes[config.start + 1] >> 7);
            const channels = (bytes[config.start + 1] >> 3) & 15;
            if(frequency > 12 || channels < 1 || channels > 7)
                fail();
            audio++;
        }
        let sampleCount = 0;
        let sampleTicks = 0;
        for(let i = 0, n = table(stts, 8);i < n;i++) {
            const at = stts.start + 8 + i * 8;
            const count = view.getUint32(at);
            const delta = view.getUint32(at + 4);
            if(!count || !delta)
                fail();
            sampleCount += count;
            sampleTicks += count * delta;
        }
        duration = Math.max(duration, sampleTicks / scale);
        if(sampleCount > maxSamples || stsz.start + 12 > stsz.end)
            fail();
        const fixedSize = view.getUint32(stsz.start + 4);
        const sizeCount = view.getUint32(stsz.start + 8);
        if(sizeCount !== sampleCount || (!fixedSize && stsz.start + 12 + sizeCount * 4 > stsz.end))
            fail();
        const ruleCount = table(stsc, 12);
        let previousFirst = 0;
        for(let i = 0; i < ruleCount; i++) {
            const at = stsc.start + 8 + i * 12;
            const first = view.getUint32(at);
            const samples = view.getUint32(at + 4);
            if(!first || !samples || view.getUint32(at + 8) !== 1 || (i === 0 && first !== 1) || first <= previousFirst)
                fail();
            previousFirst = first;
        }
        const offsetBoxes = tables.filter(b => b.type === 'stco' || b.type === 'co64');
        if(offsetBoxes.length !== 1)
            fail();
        const offsets = offsetBoxes[0];
        const width = offsets.type === 'co64' ? 8 : 4;
        let sample = 0;
        let rule = 0;
        for(let chunk = 1, n = table(offsets, width);chunk <= n;chunk++) {
            while(rule + 1 < ruleCount && view.getUint32(stsc.start + 8 + (rule + 1) * 12) <= chunk)
                rule++;
            const at = offsets.start + 8 + (chunk - 1) * width;
            let cursor = width === 8 ? Number(view.getBigUint64(at)) : view.getUint32(at);
            if(!Number.isSafeInteger(cursor))
                fail();
            for(let i = 0;i < view.getUint32(stsc.start + 12 + rule * 12);i++) {
                if(sample >= sizeCount)
                    fail();
                const size = fixedSize || view.getUint32(stsz.start + 12 + sample * 4);
                const end = cursor + size;
                if(!size || !Number.isSafeInteger(end) || !top.some(b => b.type === 'mdat' && cursor >= b.start && end <= b.end))
                    fail();
                cursor = end;
                sample++;
            }
        }
        if(sample !== sampleCount || previousFirst > table(offsets, width))
            fail();
    }
    if(video !== 1 || audio > 1 || !Number.isFinite(duration) || duration <= 0)
        fail();
    if(duration > MEDIA_MAX_SECONDS)
        throw new DomainError('UPLOAD_LIMIT', `视频太长。当前最多${MEDIA_MAX_SECONDS / 60}分钟，此视频为${Math.ceil(duration)}秒。请先裁剪为较短片段，再选择上传。`, 413);
    return { mime: 'video/mp4', durationSec: duration };
}

function unsupportedCodec(): never {
    throw new DomainError('UNSUPPORTED_CODEC', '已识别这个视频，但当前上传暂不支持它的编码。', 415);
}
function invalidContainer(): never {
    throw new DomainError('UNSUPPORTED_MEDIA', '暂时无法识别这个视频的格式或必要信息，未完成上传。请尝试用原视频工具重新导出 MP4 后再上传。', 415);
}
function topBox(header: ArrayBuffer, offset: number, total: number): Box {
    if (header.byteLength < 8) invalidContainer();
    const view = new DataView(header);
    const bytes = new Uint8Array(header);
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    let size = view.getUint32(0);
    let width = 8;
    if (size === 1) {
        if (header.byteLength < 16) invalidContainer();
        const wide = view.getBigUint64(8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalidContainer();
        size = Number(wide);
        width = 16;
    }
    if (size === 0) size = total - offset;
    if (size < width || size > total - offset) invalidContainer();
    return { type, start: offset + width, end: offset + size };
}
function validateTop(top: Box[], size: number) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MEDIA_MAX_BYTES) invalidContainer();
    const moov = top.filter(box => box.type === 'moov');
    const ftyp = top.filter(box => box.type === 'ftyp');
    if (moov.length !== 1 || ftyp.length !== 1 || ftyp[0].end - ftyp[0].start < 8 || top.some(box => box.type === 'moof')) invalidContainer();
    if (moov[0].end - moov[0].start > MEDIA_MAX_METADATA_BYTES) invalidContainer();
    return moov[0];
}
// Synchronous entry point for bounded local fixtures; production uses range reads below.
export function inspectMP4(buffer: ArrayBuffer) {
    if (buffer.byteLength > MEDIA_MAX_BYTES) invalidContainer();
    const top: Box[] = [];
    for (let offset = 0; offset < buffer.byteLength;) {
        if (top.length >= MEDIA_MAX_TOP_BOXES) invalidContainer();
        const box = topBox(buffer.slice(offset, Math.min(offset + 16, buffer.byteLength)), offset, buffer.byteLength);
        top.push(box);
        offset = box.end;
    }
    const moov = validateTop(top, buffer.byteLength);
    return inspectMetadata(buffer.slice(moov.start, moov.end), top);
}
// At most 24 tiny headers + one <=2MiB moov; mdat payload is never materialized.
export async function inspectMP4Ranges(size: number, read: (offset: number, length: number) => Promise<ArrayBuffer>) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MEDIA_MAX_BYTES) invalidContainer();
    const top: Box[] = [];
    for (let offset = 0; offset < size;) {
        if (top.length >= MEDIA_MAX_TOP_BOXES) invalidContainer();
        const length = Math.min(16, size - offset);
        const header = await read(offset, length);
        if (header.byteLength !== length) invalidContainer();
        const box = topBox(header, offset, size);
        top.push(box);
        offset = box.end;
    }
    const moov = validateTop(top, size);
    const metadata = await read(moov.start, moov.end - moov.start);
    if (metadata.byteLength !== moov.end - moov.start) invalidContainer();
    return inspectMetadata(metadata, top);
}
