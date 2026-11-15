import type { Principal } from '../contracts/index';
import type { LearningImage, LearningImageRemoval, LearningImageReservation, LearningImageType, LearningImageUpload, LearningPolicy } from '../contracts/learning';
import { assertGuard, DomainError } from './domain.ts';
import {
    bindLearningMember, commitLearning, learningConflict, learningImageHref, learningMemberFence, learningMemberGuard, learningMissing,
    learningObject, learningPostVisible, type LearningContext, type LearningDependencies, type LearningOp,
} from './learning.ts';
import { validatedLearningImage } from './learning-image-validation.ts';

type ImageState = 'reserved' | 'writing' | 'uploaded' | 'ready' | 'cleanup' | 'removed';
type ImageRow = {
    id: string; post_id: string; object_key: string; status: ImageState;
    mime_type: LearningImageType | null; digest: string | null; bytes: number | null; width: number | null; height: number | null;
};

const imageLimit = () => new DomainError('IMAGE_LIMIT', '此资料已达到图片数量上限，请先移除未使用的图片。', 409);
const imageConflict = () => new DomainError('IMAGE_CONFLICT', '此图片上传已绑定其他内容，请移除后重新选择图片。', 409);
const referenced = () => new DomainError('IMAGE_REFERENCED', '仍有草稿或发布快照引用此图片。', 409);
const notUploaded = () => new DomainError('IMAGE_NOT_UPLOADED', '图片上传尚未完成，请先重试上传。', 409);
const storageUnknown = () => new DomainError('RESULT_UNKNOWN', '未能确认图片操作结果，请保留原操作并使用同一请求重试。', 503, true);
const storageUnavailable = () => new DomainError('STORAGE_UNAVAILABLE', '图片存储暂不可用，请保留内容稍后重试。', 503, true);
const imageType = () => new DomainError('INVALID_IMAGE', '只能为图文资料添加图片。', 409);

