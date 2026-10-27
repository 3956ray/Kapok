// Synthetic metadata/virtual-offset fixture only: this does not generate decodable
// H.264/AAC payloads, and virtual size is not a claim of transferred media bytes.
import { readFile } from 'node:fs/promises';
const base = await readFile(new URL('./synthetic-pass.mp4', import.meta.url));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => { const payload = Buffer.concat(parts), header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]); };
const originalBox = type => { const p = base.indexOf(type) - 4; return base.subarray(p, p + base.readUInt32BE(p)); };
function timeline(seconds, scale = 1000) { const b = Buffer.alloc(32); b.writeUInt32BE(scale, 12); b.writeUInt32BE(seconds * scale, 16); return b; }
export function longMP4({ seconds = 7200, size = 5 * 1024 ** 3, offset = 4 * 1024 ** 3 + 128, variable = true, videoCount = seconds * 60, audioCount = seconds * 48000 / 1024, timingRows = false, everyChunk = false, audio = true, composition = false, sync = false } = {}) {
    const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
    const tracks = [];
    let payloadOffset = offset;
    for (const [handler, count, scale, delta] of [['vide', videoCount, timingRows ? 1000 : 60, timingRows ? Math.floor(seconds * 1000 / videoCount) : 1], ...(audio ? [['soun', audioCount, 48000, 1024]] : [])]) {
        if (!Number.isSafeInteger(count)) throw new Error('Synthetic count must be integer');
        let stsd;
        if (handler === 'vide') stsd = originalBox('stsd');
        else {
            // Minimal AAC-LC descriptor chain understood as metadata, not decoded.
            const config = Buffer.from([5, 2, 0x11, 0x90]);
            const decoder = Buffer.concat([Buffer.from([4, 13 + config.length, 0x40, 0x15]), Buffer.alloc(11), config]);
            const es = Buffer.concat([Buffer.from([3, 3 + decoder.length, 0, 1, 0]), decoder]);
            const esds = box('esds', Buffer.alloc(4), es);
            stsd = box('stsd', Buffer.alloc(4), u32(1), box('mp4a', Buffer.alloc(28), esds));
        }
        const hdlr = Buffer.alloc(20); hdlr.write(handler, 8);
        const sizes = variable ? Buffer.alloc(count * 4) : Buffer.alloc(0);
        for (let i = 0; i < count && variable; i++) sizes.writeUInt32BE(1, i * 4);
        const stsz = box('stsz', Buffer.alloc(4), u32(variable ? 0 : 1), u32(count), sizes);
        const timing = timingRows ? Buffer.alloc(count * 8) : Buffer.concat([u32(count), u32(delta)]);
        if (timingRows) for (let i = 0; i < count; i++) { timing.writeUInt32BE(1, i * 8); timing.writeUInt32BE(delta, i * 8 + 4); }
        const stts = box('stts', Buffer.alloc(4), u32(timingRows ? count : 1), timing);
        const chunkCount = everyChunk ? count : 1;
        const rules = Buffer.alloc((everyChunk ? count : 1) * 12);
        for (let i = 0; i < (everyChunk ? count : 1); i++) { rules.writeUInt32BE(i + 1, i * 12); rules.writeUInt32BE(everyChunk ? 1 : count, i * 12 + 4); rules.writeUInt32BE(1, i * 12 + 8); }
        const offsets = Buffer.alloc(chunkCount * 8); for (let i = 0; i < chunkCount; i++) offsets.writeBigUInt64BE(BigInt(payloadOffset + (everyChunk ? i : 0)), i * 8);
        const extras = [];
        if (composition) { const data = Buffer.alloc(count * 8); for (let i = 0; i < count; i++) data.writeUInt32BE(1, i * 8); extras.push(box('ctts', Buffer.alloc(4), u32(count), data)); }
        if (sync) { const data = Buffer.alloc(count * 4); for (let i = 0; i < count; i++) data.writeUInt32BE(i + 1, i * 4); extras.push(box('stss', Buffer.alloc(4), u32(count), data)); }
        tracks.push(box('trak', box('mdia', box('mdhd', timeline(seconds, scale)), box('hdlr', hdlr), box('minf', box('stbl', stsd, stts, stsz, box('stsc', Buffer.alloc(4), u32(everyChunk ? count : 1), rules), box('co64', Buffer.alloc(4), u32(chunkCount), offsets), ...extras)))));
        payloadOffset += count;
    }
    const metadata = box('moov', box('mvhd', timeline(seconds)), ...tracks);
    const mdat = Buffer.alloc(16); mdat.writeUInt32BE(1); mdat.write('mdat', 4); mdat.writeBigUInt64BE(BigInt(size - ftyp.length - metadata.length), 8);
    const prefix = Buffer.concat([ftyp, mdat]);
    const segments = [{ offset: 0, bytes: prefix }, { offset: size - metadata.length, bytes: metadata }];
    return { size, metadata, materializedBytes: prefix.length + metadata.length, read(at, length) {
        const b = Buffer.alloc(length);
        for (const s of segments) { const start = Math.max(at, s.offset), end = Math.min(at + length, s.offset + s.bytes.length); if (start < end) s.bytes.copy(b, start - at, start - s.offset, end - s.offset); }
        return b;
    } };
}
