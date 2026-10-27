// Synthetic sparse expansion: media offsets stay fixed, only trailing mdat padding grows.
export function sizedMP4(original, size, seconds = 3) {
    const boxes = [];
    for (let offset = 0; offset < original.length;) {
        let length = original.readUInt32BE(offset);
        const header = length === 1 ? 16 : 8;
        if (length === 1) length = Number(original.readBigUInt64BE(offset + 8));
        boxes.push({ type: original.toString('ascii', offset + 4, offset + 8), offset, header, end: offset + length });
        offset += length;
    }
    const mdat = boxes.find(box => box.type === 'mdat');
    const moov = boxes.find(box => box.type === 'moov');
    if (moov.offset !== mdat.end || moov.end !== original.length || size < original.length) throw new Error('Unexpected synthetic layout');
    const prefix = Buffer.from(original.subarray(0, mdat.end));
    const metadata = Buffer.from(original.subarray(moov.offset));
    const padding = size - original.length;
    if (mdat.header === 16) prefix.writeBigUInt64BE(BigInt(mdat.end - mdat.offset + padding), mdat.offset + 8);
    else prefix.writeUInt32BE(mdat.end - mdat.offset + padding, mdat.offset);
    const mvhd = metadata.indexOf('mvhd');
    metadata.writeUInt32BE(seconds * metadata.readUInt32BE(mvhd + 16), mvhd + 20);
    const segments = [{ offset: 0, bytes: prefix }, { offset: moov.offset + padding, bytes: metadata }];
    return {
        size,
        read(offset, length) {
            const bytes = Buffer.alloc(length);
            for (const segment of segments) {
                const start = Math.max(offset, segment.offset);
                const end = Math.min(offset + length, segment.offset + segment.bytes.length);
                if (start < end) segment.bytes.copy(bytes, start - offset, start - segment.offset, end - segment.offset);
            }
            return bytes;
        },
    };
}
