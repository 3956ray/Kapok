import type { LearningAssociation } from './topic-collections';

export const learningCategories = ['战术', '基本功', '基本概念'] as const;
export const learningImageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const learningDefaults = {
    maxTitle: 120, maxSummary: 240, maxBody: 10000, maxImages: 6, maxImageBytes: 2 * 1024 * 1024,
} as const;
export type LearningPolicy = Partial<Record<keyof typeof learningDefaults, number>>;

// Safe service bounds also cap JSON request memory and D1 batch size.
export const learningBounds = {
    maxTitle: 500, maxSummary: 1000, maxBody: 20000, maxImages: 12, maxImageBytes: 8 * 1024 * 1024,
} as const;
export const learningJsonBytes = 160000;
export const learningImageAltMax = 240;
export const learningImageDimensions = { maxEdge: 8192, maxPixels: 16_777_216 } as const;

export type LearningCategory = typeof learningCategories[number];
export type LearningImageType = typeof learningImageTypes[number];
export type LearningPostKind = 'article' | 'video';
export type LearningPostStatus = 'draft' | 'published' | 'withdrawn' | 'hidden';
export type LearningVideo = { source: 'youtube' | 'bilibili'; url: string };
export type LearningAuthor = { id: string; discName: string; jerseyNumber: string };
export type LearningImage = {
    id: string; mimeType: LearningImageType; width: number; height: number; bytes: number; href: string; alt: string; decorative: boolean;
};
export type LearningPostFields = {
    kind: LearningPostKind; category: LearningCategory; title: string; summary: string; body: string; video: LearningVideo | null;
};
export type LearningImageReferenceInput = Pick<LearningImage, 'id' | 'alt' | 'decorative'>;
export type LearningPostInput = Pick<LearningPostFields, 'kind' | 'category' | 'title'> & {
    summary?: string; body?: string; video?: LearningVideo | null; images?: LearningImageReferenceInput[]; collectionTargetId?: string | null;
};
export type LearningVersion = { expectedVersion: number };
export type LearningPublicationVersion = LearningVersion & { expectedMembershipEpoch: number };
export type LearningPostOverview = Omit<LearningPostFields, 'body'> & {
    id: string; author: LearningAuthor; isAuthor: boolean; images: LearningImage[]; publishedVersion: number; publishedAt: string;
};
export type LearningPost = LearningPostOverview & Pick<LearningPostFields, 'body'>;
export type LearningDraft = LearningPostFields & {
    id: string; status: LearningPostStatus; version: number; membershipEpoch: number; images: LearningImage[];
    collectionTargetId: string | null; association: LearningAssociation | null; publishedVersion: number | null; updatedAt: string;
};
export type LearningDraftOverview = Omit<LearningDraft, 'body' | 'video' | 'collectionTargetId' | 'association'>;
export type LearningImageReservation = { id: string; status: 'reserved' | 'uploaded' | 'ready' };
export type LearningImageUpload = { id: string; status: 'uploaded' | 'ready' };
export type LearningImageRemoval = { id: string; status: 'removed' };
export type LearningPostHide = { id: string; status: 'hidden' };
