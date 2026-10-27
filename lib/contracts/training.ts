export type Training = {
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
    source: 'bilibili' | 'upload';
    url: string | null;
    position: number;
    status: string;
    version: number;
    durationSec: number | null;
};
export type Comment = {
    id: string;
    videoId: string;
    rootId: string | null;
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
    sourceKind: 'video' | 'comment' | 'reflection';
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
    trainingId: string | null;
    videoId: string | null;
};
