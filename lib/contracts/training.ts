import type { LearningSourceKind, LearningSourceRef } from './reflections';

export type Training = {
    coverVideoId?: string | null;
    id: string;
    title: string;
    date: string;
    description: string;
    status: string;
    version: number;
    updatedAt: string;
};
export type Video = {
    id: string;
    trainingId: string;
    title: string;
    source: 'bilibili' | 'youtube' | 'upload';
    url: string | null;
    position: number;
    status: string;
    version: number;
    durationSec: number | null;
    publisherId: string | null;
    publisherName: string | null;
};
export type TrainingPublication = {
    training: Training;
    video: Video | null;
};
export type Comment = {
    id: string;
    videoId: string;
    rootId: string | null;
    replyToId: string | null;
    authorId: string;
    authorName: string;
    authorJerseyNumber: string;
    replyTargetName: string | null;
    text: string | null;
    timestampSec: number | null;
    status: string;
    version: number;
    edited: boolean;
    createdAt: string;
};
export type Collection = {
    id: string;
    sourceKind: 'training' | 'video' | 'comment' | 'reflection' | LearningSourceKind;
    sourceId: string;
    timestampSec: number | null;
    privateNote: string;
    version: number;
    createdAt: string;
    source: {
        title: string;
        href: string;
        text?: string;
    } | null;
};

export type CollectionReflectionSeed = {
    text: string;
    sourceRef?: LearningSourceRef | null;
    trainingId: string | null;
    videoId: string | null;
};
