CREATE TABLE learning_posts (
  id TEXT PRIMARY KEY NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('article','video')),
  category TEXT NOT NULL CHECK (category IN ('战术','基本功','基本概念')),
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
    OR (kind='video' AND video_source IS NOT NULL AND video_source IN ('youtube','bilibili') AND video_url IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX learning_posts_owner ON learning_posts(team_id, owner_id, updated_at, id);
--> statement-breakpoint
CREATE TABLE learning_post_publications (
  post_id TEXT PRIMARY KEY NOT NULL REFERENCES learning_posts(id),
  kind TEXT NOT NULL CHECK (kind IN ('article','video')),
  category TEXT NOT NULL CHECK (category IN ('战术','基本功','基本概念')),
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
    OR (kind='video' AND video_source IS NOT NULL AND video_source IN ('youtube','bilibili') AND video_url IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX learning_publication_order ON learning_post_publications(published_at, post_id);
--> statement-breakpoint
CREATE TABLE learning_images (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES learning_posts(id),
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
CREATE TABLE learning_draft_images (
  post_id TEXT NOT NULL REFERENCES learning_posts(id),
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  alt TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0,1) AND (decorative=0 OR alt='')),
  PRIMARY KEY (post_id, image_id),
  UNIQUE(post_id, position),
  FOREIGN KEY (post_id, image_id) REFERENCES learning_images(post_id, id)
);
--> statement-breakpoint
CREATE TABLE learning_publication_images (
  post_id TEXT NOT NULL REFERENCES learning_post_publications(post_id),
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  alt TEXT NOT NULL DEFAULT '',
  decorative INTEGER NOT NULL DEFAULT 0 CHECK (decorative IN (0,1) AND (decorative=0 OR alt='')),
  PRIMARY KEY (post_id, image_id),
  UNIQUE(post_id, position),
  FOREIGN KEY (post_id, image_id) REFERENCES learning_images(post_id, id)
);
