-- Extend the video source constraint on both drafts and snapshots. SQLite requires
-- rebuilding their FK graph together and retain the activity sequence watermark.
CREATE TABLE learning_posts_0021 (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('article','video')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  video_source TEXT,
  video_url TEXT,
  collection_target_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn','hidden')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT learning_draft_video CHECK (
    (kind='article' AND video_source IS NULL AND video_url IS NULL)
    OR (kind='video' AND video_source IS NOT NULL AND video_source IN ('youtube','bilibili','upload') AND video_url IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE learning_post_publications_0021 (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES learning_posts_0021(id),
  kind TEXT NOT NULL CHECK (kind IN ('article','video')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  video_source TEXT,
  video_url TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  author_epoch INTEGER NOT NULL CHECK (author_epoch > 0),
  collection_target_id TEXT,
  published_at TEXT NOT NULL,
  CONSTRAINT learning_publication_video CHECK (
    (kind='article' AND video_source IS NULL AND video_url IS NULL)
    OR (kind='video' AND video_source IS NOT NULL AND video_source IN ('youtube','bilibili','upload') AND video_url IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE learning_images_0021 (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES learning_posts_0021(id),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('reserved','writing','uploaded','ready','cleanup','removed')),
  digest TEXT,
  mime_type TEXT CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER CHECK (bytes > 0),
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  created_at TEXT NOT NULL,
  CONSTRAINT learning_image_post UNIQUE(post_id, id),
  CONSTRAINT learning_image_integrity CHECK (
    status NOT IN ('writing','uploaded','ready') OR
    (digest IS NOT NULL AND mime_type IS NOT NULL AND bytes IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE learning_draft_images_0021 (
  post_id TEXT NOT NULL REFERENCES learning_posts_0021(id),
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  alt TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0,1) AND (decorative=0 OR alt='')),
  PRIMARY KEY (post_id, image_id),
  UNIQUE(post_id, position),
  FOREIGN KEY (post_id, image_id) REFERENCES learning_images_0021(post_id, id)
);
--> statement-breakpoint
CREATE TABLE learning_publication_images_0021 (
  post_id TEXT NOT NULL REFERENCES learning_post_publications_0021(post_id),
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  alt TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0,1) AND (decorative=0 OR alt='')),
  PRIMARY KEY (post_id, image_id),
  UNIQUE(post_id, position),
  FOREIGN KEY (post_id, image_id) REFERENCES learning_images_0021(post_id, id)
);
--> statement-breakpoint
CREATE TABLE topic_learning_associations_0021 (
    post_id TEXT NOT NULL REFERENCES learning_posts_0021(id),
    published_version INTEGER NOT NULL CHECK (published_version > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','added-draft','added-published')),
    PRIMARY KEY (post_id,published_version)
);
--> statement-breakpoint
CREATE TABLE learning_comments_0021 (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES learning_posts_0021(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  root_id TEXT REFERENCES learning_comments_0021(id),
  reply_to_id TEXT REFERENCES learning_comments_0021(id),
  text TEXT NOT NULL,
  timestamp_sec INTEGER,
  media_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT learning_comment_status CHECK (status IN ('active','hidden','deleted')),
  CONSTRAINT learning_comment_reply CHECK ((root_id IS NULL) = (reply_to_id IS NULL)),
  CONSTRAINT learning_comment_time CHECK ((timestamp_sec IS NULL AND media_url IS NULL) OR (timestamp_sec IS NOT NULL AND timestamp_sec >= 0 AND media_url IS NOT NULL)),
  CONSTRAINT learning_comment_version CHECK (version > 0)
);
--> statement-breakpoint
CREATE TABLE learning_comment_moderation_0021 (
  id TEXT PRIMARY KEY NOT NULL REFERENCES operations(id),
  comment_id TEXT NOT NULL REFERENCES learning_comments_0021(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('hide','restore','report')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE learning_activity_events_0021 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    id TEXT UNIQUE NOT NULL,
    post_id TEXT NOT NULL REFERENCES learning_posts_0021(id),
    author_epoch INTEGER NOT NULL CHECK(author_epoch > 0),
    shared_at TEXT NOT NULL,
    revoked_at TEXT
);
--> statement-breakpoint
INSERT INTO learning_posts_0021 SELECT * FROM learning_posts;
--> statement-breakpoint
INSERT INTO learning_post_publications_0021 SELECT * FROM learning_post_publications;
--> statement-breakpoint
INSERT INTO learning_images_0021 SELECT * FROM learning_images;
--> statement-breakpoint
INSERT INTO learning_draft_images_0021 SELECT * FROM learning_draft_images;
--> statement-breakpoint
INSERT INTO learning_publication_images_0021 SELECT * FROM learning_publication_images;
--> statement-breakpoint
INSERT INTO topic_learning_associations_0021 SELECT * FROM topic_learning_associations;
--> statement-breakpoint
INSERT INTO learning_comments_0021 SELECT * FROM learning_comments;
--> statement-breakpoint
INSERT INTO learning_comment_moderation_0021 SELECT * FROM learning_comment_moderation;
--> statement-breakpoint
INSERT INTO learning_activity_events_0021 SELECT * FROM learning_activity_events;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='learning_activity_events_0021';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name, seq)
SELECT 'learning_activity_events_0021', seq FROM sqlite_sequence WHERE name='learning_activity_events';
--> statement-breakpoint
DROP TABLE learning_activity_events;
--> statement-breakpoint
DROP TABLE learning_comment_moderation;
--> statement-breakpoint
DROP TABLE learning_comments;
--> statement-breakpoint
DROP TABLE topic_learning_associations;
--> statement-breakpoint
DROP TABLE learning_publication_images;
--> statement-breakpoint
DROP TABLE learning_draft_images;
--> statement-breakpoint
DROP TABLE learning_images;
--> statement-breakpoint
DROP TABLE learning_post_publications;
--> statement-breakpoint
DROP TABLE learning_posts;
--> statement-breakpoint
ALTER TABLE learning_posts_0021 RENAME TO learning_posts;
--> statement-breakpoint
ALTER TABLE learning_post_publications_0021 RENAME TO learning_post_publications;
--> statement-breakpoint
ALTER TABLE learning_images_0021 RENAME TO learning_images;
--> statement-breakpoint
ALTER TABLE learning_draft_images_0021 RENAME TO learning_draft_images;
--> statement-breakpoint
ALTER TABLE learning_publication_images_0021 RENAME TO learning_publication_images;
--> statement-breakpoint
ALTER TABLE topic_learning_associations_0021 RENAME TO topic_learning_associations;
--> statement-breakpoint
ALTER TABLE learning_comments_0021 RENAME TO learning_comments;
--> statement-breakpoint
ALTER TABLE learning_comment_moderation_0021 RENAME TO learning_comment_moderation;
--> statement-breakpoint
ALTER TABLE learning_activity_events_0021 RENAME TO learning_activity_events;
--> statement-breakpoint
CREATE INDEX learning_posts_owner ON learning_posts(team_id, owner_id, updated_at, id);
--> statement-breakpoint
CREATE INDEX learning_publication_order ON learning_post_publications(published_at, post_id);
--> statement-breakpoint
CREATE INDEX learning_comment_post ON learning_comments(post_id, created_at, id);
--> statement-breakpoint
CREATE INDEX learning_comment_author ON learning_comments(author_id, created_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX learning_activity_current ON learning_activity_events(post_id, author_epoch) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX learning_activity_post ON learning_activity_events(post_id, author_epoch, sequence);

--> statement-breakpoint
ALTER TABLE trainings ADD COLUMN workspace_details TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE learning_posts ADD COLUMN workspace_details TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE learning_post_publications ADD COLUMN workspace_details TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE video_comments ADD COLUMN reference_times TEXT;
--> statement-breakpoint
ALTER TABLE learning_comments ADD COLUMN reference_times TEXT;
--> statement-breakpoint
ALTER TABLE trainings ADD COLUMN publisher_id TEXT REFERENCES users(id);
--> statement-breakpoint
WITH creators AS (
  SELECT o.target_id AS team, json_extract(o.result_json, '$.id') AS training,
         min(o.actor_id) AS publisher
  FROM operations o JOIN users u ON u.id=o.actor_id
  WHERE o.kind IN ('training', 'training-publish') AND o.status='done' AND json_valid(o.result_json)
  GROUP BY o.target_id, json_extract(o.result_json, '$.id')
  HAVING count(DISTINCT o.actor_id)=1
)
UPDATE trainings SET publisher_id=creators.publisher FROM creators
WHERE creators.training=trainings.id AND creators.team=trainings.team_id;
--> statement-breakpoint
CREATE TABLE material_assets (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_kind TEXT NOT NULL CHECK(parent_kind IN ('training','post')),
  parent_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>0),
  digest TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX material_assets_parent ON material_assets(parent_kind,parent_id);
--> statement-breakpoint
CREATE INDEX material_assets_team ON material_assets(team_id);
--> statement-breakpoint
CREATE TABLE training_discussions (
  id TEXT PRIMARY KEY NOT NULL,
  training_id TEXT NOT NULL REFERENCES trainings(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  root_id TEXT REFERENCES training_discussions(id),
  reply_to_id TEXT REFERENCES training_discussions(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX training_discussions_order ON training_discussions(training_id,created_at,id);
--> statement-breakpoint
CREATE VIEW material_storage_usage AS
SELECT team_id,max(bytes,reserved_bytes) AS bytes FROM uploads WHERE status NOT IN ('cancelled','rejected')
UNION ALL
SELECT team_id,bytes FROM material_assets WHERE NOT (parent_kind='training' AND mime LIKE 'video/%' AND ready=1);
