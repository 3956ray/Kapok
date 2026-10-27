import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, check, primaryKey, index, real, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), status: text('status', { enum: ['active', 'deleted'] }).notNull().default('active'),
  version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(),
}, t => [check('users_status', sql`${t.status} IN ('active','deleted')`), check('users_version', sql`${t.version}>0`)]);
export const authIdentities = sqliteTable('auth_identities', {
  id: text('id').primaryKey(), provider: text('provider').notNull(), subject: text('subject').notNull(), userId: text('user_id').notNull().references(() => users.id),
}, t => [uniqueIndex('identity_subject').on(t.provider, t.subject), uniqueIndex('identity_user').on(t.userId, t.provider), check('identity_provider', sql`${t.provider}='site'`)]);
export const profiles = sqliteTable('profiles', {
  userId: text('user_id').primaryKey().references(() => users.id), discName: text('disc_name').notNull(), jerseyNumber: text('jersey_number').notNull(), version: integer('version').notNull().default(1),
}, t => [check('profile_disc_name', sql`length(${t.discName}) BETWEEN 1 AND 20`), check('profile_jersey', sql`length(${t.jerseyNumber}) BETWEEN 1 AND 4`), check('profile_version', sql`${t.version}>0`)]);
export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(), singleton: integer('singleton').notNull(), name: text('name').notNull(), description: text('description').notNull(), createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('team_singleton').on(t.singleton), check('team_slot', sql`${t.singleton}=1`)]);
export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), userId: text('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['admin', 'coach', 'member'] }).notNull(), status: text('status', { enum: ['active', 'paused', 'left'] }).notNull(), epoch: integer('epoch').notNull(), version: integer('version').notNull().default(1), joinedAt: text('joined_at').notNull(),
}, t => [uniqueIndex('membership_team_user').on(t.teamId, t.userId), check('membership_role', sql`${t.role} IN ('admin','coach','member')`), check('membership_status', sql`${t.status} IN ('active','paused','left')`), check('membership_epoch', sql`${t.epoch}>0`), check('membership_version', sql`${t.version}>0`)]);
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(), actorId: text('actor_id').notNull(), kind: text('kind').notNull(), targetId: text('target_id').notNull(), key: text('key').notNull(), inputHash: text('input_hash').notNull(), status: text('status', { enum: ['pending', 'done', 'superseded'] }).notNull(), resultJson: text('result_json'), createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('operation_key').on(t.actorId, t.kind, t.targetId, t.key), check('operation_status', sql`${t.status} IN ('pending','done','superseded')`)]);
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(), teamId: text('team_id').notNull().references(() => teams.id), tokenHash: text('token_hash').notNull(), maxUses: integer('max_uses').notNull(), usedCount: integer('used_count').notNull().default(0), expiresAt: text('expires_at').notNull(), revoked: integer('revoked').notNull().default(0), recipientSubject: text('recipient_subject'), lastOpId: text('last_op_id').references(() => operations.id), createdBy: text('created_by').notNull().references(() => users.id),
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
        enum: ['bilibili', 'upload']
    }).notNull(), url: text('url'), uploadId: text('upload_id').references(() => uploads.id).unique(), position: integer('position').notNull(), status: text('status', {
        enum: ['active', 'hidden', 'deleted']
    }).notNull().default('active'), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [check('video_source', sql `${t.source} IN ('bilibili','upload')`), check('video_status', sql `${t.status} IN ('active','hidden','deleted')`), index('video_training_order').on(t.trainingId, t.position, t.id)]);
export const videoComments = sqliteTable('video_comments', {
    id: text('id').primaryKey(), videoId: text('video_id').notNull().references(() => videos.id), teamId: text('team_id').notNull().references(() => teams.id), authorId: text('author_id').notNull().references(() => users.id), rootId: text('root_id').references((): AnySQLiteColumn => videoComments.id), text: text('text').notNull(), timestampSec: integer('timestamp_sec'), status: text('status', {
        enum: ['active', 'hidden', 'deleted']
    }).notNull().default('active'), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [check('comment_status', sql `${t.status} IN ('active','hidden','deleted')`), index('comment_video').on(t.videoId, t.createdAt, t.id)]);
export const collections = sqliteTable('collections', {
    id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id), sourceKind: text('source_kind', {
        enum: ['video', 'comment', 'reflection']
    }).notNull(), sourceId: text('source_id').notNull(), timestampSec: integer('timestamp_sec'), privateNote: text('private_note').notNull().default(''), version: integer('version').notNull().default(1), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [uniqueIndex('collection_owner_source').on(t.ownerId, t.sourceKind, t.sourceId), check('collection_kind', sql `${t.sourceKind} IN ('video','comment','reflection')`)]);
export const commentReports = sqliteTable('comment_reports', {
    id: text('id').primaryKey(), commentId: text('comment_id').notNull().references(() => videoComments.id), actorId: text('actor_id').notNull().references(() => users.id), reason: text('reason').notNull(), createdAt: text('created_at').notNull()
});
export const moderationAudit = sqliteTable('moderation_audit', {
    id: text('id').primaryKey(), actorId: text('actor_id').notNull().references(() => users.id), targetId: text('target_id').notNull(), action: text('action').notNull(), reason: text('reason').notNull(), createdAt: text('created_at').notNull()
});

export const reflections = sqliteTable('reflections', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    teamId: text('team_id').notNull().references(() => teams.id),
    title: text('title').notNull().default(''),
    text: text('text').notNull(),
    date: text('date').notNull(),
    trainingId: text('training_id').references(() => trainings.id),
    videoId: text('video_id').references(() => videos.id),
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
export const announcements = sqliteTable('announcements', {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().references(() => teams.id),
    title: text('title').notNull(),
    text: text('text').notNull(),
    status: text('status', { enum: ['draft', 'published', 'deleted'] }).notNull(),
    version: integer('version').notNull().default(1),
    publishedAt: text('published_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastOpId: text('last_op_id')
}, t => [
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
