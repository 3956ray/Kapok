import { sql } from 'drizzle-orm';
import { learningCategoryMax, learningImageTypes } from '../lib/contracts/learning';
import { sqliteTable, text, integer, uniqueIndex, check, primaryKey, foreignKey, unique, index, real, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), status: text('status', { enum: ['active', 'deleted'] }).notNull().default('active'),
  version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(),
}, t => [check('users_status', sql`${t.status} IN ('active','deleted')`), check('users_version', sql`${t.version}>0`)]);
export const authIdentities = sqliteTable('auth_identities', {
  id: text('id').primaryKey(), provider: text('provider').notNull(), issuer: text('issuer').notNull(), subject: text('subject').notNull(), userId: text('user_id').notNull().references(() => users.id),
}, t => [uniqueIndex('identity_subject').on(t.provider, t.issuer, t.subject), uniqueIndex('identity_user').on(t.userId, t.provider, t.issuer), check('identity_provider', sql`${t.provider} IN ('site','access')`), check('identity_issuer', sql`length(${t.issuer})>0`), check('identity_subject_nonempty', sql`length(${t.subject})>0`)]);
export const profiles = sqliteTable('profiles', {
  position: text('position').notNull().default(''),
  userId: text('user_id').primaryKey().references(() => users.id), bio: text('bio').notNull().default(''), discName: text('disc_name').notNull(), jerseyNumber: text('jersey_number').notNull(), version: integer('version').notNull().default(1),
}, t => [check('profile_position', sql`${t.position} IN ('','Cutter','Handler','防守大闸','六边形')`), check('profile_disc_name', sql`length(${t.discName}) BETWEEN 1 AND 20`), check('profile_jersey', sql`length(${t.jerseyNumber}) BETWEEN 1 AND 4`), check('profile_version', sql`${t.version}>0`)]);
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(), singleton: integer('singleton').notNull(), name: text('name').notNull(), description: text('description').notNull(), createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('team_singleton').on(t.singleton), check('team_slot', sql`${t.singleton}=1`)]);
export const profileAvatars = sqliteTable('profile_avatars', {
    userId: text('user_id').primaryKey().references(() => profiles.userId, {onDelete:'cascade'}),
    digest: text('digest').notNull(),
    image: text('image').notNull(),
}, t => [check('avatar_digest', sql`length(${t.digest})=64`), check('avatar_image', sql`length(${t.image}) BETWEEN 1 AND 410000`)]);

export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['admin', 'coach', 'member'] }).notNull(), status: text('status', { enum: ['active', 'paused', 'left'] }).notNull(), epoch: integer('epoch').notNull(), version: integer('version').notNull().default(1), joinedAt: text('joined_at').notNull(),
}, t => [uniqueIndex('membership_team_user').on(t.teamId, t.userId), check('membership_role', sql`${t.role} IN ('admin','coach','member')`), check('membership_status', sql`${t.status} IN ('active','paused','left')`), check('membership_epoch', sql`${t.epoch}>0`), check('membership_version', sql`${t.version}>0`)]);
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(), actorId: text('actor_id').notNull(), kind: text('kind').notNull(), targetId: text('target_id').notNull(), key: text('key').notNull(), inputHash: text('input_hash').notNull(), status: text('status', { enum: ['pending', 'done', 'superseded'] }).notNull(), resultJson: text('result_json'), createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('operation_key').on(t.actorId, t.kind, t.targetId, t.key), check('operation_status', sql`${t.status} IN ('pending','done','superseded')`)]);
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), tokenHash: text('token_hash').notNull(), maxUses: integer('max_uses').notNull(), usedCount: integer('used_count').notNull().default(0), expiresAt: text('expires_at').notNull(), revoked: integer('revoked').notNull().default(0), recipientSubject: text('recipient_subject'), recipientEmail: text('recipient_email'), lastOpId: text('last_op_id').references(() => operations.id), createdBy: text('created_by').notNull().references(() => users.id),
}, t => [uniqueIndex('invite_token').on(t.tokenHash), check('invite_max', sql`${t.maxUses}>0`), check('invite_used', sql`${t.usedCount}>=0 AND ${t.usedCount}<=${t.maxUses}`), check('invite_revoked', sql`${t.revoked} IN (0,1)`)]);
export const joinReceipts = sqliteTable('join_receipts', {
  id: text('id').primaryKey(), opId: text('op_id').notNull().references(() => operations.id), inviteId: text('invite_id').notNull().references(() => invites.id), membershipId: text('membership_id').notNull().references(() => memberships.id), epoch: integer('epoch').notNull(),
}, t => [uniqueIndex('receipt_operation').on(t.opId), uniqueIndex('receipt_member_epoch').on(t.membershipId, t.epoch), check('receipt_epoch', sql`${t.epoch}>0`)]);
export const writeGuards = sqliteTable('write_guards', {
  opId: text('op_id').notNull().references(() => operations.id), phase: text('phase').notNull(), pass: integer('pass').notNull(),
}, t => [primaryKey({ columns: [t.opId, t.phase] }), check('write_guard_pass', sql`${t.pass}=1`)]);
export const bootstraps = sqliteTable('bootstraps', {
  id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), ownerUserId: text('owner_user_id').notNull().references(() => users.id), opId: text('op_id').notNull().references(() => operations.id), initializedAt: text('initialized_at').notNull(),
}, t => [uniqueIndex('bootstrap_team').on(t.teamId), uniqueIndex('bootstrap_operation').on(t.opId), check('bootstrap_slot', sql`${t.id}='site'`)]);

