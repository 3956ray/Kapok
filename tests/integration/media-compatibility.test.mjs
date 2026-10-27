import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectMP4, inspectMP4Ranges } from '../../lib/server/media.ts';
const original = await readFile(new URL('../fixtures/synthetic-pass.mp4', import.meta.url));
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
test('metadata policy accepts timeline mismatch without a per-frame decoder gate', () => {
  const bytes = Buffer.from(original);
  bytes.writeUInt32BE(bytes.readUInt32BE(bytes.indexOf('mdhd') + 20) + 2048, bytes.indexOf('mdhd') + 20);
  assert.equal(inspectMP4(buffer(bytes)).mime, 'video/mp4');
});
test('range metadata reader skips mdat and bounds every allocation', async () => {
  const reads = [];
  const media = await inspectMP4Ranges(original.length, async (offset, length) => {
    reads.push({ offset, length });
    return buffer(original.subarray(offset, offset + length));
  });
  assert.equal(media.durationSec, 3);
  assert.ok(reads.length <= 25);
  assert.ok(reads.every(x => x.length <= 2 * 1024 * 1024));
  assert.ok(reads.reduce((n, x) => n + x.length, 0) < original.length);
});
test('local authorized samples are metadata-only regressions when explicitly supplied', async t => {
  if (!process.env.KAPOK_SAMPLE_A || !process.env.KAPOK_SAMPLE_B) return t.skip('local-only sample paths not supplied');
  for (const label of ['A', 'B']) {
    const bytes = await readFile(process.env['KAPOK_SAMPLE_' + label]);
    assert.equal(inspectMP4(buffer(bytes)).mime, 'video/mp4', label);
  }
});
test('600 second boundary, actual declared duration plus one, and unknown codecs are distinct', async () => {
  const { sizedMP4 } = await import('../fixtures/mp4-sized.mjs');
  for (const seconds of [600, 601]) {
    const file = sizedMP4(original, original.length, seconds);
    const parse = () => inspectMP4(buffer(file.read(0, file.size)));
    if (seconds === 600) assert.equal(parse().durationSec, 600);
    else assert.throws(parse, error => error.code === 'UPLOAD_LIMIT');
  }
  const unknown = Buffer.from(original); unknown.write('hvc1', unknown.indexOf('avc1'));
  assert.throws(() => inspectMP4(buffer(unknown)), error => error.code === 'UNSUPPORTED_CODEC');
});
test('malicious sizes, parameter lengths, offsets, tables and metadata budgets are rejected', async () => {
  const cases = [
    bytes => bytes.writeBigUInt64BE(2n ** 63n, 36),
    bytes => bytes.writeUInt16BE(65535, bytes.indexOf('avcC') + 10),
    bytes => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('stco') + 12),
    bytes => bytes.writeUInt32BE(100001, bytes.indexOf('stsz') + 12),
    bytes => bytes.writeUInt32BE(0xffffffff, bytes.indexOf('stts') + 8),
  ];
  for (const mutate of cases) { const bytes = Buffer.from(original); mutate(bytes); assert.throws(() => inspectMP4(buffer(bytes)), error => error.code === 'UNSUPPORTED_MEDIA'); }
  const box = (type, size) => { const bytes = Buffer.alloc(16); bytes.writeUInt32BE(size); bytes.write(type, 4); return buffer(bytes); };
  let calls = 0;
  await assert.rejects(inspectMP4Ranges(10 * 1024 * 1024, async (offset, length) => { calls++; assert.equal(length, 16); return offset === 0 ? box('ftyp', 16) : box('moov', 10 * 1024 * 1024 - 16); }), error => error.code === 'UNSUPPORTED_MEDIA');
  assert.equal(calls, 2, 'oversized moov never fetched');
  calls = 0;
  await assert.rejects(inspectMP4Ranges(1000, async () => { calls++; return box('free', 16); }), error => error.code === 'UNSUPPORTED_MEDIA');
  assert.equal(calls, 24, 'top-level malicious box scan cannot exceed read budget');
});
test('recognized metadata/timecode tracks do not reject otherwise supported media; total track count remains bounded', () => {
  const moovAt = original.indexOf('moov') - 4;
  const trakAt = original.indexOf('trak') - 4;
  const track = Buffer.from(original.subarray(trakAt, trakAt + original.readUInt32BE(trakAt)));
  track.write('tmcd', track.indexOf('hdlr') + 12);
  function additional(count) {
    const bytes = Buffer.concat([original, ...Array.from({ length: count }, () => track)]);
    bytes.writeUInt32BE(bytes.length - moovAt, moovAt);
    return bytes;
  }
  assert.equal(inspectMP4(buffer(additional(2))).mime, 'video/mp4');
  assert.throws(() => inspectMP4(buffer(additional(8))), error => error.code === 'UNSUPPORTED_MEDIA');
});
