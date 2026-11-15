import { learningImageDimensions, type LearningImageType } from '../contracts/learning.ts';
import { DomainError } from './domain.ts';

type Dimensions = { width: number; height: number };
const invalid = () => new DomainError('INVALID_IMAGE', '请选择可读取的 PNG、JPEG 或 WebP 图片。', 415);
function dimensions(width: number, height: number): Dimensions {
    const { maxEdge, maxPixels } = learningImageDimensions;
    if (width < 1 || height < 1 || width > maxEdge || height > maxEdge || width * height > maxPixels) throw invalid();
    return { width, height };
}
function tag(bytes: Uint8Array, offset: number) {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
const pngMagic = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
    let crc = byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    return crc;
});
function validCrc(bytes: Uint8Array, start: number, end: number, expected: number) {
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
    return (crc ^ 0xffffffff) >>> 0 === expected;
}

async function png(bytes: Uint8Array<ArrayBuffer>, view: DataView): Promise<Dimensions> {
    if (bytes.length < 45 || tag(bytes, 12) !== 'IHDR' || view.getUint32(8) !== 13) throw invalid();
    const size = dimensions(view.getUint32(16), view.getUint32(20));
    const [depth, color, compression, filter, interlace] = bytes.subarray(24, 29);
    const channels = [1, 0, 3, 1, 2, 0, 4][color];
    const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
    if (!channels || !depths.includes(depth) || compression || filter || interlace > 1) throw invalid();

    let palette = false;
    let endedData = false;
    let ended = false;
    let count = 0;
    const data: Uint8Array<ArrayBuffer>[] = [];
    for (let pos = 8; pos + 12 <= bytes.length;) {
        const length = view.getUint32(pos);
        const type = tag(bytes, pos + 4);
        const start = pos + 8;
        const end = start + length;
        if (++count > 2048 || end + 4 > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
            !validCrc(bytes, pos + 4, end, view.getUint32(end))) throw invalid();
        if (type === 'IHDR' && pos === 8) {
            // Header was checked before reading dimensions.
        } else if (type === 'PLTE') {
            if (palette || data.length || color === 0 || color === 4 || !length || length % 3 || length / 3 > (color === 3 ? 1 << depth : 256)) throw invalid();
            palette = true;
        } else if (type === 'IDAT') {
            if (endedData || (color === 3 && !palette)) throw invalid();
            data.push(bytes.subarray(start, end));
        } else if (type === 'IEND') {
            if (length || end + 4 !== bytes.length || !data.length) throw invalid();
            ended = true;
            break;
        } else {
            if (type[0] === type[0].toUpperCase() || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw invalid();
            if (data.length) endedData = true;
        }
        pos = end + 4;
    }
    if (!ended) throw invalid();

    const passes = interlace ? [
        [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
    ] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => ({
        rowBytes: Math.ceil(Math.ceil((size.width - x) / dx) * channels * depth / 8) + 1,
        rowCount: Math.ceil((size.height - y) / dy),
    })).filter(pass => pass.rowBytes > 1 && pass.rowCount > 0);
    const raw = new Blob(data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let pass = 0, row = 0, offset = 0;
    try {
        for (;;) {
            const item = await raw.read();
            if (item.done) break;
            for (let i = 0; i < item.value.length;) {
                const cursor = rows[pass];
                if (!cursor || (!offset && item.value[i] > 4)) throw invalid();
                const count = Math.min(item.value.length - i, cursor.rowBytes - offset);
                i += count;
                offset += count;
                if (offset === cursor.rowBytes) {
                    offset = 0;
                    if (++row === cursor.rowCount) { row = 0; pass++; }
                }
            }
        }
        if (pass !== rows.length) throw invalid();
    } catch {
        throw invalid();
    } finally {
        await raw.cancel().catch(() => {});
        raw.releaseLock();
    }
    return size;
}

function jpeg(bytes: Uint8Array, view: DataView): Dimensions {
    let size: Dimensions | undefined;
    let progressive = false, scanning = false, scans = 0, segments = 0;
    const components = new Map<number, number>();
    const quantization = new Set<number>();
    const huffman = new Set<number>();
    const seen = new Set<number>();
    for (let pos = 2; pos < bytes.length;) {
        if (scanning) {
            const start = pos;
            while (pos < bytes.length) {
                if (bytes[pos++] !== 255) continue;
                const markerAt = pos - 1;
                while (bytes[pos] === 255) pos++;
                if (bytes[pos] === 0 || (bytes[pos] >= 0xd0 && bytes[pos] <= 0xd7)) { pos++; continue; }
                pos = markerAt;
                break;
            }
            if (pos === start) throw invalid();
            scanning = false;
        }
        if (++segments > 2048 || bytes[pos++] !== 255) throw invalid();
        while (bytes[pos] === 255) pos++;
        const marker = bytes[pos++];
        if (marker === 0xd9 && size && scans && seen.size === components.size && pos === bytes.length) return size;
        if (pos + 2 > bytes.length) throw invalid();
        const length = view.getUint16(pos);
        const end = pos + length;
        pos += 2;
        if (length < 2 || end > bytes.length) throw invalid();
        if (marker === 0xc0 || marker === 0xc2) {
            if (size || length < 11 || bytes[pos] !== 8) throw invalid();
            size = dimensions(view.getUint16(pos + 3), view.getUint16(pos + 1));
            progressive = marker === 0xc2;
            const count = bytes[pos + 5];
            if (![1, 3, 4].includes(count) || length !== 8 + 3 * count) throw invalid();
            for (let i = pos + 6; i < end; i += 3) {
                const hv = bytes[i + 1];
                if (components.has(bytes[i]) || !(hv >> 4) || hv >> 4 > 4 || !(hv & 15) || (hv & 15) > 4 || bytes[i + 2] > 3) throw invalid();
                components.set(bytes[i], bytes[i + 2]);
            }
        } else if (marker === 0xdb) {
            if (length < 67) throw invalid();
            for (let i = pos; i < end;) {
                const table = bytes[i++];
                const precision = table >> 4;
                const width = precision + 1;
                if (precision > 1 || (table & 15) > 3 || i + 64 * width > end) throw invalid();
                quantization.add(table & 15);
                for (let q = 0; q < 64; q++, i += width) {
                    if (!(precision ? view.getUint16(i) : bytes[i])) throw invalid();
                }
            }
        } else if (marker === 0xc4) {
            if (length < 20) throw invalid();
            for (let i = pos; i < end;) {
                const table = bytes[i++];
                if ((table >> 4) > 1 || (table & 15) > 3 || i + 16 >= end) throw invalid();
                let total = 0, free = 1;
                for (let bits = 0; bits < 16; bits++) {
                    const count = bytes[i++];
                    total += count;
                    free = free * 2 - count;
                    if (free <= 0) throw invalid();
                }
                if (!total || total > 256 || i + total > end) throw invalid();
                huffman.add(table);
                i += total;
            }
        } else if (marker === 0xda) {
            const count = bytes[pos];
            if (!size || !count || count > components.size || length !== 6 + 2 * count || ++scans > 256) throw invalid();
            const [first, last, refinement] = bytes.subarray(end - 3, end);
            if (first > last || last > 63 || (progressive && (first ? count !== 1 : last !== 0)) ||
                (!progressive && (first !== 0 || last !== 63 || refinement !== 0))) throw invalid();
            const thisScan = new Set<number>();
            for (let i = pos + 1; i < end - 3; i += 2) {
                const component = bytes[i];
                const table = bytes[i + 1];
                const quant = components.get(component);
                if (quant === undefined || !quantization.has(quant) || thisScan.has(component) ||
                    ((!progressive || (!first && refinement >> 4 === 0)) && !huffman.has(table >> 4)) ||
                    ((!progressive || first > 0) && !huffman.has(16 | (table & 15)))) throw invalid();
                thisScan.add(component);
                seen.add(component);
            }
            scanning = true;
        } else if (marker === 0xdd) {
            if (length !== 4) throw invalid();
        } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
            throw invalid();
        }
        pos = end;
    }
    throw invalid();
}

function webp(bytes: Uint8Array, view: DataView): Dimensions {
    if (bytes.length < 26 || view.getUint32(4, true) !== bytes.length - 8 || tag(bytes, 8) !== 'WEBP') throw invalid();
    let canvas: Dimensions | undefined;
    let image: Dimensions | undefined;
    let features = 0;
    let pos = 12;
    let losslessAlpha = false;
    const chunks = new Set<string>();
    const u24 = (i: number) => bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16);
    for (; pos + 8 <= bytes.length;) {
        const type = tag(bytes, pos);
        const length = view.getUint32(pos + 4, true);
        const start = pos + 8;
        const end = start + length;
        if (!length || end + (length & 1) > bytes.length || ((length & 1) && bytes[end] !== 0) || chunks.has(type)) throw invalid();
        chunks.add(type);
        if (type === 'VP8X') {
            if (pos !== 12 || length !== 10 || (bytes[start] & 0xc3) || u24(start + 1)) throw invalid();
            features = bytes[start];
            canvas = dimensions(u24(start + 4) + 1, u24(start + 7) + 1);
        } else if (type === 'VP8 ') {
            if (image || length < 12 || bytes[start] & 1 || (u24(start) >> 5) === 0 || (u24(start) >> 5) > length - 10 ||
                bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) throw invalid();
            image = dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
        } else if (type === 'VP8L') {
            if (image || length < 7 || bytes[start] !== 0x2f || chunks.has('ALPH')) throw invalid();
            const flags = view.getUint32(start + 1, true);
            if (flags >>> 29) throw invalid();
            image = dimensions((flags & 0x3fff) + 1, ((flags >>> 14) & 0x3fff) + 1);
            losslessAlpha = !!(flags & (1 << 28));
        } else if (type === 'ALPH') {
            const flags = bytes[start];
            if (!canvas || image || length < 2 || (flags & 0xc0) || (flags & 3) > 1 || ((flags >> 4) & 3) > 1 ||
                ((flags & 3) === 0 && length !== canvas.width * canvas.height + 1)) throw invalid();
        } else if (type === 'ICCP') {
            if (!canvas || image || chunks.has('ALPH')) throw invalid();
        } else if (type === 'EXIF' || type === 'XMP ') {
            if (!canvas || !image) throw invalid();
        } else {
            throw invalid();
        }
        pos = end + (length & 1);
    }
    if (!image || pos !== bytes.length || (canvas && (canvas.width !== image.width || canvas.height !== image.height)) ||
        !!(features & 0x20) !== chunks.has('ICCP') || (canvas && !!(features & 0x10) !== (chunks.has('ALPH') || losslessAlpha)) ||
        !!(features & 0x08) !== chunks.has('EXIF') || !!(features & 0x04) !== chunks.has('XMP ')) throw invalid();
    return image;
}

