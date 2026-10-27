export type ReflectionLink = {
    title: string;
    href: string;
} | null;
export type ReflectionReader = {
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
};
export type Reflection = ReflectionReader | ReflectionAuthor;
export type ActivityItem = {
    id: string;
    kind: 'reflection' | 'video' | 'announcement';
    title: string;
    href: string;
    publishedAt: string;
    updatedAt: string;
};
export type ActivityPage = {
    items: ActivityItem[];
    nextCursor: string | null;
};
export type PublicMember = {
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
