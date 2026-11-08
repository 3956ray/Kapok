const origin = 'https://kapok.party';
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const bvidPattern = /^BV[A-Za-z0-9]{10}$/;
const own = (object, key) => Object.hasOwn(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && idPattern.test(value);
const isDeepStrictEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(v => v.toString(16).padStart(2, '0')).join('');
const writable = status => status === 'draft' || status === 'published';

class ImportError extends Error {}
function requireValue(condition, message) {
    if (!condition) throw new ImportError(message);
}

function object(value, fields, label) {
    requireValue(isObject(value) && Object.keys(value).every(key => fields.includes(key)), label + ' fields are invalid.');
}
function title(value, label) {
    requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80, label + ' title is invalid.');
    return value.trim();
}
function eventDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
        && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function bilibili(value) {
    const match = typeof value === 'string' && value.length <= 2000 &&
        /^https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[A-Za-z0-9]{10})\/?(?:[?#][^\s<>"'\\]*)?$/.exec(value);
    requireValue(match, 'Invalid canonical Bilibili video URL.');
    const pages = new URL(value).searchParams.getAll('p');
    const page = pages.length === 0 ? 1 : Number(pages[0]);
    requireValue(pages.length < 2 && Number.isSafeInteger(page) && page >= 1 && page <= 1000, 'Invalid Bilibili page.');
    return { bvid: match[1], url: 'https://www.bilibili.com/video/' + match[1] + '/' + (page > 1 ? '?p=' + page : '') };
}

export function prepareImport(manifest, mapping = {}) {
    requireValue(isObject(manifest) && Array.isArray(manifest.items) && manifest.items.length > 0 && manifest.items.length <= 8, 'Invalid initial videos manifest.');
    requireValue(isObject(mapping), 'Mapping must be an object keyed by BVID.');
    const seen = new Set();
    const trainings = new Map();
    const rows = manifest.items.map(item => {
        requireValue(isObject(item) && typeof item.bvid === 'string' && bvidPattern.test(item.bvid) && !seen.has(item.bvid), 'Invalid or repeated manifest BVID.');
        const { bvid, url } = bilibili(item.url);
        requireValue(bvid === item.bvid, 'Manifest BVID and URL differ.');
        seen.add(bvid);
        requireValue(item.event_date === null || eventDate(item.event_date), bvid + ' event date is invalid.');
        requireValue(['user', 'temporary_label'].includes(item.title_source), bvid + ' title source is invalid.');
        requireValue(item.user_date_label === null || (typeof item.user_date_label === 'string' && /^\d{4}$/.test(item.user_date_label)), bvid + ' date label is invalid.');
        const displayTitle = title(item.display_title, bvid);
        const entry = own(mapping, bvid) ? mapping[bvid] : {};
        object(entry, ['trainingId', 'newTraining', 'videoTitle', 'position'], bvid + ' mapping');
        const blockers = [];
        let association = null;
        if (own(entry, 'trainingId')) {
            requireValue(isId(entry.trainingId) && !own(entry, 'newTraining'), bvid + ' must specify one valid training association.');
            association = { trainingId: entry.trainingId };
        } else if (own(entry, 'newTraining')) {
            const input = entry.newTraining;
            object(input, ['group', 'date', 'title', 'confirmed'], bvid + ' new training');
            requireValue(isId(input.group), bvid + ' new training group is invalid.');
            const date = eventDate(input.date) ? input.date : null;
            const trainingTitle = input.title == null || input.title === '' ? null : title(input.title, bvid + ' new training');
            if (!date || !trainingTitle || input.confirmed !== true) blockers.push('CONFIRM_NEW_TRAINING_DATE_AND_TITLE');
            if (date && item.event_date !== null) requireValue(date === item.event_date, bvid + ' confirmed date differs from manifest.');
            const payload = { title: trainingTitle, date, description: '', status: 'published' };
            const prior = trainings.get(input.group);
            requireValue(!prior || isDeepStrictEqual(prior, payload), 'One new training group has different payloads.');
            trainings.set(input.group, payload);
            association = { newTrainingGroup: input.group };
        } else {
            blockers.push('CHOOSE_EXISTING_OR_CONFIRM_NEW_TRAINING');
        }
        if (!own(entry, 'videoTitle') && item.title_source === 'temporary_label') blockers.push('CONFIRM_VIDEO_TITLE');
        if (!own(entry, 'position')) blockers.push('CHOOSE_VIDEO_POSITION');
        else requireValue(Number.isSafeInteger(entry.position) && entry.position >= 0 && entry.position <= 10000, bvid + ' video position is invalid.');
        return {
            bvid, displayTitle, titleSource: item.title_source, dateLabel: item.user_date_label, eventDate: item.event_date,
            association, video: { title: own(entry, 'videoTitle') ? title(entry.videoTitle, bvid) : displayTitle, source: 'bilibili', url, position: entry.position ?? null },
            blockers,
        };
    });
    requireValue(Object.keys(mapping).every(key => seen.has(key)), 'Mapping includes a BVID outside this manifest.');
    const events = [...trainings.values()].filter(payload => payload.date && payload.title).map(payload => JSON.stringify([payload.date, payload.title]));
    requireValue(new Set(events).size === events.length, 'Use one new training group for the same date and title.');
    return { rows, newTrainings: [...trainings].map(([group, payload]) => ({ group, payload })) };
}

function adminBinding(actor, account) {
    const { user, membership } = account ?? {};
    requireValue(user?.status === 'active' && isId(user.id) && membership?.status === 'active' && membership.role === 'admin'
        && isId(membership.id) && isId(membership.teamId) && Number.isSafeInteger(membership.epoch) && membership.epoch > 0,
    'Current Kapok account is not an active administrator.');
    return { actor, userId: user.id, teamId: membership.teamId, membershipId: membership.id, epoch: membership.epoch };
}
async function currentAdmin(api, actor) {
    const { data } = await api('me', { actor });
    const binding = adminBinding(actor, data);
    requireValue(data.team?.id === binding.teamId, 'Kapok team binding is invalid.');
    return binding;
}
async function bindAdmin(api) {
    const { actor, data } = await api('bootstrap');
    requireValue(isObject(data) && data.actorId === actor && !own(data, 'siteUserId'), 'Kapok Access actor could not be verified.');
    const binding = adminBinding(actor, data.me);
    requireValue(isDeepStrictEqual(binding, await currentAdmin(api, actor)), 'Kapok account changed during verification.');
    return binding;
}

async function operationKey(binding, kind, target, item) {
    return 'kapok_initial_v1_' + await hash([origin, binding.actor, binding.userId, binding.teamId, kind, target, item]);
}
function checkTraining(row) {
    requireValue(isObject(row) && isId(row.id) && typeof row.title === 'string' && eventDate(row.date)
        && ['draft', 'published', 'archived', 'hidden', 'deleted'].includes(row.status), 'Invalid Kapok training response.');
}
function checkVideo(row, trainingId) {
    requireValue(isObject(row) && isId(row.id) && row.trainingId === trainingId && typeof row.title === 'string'
        && Number.isSafeInteger(row.position) && ['active', 'hidden', 'deleted'].includes(row.status)
        && ['upload', 'bilibili'].includes(row.source), 'Invalid Kapok video response.');
    return row.source === 'bilibili' ? bilibili(row.url).bvid : null;
}
async function snapshot(api, actor, batch) {
    if (batch) {
        const { data } = await api("trainings/import-inventory", { actor });
        const trainings = new Map(data.trainings.map(t => { checkTraining(t); return [t.id, t]; }));
        const videos = new Map();
        for (const v of data.videos) { const bvid = checkVideo(v, v.trainingId); if (bvid) videos.set(bvid, [...(videos.get(bvid) ?? []), v]); }
        return { trainings, videos };
    }
    const list = (await api('trainings', { actor })).data;
    requireValue(Array.isArray(list), 'Invalid Kapok training list.');
    const trainings = new Map();
    const videos = new Map();
    for (const row of list) {
        checkTraining(row);
        const detail = (await api('trainings/' + row.id, { actor })).data;
        checkTraining(detail);
        requireValue(detail.id === row.id && Array.isArray(detail.videos) && !trainings.has(row.id), 'Invalid Kapok training detail.');
        trainings.set(detail.id, detail);
        for (const video of detail.videos) {
            const bvid = checkVideo(video, detail.id);
            if (bvid) videos.set(bvid, [...(videos.get(bvid) ?? []), video]);
        }
    }
    return { trainings, videos };
}

const blank = () => ({ state: 'planned', id: null, observed: [], key: null });
function validReceipt(entry) {
    return isObject(entry) && Array.isArray(entry.observed) && entry.observed.every(isId)
        && (entry.key === null || (typeof entry.key === 'string' && /^kapok_initial_v1_[a-f0-9]{64}$/.test(entry.key)))
        && (['planned', 'pending'].includes(entry.state) ? entry.id === null
            : ['matched', 'confirmed'].includes(entry.state) && isId(entry.id));
}
function recordObserved(receipt, ids) {
    receipt.observed = [...new Set([...receipt.observed, ...ids])].sort();
}

function reconcile(plan, ledger, current) {
    const blockers = [];
    const targets = new Map();
    for (const { group, payload } of plan.newTrainings) {
        const entry = ledger.trainings[group];
        if (plan.batch) {
            const matches = [...current.trainings.values()].filter(t => t.date === payload.date);
            if (matches.length > 1) blockers.push({ group, reason: 'MULTIPLE_DATE_MATCHES' });
            else if (matches.length === 1 && !entry.id) Object.assign(entry, { state: 'matched', id: matches[0].id });
        }
        const target = current.trainings.get(entry.id);
        if (entry.id && (!target || (plan.batch ? !['published', 'archived'].includes(target.status) : !writable(target.status)))) blockers.push({ group, reason: 'KNOWN_TRAINING_UNAVAILABLE' });
        if (!plan.batch && entry.state === 'planned') {
            recordObserved(entry, [...current.trainings.values()].filter(t => t.date === payload.date && t.title === payload.title).map(t => t.id));
            if (entry.observed.length) blockers.push({ group, reason: 'MATCHING_TRAINING_REQUIRES_EXPLICIT_ID', trainingIds: entry.observed });
        }
        targets.set(group, entry.id);
    }
    const decisions = plan.rows.map(row => {
        const { bvid, association } = row;
        const trainingId = association.trainingId ?? targets.get(association.newTrainingGroup);
        const training = current.trainings.get(trainingId);
        const receipt = ledger.videos[bvid];
        const matches = current.videos.get(bvid) ?? [];
        const match = matches.length === 1 ? matches[0] : null;
        const previouslySeen = receipt.observed;
        recordObserved(receipt, matches.map(video => video.id));
        let reason;
        if (trainingId && (!training || ['hidden', 'deleted'].includes(training.status))) reason = 'TRAINING_UNAVAILABLE';
        else if (training && row.eventDate && training.date !== row.eventDate) reason = 'TRAINING_DATE_DIFFERS_FROM_MANIFEST';
        else if (matches.length > 1) reason = 'MULTIPLE_BVID_MATCHES';
        else if ((receipt.id && match?.id !== receipt.id) || previouslySeen.some(id => id !== match?.id)) reason = 'KNOWN_VIDEO_UNAVAILABLE';
        else if (match && match.status !== 'active') reason = plan.batch ? 'BVID_HIDDEN_OR_DELETED' : 'BVID_HIDDEN';
        else if (plan.batch && match && match.publisherId !== ledger.frozen.binding.userId) reason = 'PUBLISHER_CONFLICT';
        else if (match && match.trainingId !== trainingId) reason = 'BVID_ON_DIFFERENT_TRAINING';
        else if (training && !match && (plan.batch ? training.status !== 'published' : !writable(training.status))) reason = 'TRAINING_READ_ONLY';
        if (reason) blockers.push({ bvid, reason });
        if (match && !reason && !receipt.id) Object.assign(receipt, { state: 'matched', id: match.id });
        return { bvid, trainingId, state: reason ? 'blocked' : receipt.state, reason,
            ...(training ? { trainingTitle: training.title, trainingDate: training.date, trainingStatus: training.status } : {}),
            ...(match ? { videoId: match.id, currentTitle: match.title, currentPosition: match.position, currentTrainingId: match.trainingId, currentVideoStatus: match.status } : {}) };
    });
    return { blockers, decisions };
}

/** @param {{ mode: string, plan: any, api: Function, ledger?: any, save: Function, approval?: string }} options */
export async function runImport({ mode, plan, api, ledger, save, approval }) {
    requireValue(['reconcile', 'apply'].includes(mode) && plan.rows.every(row => !row.blockers.length), 'Resolve all offline blockers before connecting.');
    const binding = await bindAdmin(api);
    const frozen = { schema: 1, origin, binding, plan };
    let digest = await hash(plan.batch ? [frozen, ledger?.mapping ?? null] : frozen);
    if (ledger) {
        requireValue(isDeepStrictEqual(ledger.frozen?.binding, binding), 'Ledger belongs to a different Kapok administrator, account, membership epoch or team.');
        requireValue(ledger.approval === digest && isDeepStrictEqual(ledger.frozen, frozen), 'Ledger plan changed. Use its original immutable inputs.');
        requireValue(isObject(ledger.trainings) && isObject(ledger.videos)
            && plan.newTrainings.every(({ group }) => own(ledger.trainings, group) && validReceipt(ledger.trainings[group]))
            && plan.rows.every(({ bvid }) => own(ledger.videos, bvid) && validReceipt(ledger.videos[bvid])), 'Ledger receipts are invalid.');
    }
    if (mode === 'apply') requireValue(ledger && approval === digest, 'Apply requires the approval hash from the reviewed reconciliation ledger.');
    ledger = ledger ? structuredClone(ledger) : {
        frozen, approval: digest,
        trainings: Object.fromEntries(plan.newTrainings.map(({ group }) => [group, blank()])),
        videos: Object.fromEntries(plan.rows.map(({ bvid }) => [bvid, blank()])),
    };
    const actor = binding.actor;
    async function refresh() {
        const current = await snapshot(api, actor, plan.batch);
        requireValue(isDeepStrictEqual(binding, await currentAdmin(api, actor)), 'Kapok administrator binding changed during reconciliation.');
        const report = reconcile(plan, ledger, current);
        if (plan.batch) {
            const mapping = report.decisions.map(decision => {
                const row = plan.rows.find(row => row.bvid === decision.bvid);
                const trainingReceipt = ledger.trainings[row.association.newTrainingGroup];
                const videoReceipt = ledger.videos[row.bvid];
                const approved = ledger.mapping?.find(item => item.bvid === row.bvid);
                // Own pending operations can only resume via the same key, with server-side mapping guards.
                if (approved && (trainingReceipt.key || videoReceipt.key)) return approved;
                return { bvid: row.bvid, action: decision.videoId ? 'existing' : decision.trainingId ? 'append' : 'create', trainingId: decision.trainingId ?? null, videoId: decision.videoId ?? null };
            });
            if (!isDeepStrictEqual(mapping, ledger.mapping)) {
                if (mode === 'apply') report.blockers.push({ reason: 'APPROVED_MAPPING_CHANGED_REVIEW_AGAIN' });
                else { ledger.mapping = mapping; digest = await hash([frozen, mapping]); ledger.approval = digest; }
            }
        }
        await save(ledger);
        return { approval: digest, mapping: ledger.mapping, ...report };
    }
    let report = await refresh();
    if (mode === 'reconcile' || report.blockers.length) return report;

    async function post(route, key, payload, receipt, validate) {
        requireValue(isDeepStrictEqual(binding, await currentAdmin(api, actor)), 'Kapok administrator binding changed before write.');
        requireValue(receipt.key === null || receipt.key === key, 'Ledger operation key changed. Preserve its original state.');
        Object.assign(receipt, { state: 'pending', key, id: null, replayRequired: true });
        await save(ledger);
        const row = plan.rows.find(row => route === 'trainings/publish' ? row.video.url === payload.video?.url : row.video.url === payload.url);
        const approved = ledger.mapping?.find(item => item.bvid === row?.bvid);
        const precondition = plan.batch ? { ...binding, trainingDate: row.eventDate, trainingId: approved.trainingId } : undefined;
        let data;
        try { ({ data } = await api(route, { actor, key, payload, precondition })); }
        catch (error) {
            if (plan.batch && error?.code === 'IMPORT_MAPPING_REJECTED_NO_COMMIT') {
                // Keep the rejected key as audit evidence; only this receipt is unlocked.
                const rejected = [...(receipt.rejected ?? []), { key, mapping: approved, approval: ledger.approval }];
                Object.assign(receipt, blank(), { replayRequired: false, rejected });
                await save(ledger);
            }
            throw error;
        }
        validate(data);
        Object.assign(receipt, { id: data.id, state: 'confirmed', replayRequired: false });
        await save(ledger);
    }
    for (const { group, payload } of plan.newTrainings) {
        const receipt = ledger.trainings[group];
        const batchRow = plan.batch && plan.rows.find(row => row.association.newTrainingGroup === group);
        if (receipt.id && !(batchRow && receipt.key && (receipt.replayRequired || !ledger.videos[batchRow.bvid].id))) continue;
        if (plan.batch) {
            const row = plan.rows.find(row => row.association.newTrainingGroup === group);
            const key = await operationKey(binding, 'batch-publish', binding.teamId, row.bvid);
            await post('trainings/publish', key, { title: payload.title, date: payload.date, description: '', video: { title: row.video.title, url: row.video.url } }, receipt, data => {
                checkTraining(data.training);
                requireValue(checkVideo(data.video, data.training.id) === row.bvid && data.video.publisherId === binding.userId, 'Unexpected publication receipt.');
                data.id = data.training.id;
                Object.assign(ledger.videos[row.bvid], { state: 'confirmed', id: data.video.id, key });
            });
        } else {
        await post('trainings', await operationKey(binding, 'training', binding.teamId, group), payload, receipt, checkTraining);
        }
        report = await refresh();
        if (report.blockers.length) return report;
    }

    for (const row of plan.rows) {
        const receipt = ledger.videos[row.bvid];
        if (receipt.id) continue;
        const trainingId = row.association.trainingId ?? ledger.trainings[row.association.newTrainingGroup].id;
        const key = await operationKey(binding, 'video-add', trainingId, row.bvid);
        await post('trainings/' + trainingId + '/videos', key, row.video, receipt, data => {
            requireValue(checkVideo(data, trainingId) === row.bvid && data.status === 'active', 'Unexpected Kapok video receipt. Preserve the pending ledger.');
        });
        report = await refresh();
        if (report.blockers.length) return report;
    }
    return report;
}


export function selectBatch(manifest, batch) {
    requireValue(batch === 'initial_batch' && Array.isArray(manifest.initial_batch) && manifest.initial_batch.length === 4 && new Set(manifest.initial_batch).size === 4, 'Select the explicit initial_batch of four.');
    const items = manifest.initial_batch.map(id => {
        const found = manifest.items.filter(item => item.bvid === id);
        requireValue(found.length === 1 && eventDate(found[0].event_date), 'Batch row requires one confirmed date.');
        return found[0];
    });
    return { items };
}
export function prepareBatch(manifest, batch) {
    const selected = selectBatch(manifest, batch);
    const mapping = Object.fromEntries(selected.items.map(item => [item.bvid, { newTraining: { group: item.bvid, date: item.event_date, title: item.event_date + ' 训练', confirmed: true }, videoTitle: item.display_title, position: 0 }]));
    return { ...prepareImport(selected, mapping), batch, manifest: selected };
}
