import { materialDetails, materialIndexDetails, materialPhotoGuard } from './workspace-material-details.ts';
import type { LearningAssociation } from '../contracts/topic-collections';
import type { Me, Principal } from '../contracts/index';
import {
    dailyArticleCategory, isDailyArticle, isDefaultLearningCategory, learningBounds, learningCategories, learningCategoryMax, learningDefaults, learningImageAltMax, normalizeLearningCategory, type LearningDraft, type LearningDraftOverview, type LearningImage,
    type LearningImageReferenceInput,
    type LearningPolicy, type LearningPost, type LearningPostFields, type LearningPostHide, type LearningPostOverview, type LearningPostStatus,
} from '../contracts/learning.ts';
import { parseYouTubeSource } from '../video-source.ts';
import { resolveBilibiliShare } from './bilibili.ts';
import { assertGuard, DomainError, type StoredResult } from './domain.ts';
import { identityTuple } from './identity.ts';
import { createLearningImages } from './learning-images.ts';

type ActiveMember = Me & { user: NonNullable<Me['user']>; membership: NonNullable<Me['membership']> };
export type LearningContext = ActiveMember & { identity: ReturnType<typeof identityTuple> };
export type LearningOp = {
    opId: string;
    replay: { result: StoredResult } | null;
    commit: (statements: D1PreparedStatement[], result: StoredResult) => Promise<{ result: StoredResult; fresh: boolean }>;
};
export type LearningDependencies = {
    db: D1Database; bucket?: R2Bucket; clock: () => Date; learningPolicy?: LearningPolicy;
    activeMember: (p: Principal | null, admin?: boolean) => Promise<ActiveMember>;
    operation: (actor: string, kind: string, target: string, key: string, input: unknown, prepareInput?: () => Promise<unknown>) => Promise<LearningOp>;
};

export const learningMissing = () => new DomainError('NOT_FOUND', '资料不可用或当前无权查看。', 404);
export const learningConflict = () => new DomainError('VERSION_CONFLICT', '资料或权限已变化，请重新加载后重试。', 409);
const locked = () => new DomainError('READ_ONLY', '资料已被管理员隐藏。', 409);
const invalid = () => new DomainError('INVALID_INPUT', '请检查学习资料填写内容。');
type ContentRow = Omit<LearningPostFields, 'video' | 'body'> & { video_source: 'youtube' | 'bilibili' | 'upload' | null; video_url: string | null };
type DraftRow = {
    id: string; kind: LearningPostFields['kind']; category: LearningPostFields['category']; title: string; summary: string;
    status: LearningPostStatus; version: number; collection_target_id: string | null;
    published_version: number | null; updated_at: string; images: string;
};
type PublicRow = ContentRow & {
    id: string; version: number; owner_id: string; disc_name: string; jersey_number: string; published_at: string; images: string;
};
export type LearningReferenceTable = 'learning_draft_images' | 'learning_publication_images';

export function learningObject(input: unknown, fields: string[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw invalid();
    return input as Record<string, unknown>;
}
function field(value: unknown, max: number, required: boolean) {
    if (!required && value === undefined) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw invalid();
    return value;
}
function version(value: unknown) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid();
    return Number(value);
}
function isId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function limits(overrides: LearningPolicy | undefined) {
    const policy: Required<LearningPolicy> = { ...learningDefaults, ...overrides };
    for (const key of Object.keys(learningDefaults) as (keyof LearningPolicy)[]) {
        if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > learningBounds[key]) throw new Error('Invalid learning policy: ' + key);
    }
    return policy;
}
export async function bindLearningMember(activeMember: LearningDependencies['activeMember'], p: Principal | null, admin = false): Promise<LearningContext> {
    if (!p) throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
    const identity = identityTuple(p);
    const member = await activeMember(p, admin);
    return { ...member, identity };
}
export function learningMemberFence(c: LearningContext) {
    return {
        sql: `EXISTS(SELECT 1 FROM memberships lm JOIN users lu ON lu.id=lm.user_id
            JOIN auth_identities lai ON lai.user_id=lm.user_id
            WHERE lm.id=? AND lm.user_id=? AND lm.team_id=? AND lm.epoch=? AND lm.role=?
            AND lm.status='active' AND lu.status='active'
            AND lai.provider=? AND lai.issuer=? AND lai.subject=?)`,
        values: [c.membership.id, c.user.id, c.membership.teamId, c.membership.epoch, c.membership.role, ...c.identity],
    };
}
export function learningMemberGuard(db: D1Database, op: LearningOp, c: LearningContext, phase: 'before' | 'after') {
    const member = learningMemberFence(c);
    return assertGuard(db, op.opId, phase + '-member', member.sql, member.values);
}
export async function commitLearning(op: LearningOp, body: D1PreparedStatement[], id: string) {
    try { return (await op.commit(body, { id })).result.id!; }
    catch (error) {
        if (error instanceof DomainError) throw error;
        throw learningConflict();
    }
}

