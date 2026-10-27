import type { ReflectionAuthor } from '../contracts/reflections';
export type CloudRevision = Pick<ReflectionAuthor, 'id' | 'version' | 'sharingVersion' | 'generation'>;
export type DraftBody = {
    title: string;
    text: string;
    date: string;
    trainingId: string | null;
    videoId: string | null;
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
    const saved = draft.title === cloud.title && draft.text === cloud.text && draft.date === cloud.date && (draft.trainingId || null) === cloud.trainingId && (draft.videoId || null) === cloud.videoId;
    return {
        saved,
        draft: {
            ...draft,
            pending: null,
            cloud: revision(cloud)
        }
    };
}
