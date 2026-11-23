import type { LearningComment } from './learning-social';
import type { LearningImage, LearningPostFields, LearningPostStatus, LearningVideo } from './learning';
import type { TopicDraft, TopicReference } from './topic-collections';
import type { Me } from './index';
import type { Collection } from './training';
import type { LearningSourceKind, ReflectionAuthor } from './reflections';

export type DeletedReflection = ReflectionAuthor & {
    deletedAt: string;
    recoverUntil: string;
};
export type ManagedMember = NonNullable<Me['membership']> & {
    canSignIn?: boolean;
    userId: string;
    discName: string;
    jerseyNumber: string;
};
export type PersonalExport = {
    format: 'kapok-personal-v1';
    generatedAt: string;
    profile: { discName: string; jerseyNumber: string; bio?: string; avatar?: string };
    reflections: {
        category: string | null;
        id: string;
        title: string;
        text: string;
        date: string;
        trainingId: string | null;
        videoId: string | null;
        sourceKind: LearningSourceKind | null;
        sourceId: string | null;
        sourceAvailable: boolean;
        deletedAt: string | null;
        createdAt: string;
        updatedAt: string;
    }[];
    collections: {
        id: string;
        sourceKind: Collection['sourceKind'];
        sourceId: string;
        timestampSec: number | null;
        privateNote: string;
        sourceAvailable: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
    comments: {
        id: string;
        videoId: string;
        rootId: string | null;
        text: string | null;
        timestampSec: number | null;
        referenceTimes?:number[];
        status: string;
        sourceAvailable: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
    learningComments: (Pick<LearningComment, 'id' | 'postId' | 'rootId' | 'replyToId' | 'text' | 'timestampSec' | 'status' | 'createdAt'> & {
        sourceAvailable: boolean; updatedAt: string; referenceTimes?:number[];
    })[];
    learningActivity: { id: string; postId: string; sharedAt: string; revokedAt: string | null; active: boolean }[];
    learningPosts: ExportedLearningPost[];
    topicCollections: ExportedTopicCollection[];
    learningImages: ExportedLearningImage[];
    trainings: {id:string; title:string; date:string; description:string; status:string}[];
    materialAssets: {id:string; parentKind:'training'|'post'; parentId:string; mimeType:string; bytes:number; createdAt:string}[];
    trainingDiscussions: {id:string; trainingId:string; rootId:string|null; replyToId:string|null; text:string|null; status:string; createdAt:string}[];
};

export type ExportedImageReference = { id: string; position: number; alt: string; decorative: boolean };
export type ExportedLearningContent = Omit<LearningPostFields, 'video'> & {
    version: number; video: LearningVideo | null; collectionTargetId: string | null; images: ExportedImageReference[];
    workspaceDetails: {date?:string;photos?:{id:string;alt:string}[];chapters?:Record<string,{at:number;title:string}[]>};
};
export type ExportedLearningPost = {
    id: string; status: LearningPostStatus; createdAt: string; updatedAt: string;
    draft: ExportedLearningContent;
    publication: (ExportedLearningContent & { publishedAt: string; available: boolean }) | null;
};
export type ExportedTopicRevision = {
    title: string; summary: string; category: string; version: number; coverVersion?: number;
    items: (TopicReference & { position: number; sourceAvailable: boolean })[];
};
export type ExportedTopicCollection = {
    id: string; status: TopicDraft['status']; createdAt: string; updatedAt: string;
    draft: ExportedTopicRevision;
    publication: (ExportedTopicRevision & { publishedAt: string; available: boolean }) | null;
};
export type ExportedLearningImage = Pick<LearningImage, 'id' | 'mimeType' | 'bytes' | 'width' | 'height'> & {
    postId: string; createdAt: string;
};