export async function validatedLearningImage(body: ReadableStream<Uint8Array> | null, declaredType: string | null, maxBytes: number) {
    if (!body || !['image/png', 'image/jpeg', 'image/webp'].includes(declaredType ?? '')) throw invalid();
    const reader = body.getReader();
    const buffer = new Uint8Array(maxBytes);
    let length = 0;
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            const end = length + item.value.length;
            if (end > maxBytes) throw new DomainError('IMAGE_TOO_LARGE', '图片超过大小上限，请缩小后重试。', 413);
            buffer.set(item.value, length);
            length = end;
        }
    } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('RESULT_UNKNOWN', '未收到完整图片，请保留图片并重试。', 503, true);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    const bytes = buffer.subarray(0, length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let mimeType: LearningImageType;
    let size: Dimensions;
    if (pngMagic.every((value, index) => bytes[index] === value)) {
        mimeType = 'image/png';
        size = await png(bytes, view);
    } else if (bytes[0] === 255 && bytes[1] === 0xd8) {
        mimeType = 'image/jpeg';
        size = jpeg(bytes, view);
    } else if (tag(bytes, 0) === 'RIFF') {
        mimeType = 'image/webp';
        size = webp(bytes, view);
    } else {
        throw invalid();
    }
    if (mimeType !== declaredType) throw invalid();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    return { bytes, mimeType, digest, ...size };
}
