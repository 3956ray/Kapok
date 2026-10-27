// Rebuild only container sample/timing references around the actual synthetic IDR.
// No encoded payload or codec is invented; malformed SPS is an optional early-stage sentinel.
function uint32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
}
function box(type, ...payload) {
    const data = Buffer.concat(payload);
    return Buffer.concat([uint32(data.length + 8), Buffer.from(type), data]);
}
function fullBox(type, ...payload) {
    return box(type, uint32(0), ...payload);
}
function children(bytes, start = 0, end = bytes.length) {
    const result = [];
    while(start < end) {
        let size = bytes.readUInt32BE(start);
        let header = 8;
        if(size === 1) {
            size = Number(bytes.readBigUInt64BE(start + 8));
            header = 16;
        }
        if(!size) size = end - start;
        result.push({ type: bytes.toString('ascii', start + 4, start + 8), start, data: start + header, end: start + size });
        start += size;
    }
    return result;
}
const one = (list, type) => list.find(item => item.type === type);
const raw = (bytes, item) => bytes.subarray(item.start, item.end);
export function referencedMP4(original, counts, {
    compactChunks = false,
    corruptFirstSps = false,
    sampleSizeOverride,
    mdatPadding = 0,
} = {}) {
    const top = children(original);
    const moov = one(top, 'moov');
    const movie = children(original, moov.data, moov.end);
    const sourceTrack = one(movie, 'trak');
    const track = children(original, sourceTrack.data, sourceTrack.end);
    const mdia = one(track, 'mdia');
    const media = children(original, mdia.data, mdia.end);
    const minf = one(media, 'minf');
    const info = children(original, minf.data, minf.end);
    const stbl = one(info, 'stbl');
    const tables = children(original, stbl.data, stbl.end);
    const firstOffset = original.readUInt32BE(one(tables, 'stco').data + 8);
    const sourceSizes = one(tables, 'stsz');
    const sampleSize = original.readUInt32BE(sourceSizes.data + 4) || original.readUInt32BE(sourceSizes.data + 12);
    const declaredSize = sampleSizeOverride ?? sampleSize;
    const idrSample = original.subarray(firstOffset, firstOffset + sampleSize);
    const ftyp = raw(original, one(top, 'ftyp'));
    const payload = Buffer.alloc(Math.max(idrSample.length, mdatPadding));
    idrSample.copy(payload);
    const mediaData = box('mdat', payload);
    const offset = ftyp.length + 8;
    const tracks = counts.map((count, index) => {
        const description = Buffer.from(raw(original, one(tables, 'stsd')));
        if(corruptFirstSps && index === 0) {
            const config = description.indexOf('avcC') + 4;
            const length = description.readUInt16BE(config + 6);
            description.fill(0, config + 9, config + 8 + length);
        }
        const chunkOffsets = compactChunks ? [uint32(offset)] : Array.from({ length: count }, () => uint32(offset));
        const samplesPerChunk = compactChunks ? count : 1;
        const sampleTable = box(
            'stbl',

            description,

            fullBox('stts', uint32(1), uint32(count), uint32(3)),

            fullBox('stsz', uint32(declaredSize), uint32(count)),

            fullBox('stsc', uint32(1), uint32(1), uint32(samplesPerChunk), uint32(1)),

            fullBox('stco', uint32(chunkOffsets.length), ...chunkOffsets),

        );
        const header = Buffer.from(raw(original, one(media, 'mdhd')));
        header.writeUInt32BE(count, 20); // timescale=count, count samples each lasting three ticks.
        header.writeUInt32BE(count * 3, 24);
        const rebuiltInfo = box('minf', ...info.map(item => item.type === 'stbl' ? sampleTable : raw(original, item)));
        const rebuiltMedia = box('mdia', ...media.map(item => item.type === 'mdhd' ? header : item.type === 'minf' ? rebuiltInfo : raw(original, item)));
        return box('trak', ...track.map(item => item.type === 'mdia' ? rebuiltMedia : raw(original, item)));
    });
    return {
        bytes: Buffer.concat([ftyp, mediaData, box('moov', raw(original, one(movie, 'mvhd')), ...tracks)]),
        samples: counts.reduce((sum, count) => sum + count, 0),
        referencedBytes: counts.reduce((sum, count) => sum + count * declaredSize, 0),
        mdatBytes: payload.length,
    };
}
