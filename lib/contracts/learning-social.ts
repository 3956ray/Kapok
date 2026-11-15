import type { LearningPost } from './learning';

export const learningCommentTextLimit = 2000;
export const learningCommentReasonLimit = 500;

export type LearningCommentStatus = 'active' | 'hidden' | 'deleted';
export type LearningCommentAction = 'hide' | 'restore' | 'report';

export type LearningComment = {
    id: string;
    postId: string;
    rootId: string | null;
    replyToId: string | null;
    author: LearningPost['author'];
    replyTarget: { id: string; authorName: string } | null;
    text: string | null;
    timestampSec: number | null;
    mediaUrl: string | null;
    matchesCurrentMedia: boolean;
    status: LearningCommentStatus;
    version: number;
    edited: boolean;
    createdAt: string;
};

export type LearningCommentInput = {
    text: string;
    rootId?: string;
    replyToId?: string;
    timestampSec?: number;
    mediaUrl?: string;
};
export type LearningCommentEditInput = {
    text: string;
    timestampSec?: number;
    mediaUrl?: string;
    expectedVersion: number;
} | { action: 'delete'; expectedVersion: number };
export type LearningCommentModerationInput = {
    action: LearningCommentAction;
    reason: string;
    expectedVersion: number;
};

export type LearningActivityStatus = {
    publishedVersion: number;
    lastEventId: string | null;
    event: { id: string; sharedAt: string } | null;
};

export type LearningActivityInput = {
    expectedPublishedVersion: number;
    expectedMembershipEpoch: number;
    expectedEventId: string | null;
};
