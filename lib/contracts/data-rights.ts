import type { Me } from './index';
import type { ReflectionAuthor } from './reflections';

export type DeletedReflection = ReflectionAuthor & {
    deletedAt: string;
    recoverUntil: string;
};
export type ManagedMember = NonNullable<Me['membership']> & {
    userId: string;
    discName: string;
    jerseyNumber: string;
};
export type PersonalExport = {
    format: 'kapok-personal-v1';
    generatedAt: string;
    profile: { discName: string; jerseyNumber: string };
    reflections: {
        id: string;
        title: string;
        text: string;
        date: string;
        trainingId: string | null;
        videoId: string | null;
        sourceAvailable: boolean;
        deletedAt: string | null;
        createdAt: string;
        updatedAt: string;
    }[];
    collections: {
        id: string;
        sourceKind: string;
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
        status: string;
        sourceAvailable: boolean;
        createdAt: string;
        updatedAt: string;
    }[];
};