// All member reads and collection-source guards use aliases lp (post), lpub (publication).
export const learningPostVisible = `lp.status='published' AND EXISTS(
    SELECT 1 FROM memberships lam JOIN users lau ON lau.id=lam.user_id
    WHERE lam.user_id=lp.owner_id AND lam.team_id=lp.team_id AND lam.epoch=lpub.author_epoch
    AND lam.status='active' AND lau.status='active'
)`;
export const learningImageHref = (postId: string, imageId: string, draft: boolean) =>
    `/api/v1/learning/posts/${postId}/images/${imageId}${draft ? '?view=draft' : ''}`;

function imageProjection(table: LearningReferenceTable) {
    return `(SELECT json_group_array(json_object(
        'id',id,'mimeType',mime_type,'bytes',bytes,'width',width,'height',height,'alt',alt,'decorative',decorative
    )) FROM (SELECT li.id,li.mime_type,li.bytes,li.width,li.height,lir.alt,lir.decorative FROM ${table} lir JOIN learning_images li ON li.id=lir.image_id
        WHERE lir.post_id=lp.id AND li.status='ready' ORDER BY lir.position)) AS images`;
}
function videoDto(row: ContentRow): LearningPostFields['video'] {
    return row.video_source && row.video_url ? { source: row.video_source, url: row.video_url } : null;
}
function contentSummary(row: { workspaceDetails?: string } & Omit<ContentRow, 'video_source' | 'video_url'>) {
    return {
        kind: row.kind, category: row.category, title: row.title, summary: row.summary, workspaceDetails: row.workspaceDetails,
    };
}
function images(row: { id: string; images: string }, draft: boolean): LearningImage[] {
    const entries = JSON.parse(row.images) as (Omit<LearningImage, 'href' | 'decorative'> & { decorative: number })[];
    return entries.map(image => ({ ...image, decorative: Boolean(image.decorative), href: learningImageHref(row.id, image.id, draft) }));
}
function draftOverview(row: DraftRow, c: LearningContext): LearningDraftOverview {
    return {
        ...contentSummary(row), id: row.id, status: row.status, version: row.version, images: images(row, true),
        publishedVersion: row.published_version, membershipEpoch: c.membership.epoch, updatedAt: row.updated_at,
    };
}
function publicOverview(row: PublicRow, c: LearningContext): LearningPostOverview {
    return {
        ...contentSummary(row), video: videoDto(row), id: row.id, author: { id: row.owner_id, discName: row.disc_name, jerseyNumber: row.jersey_number },
        isAuthor: c.user.id === row.owner_id, images: images(row, false), publishedVersion: row.version, publishedAt: row.published_at,
    };
}

