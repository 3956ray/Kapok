import type { LearningAuthor, LearningCategory, LearningImage, LearningVersion } from './learning';

export const topicDefaults = { maxTitle: 120, maxSummary: 240, maxBatch: 10, maxItems: 100, maxFeatured: 3 } as const;
export type TopicPolicy = { maxFeatured?: number };
export type TopicReference = { kind: 'post' | 'video'; id: string };
export type TopicSource = TopicReference & {
    title: string;
    author: LearningAuthor | null;
    category: LearningCategory | null;
    mediaKind: 'article' | 'video';
    trainingId: string | null;
    summary: string;
    cover: LearningImage | null;
};
export type TopicInput = { title: string; summary?: string };
export type TopicCollection = TopicInput & {
    id: string; summary: string; author: LearningAuthor; isAuthor: boolean;
    publishedVersion: number; publishedAt: string; items: TopicSource[];
};
export type TopicDraft = TopicInput & {
    id: string; summary: string; status: 'draft' | 'published' | 'withdrawn'; items: TopicSource[];
    version: number; publishedVersion: number | null; membershipEpoch: number; updatedAt: string;
};
export type TopicChoice = Pick<TopicDraft, 'id' | 'title' | 'status'>;
export type TopicItemsInput = LearningVersion & { items: TopicReference[] };
export type TopicItemInput = LearningVersion & { item: TopicReference };
export type TopicAddOutcome = TopicReference & { status: 'added' | 'duplicate' | 'unavailable' | 'limit' };
export type TopicAddResult = { collection: TopicDraft; outcomes: TopicAddOutcome[] };
export type FeaturedTopics = { collections: TopicCollection[] };
export type FeaturedTopicAdmin = FeaturedTopics & { version: number; maxFeatured: number };
export type FeaturedTopicInput = LearningVersion & { collectionIds: string[] };

export type LearningAssociation = {
    targetId: string;
    publishedVersion: number;
    status: 'pending' | 'added-draft' | 'added-published';
};
export type LearningInclusionInput = { expectedPublishedVersion: number };