export function createLearningImages(deps: LearningDependencies, policy: Required<LearningPolicy>) {
    const { db, bucket, clock, activeMember, operation } = deps;
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
    const live = "li.status NOT IN ('cleanup','removed')";
    const owner = 'lp.id=? AND lp.team_id=? AND lp.owner_id=?';
    const owned = 'FROM learning_images li JOIN learning_posts lp ON lp.id=li.post_id';
    const ref = `EXISTS(SELECT 1 FROM learning_draft_images ld WHERE ld.post_id=li.post_id AND ld.image_id=li.id)
        OR EXISTS(SELECT 1 FROM learning_publication_images lr WHERE lr.post_id=li.post_id AND lr.image_id=li.id)`;
    // A published-only image stays pinned until a later publication replaces its snapshot.
    const slots = `(SELECT COUNT(*) FROM learning_images li WHERE li.post_id=?
        AND li.status NOT IN ('cleanup','removed') AND (li.status<>'ready'
            OR EXISTS(SELECT 1 FROM learning_draft_images ld WHERE ld.post_id=li.post_id AND ld.image_id=li.id)
            OR NOT EXISTS(SELECT 1 FROM learning_publication_images lr WHERE lr.post_id=li.post_id AND lr.image_id=li.id)))`;
    const ownerArgs = (c: LearningContext, postId: string) => [postId, c.membership.teamId, c.user.id];
    function store() {
        if (!bucket) throw storageUnavailable();
        return bucket;
    }
    async function storage<T>(action: () => Promise<T>): Promise<T> {
        try { return await action(); } catch { throw storageUnknown(); }
    }
    function dto(row: ImageRow & { alt: string; decorative: number }): LearningImage {
        return {
            id: row.id, mimeType: row.mime_type!, bytes: row.bytes!, width: row.width!, height: row.height!,
            href: learningImageHref(row.post_id, row.id, true), alt: row.alt, decorative: Boolean(row.decorative),
        };
    }
    async function load(c: LearningContext, postId: string, imageId: string, allowRemoved = false) {
        const member = learningMemberFence(c);
        const row = await q(`SELECT li.* ${owned} WHERE ${owner} AND li.id=? AND ${member.sql} ${allowRemoved ? '' : 'AND ' + live}`,
            ...ownerArgs(c, postId), imageId, ...member.values).first<ImageRow>();
        if (!row) throw learningMissing();
        return row;
    }
    function guardImage(op: LearningOp, c: LearningContext, postId: string, imageId: string, phase: string, predicate: string, values: unknown[] = []) {
        return assertGuard(db, op.opId, phase, `EXISTS(SELECT 1 ${owned} WHERE ${owner} AND li.id=? AND (${predicate}))`,
            [...ownerArgs(c, postId), imageId, ...values]);
    }
    function matches(row: ImageRow, object: R2Object | null) {
        const checksum = object?.checksums.sha256;
        return !!object && !!checksum && object.size === row.bytes && object.httpMetadata?.contentType === row.mime_type &&
            Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, '0')).join('') === row.digest;
    }

    async function reserveLearningImage(p: Principal | null, postId: string, input: unknown, key: string): Promise<LearningImageReservation> {
        const c = await bindLearningMember(activeMember, p);
        learningObject(input, []);
        const member = learningMemberFence(c);
        const post = await q(`SELECT lp.kind,${slots} AS used FROM learning_posts lp WHERE ${owner} AND ${member.sql}`,
            postId, ...ownerArgs(c, postId), ...member.values).first<{ kind: string; used: number }>();
        if (!post) throw learningMissing();
        const op = await operation(c.user.id, 'learning-image-reserve', postId, key, {});
        let id = op.replay?.result.id;
        if (!id) {
            store();
            if (post.kind !== 'article') throw imageType();
            if (post.used >= policy.maxImages) throw imageLimit();
            const imageId = crypto.randomUUID();
            const objectKey = 'learning/' + crypto.randomUUID();
            try {
                id = await commitLearning(op, [
                    learningMemberGuard(db, op, c, 'before'),
                    assertGuard(db, op.opId, 'room', `${slots}<? AND EXISTS(SELECT 1 FROM learning_posts lp WHERE ${owner} AND lp.kind='article')`,
                        [postId, policy.maxImages, ...ownerArgs(c, postId)]),
                    q("INSERT INTO learning_images(id,post_id,object_key,status,created_at) VALUES(?,?,?,'reserved',?)", imageId, postId, objectKey, clock().toISOString()),
                    guardImage(op, c, postId, imageId, 'reserved', "li.status='reserved'"),
                    learningMemberGuard(db, op, c, 'after'),
                ], imageId);
            } catch (error) {
                if (error instanceof DomainError && error.code === 'VERSION_CONFLICT') {
                    const used = await q(`SELECT ${slots} AS used FROM learning_posts lp WHERE ${owner} AND ${member.sql}`,
                        postId, ...ownerArgs(c, postId), ...member.values).first<number>('used');
                    if (used !== null && used >= policy.maxImages) throw imageLimit();
                }
                throw error;
            }
        }
        const row = await load(c, postId, id);
        return { id, status: row.status === 'writing' || row.status === 'reserved' ? 'reserved' : row.status as 'uploaded' | 'ready' };
    }

    async function uploadLearningImage(p: Principal | null, postId: string, imageId: string,
        body: ReadableStream<Uint8Array> | null, contentType: string | null, key: string): Promise<LearningImageUpload> {
        const c = await bindLearningMember(activeMember, p);
        await load(c, postId, imageId);
        const b = store();
        const { bytes, mimeType, digest, width, height } = await validatedLearningImage(body, contentType, policy.maxImageBytes);
        const input = { digest, mimeType, bytes: bytes.length, width, height };
        const op = await operation(c.user.id, 'learning-image-upload', imageId, key, input);
        let row = await load(c, postId, imageId);
        if (row.digest !== null && row.digest !== digest) throw imageConflict();
        if (row.status === 'reserved') {
            await commitLearning(op, [
                learningMemberGuard(db, op, c, 'before'),
                guardImage(op, c, postId, imageId, 'writable', "li.status='reserved' AND lp.kind='article'"),
                q("UPDATE learning_images SET status='writing',digest=?,mime_type=?,bytes=?,width=?,height=? WHERE id=?",
                    digest, mimeType, bytes.length, width, height, imageId),
                guardImage(op, c, postId, imageId, 'intent', "li.status='writing' AND li.digest=?", [digest]),
                learningMemberGuard(db, op, c, 'after'),
            ], imageId);
            row = await load(c, postId, imageId);
        } else if (!op.replay) {
            // Every accepted request key binds the same immutable digest, including retries with new keys.
            await commitLearning(op, [
                learningMemberGuard(db, op, c, 'before'),
                guardImage(op, c, postId, imageId, 'intent', `${live} AND li.digest=?`, [digest]),
                learningMemberGuard(db, op, c, 'after'),
            ], imageId);
        }
        if (row.digest !== digest) throw imageConflict();
        if (row.status === 'writing') {
            let object = await storage(() => b.head(row.object_key));
            if (!object) {
                await load(c, postId, imageId);
                object = await storage(() => b.put(row.object_key, bytes, {
                    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: mimeType }, sha256: digest,
                }));
                if (!object) object = await storage(() => b.head(row.object_key));
            }
            row = await load(c, postId, imageId);
            if (!matches(row, object)) throw storageUnknown();
            if (row.status === 'writing') {
                const confirmed = await operation(c.user.id, 'learning-image-upload-confirmed', imageId, key, input);
                if (!confirmed.replay) await commitLearning(confirmed, [
                    learningMemberGuard(db, confirmed, c, 'before'),
                    guardImage(confirmed, c, postId, imageId, 'written', `${live} AND li.digest=?`, [digest]),
                    q("UPDATE learning_images SET status='uploaded' WHERE id=? AND status='writing'", imageId),
                    guardImage(confirmed, c, postId, imageId, 'confirmed', "li.status IN ('uploaded','ready') AND li.digest=?", [digest]),
                    learningMemberGuard(db, confirmed, c, 'after'),
                ], imageId);
            }
        }
        const final = await load(c, postId, imageId);
        if (final.status !== 'uploaded' && final.status !== 'ready') throw storageUnknown();
        return { id: imageId, status: final.status };
    }

    async function completeLearningImage(p: Principal | null, postId: string, imageId: string, input: unknown, key: string): Promise<LearningImage> {
        const c = await bindLearningMember(activeMember, p);
        learningObject(input, []);
        const row = await load(c, postId, imageId);
        if (!['uploaded', 'ready'].includes(row.status)) throw notUploaded();
        const op = await operation(c.user.id, 'learning-image-complete', imageId, key, {});
        if (!op.replay && row.status === 'uploaded') {
            const b = store();
            if (!matches(row, await storage(() => b.head(row.object_key)))) throw storageUnknown();
            await commitLearning(op, [
                learningMemberGuard(db, op, c, 'before'),
                guardImage(op, c, postId, imageId, 'uploaded', "li.status='uploaded' AND lp.kind='article' AND li.digest=?", [row.digest]),
                assertGuard(db, op.opId, 'room', '(SELECT COUNT(*) FROM learning_draft_images WHERE post_id=?)<?', [postId, policy.maxImages]),
                q("UPDATE learning_images SET status='ready' WHERE id=?", imageId),
                q(`INSERT INTO learning_draft_images(post_id,image_id,position)
                    SELECT ?,?,COALESCE(MAX(position)+1,0) FROM learning_draft_images WHERE post_id=?`, postId, imageId, postId),
                q('UPDATE learning_posts SET version=version+1,updated_at=? WHERE id=?', clock().toISOString(), postId),
                guardImage(op, c, postId, imageId, 'attached', `li.status='ready' AND EXISTS(
                    SELECT 1 FROM learning_draft_images WHERE post_id=li.post_id AND image_id=li.id)`),
                learningMemberGuard(db, op, c, 'after'),
            ], imageId);
        }
        return dto(await authorized(c, postId, imageId, 'draft'));
    }

    async function authorized(c: LearningContext, postId: string, imageId: string, view: 'draft' | 'published') {
        const member = learningMemberFence(c);
        const published = view === 'published';
        const reference = published ? 'learning_publication_images' : 'learning_draft_images';
        const row = await q(`SELECT li.*,lr.alt,lr.decorative ${owned}
            ${published ? 'JOIN learning_post_publications lpub ON lpub.post_id=lp.id' : ''}
            JOIN ${reference} lr ON lr.post_id=lp.id AND lr.image_id=li.id
            WHERE lp.id=? AND lp.team_id=? AND li.id=? AND li.status='ready'
            AND ${published ? learningPostVisible : 'lp.owner_id=?'} AND ${member.sql}`,
            postId, c.membership.teamId, imageId, ...(published ? [] : [c.user.id]), ...member.values).first<ImageRow & { alt: string; decorative: number }>();
        if (!row) throw learningMissing();
        return row;
    }

    async function getLearningImage(p: Principal | null, postId: string, imageId: string, view: 'draft' | 'published' = 'published'): Promise<Response> {
        const c = await bindLearningMember(activeMember, p);
        const row = await authorized(c, postId, imageId, view);
        const b = store();
        const object = await storage(() => b.get(row.object_key));
        try {
            await authorized(c, postId, imageId, view);
            if (!object || !matches(row, object)) throw storageUnavailable();
        } catch (error) {
            await object?.body.cancel().catch(() => {});
            throw error;
        }
        return new Response(object.body, { headers: {
            'Content-Type': row.mime_type!, 'Content-Length': String(row.bytes),
            'Cache-Control': 'private, no-store, max-age=0',
            'Vary': 'Cookie, oai-authenticated-user-id, Cf-Access-Jwt-Assertion', 'X-Content-Type-Options': 'nosniff',
        } });
    }

    async function removeLearningImage(p: Principal | null, postId: string, imageId: string, input: unknown, key: string): Promise<LearningImageRemoval> {
        const c = await bindLearningMember(activeMember, p);
        learningObject(input, []);
        const row = await load(c, postId, imageId, true);
        const op = await operation(c.user.id, 'learning-image-remove', imageId, key, {});
        if (!op.replay && row.status !== 'removed' && row.status !== 'cleanup') {
            const member = learningMemberFence(c);
            const linked = await q(`SELECT 1 ${owned} WHERE ${owner} AND li.id=? AND (${ref}) AND ${member.sql}`,
                ...ownerArgs(c, postId), imageId, ...member.values).first();
            if (linked) throw referenced();
            store();
            await commitLearning(op, [
                learningMemberGuard(db, op, c, 'before'),
                guardImage(op, c, postId, imageId, 'detached', `li.status<>'removed' AND NOT (${ref})`),
                q("UPDATE learning_images SET status='cleanup' WHERE id=?", imageId),
                guardImage(op, c, postId, imageId, 'cleanup', `li.status='cleanup' AND NOT (${ref})`),
                learningMemberGuard(db, op, c, 'after'),
            ], imageId);
        }
        const cleanup = await load(c, postId, imageId, true);
        if (cleanup.status === 'removed') return { id: imageId, status: 'removed' };
        if (cleanup.status !== 'cleanup') throw learningConflict();
        const b = store();
        // Atomically erase bytes but retain the occupied key. A late create-if-missing PUT cannot resurrect them.
        const sealed = await storage(() => b.put(cleanup.object_key, new Uint8Array(), { customMetadata: { removed: '1' } }));
        if (!sealed || sealed.size !== 0 || sealed.customMetadata?.removed !== '1') throw storageUnknown();
        const confirmed = await operation(c.user.id, 'learning-image-remove-confirmed', imageId, key, {});
        if (!confirmed.replay) await commitLearning(confirmed, [
            learningMemberGuard(db, confirmed, c, 'before'),
            guardImage(confirmed, c, postId, imageId, 'unreferenced', `li.status IN ('cleanup','removed') AND NOT (${ref})`),
            q("UPDATE learning_images SET status='removed',digest=NULL,mime_type=NULL,bytes=NULL,width=NULL,height=NULL WHERE id=?", imageId),
            guardImage(confirmed, c, postId, imageId, 'removed', "li.status='removed'"),
            learningMemberGuard(db, confirmed, c, 'after'),
        ], imageId);
        if ((await load(c, postId, imageId, true)).status !== 'removed') throw storageUnknown();
        return { id: imageId, status: 'removed' };
    }

    return { reserveLearningImage, uploadLearningImage, completeLearningImage, getLearningImage, removeLearningImage };
}
