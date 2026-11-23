export type LearningSourceKind = 'learning_post' | 'topic_collection';
export type LearningSourceRef = { kind: LearningSourceKind; id: string };

export function isLearningSourceKind(value: unknown): value is LearningSourceKind {
    return value === 'learning_post' || value === 'topic_collection';
}
export function isLearningSourceId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
export function isLearningSourceRef(value: unknown): value is LearningSourceRef {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return false;
    const ref = value as Partial<LearningSourceRef>;
    return Object.hasOwn(ref, 'kind') && Object.hasOwn(ref, 'id') && isLearningSourceKind(ref.kind) && isLearningSourceId(ref.id);
}
export function learningReflectionHref(kind: LearningSourceKind, id: string) {
    return '/reflections/new?' + new URLSearchParams({ sourceKind: kind, sourceId: id }).toString();
}
export type ReflectionLink = {
    title: string;
    href: string;
} | null;
export type ReflectionReader = {
    category?: string;
    id: string;
    title: string;
    text: string;
    date: string;
    updatedAt: string;
    author: {
        id: string;
        discName: string;
        jerseyNumber: string;
    };
    isAuthor: boolean;
    link: ReflectionLink;
};
export type ReflectionAuthor = ReflectionReader & {
    isAuthor: true;
    version: number;
    sharingVersion: number;
    generation: number;
    scope: 'private' | 'team';
    published: boolean;
    trainingId: string | null;
    videoId: string | null;
    sourceRef?: LearningSourceRef | null;
};
export type Reflection = ReflectionReader | ReflectionAuthor;
export type ActivityItem = {
    id: string;
    title: string;
    href: string;
    publishedAt: string;
    updatedAt: string;
} & (
    | { kind: 'video'; publisherId: string | null; publisherName: string | null }
    | { kind: 'reflection' | 'announcement' }
    | { kind: 'learning' }
);
export type ActivityPage = {
    items: ActivityItem[];
    nextCursor: string | null;
};
export type PublicMember = {
    avatarDigest?: string;
    position?: string;
    bio?: string;
    id: string;
    discName: string;
    jerseyNumber: string;
    role: string;
};
export type PublicProfile = PublicMember & {
    reflections: {
        id: string;
        title: string;
        date: string;
    }[];
};
export type Announcement = {
    id: string;
    title: string;
    text: string;
    status: 'draft' | 'published' | 'deleted';
    version: number;
    publishedAt: string | null;
    updatedAt: string;
};