export const trainings = sqliteTable('trainings', {
    publisherId: text('publisher_id').references(() => users.id),
    workspaceDetails: text('workspace_details').notNull().default('{}'),
    id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), title: text('title').notNull(), date: text('date').notNull(), description: text('description').notNull(), status: text('status', {
        enum: ['draft', 'published', 'archived', 'hidden', 'deleted']
    }).notNull(), version: integer('version').notNull().default(1), updatedAt: text('updated_at').notNull(), createdAt: text('created_at').notNull(),
}, t => [check('training_title', sql `length(${t.title}) BETWEEN 1 AND 80`), check('training_status', sql `${t.status} IN ('draft','published','archived','hidden','deleted')`), index('training_team_date').on(t.teamId, t.date, t.id)]);
export const uploads = sqliteTable('uploads', {
    id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), ownerId: text('owner_id').notNull().references(() => users.id), bytes: integer('bytes').notNull(), status: text('status', {
        enum: ['pending', 'receiving', 'received', 'ready', 'rejected', 'cancelled']
    }).notNull(), objectKey: text('object_key'), contentKey: text('content_key'), mime: text('mime'), durationSec: real('duration_sec'), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(),
    cleanupState: text('cleanup_state', { enum: ['none', 'pending', 'deleted'] }).notNull().default('none'),
    cleanupTarget: text('cleanup_target', { enum: ['cancelled', 'rejected', 'pending'] }),
    cleanupError: text('cleanup_error'),
    transferActive: integer('transfer_active').notNull().default(0),
    multipartId: text('multipart_id'),
    protocolVersion: integer('protocol_version').notNull().default(1),
    manifestJson: text('manifest_json'), receivedParts: integer('received_parts').notNull().default(0),
    generation: integer('generation').notNull().default(0), leaseToken: text('lease_token'), leaseUntil: text('lease_until'),
    reservedBytes: integer('reserved_bytes').notNull().default(0), assemblyId: text('assembly_id'), validationState: text('validation_state'),

}, t => [index('upload_team_lease').on(t.teamId, t.leaseUntil), check('upload_bytes', sql `${t.bytes}>0`), check('upload_status', sql `${t.status} IN ('pending','receiving','received','ready','rejected','cancelled')`)]);
export const videos = sqliteTable('videos', {
    id: text('id').primaryKey(), trainingId: text('training_id').notNull().references(() => trainings.id), teamId: text('team_id').notNull().references(() => teams.id), title: text('title').notNull(), source: text('source', {
        enum: ['bilibili', 'youtube', 'upload']
    }).notNull(), url: text('url'), uploadId: text('upload_id').references(() => uploads.id).unique(), position: integer('position').notNull(), status: text('status', {
        enum: ['active', 'hidden', 'deleted']
    }).notNull().default('active'), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
    publisherId: text('publisher_id').references(() => users.id),
}, t => [check('video_source', sql `${t.source} IN ('bilibili','youtube','upload')`), check('video_status', sql `${t.status} IN ('active','hidden','deleted')`), index('video_training_order').on(t.trainingId, t.position, t.id)]);
export const videoComments = sqliteTable('video_comments', {
    referenceTimes: text('reference_times'),
    id: text('id').primaryKey(), videoId: text('video_id').notNull().references(() => videos.id), teamId: text('team_id').notNull().references(() => teams.id), authorId: text('author_id').notNull().references(() => users.id), rootId: text('root_id').references((): AnySQLiteColumn => videoComments.id), text: text('text').notNull(), timestampSec: integer('timestamp_sec'), status: text('status', {
        enum: ['active', 'hidden', 'deleted']
    }).notNull().default('active'), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
    replyToId: text('reply_to_id').references((): AnySQLiteColumn => videoComments.id),
}, t => [check('comment_status', sql `${t.status} IN ('active','hidden','deleted')`), index('comment_video').on(t.videoId, t.createdAt, t.id)]);
export const collections = sqliteTable('collections', {
    id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id), sourceKind: text('source_kind', {
        enum: ['training', 'video', 'comment', 'reflection', 'learning_post', 'topic_collection']
    }).notNull(), sourceId: text('source_id').notNull(), timestampSec: integer('timestamp_sec'), privateNote: text('private_note').notNull().default(''), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [uniqueIndex('collection_owner_source').on(t.ownerId, t.sourceKind, t.sourceId), check('collection_kind', sql `${t.sourceKind} IN ('training','video','comment','reflection','learning_post','topic_collection')`)]);
