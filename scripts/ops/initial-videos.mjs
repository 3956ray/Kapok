import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { prepareImport, prepareBatch, runImport } from '../../lib/import/initial-videos.mjs';
export { prepareImport, prepareBatch, runImport } from '../../lib/import/initial-videos.mjs';
const origin = 'https://kapok.party';
const actorPattern = /^actor_[a-f0-9]{64}$/;
const own = (object, key) => Object.hasOwn(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class ImportError extends Error {}
function requireValue(condition, message) {
    if (!condition) throw new ImportError(message);
}

export function createImportApi(session, fetcher = fetch) {
    requireValue(typeof session === 'string' && session.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session), 'Supply a current CF_Authorization session at runtime.');
    return async (route, { actor, key, payload, precondition } = {}) => {
        requireValue(/^(?:bootstrap|me|trainings(?:\/[A-Za-z0-9_-]{1,160}(?:\/videos)?)?)$/.test(route), 'Invalid import API route.');
        const url = origin + '/api/v1/' + route;
        const headers = { Accept: 'application/json', Cookie: 'CF_Authorization=' + session };
        if (payload) Object.assign(headers, { 'Content-Type': 'application/json', Origin: origin, 'X-Kapok-Actor': actor, 'Idempotency-Key': key });
        if (precondition) headers['X-Kapok-Import'] = JSON.stringify(precondition);
        let response;
        try {
            response = await fetcher(url, {
                method: payload ? 'POST' : 'GET', headers, body: payload ? JSON.stringify(payload) : undefined,
                redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
            });
        } catch {
            throw new ImportError(payload ? 'Write result unknown. Reconcile with this ledger before retrying.' : 'Kapok API could not be reached without a redirect.');
        }
        const responseActor = response.headers.get('X-Kapok-Actor');
        if (payload && response.status === 409 && !response.redirected && (!response.url || response.url === url) && response.headers.get('X-Kapok-Actor') === actor && response.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json') {
            const rejected = await response.clone().json().catch(() => null);
            if (rejected?.error?.code === 'IMPORT_MAPPING_REJECTED_NO_COMMIT') {
                const error = new ImportError('Training mapping rejected without commit (HTTP 409). Reconcile and approve again.');
                error.code = rejected.error.code;
                throw error;
            }
        }
        if (response.redirected || (response.url && response.url !== url) || !response.ok || (actor && actor !== responseActor)
            || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
            await response.body?.cancel().catch(() => {});
            requireValue(false, actor && responseActor && actor !== responseActor
                ? 'Kapok actor changed. Stop and use the original administrator session.'
                : `Kapok API response rejected (HTTP ${response.status}). ${payload ? 'Reconcile this pending write before retrying.' : 'Check the current Access session and permissions.'}`);
        }
        let body;
        try { body = await response.json(); } catch { throw new ImportError('Kapok API JSON could not be read. Preserve the ledger.'); }
        requireValue(isObject(body) && own(body, 'data') && typeof body.requestId === 'string' && typeof responseActor === 'string' && actorPattern.test(responseActor), 'Invalid Kapok API envelope.');
        return { data: body.data, actor: responseActor };
    };
}

async function jsonFile(path, label) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new ImportError(label + ' could not be read as JSON.'); }
}
export async function withLedger(path, run) {
    const lock = path + '.lock';
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new ImportError('Cannot acquire the ledger lock. Check the path or another running import.'); }
    try {
        let ledger;
        const stat = await lstat(path).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        if (stat) {
            requireValue(stat.isFile() && (stat.mode & 0o077) === 0, 'Ledger must be a private regular file.');
            ledger = await jsonFile(path, 'Ledger');
            requireValue(isObject(ledger), 'Invalid ledger.');
        }
        const save = async state => {
            const temporary = path + '.' + randomUUID() + '.tmp';
            try {
                const file = await open(temporary, 'wx', 0o600);
                try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); }
                finally { await file.close(); }
                await rename(temporary, path);
                const directory = await open(dirname(path), 'r');
                try { await directory.sync(); } finally { await directory.close(); }
            } finally {
                await rm(temporary, { force: true });
            }
        };
        return await run(ledger, save);
    } finally {
        await rmdir(lock);
    }
}

async function main() {
    let values;
    try {
        ({ values } = parseArgs({ options: {
            batch: { type: 'string' }, offline: { type: 'boolean' }, manifest: { type: 'string' }, mapping: { type: 'string' }, ledger: { type: 'string' },
            reconcile: { type: 'boolean' }, apply: { type: 'boolean' }, approve: { type: 'string' },
        } }));
    } catch { throw new ImportError('Invalid options. Use --manifest, optional --mapping, and see the runbook for online modes.'); }
    requireValue(values.manifest && !(values.apply && values.reconcile), 'Provide --manifest and select at most one online mode.');
    const manifest = await jsonFile(values.manifest, 'Manifest');
    const plan = values.batch ? prepareBatch(manifest, values.batch) : prepareImport(manifest, values.mapping ? await jsonFile(values.mapping, 'Mapping') : {});
    requireValue(!values.offline || (!values.apply && !values.reconcile), 'Offline mode cannot write.');
    requireValue(!values.batch || !values.mapping, 'Batch mapping is frozen.');
    if (!values.apply && !values.reconcile) {
        requireValue(!values.approve && !values.ledger, 'Ledger options require an explicit online mode.');
        console.log(JSON.stringify({ mode: 'offline-preview', status: 'NOT_IMPORTED', ...plan }, null, 2));
        return;
    }
    requireValue((values.mapping || values.batch) && values.ledger && (values.apply ? /^[a-f0-9]{64}$/.test(values.approve ?? '') : !values.approve),
        'Online mode requires --mapping and --ledger. Apply also requires the reviewed --approve hash.');
    requireValue(plan.rows.every(row => !row.blockers.length), 'Resolve all offline blockers before connecting.');
    const session = process.env.KAPOK_ACCESS_SESSION;
    delete process.env.KAPOK_ACCESS_SESSION;
    const api = createImportApi(session);
    const mode = values.apply ? 'apply' : 'reconcile';
    const report = await withLedger(resolve(values.ledger), (ledger, save) => runImport({ mode, plan, api, ledger, save, approval: values.approve }));
    console.log(JSON.stringify({ mode, ...report }, null, 2));
    if (report.blockers.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof ImportError ? error.message : 'Initial video import stopped. Preserve the ledger and reconcile before retrying.');
        process.exitCode = 1;
    });
}
