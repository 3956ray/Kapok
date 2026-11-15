CREATE TABLE learning_comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES learning_posts(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  root_id TEXT REFERENCES learning_comments(id),
  reply_to_id TEXT REFERENCES learning_comments(id),
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
CREATE INDEX learning_comment_post ON learning_comments(post_id, created_at, id);
--> statement-breakpoint
CREATE INDEX learning_comment_author ON learning_comments(author_id, created_at, id);
--> statement-breakpoint
CREATE TABLE learning_comment_moderation (
  id TEXT PRIMARY KEY NOT NULL REFERENCES operations(id),
  comment_id TEXT NOT NULL REFERENCES learning_comments(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('hide','restore','report')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