export function createLearningService(deps: LearningDependencies & {
    attemptLearningInclusion: (p: Principal | null, id: string, publishedVersion: number, key: string) => Promise<void>;
}) {
    const { db, clock, learningPolicy, activeMember, operation } = deps;
    const policy = limits(learningPolicy);
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
    const publicSelect = (detail: boolean) => `SELECT lpub.kind,lpub.category,lpub.title,lpub.summary,lpub.video_source,lpub.video_url,
        ${detail?'lpub.workspace_details':materialIndexDetails('lpub.workspace_details')} AS workspaceDetails,lpub.version,lpub.published_at,${detail ? 'lpub.body,' : ''} lp.id,lp.owner_id,p.disc_name,p.jersey_number,${imageProjection('learning_publication_images')}
        FROM learning_post_publications lpub JOIN learning_posts lp ON lp.id=lpub.post_id JOIN profiles p ON p.user_id=lp.owner_id`;
    const draftSelect = (detail: boolean) => `SELECT lp.id,lp.kind,lp.category,lp.title,lp.summary,${detail?'lp.workspace_details':materialIndexDetails('lp.workspace_details')} AS workspaceDetails,lp.version,lp.updated_at,
        ${detail ? `lp.body,lp.video_source,lp.video_url,lp.collection_target_id,lpub.collection_target_id AS published_target,
            CASE WHEN ${learningPostVisible} THEN (SELECT status FROM topic_learning_associations
                WHERE post_id=lp.id AND published_version=lpub.version) END AS association_status,` : ''}
        CASE WHEN ${learningPostVisible} THEN lpub.version END AS published_version,
        CASE WHEN lp.status='published' AND NOT (${learningPostVisible}) THEN 'withdrawn' ELSE lp.status END AS status,
        ${imageProjection('learning_draft_images')}
        FROM learning_posts lp LEFT JOIN learning_post_publications lpub ON lpub.post_id=lp.id`;

    async function getDraft(c: LearningContext, id: string): Promise<LearningDraft> {
        const member = learningMemberFence(c);
        const row = await q(`${draftSelect(true)} WHERE lp.id=? AND lp.team_id=? AND lp.owner_id=? AND ${member.sql}`,
            id, c.membership.teamId, c.user.id, ...member.values).first<DraftRow & ContentRow & { body: string; published_target: string | null; association_status: LearningAssociation['status'] | null }>();
        if (!row) throw learningMissing();
        return { ...draftOverview(row, c), body: row.body, video: videoDto(row), collectionTargetId: row.collection_target_id,
            association: row.association_status && row.published_target && row.published_version
                ? { status: row.association_status, targetId: row.published_target, publishedVersion: row.published_version } : null };
    }
    async function getLearningPost(p: Principal | null, id: string, view: 'draft'): Promise<LearningDraft>;
    async function getLearningPost(p: Principal | null, id: string, view?: 'published'): Promise<LearningPost>;
    async function getLearningPost(p: Principal | null, id: string, view: 'draft' | 'published' = 'published') {
        const c = await bindLearningMember(activeMember, p);
        if (view === 'draft') return getDraft(c, id);
        const member = learningMemberFence(c);
        const row = await q(`${publicSelect(true)} WHERE lp.id=? AND lp.team_id=? AND ${learningPostVisible} AND ${member.sql}`,
            id, c.membership.teamId, ...member.values).first<PublicRow & { body: string }>();
        if (!row) throw learningMissing();
        return { ...publicOverview(row, c), body: row.body };
    }
    async function listLearningCategoryNames(c: LearningContext): Promise<string[]> {
        const member = learningMemberFence(c);
        const { results } = await q(`SELECT lc.name FROM teams t
            LEFT JOIN learning_categories lc ON lc.team_id=t.id
            WHERE t.id=? AND ${member.sql} ORDER BY lc.name`, c.membership.teamId, ...member.values).all<{ name: string | null }>();
        if (!results.length) throw learningConflict();
        return [...new Set([...learningCategories, ...results.flatMap(({ name }) => name === null ? [] : [name])])];
    }

    async function listLearningCategories(p: Principal | null): Promise<string[]> {
        return listLearningCategoryNames(await bindLearningMember(activeMember, p));
    }

    async function createLearningCategory(p: Principal | null, input: unknown, key: string): Promise<string> {
        const c = await bindLearningMember(activeMember, p);
        const name = normalizeLearningCategory(learningObject(input, ['name']).name);
        if (!name) throw new DomainError('INVALID_INPUT', `分类名称须为 1–${learningCategoryMax} 个字符。`);
        const op = await operation(c.user.id, 'learning-category-create', c.membership.teamId, key, { name });
        if (!op.replay) {
            const write = [learningMemberGuard(db, op, c, 'before')];
            if (!isDefaultLearningCategory(name)) {
                write.push(q('INSERT INTO learning_categories(team_id,name) VALUES(?,?) ON CONFLICT(team_id,name) DO NOTHING',
                    c.membership.teamId, name));
            }
            write.push(learningMemberGuard(db, op, c, 'after'));
            await commitLearning(op, write, name);
        }
        const member = learningMemberFence(c);
        if (!await q(`SELECT 1 WHERE ${member.sql}`, ...member.values).first()) throw learningConflict();
        return name;
    }

    async function listLearningPosts(p: Principal | null): Promise<LearningPostOverview[]> {
        const c = await bindLearningMember(activeMember, p);
        const member = learningMemberFence(c);
        const { results } = await q(`${publicSelect(false)} WHERE lp.team_id=? AND ${learningPostVisible} AND ${member.sql}
            ORDER BY lpub.published_at DESC,lp.id`, c.membership.teamId, ...member.values).all<PublicRow>();
        return results.map(row => publicOverview(row, c));
    }
    async function listMyLearningPosts(p: Principal | null, view?: 'unpublished-drafts'): Promise<LearningDraftOverview[]> {
        const c = await bindLearningMember(activeMember, p);
        const member = learningMemberFence(c);
        const { results } = await q(`${draftSelect(false)} WHERE lp.team_id=? AND lp.owner_id=? AND ${member.sql}
            ${view === 'unpublished-drafts' ? "AND lp.status='draft'" : ''}
            ORDER BY lp.updated_at DESC,lp.id`, c.membership.teamId, c.user.id, ...member.values).all<DraftRow>();
        return results.map(row => draftOverview(row, c));
    }
    async function ownedRow(c: LearningContext, id: string) {
        const member = learningMemberFence(c);
        const row = await q(`SELECT id,kind,category,version,status,body,collection_target_id FROM learning_posts WHERE id=? AND team_id=? AND owner_id=? AND ${member.sql}`,
            id, c.membership.teamId, c.user.id, ...member.values).first<Pick<DraftRow, 'id' | 'kind' | 'category' | 'version' | 'status'> & { body: string; collection_target_id: string | null }>();
        if (!row) throw learningMissing();
        return row;
    }
    const ownedGuard = (op: LearningOp, c: LearningContext, id: string, expectedVersion: number, phase = 'post') =>
        assertGuard(db, op.opId, phase, 'EXISTS(SELECT 1 FROM learning_posts WHERE id=? AND team_id=? AND owner_id=? AND version=?)',
            [id, c.membership.teamId, c.user.id, expectedVersion]);
    const referencesReady = (table: LearningReferenceTable) => `NOT EXISTS(SELECT 1 FROM ${table} lr JOIN learning_images li
        ON li.id=lr.image_id AND li.post_id=lr.post_id WHERE lr.post_id=? AND li.status<>'ready')`;

    function attachments(input: unknown, canAttach: boolean): LearningImageReferenceInput[] | undefined {
        if (input === undefined) return undefined;
        if (!Array.isArray(input) || input.length > policy.maxImages || (!canAttach && input.length)) throw invalid();
        const seen = new Set<string>();
        return input.map(value => {
            const { id, alt, decorative } = learningObject(value, ['id', 'alt', 'decorative']);
            if (!isId(id) || seen.has(id) || typeof alt !== 'string' || alt.length > learningImageAltMax ||
                typeof decorative !== 'boolean' || (decorative && alt.trim())) throw invalid();
            seen.add(id);
            return { id, alt: alt.trim(), decorative };
        });
    }

    async function saveLearningPost(p: Principal | null, id: string | null, input: unknown, key: string): Promise<LearningDraft> {
        const c = await bindLearningMember(activeMember, p);
        const r = learningObject(input, ['kind', 'category', 'title', 'summary', 'body', 'video', 'collectionTargetId', 'images', 'workspaceDetails', ...(id ? ['expectedVersion'] : [])]);
        const kind = r.kind === 'article' || r.kind === 'video' ? r.kind : null;
        const category = normalizeLearningCategory(r.category);
        if (!kind || !category || (r.collectionTargetId != null && !isId(r.collectionTargetId))) throw invalid();
        if (!isDefaultLearningCategory(category)) {
            const member = learningMemberFence(c);
            const known = await q(`SELECT 1 FROM learning_categories WHERE team_id=? AND name=? AND ${member.sql}`,
                c.membership.teamId, category, ...member.values).first();
            if (!known) throw invalid();
        }
        const refs = attachments(r.images, !!id && kind === 'article');
        const expectedVersion = id ? version(r.expectedVersion) : null;
        const title = field(r.title, policy.maxTitle, true).trim();
        const summary = field(r.summary, policy.maxSummary, false);
        const body = field(r.body, policy.maxBody, false);
        let video: LearningPostFields['video'] = null;
        if (kind === 'article' && r.video != null) throw invalid();
        if (kind === 'video') {
            const v = learningObject(r.video, ['source', 'url']);
            if ((v.source !== 'bilibili' && v.source !== 'youtube' && v.source !== 'upload') || typeof v.url !== 'string' || !v.url.trim() || v.url.length > 2000) throw invalid();
            video = { source: v.source, url: v.url };
            if (video.source === 'upload' && (!id || !/^\/api\/v1\/material-assets\/[a-f0-9-]{36}$/.test(video.url))) throw invalid();
            if (video.source === 'youtube') {
                const parsed = parseYouTubeSource(video.url);
                if (!parsed) throw invalid();
                video.url = parsed.url;
            }
        }
        const details = materialDetails(r.workspaceDetails);
        const normalized = { ...(details === undefined ? {} : { workspaceDetails: details }), kind, category, title, summary, body, video, images: refs, collectionTargetId: r.collectionTargetId, expectedVersion };
        if (id) await ownedRow(c, id);
        const op = await operation(c.user.id, 'learning-save', id ?? 'new', key, normalized, video?.source === 'bilibili'
            ? async () => {
                video = { source: 'bilibili', url: await resolveBilibiliShare(video!.url) };
                return { ...normalized, video };
            } : undefined);
        if (op.replay) return getDraft(c, op.replay.result.id!);

        const target = id ?? crypto.randomUUID();
        const at = clock().toISOString();
        const write: D1PreparedStatement[] = [learningMemberGuard(db, op, c, 'before')];
        if (id && expectedVersion !== null) {
            write.push(ownedGuard(op, c, id, expectedVersion));
            if (refs?.length) {
                const ids = refs.map(image => image.id);
                const member = learningMemberFence(c);
                const ready = await q(`SELECT COUNT(*) AS count FROM learning_images WHERE post_id=? AND status='ready'
                    AND id IN (${ids.map(() => '?').join(',')}) AND ${member.sql}`, id, ...ids, ...member.values).first<number>('count');
                if (ready !== ids.length) throw new DomainError('INVALID_IMAGE', '有图片未完成上传或已移除。', 409);
            }
            write.push(q(`UPDATE learning_posts SET kind=?,category=?,title=?,summary=?,body=?,video_source=?,video_url=?,
                collection_target_id=CASE WHEN ? THEN ? ELSE collection_target_id END,version=version+1,updated_at=? WHERE id=?`,
                kind, category, title, summary, body, video?.source ?? null, video?.url ?? null, Number(r.collectionTargetId !== undefined),
                r.collectionTargetId ?? null, at, id));
            if (refs !== undefined || kind === 'video') {
                write.push(q('DELETE FROM learning_draft_images WHERE post_id=?', id));
                for (const [position, image] of (refs ?? []).entries()) {
                    write.push(q('INSERT INTO learning_draft_images(post_id,image_id,position,alt,decorative) VALUES(?,?,?,?,?)',
                        id, image.id, position, image.alt, Number(image.decorative)));
                }
            }
            write.push(assertGuard(db, op.opId, 'images', referencesReady('learning_draft_images'), [id]));
        } else {
            write.push(q(`INSERT INTO learning_posts(id,team_id,owner_id,kind,category,title,summary,body,video_source,video_url,
                collection_target_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                target, c.membership.teamId, c.user.id, kind, category, title, summary, body, video?.source ?? null,
                video?.url ?? null, r.collectionTargetId ?? null, at, at));
        }
        write.push(...materialPhotoGuard(db,op.opId,'post',target,c.membership.teamId,details));
        if (video?.source==='upload') write.push(assertGuard(db,op.opId,'workspace-clip',
            "EXISTS(SELECT 1 FROM material_assets WHERE id=? AND parent_kind='post' AND parent_id=? AND team_id=? AND ready=1 AND mime LIKE 'video/%')",
            [video.url.split('/').at(-1),target,c.membership.teamId]));
        if (details !== undefined) write.push(q('UPDATE learning_posts SET workspace_details=? WHERE id=?', details, target));
        write.push(ownedGuard(op, c, target, (expectedVersion ?? 0) + 1, 'post-written'), learningMemberGuard(db, op, c, 'after'));
        return getDraft(c, await commitLearning(op, write, target));
    }

    async function changePublication(p: Principal | null, id: string, input: unknown, key: string, action: 'publish' | 'withdraw') {
        const c = await bindLearningMember(activeMember, p);
        const r = learningObject(input, ['expectedVersion', 'expectedMembershipEpoch', ...(action === 'publish' ? ['shareToActivity'] : [])]);
        if (r.shareToActivity !== undefined && r.shareToActivity !== true) throw invalid();
        const expected = version(r.expectedVersion);
        const expectedMembershipEpoch = version(r.expectedMembershipEpoch);
        const current = await ownedRow(c, id);
        if (expectedMembershipEpoch !== c.membership.epoch) throw learningConflict();
        if (current.status === 'hidden') throw locked();
        const op = await operation(c.user.id, 'learning-' + action, id, key, { expectedVersion: expected, expectedMembershipEpoch,
            ...(r.shareToActivity && { shareToActivity: true }) });
        const status = action === 'publish' ? 'published' : 'withdrawn';
        const finalVersion = expected + 1;
        if (!op.replay) {
            if (current.version !== expected) throw learningConflict();
            if (action === 'withdraw' && current.status !== 'published') throw learningMissing();
            const at = clock().toISOString();
            const write: D1PreparedStatement[] = [
                learningMemberGuard(db, op, c, 'before'),
                assertGuard(db, op.opId, 'post', `EXISTS(SELECT 1 FROM learning_posts WHERE id=? AND team_id=? AND owner_id=? AND version=?
                    AND status ${action === 'publish' ? "<>'hidden'" : "='published'"})`, [id, c.membership.teamId, c.user.id, expected]),
            ];
            if (action === 'withdraw') write.push(q(`UPDATE learning_activity_events SET revoked_at=?
                WHERE post_id=? AND revoked_at IS NULL AND author_epoch=(SELECT author_epoch FROM learning_post_publications WHERE post_id=?)`,
                at, id, id));
            const daily = action === 'publish' && isDailyArticle(current);
            const target = action === 'publish' && !daily ? current.collection_target_id : null;
            if (r.shareToActivity) {
                if (!daily) throw invalid();
                // Decide from the previous publication before replacing it. Editing a daily post leaves
                // its existing share or manual withdrawal intact, even if the draft was reopened.
                write.push(q(`INSERT INTO learning_activity_events(id,post_id,author_epoch,shared_at)
                    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM learning_post_publications
                        WHERE post_id=? AND kind='article' AND category=? AND author_epoch=? AND ?<>'withdrawn')
                    AND NOT EXISTS (SELECT 1 FROM learning_activity_events
                        WHERE post_id=? AND author_epoch=? AND revoked_at IS NULL)`, crypto.randomUUID(), id, c.membership.epoch, at,
                    id, dailyArticleCategory, c.membership.epoch, current.status, id, c.membership.epoch));
            }
            if (action === 'publish') {
                if (current.kind === 'article' && !current.body.trim() && !await q('SELECT 1 FROM learning_draft_images WHERE post_id=? LIMIT 1',id).first()) throw new DomainError('INVALID_INPUT', '发布图文前请填写正文。');
                const member = learningMemberFence(c);
                if (await q(`SELECT 1 FROM learning_draft_images WHERE post_id=? AND decorative=0 AND alt='' AND ${member.sql} LIMIT 1`,
                    id, ...member.values).first()) {
                    throw new DomainError('INVALID_INPUT', '发布前请为图片填写替代文字，或标记为装饰图片。');
                }
                write.push(
                    assertGuard(db, op.opId, 'images', referencesReady('learning_draft_images'), [id]),
                    q(`INSERT INTO learning_post_publications(post_id,kind,category,title,summary,body,video_source,video_url,version,author_epoch,collection_target_id,published_at,workspace_details)
                        SELECT id,kind,category,title,summary,body,video_source,video_url,?,?,?,?,workspace_details FROM learning_posts WHERE id=?
                        ON CONFLICT(post_id) DO UPDATE SET kind=excluded.kind,category=excluded.category,title=excluded.title,
                            summary=excluded.summary,body=excluded.body,video_source=excluded.video_source,video_url=excluded.video_url,
                            version=excluded.version,workspace_details=excluded.workspace_details,author_epoch=excluded.author_epoch,collection_target_id=excluded.collection_target_id,published_at=excluded.published_at`, finalVersion, c.membership.epoch, target, at, id),
                    q('DELETE FROM learning_publication_images WHERE post_id=?', id),
                    q(`INSERT INTO learning_publication_images(post_id,image_id,position,alt,decorative)
                        SELECT post_id,image_id,position,alt,decorative FROM learning_draft_images WHERE post_id=?`, id),
                    assertGuard(db, op.opId, 'published-images', referencesReady('learning_publication_images'), [id]),

                );
            }
            if (target) write.push(q("INSERT INTO topic_learning_associations(post_id,published_version,status) VALUES(?,?,'pending')", id, finalVersion));
            write.push(
                q('UPDATE learning_posts SET status=?,version=?,updated_at=?,collection_target_id=CASE WHEN ? THEN NULL ELSE collection_target_id END WHERE id=?', status, finalVersion, at, Number(daily), id),
                ...(target ? [assertGuard(db, op.opId, 'association', `EXISTS(SELECT 1 FROM topic_learning_associations ta
                    JOIN learning_post_publications lpub ON lpub.post_id=ta.post_id AND lpub.version=ta.published_version
                    WHERE ta.post_id=? AND ta.published_version=? AND ta.status='pending' AND lpub.collection_target_id=?)`, [id, finalVersion, target])] : []),
                assertGuard(db, op.opId, 'post-written', 'EXISTS(SELECT 1 FROM learning_posts WHERE id=? AND version=? AND status=?)', [id, finalVersion, status]),
                learningMemberGuard(db, op, c, 'after'),
            );
            let fresh;
            try { fresh = (await op.commit(write, { id })).fresh; }
            catch (error) {
                if (error instanceof DomainError) throw error;
                throw learningConflict();
            }
            if (target && fresh) await deps.attemptLearningInclusion(p, id, finalVersion, key);
        }
        const after = await getDraft(c, id);
        if (after.version < finalVersion || after.status !== status || (action === 'publish' && after.publishedVersion !== finalVersion)) throw learningConflict();
        if (action === 'withdraw' && after.version !== finalVersion) throw learningConflict();
        return after;
    }
    const publishLearningPost = (p: Principal | null, id: string, input: unknown, key: string) => changePublication(p, id, input, key, 'publish');
    const withdrawLearningPost = (p: Principal | null, id: string, input: unknown, key: string) => changePublication(p, id, input, key, 'withdraw');

    async function hideLearningPost(p: Principal | null, id: string, input: unknown, key: string): Promise<LearningPostHide> {
        const c = await bindLearningMember(activeMember, p, true);
        const expected = version(learningObject(input, ['expectedVersion']).expectedVersion);
        const op = await operation(c.user.id, 'learning-hide', id, key, { expectedVersion: expected });
        const member = learningMemberFence(c);
        const hideRows = `FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
            WHERE lp.id=? AND lp.team_id=? AND ${learningPostVisible}`;
        const args = [id, c.membership.teamId];
        if (!op.replay) {
            const published = await q(`SELECT lpub.version ${hideRows} AND ${member.sql}`, ...args, ...member.values).first<number>('version');
            if (published === null) throw learningMissing();
            if (published !== expected) throw learningConflict();
            const at = clock().toISOString();
            await commitLearning(op, [
                learningMemberGuard(db, op, c, 'before'),
                assertGuard(db, op.opId, 'snapshot', `EXISTS(SELECT 1 ${hideRows} AND lpub.version=?)`, [...args, expected]),
                q("UPDATE learning_posts SET status='hidden',version=version+1,updated_at=? WHERE id=?", at, id),
                q(`UPDATE learning_activity_events SET revoked_at=? WHERE post_id=? AND revoked_at IS NULL
                    AND author_epoch=(SELECT author_epoch FROM learning_post_publications WHERE post_id=?)`, at, id, id),
                assertGuard(db, op.opId, 'post-written', "EXISTS(SELECT 1 FROM learning_posts WHERE id=? AND status='hidden')", [id]),
                learningMemberGuard(db, op, c, 'after'),
            ], id);
        }
        const hidden = await q(`SELECT id FROM learning_posts WHERE id=? AND team_id=? AND status='hidden' AND ${member.sql}`,
            ...args, ...member.values).first();
        if (!hidden) throw learningMissing();
        return { id, status: 'hidden' };
    }

    return {
        listLearningCategories, createLearningCategory, getLearningPost, listLearningPosts, listMyLearningPosts, saveLearningPost, publishLearningPost, withdrawLearningPost, hideLearningPost,
        ...createLearningImages(deps, policy),
    };
}
