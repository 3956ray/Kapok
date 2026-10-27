import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferUpload } from '../../lib/client/upload.ts';
import { withRequestDeadline } from '../../lib/client/api.ts';
import { MEDIA_PART_BYTES, MEDIA_UPLOAD_TIMEOUT_MS } from '../../lib/contracts/media.ts';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
class XHR {
    static requests = [];
    upload = {}; headers = {}; status = 200; responseText = JSON.stringify({ data: { id: 'u' } });
    constructor() { XHR.requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    getResponseHeader() { return 'A'; }
    send(blob) { this.blob = blob; }
    abort() { this.onabort(); }
}
test('sequential upload slices and immutable retry key with active-generation abort fence', async t => {
    const previous = globalThis.XMLHttpRequest; globalThis.XMLHttpRequest = XHR; t.after(() => { globalThis.XMLHttpRequest = previous; });
    XHR.requests = [];
    const file = new File([new Uint8Array(MEDIA_PART_BYTES + 17)], 'synthetic.mp4');
    const progress = []; let active, current = true;
    const pending = transferUpload(file, 'u', 'A', 'stable', () => current, request => { active = request; }, value => progress.push(value));
    assert.equal(XHR.requests.length, 1);
    assert.equal(active.blob.size, MEDIA_PART_BYTES);
    assert.equal(active.timeout, MEDIA_UPLOAD_TIMEOUT_MS);
    active.upload.onprogress({ lengthComputable: true, loaded: MEDIA_PART_BYTES });
    active.onload(); await flush();
    assert.equal(XHR.requests.length, 2);
    assert.equal(active.blob.size, 17);
    assert.equal(active.headers['X-Kapok-Part'], '2');
    assert.equal(active.headers['Idempotency-Key'], 'stable');
    const last = active; const rejected = assert.rejects(pending, /停止/);
    current = false; active.abort(); last.onload(); await rejected;
    assert.equal(active, null); assert.ok(progress[0] > 90);
});
test('upload timeout and missing response identity report uncertainty without creating later chunks', async t => {
    const previous = globalThis.XMLHttpRequest; globalThis.XMLHttpRequest = XHR; t.after(() => { globalThis.XMLHttpRequest = previous; });
    for (const failure of ['timeout', 'identity']) {
        XHR.requests = [];
        const pending = transferUpload(new File([new Uint8Array(5)], 'synthetic.mp4'), 'u', 'A', 'stable', () => true, () => {}, () => {});
        const rejected = assert.rejects(pending, /暂时无法确认/);
        const request = XHR.requests[0];
        if (failure === 'timeout') request.ontimeout();
        else { request.getResponseHeader = () => null; request.onload(); }
        await rejected; assert.equal(XHR.requests.length, 1);
    }
});
test('ordinary API deadline stays 15 seconds, upload completion is finite 120 seconds, abort suppresses late result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const ordinary = withRequestDeadline(() => new Promise(() => {}));
        const ordinaryRejected = assert.rejects(ordinary, error => error.code === 'REQUEST_TIMEOUT');
        t.mock.timers.tick(15001); await ordinaryRejected;
        let resolve, done = false;
        const upload = withRequestDeadline(() => new Promise(r => { resolve = r; }), undefined, true, true);
        upload.then(() => { done = true; }, () => {}); await flush();
        t.mock.timers.tick(15001); await flush(); assert.equal(done, false);
        const uploadRejected = assert.rejects(upload, error => error.code === 'REQUEST_TIMEOUT');
        t.mock.timers.tick(105000); await uploadRejected;
        resolve('late'); await flush(); assert.equal(done, false);
        const controller = new AbortController();
        const cancelled = withRequestDeadline(() => new Promise(() => {}), controller.signal, true, true);
        const cancelledRejected = assert.rejects(cancelled); controller.abort(); await cancelledRejected;
    } finally { t.mock.timers.reset(); }
});