export const commentReports = sqliteTable('comment_reports', {
    id: text('id').primaryKey(), commentId: text('comment_id').notNull().references(() => videoComments.id), actorId: text('actor_id').notNull().references(() => users.id), reason: text('reason').notNull(), createdAt: text('created_at').notNull()
});
export const moderationAudit = sqliteTable('moderation_audit', {
    id: text('id').primaryKey(), actorId: text('actor_id').notNull().references(() => users.id), targetId: text('target_id').notNull(), action: text('action').notNull(), reason: text('reason').notNull(), createdAt: text('created_at').notNull()
});

export const reflections = sqliteTable('reflections', {
    discussionEpoch:integer('discussion_epoch').notNull().default(1),
    photos: text('photos').notNull().default('[]'),
    localPhotosPending: integer('local_photos_pending').notNull().default(0),
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    teamId: text('team_id').notNull().references(() => teams.id),
    title: text('title').notNull().default(''),
    text: text('text').notNull(),
    date: text('date').notNull(),
    category: text('category'),
    trainingId: text('training_id').references(() => trainings.id),
    videoId: text('video_id').references(() => videos.id),
    sourceKind: text('source_kind', { enum: ['learning_post', 'topic_collection'] }),
    sourceId: text('source_id'),
    version: integer('version').notNull().default(1),
    sharingVersion: integer('sharing_version').notNull().default(1),
    generation: integer('generation').notNull().default(1),
    gate: text('gate', { enum: ['open', 'closed'] }).notNull().default('closed'),
    activeOpId: text('active_op_id'),
    lastCommittedOpId: text('last_committed_op_id'),
    // 0005 triggers reject coach grants; retain the physical legacy CHECK below to avoid a table rebuild.
    scope: text('scope', { enum: ['private', 'team'] }).notNull().default('private'),
    coachId: text('coach_id').references(() => users.id),
    coachEpoch: integer('coach_epoch'),
    authorEpoch: integer('author_epoch'),
    publishedAt: text('published_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
}, t => [
    check('reflection_discussion_epoch',sql`${t.discussionEpoch}>0`),
    check('reflection_photos',sql`json_valid(${t.photos}) AND json_type(${t.photos})='array' AND json_array_length(${t.photos})<=9`),
    check('reflection_local_photos',sql`${t.localPhotosPending} IN (0,1)`),
    check('reflection_source_ref', sql`(${t.sourceKind} IS NULL AND ${t.sourceId} IS NULL) OR
        (${t.sourceKind} IS NOT NULL AND ${t.sourceKind} IN ('learning_post','topic_collection') AND ${t.sourceId} IS NOT NULL
        AND length(${t.sourceId}) BETWEEN 1 AND 80 AND ${t.sourceId} NOT GLOB '*[^A-Za-z0-9_-]*'
        AND ${t.trainingId} IS NULL AND ${t.videoId} IS NULL)`),
    check('reflection_title', sql`length(${t.title})<=60`),
    check('reflection_text', sql`length(${t.text}) BETWEEN 1 AND 5000`),
    check('reflection_version', sql`${t.version}>0`),
    check('reflection_sharing_version', sql`${t.sharingVersion}>0`),
    check('reflection_generation', sql`${t.generation}>0`),
    check('reflection_gate', sql`${t.gate} IN ('open','closed')`),
    check('reflection_scope', sql`${t.scope} IN ('private','team','coach')`),
    check('reflection_coach', sql`(${t.scope}='coach' AND ${t.coachId} IS NOT NULL AND ${t.coachEpoch} IS NOT NULL) OR (${t.scope}!='coach' AND ${t.coachId} IS NULL AND ${t.coachEpoch} IS NULL)`),
    check('reflection_publication', sql`${t.publishedAt} IS NULL OR ${t.scope}='team'`),
    check('reflection_open', sql`${t.gate}='closed' OR (${t.scope}!='private' AND ${t.deletedAt} IS NULL)`),
    index('reflection_owner_date').on(t.ownerId, t.date, t.id),
    index('reflection_team_scope').on(t.teamId, t.scope, t.publishedAt, t.id)
]);
export const reflectionImages = sqliteTable('reflection_images', {
    id:text('id').notNull(), ownerId:text('owner_id').notNull().references(()=>users.id),
    teamId:text('team_id').notNull().references(()=>teams.id), objectKey:text('object_key').unique().notNull(),
    digest:text('digest').notNull(), mime:text('mime').notNull(), bytes:integer('bytes').notNull(),
    thumbMime:text('thumb_mime'),thumbBytes:integer('thumb_bytes'),thumbDigest:text('thumb_digest'),
    state:text('state',{enum:['uploading','ready','deleting']}).notNull(),
    reflectionId:text('reflection_id').references(()=>reflections.id,{onDelete:'set null'}), touchedAt:text('touched_at').notNull(),
}, t=>[
    primaryKey({columns:[t.ownerId,t.id]}), index('reflection_images_attachment').on(t.ownerId,t.reflectionId,t.touchedAt),
    index('reflection_images_expiry').on(t.touchedAt,t.objectKey).where(sql`${t.reflectionId} IS NULL`),
    check('reflection_thumb_mime',sql`${t.thumbMime} IN ('image/jpeg','image/png','image/webp')`),
    check('reflection_thumb_digest',sql`length(${t.thumbDigest})=64`),
    check('reflection_thumb_bytes',sql`${t.thumbBytes} BETWEEN 1 AND 131072`),
    check('reflection_thumb_fields',sql`(${t.thumbMime} IS NULL AND ${t.thumbBytes} IS NULL AND ${t.thumbDigest} IS NULL) OR
        (${t.thumbMime} IS NOT NULL AND ${t.thumbBytes} IS NOT NULL AND ${t.thumbDigest} IS NOT NULL)`),
    check('reflection_image_digest',sql`length(${t.digest})=64`),
    check('reflection_image_mime',sql`${t.mime} IN ('image/jpeg','image/png','image/webp')`),
    check('reflection_image_bytes',sql`${t.bytes} BETWEEN 1 AND 8388608`),
    check('reflection_image_state',sql`${t.state} IN ('uploading','ready','deleting')`),
]);
export const reflectionImageSweep = sqliteTable('reflection_image_sweep', {
    id: integer('id').primaryKey(), cursor:text('cursor'),
}, t=>[check('reflection_image_sweep_singleton',sql`${t.id}=1`)]);

export const announcements = sqliteTable('announcements', {
    discussionEpoch:integer('discussion_epoch').notNull().default(1),
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id),
    title: text('title').notNull(),
    text: text('text').notNull(),
    status: text('status', { enum: ['draft', 'published', 'deleted'] }).notNull(),
    version: integer('version').notNull().default(1),
    publishedAt: text('published_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    revisionTitle: text('revision_title'),
    revisionText: text('revision_text'),
    revisionVersion: integer('revision_version'),
    lastOpId: text('last_op_id')
}, t => [
    check('announcement_discussion_epoch',sql`${t.discussionEpoch}>0`),
    check('announcement_title', sql`length(${t.title}) BETWEEN 1 AND 80`),
    check('announcement_text', sql`length(${t.text}) BETWEEN 1 AND 5000`),
    check('announcement_status', sql`${t.status} IN ('draft','published','deleted')`)
]);
export const videoEvents = sqliteTable('video_events', {
    videoId: text('video_id').primaryKey().references(() => videos.id),
    publishedAt: text('published_at').notNull()
});

// Attempt keys are never reused. Unknown side effects keep their physical byte reservation.
export const uploadAttempts = sqliteTable('upload_attempts', {
    id: text('id').primaryKey(), uploadId: text('upload_id').notNull().references(() => uploads.id),
    kind: text('kind').notNull(), partNumber: integer('part_number').notNull(), objectKey: text('object_key').notNull(),
    bytes: integer('bytes').notNull(), state: text('state').notNull(), active: integer('active').notNull().default(1),
    multipartId: text('multipart_id'), completedParts: integer('completed_parts').notNull().default(0),
    generation: integer('generation').notNull(),
}, t => [uniqueIndex('upload_attempt_key').on(t.objectKey), index('upload_attempt_upload').on(t.uploadId, t.kind, t.partNumber), index('upload_attempt_active').on(t.active, t.uploadId), index('upload_attempt_cleanup').on(t.uploadId, t.state, t.id),
    check('upload_attempt_kind', sql`${t.kind} IN ('part','assembly')`), check('upload_attempt_state', sql`${t.state} IN ('pending','committed','garbage','deleted')`),
    check('upload_attempt_active', sql`${t.active} IN (0,1)`), check('upload_attempt_bytes', sql`${t.bytes}>0`)]);
export const uploadParts = sqliteTable('upload_parts', {
    uploadId: text('upload_id').notNull().references(() => uploads.id), partNumber: integer('part_number').notNull(),
    attemptId: text('attempt_id').references(() => uploadAttempts.id), digest: text('digest').notNull(), bytes: integer('bytes').notNull(),
}, t => [primaryKey({ columns: [t.uploadId, t.partNumber] }), check('upload_part_number', sql`${t.partNumber}>0`)]);

export const uploadAssemblyParts = sqliteTable('upload_assembly_parts', {
    attemptId: text('attempt_id').notNull().references(() => uploadAttempts.id), partNumber: integer('part_number').notNull(), etag: text('etag').notNull(),
}, t => [primaryKey({ columns: [t.attemptId, t.partNumber] }), check('assembly_part_number', sql`${t.partNumber}>0`), check('assembly_etag', sql`length(${t.etag}) BETWEEN 1 AND 1024`)]);

export const initialAdminGrants = sqliteTable('initial_admin_grants', {
  teamId: text('team_id').primaryKey().notNull().references(() => teams.id),
  opId: text('op_id').references(() => operations.id),
});

export const learningCategoryNames = sqliteTable('learning_categories', {
    teamId: text('team_id').notNull().references(() => teams.id),
    name: text('name').notNull(),
}, t => [
    primaryKey({ columns: [t.teamId, t.name] }),
    check('learning_category_length', sql`instr(${t.name}, char(0)) = 0 AND length(${t.name}) BETWEEN 1 AND ${sql.raw(String(learningCategoryMax))}`),
]);

function learningContentColumns() {
    return {
        kind: text('kind', { enum: ['article', 'video'] }).notNull(),
        category: text('category').notNull(),
        title: text('title').notNull(), summary: text('summary').notNull(), body: text('body').notNull(),
        videoSource: text('video_source', { enum: ['youtube', 'bilibili','upload'] }), videoUrl: text('video_url'),
    };
}
function learningContentChecks(name: string, t: { kind: AnySQLiteColumn; videoSource: AnySQLiteColumn; videoUrl: AnySQLiteColumn }) {
    return [
        check(name + '_kind', sql`${t.kind} IN ('article','video')`),
        check(name + '_video', sql`(${t.kind}='article' AND ${t.videoSource} IS NULL AND ${t.videoUrl} IS NULL)
            OR (${t.kind}='video' AND ${t.videoSource} IS NOT NULL AND ${t.videoSource} IN ('youtube','bilibili','upload') AND ${t.videoUrl} IS NOT NULL)`),
    ];
}
export const learningPosts = sqliteTable('learning_posts', {
    workspaceDetails: text('workspace_details').notNull().default('{}'),
    id: text('id').primaryKey().notNull(), teamId: text('team_id').notNull().references(() => teams.id),
    ownerId: text('owner_id').notNull().references(() => users.id), ...learningContentColumns(),
    collectionTargetId: text('collection_target_id'),
    status: text('status', { enum: ['draft', 'published', 'withdrawn', 'hidden'] }).notNull().default('draft'),
    version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [
    ...learningContentChecks('learning_draft', t),
    check('learning_post_status', sql`${t.status} IN ('draft','published','withdrawn','hidden')`),
    check('learning_post_version', sql`${t.version} > 0`), index('learning_posts_owner').on(t.teamId, t.ownerId, t.updatedAt, t.id),
]);
export const learningPostPublications = sqliteTable('learning_post_publications', {
    workspaceDetails: text('workspace_details').notNull().default('{}'),
    postId: text('post_id').primaryKey().notNull().references(() => learningPosts.id), ...learningContentColumns(),
    version: integer('version').notNull(), authorEpoch: integer('author_epoch').notNull(),
    collectionTargetId: text('collection_target_id'), publishedAt: text('published_at').notNull(),
}, t => [
    ...learningContentChecks('learning_publication', t), check('learning_publication_version', sql`${t.version}>0`),
    check('learning_publication_epoch', sql`${t.authorEpoch}>0`), index('learning_publication_order').on(t.publishedAt, t.postId),
]);
export const learningImages = sqliteTable('learning_images', {
    id: text('id').primaryKey().notNull(), postId: text('post_id').notNull().references(() => learningPosts.id),
    objectKey: text('object_key').notNull().unique(),
    status: text('status', { enum: ['reserved', 'writing', 'uploaded', 'ready', 'cleanup', 'removed'] }).notNull(),
    digest: text('digest'), mimeType: text('mime_type', { enum: learningImageTypes }), bytes: integer('bytes'),
    width: integer('width'), height: integer('height'), createdAt: text('created_at').notNull(),
}, t => [
    unique('learning_image_post').on(t.postId, t.id),
    check('learning_image_status', sql`${t.status} IN ('reserved','writing','uploaded','ready','cleanup','removed')`),
    check('learning_image_mime', sql`${t.mimeType} IN ('image/png','image/jpeg','image/webp')`),
    check('learning_image_size', sql`${t.bytes}>0`),
    check('learning_image_width', sql`${t.width}>0`), check('learning_image_height', sql`${t.height}>0`),
    check('learning_image_integrity', sql`${t.status} NOT IN ('writing','uploaded','ready') OR
        (${t.digest} IS NOT NULL AND ${t.mimeType} IS NOT NULL AND ${t.bytes} IS NOT NULL AND ${t.width} IS NOT NULL AND ${t.height} IS NOT NULL)`),
]);
function learningImageReferences(name: 'learning_draft_images' | 'learning_publication_images', parent: AnySQLiteColumn) {
    return sqliteTable(name, {
        postId: text('post_id').notNull().references(() => parent),
        imageId: text('image_id').notNull(), position: integer('position').notNull(), alt: text('alt').notNull().default(''),
        decorative: integer('decorative', { mode: 'boolean' }).notNull().default(false),
    }, t => [
        primaryKey({ columns: [t.postId, t.imageId] }), unique().on(t.postId, t.position),
        foreignKey({ columns: [t.postId, t.imageId], foreignColumns: [learningImages.postId, learningImages.id] }),
        check(name + '_nonnegative', sql`${t.position} >= 0`),
        check(name + '_decorative', sql`${t.decorative} IN (0,1) AND (${t.decorative}=0 OR ${t.alt}='')`),
    ]);
}
export const learningDraftImages = learningImageReferences('learning_draft_images', learningPosts.id);
export const learningPublicationImages = learningImageReferences('learning_publication_images', learningPostPublications.postId);

export const topicCollections = sqliteTable('topic_collections', {
    id: text('id').primaryKey().notNull(), teamId: text('team_id').notNull().references(() => teams.id),
    ownerId: text('owner_id').notNull().references(() => users.id), title: text('title').notNull(), summary: text('summary').notNull(), category: text('category').notNull().default(''),
    status: text('status', { enum: ['draft', 'published', 'withdrawn'] }).notNull().default('draft'),
    version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [
    check('topic_collection_status', sql`${t.status} IN ('draft','published','withdrawn')`),
    check('topic_collection_version', sql`${t.version}>0`),
    index('topic_collections_owner').on(t.teamId, t.ownerId, t.updatedAt, t.id),
]);
export const topicCollectionPublications = sqliteTable('topic_collection_publications', {
    collectionId: text('collection_id').primaryKey().notNull().references(() => topicCollections.id),
    title: text('title').notNull(), summary: text('summary').notNull(), category: text('category').notNull().default(''), version: integer('version').notNull(),
    authorEpoch: integer('author_epoch').notNull(), visibilityId: text('visibility_id').notNull(), publishedAt: text('published_at').notNull(),
}, t => [
    check('topic_publication_version', sql`${t.version}>0`), check('topic_publication_epoch', sql`${t.authorEpoch}>0`),
]);
export const workspaceTopicCoverRevisions = sqliteTable('workspace_topic_cover_revisions', {
    collectionId: text('collection_id').notNull().references(() => topicCollections.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(), digest: text('digest'), image: text('image'),
}, t => [
    primaryKey({ columns: [t.collectionId, t.version] }), check('topic_cover_version', sql`${t.version}>0`),
    check('topic_cover_data', sql`(${t.digest} IS NULL AND ${t.image} IS NULL) OR
        (${t.digest} IS NOT NULL AND length(${t.digest})=64 AND ${t.image} IS NOT NULL AND length(${t.image}) BETWEEN 1 AND 410000)`),
]);
export const topicCollectionItems = sqliteTable('topic_collection_items', {
    collectionId: text('collection_id').notNull().references(() => topicCollections.id),
    snapshot: integer('snapshot').notNull(), kind: text('kind', { enum: ['post', 'video', 'training'] }).notNull(),
    sourceId: text('source_id').notNull(), position: integer('position').notNull(),
}, t => [
    primaryKey({ columns: [t.collectionId, t.snapshot, t.kind, t.sourceId] }), unique().on(t.collectionId, t.snapshot, t.position),
    check('topic_item_snapshot', sql`${t.snapshot} IN (0,1)`), check('topic_item_kind', sql`${t.kind} IN ('post','video','training')`),
    check('topic_item_position', sql`${t.position}>=0`),
]);
export const workspaceTopicShares = sqliteTable('workspace_topic_shares', {
    id: text('id').primaryKey().notNull(),
    collectionId: text('collection_id').notNull().references(() => topicCollections.id, {onDelete:'cascade'}),
    version: integer('version').notNull(), visibilityId: text('visibility_id').notNull(),
    title: text('title').notNull(), summary: text('summary').notNull(), category: text('category').notNull(),
    publishedAt: text('published_at').notNull(), items: text('items').notNull(),
}, t => [unique().on(t.collectionId,t.version),check('workspace_topic_items_json',sql`json_valid(${t.items})`)]);
export const topicFeatured = sqliteTable('topic_featured', {
    teamId: text('team_id').primaryKey().notNull().references(() => teams.id),
    version: integer('version').notNull(), choices: text('choices', { mode: 'json' }).notNull(),
}, t => [
    check('topic_featured_version', sql`${t.version}>0`),
    check('topic_featured_choices', sql`json_valid(${t.choices}) AND json_type(${t.choices})='array'`),
]);
export const topicLearningAssociations = sqliteTable('topic_learning_associations', {
    postId: text('post_id').notNull().references(() => learningPosts.id),
    publishedVersion: integer('published_version').notNull(),
    status: text('status', { enum: ['pending', 'added-draft', 'added-published'] }).notNull(),
}, t => [
    primaryKey({ columns: [t.postId, t.publishedVersion] }), check('topic_learning_version', sql`${t.publishedVersion}>0`),
    check('topic_learning_status', sql`${t.status} IN ('pending','added-draft','added-published')`),
]);

export const learningComments = sqliteTable('learning_comments', {
    referenceTimes: text('reference_times'),
    id: text('id').primaryKey(),
    postId: text('post_id').notNull().references(() => learningPosts.id),
    teamId: text('team_id').notNull().references(() => teams.id),
    authorId: text('author_id').notNull().references(() => users.id),
    rootId: text('root_id').references((): AnySQLiteColumn => learningComments.id),
    replyToId: text('reply_to_id').references((): AnySQLiteColumn => learningComments.id),
    text: text('text').notNull(),
    timestampSec: integer('timestamp_sec'),
    mediaUrl: text('media_url'),
    status: text('status', { enum: ['active', 'hidden', 'deleted'] }).notNull().default('active'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    edited: integer('edited', { mode: 'boolean' }).notNull().default(false),
}, t => [
    index('learning_comment_post').on(t.postId, t.createdAt, t.id),
    index('learning_comment_author').on(t.authorId, t.createdAt, t.id),
    check('learning_comment_status', sql `${t.status} IN ('active','hidden','deleted')`),
    check('learning_comment_reply', sql `(${t.rootId} IS NULL) = (${t.replyToId} IS NULL)`),
    check('learning_comment_time', sql `(${t.timestampSec} IS NULL AND ${t.mediaUrl} IS NULL) OR (${t.timestampSec} IS NOT NULL AND ${t.timestampSec} >= 0 AND ${t.mediaUrl} IS NOT NULL)`),
    check('learning_comment_version', sql `${t.version} > 0`),
]);

export const learningCommentModeration = sqliteTable('learning_comment_moderation', {
    id: text('id').primaryKey().references(() => operations.id),
    commentId: text('comment_id').notNull().references(() => learningComments.id),
    actorId: text('actor_id').notNull().references(() => users.id),
    action: text('action', { enum: ['hide', 'restore', 'report'] }).notNull(),
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
}, t => [check('learning_comment_moderation_action', sql `${t.action} IN ('hide','restore','report')`)]);

export const learningActivityEvents = sqliteTable('learning_activity_events', {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }).notNull(),
    id: text('id').notNull().unique(),
    postId: text('post_id').notNull().references(() => learningPosts.id),
    authorEpoch: integer('author_epoch').notNull(),
    sharedAt: text('shared_at').notNull(),
    revokedAt: text('revoked_at'),
}, t => [
    check('learning_activity_epoch', sql`${t.authorEpoch} > 0`),
    uniqueIndex('learning_activity_current').on(t.postId, t.authorEpoch).where(sql`${t.revokedAt} IS NULL`),
    index('learning_activity_post').on(t.postId, t.authorEpoch, t.sequence),
]);

export const materialAssets = sqliteTable('material_assets', {
    id:text('id').primaryKey(), teamId:text('team_id').notNull().references(()=>teams.id),
    ownerId:text('owner_id').notNull().references(()=>users.id), parentKind:text('parent_kind',{enum:['training','post']}).notNull(),
    parentId:text('parent_id').notNull(), mime:text('mime').notNull(), bytes:integer('bytes').notNull(), digest:text('digest').notNull(),
    ready:integer('ready').default(0).notNull(), createdAt:text('created_at').notNull(),
}, t=>[index('material_assets_parent').on(t.parentKind,t.parentId),index('material_assets_team').on(t.teamId)]);

export const trainingDiscussions = sqliteTable('training_discussions', {
    id:text('id').primaryKey(),trainingId:text('training_id').notNull().references(()=>trainings.id),authorId:text('author_id').notNull().references(()=>users.id),
    rootId:text('root_id').references((): AnySQLiteColumn=>trainingDiscussions.id),replyToId:text('reply_to_id').references((): AnySQLiteColumn=>trainingDiscussions.id),
    body:text('body').notNull(),status:text('status',{enum:['active','deleted']}).default('active').notNull(),
    version:integer('version').default(1).notNull(),createdAt:text('created_at').notNull(),
}, t=>[index('training_discussions_order').on(t.trainingId,t.createdAt,t.id)]);

export const readerDiscussions = sqliteTable('reader_discussions', {
    id:text('id').primaryKey().notNull(), teamId:text('team_id').notNull().references(()=>teams.id),
    sourceKind:text('source_kind',{enum:['reflection','announcement']}).notNull(), sourceId:text('source_id').notNull(),
    discussionEpoch:integer('discussion_epoch').notNull(), authorId:text('author_id').notNull().references(()=>users.id),
    rootId:text('root_id').references(():AnySQLiteColumn=>readerDiscussions.id),
    replyToId:text('reply_to_id').references(():AnySQLiteColumn=>readerDiscussions.id),
    body:text('body').notNull(),status:text('status',{enum:['active','deleted']}).notNull().default('active'),
    version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),
}, t=>[
    index('reader_discussions_source').on(t.teamId,t.sourceKind,t.sourceId,t.discussionEpoch,t.createdAt,t.id),
    index('reader_discussions_author').on(t.authorId,t.createdAt,t.id),
    index('reader_discussions_feed').on(t.teamId,t.createdAt,t.id).where(sql`${t.status}='active'`),
    check('reader_discussion_kind',sql`${t.sourceKind} IN ('reflection','announcement')`),
    check('reader_discussion_epoch',sql`${t.discussionEpoch}>0`),
    check('reader_discussion_version',sql`${t.version}>0`),
    check('reader_discussion_status',sql`${t.status} IN ('active','deleted')`),
    check('reader_discussion_reply',sql`(${t.rootId} IS NULL)=(${t.replyToId} IS NULL)`),
    check('reader_discussion_body',sql`(${t.status}='active' AND length(${t.body}) BETWEEN 1 AND 2000) OR (${t.status}='deleted' AND ${t.body}='')`),
]);
