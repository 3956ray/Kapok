CREATE TABLE collections_with_learning_sources (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    source_kind TEXT NOT NULL CONSTRAINT collection_kind CHECK(source_kind IN ('video','comment','reflection','learning_post','topic_collection')),
    source_id TEXT NOT NULL,
    timestamp_sec INTEGER,
    private_note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO collections_with_learning_sources (id,owner_id,source_kind,source_id,timestamp_sec,private_note,version,created_at,updated_at)
SELECT id,owner_id,source_kind,source_id,timestamp_sec,private_note,version,created_at,updated_at FROM collections;
--> statement-breakpoint
DROP TABLE collections;
--> statement-breakpoint
ALTER TABLE collections_with_learning_sources RENAME TO collections;
--> statement-breakpoint
CREATE UNIQUE INDEX collection_owner_source ON collections(owner_id,source_kind,source_id);
--> statement-breakpoint
ALTER TABLE reflections ADD COLUMN source_kind TEXT;
--> statement-breakpoint
ALTER TABLE reflections ADD COLUMN source_id TEXT CONSTRAINT reflection_source_ref CHECK (
    (source_kind IS NULL AND source_id IS NULL) OR
    (source_kind IS NOT NULL AND source_kind IN ('learning_post','topic_collection') AND source_id IS NOT NULL
        AND length(source_id) BETWEEN 1 AND 80 AND source_id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND training_id IS NULL AND video_id IS NULL)
);
