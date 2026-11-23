import { isLearningSourceId, isLearningSourceKind, isLearningSourceRef, learningReflectionHref } from '../contracts/reflections.ts';
import { draftPrefix } from './session-guard.ts';
import type { LearningSourceRef, ReflectionAuthor } from '../contracts/reflections';
export type CloudRevision = Pick<ReflectionAuthor, 'id' | 'version' | 'sharingVersion' | 'generation'>;
export type DraftBody = {
    title: string;
    text: string;
    date: string;
    trainingId: string | null;
    videoId: string | null;
    sourceRef?: LearningSourceRef | null;
    expectedVersion?: number;
    expectedSharingVersion?: number;
    expectedGeneration?: number;
};
export type Draft = {
    schema: 1;
    title: string;
    text: string;
    date: string;
    trainingId: string;
    videoId: string;
    sourceRef?: LearningSourceRef | null;
    updatedAt: string;
    cloud: CloudRevision | null;
    pending: {
        key: string;
        targetId: string | null;
        body: DraftBody;
    } | null;
};
export function revision(cloud: CloudRevision): CloudRevision {
    return {
        id: cloud.id,
        version: cloud.version,
        sharingVersion: cloud.sharingVersion,
        generation: cloud.generation
    };
}
// Persist this result BEFORE sending: a reload must replay the identical immutable request.
export function prepareDraftRequest(draft: Draft, key: string): Draft & {
    pending: NonNullable<Draft['pending']>;
} {
    if (draft.pending) return {
        ...draft,
        pending: draft.pending
    };
    return {
        ...draft,
        pending: {
            key,
            targetId: draft.cloud?.id ?? null,
            body: {
                title: draft.title,
                text: draft.text,
                date: draft.date,
                trainingId: draft.trainingId || null,
                videoId: draft.videoId || null,
                ...(draft.sourceRef !== undefined ? { sourceRef: draft.sourceRef ? { ...draft.sourceRef } : null } : {}),
                ...(draft.cloud ? {
                    expectedVersion: draft.cloud.version,
                    expectedSharingVersion: draft.cloud.sharingVersion,
                    expectedGeneration: draft.cloud.generation
                } : {})
            }
        }
    };
}
export function reconcileDraft(draft: Draft, cloud: CloudRevision & DraftBody) {
    const saved = draft.title === cloud.title && draft.text === cloud.text && draft.date === cloud.date && (draft.trainingId || null) === cloud.trainingId && (draft.videoId || null) === cloud.videoId &&
        (draft.sourceRef?.kind ?? null) === (cloud.sourceRef?.kind ?? null) &&
        (draft.sourceRef?.id ?? null) === (cloud.sourceRef?.id ?? null);
    return {
        saved,
        draft: {
            ...draft,
            pending: null,
            cloud: revision(cloud)
        }
    };
}

export function readLocalDraft(storageKey: string, storage: Storage = localStorage): Draft | null {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const local = JSON.parse(raw) as Draft;
    const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    const validFields = (value: { title?: unknown; text?: unknown; date?: unknown } | null) => value &&
        typeof value.title === 'string' && value.title.length <= 60 && typeof value.text === 'string' && value.text.length <= 5000 &&
        typeof value.date === 'string' && (value.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.date));
    const validSource = (value: Pick<Draft, 'sourceRef'> & { trainingId?: string | null; videoId?: string | null }) =>
        value.sourceRef === undefined || value.sourceRef === null || (isLearningSourceRef(value.sourceRef) && !value.trainingId && !value.videoId);
    const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
    if (!local || local.schema !== 1 || !validFields(local) || typeof local.updatedAt !== 'string' || !validSource(local) ||
        !(local.trainingId === '' || validId(local.trainingId)) || !(local.videoId === '' || validId(local.videoId))) return null;
    if (local.cloud !== null && (!local.cloud || !validId(local.cloud.id) || !validVersion(local.cloud.version) ||
        !validVersion(local.cloud.sharingVersion) || !validVersion(local.cloud.generation))) return null;
    if (local.pending !== null) {
        const pending = local.pending;
        if (!pending || typeof pending.key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pending.key) ||
            pending.targetId !== (local.cloud?.id ?? null) || !validFields(pending.body) || !validSource(pending.body) ||
            !(pending.body.trainingId === null || validId(pending.body.trainingId)) || !(pending.body.videoId === null || validId(pending.body.videoId))) return null;
        if (local.cloud && (pending.body.expectedVersion !== local.cloud.version || pending.body.expectedSharingVersion !== local.cloud.sharingVersion || pending.body.expectedGeneration !== local.cloud.generation)) return null;
    }
    return local;
}

export function listDeviceDrafts(storage: Storage, actorId: string) {
    const prefix = draftPrefix + encodeURIComponent(actorId) + ':';
    const found: { href: string; title: string; updatedAt: string; pending: boolean }[] = [];
    for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        try {
            const id = decodeURIComponent(key.slice(prefix.length));
            const [kind, sourceId, extra] = id.split(':');
            let href: string;
            if (id === 'new') href = '/reflections/new';
            else if (extra === undefined && isLearningSourceId(sourceId) && kind === 'collection')
                href = '/reflections/new?collection=' + encodeURIComponent(sourceId);
            else if (extra === undefined && isLearningSourceId(sourceId) && isLearningSourceKind(kind))
                href = learningReflectionHref(kind, sourceId);
            else if (isLearningSourceId(id) && id !== 'bloom-notes') href = '/reflections/' + id + '/edit';
            else continue;
            const draft = readLocalDraft(key, storage);
            if (!draft || !(draft.text.trim() || draft.title.trim() || draft.pending)) continue;
            found.push({ href, title: draft.title || '未命名复盘', updatedAt: draft.updatedAt, pending: Boolean(draft.pending) });
        } catch { /* A malformed record must not hide other recoverable drafts. */ }
    }
    return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
