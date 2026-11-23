CREATE TABLE collections_with_training_sources (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    source_kind TEXT NOT NULL CONSTRAINT collection_kind CHECK(source_kind IN ('training','video','comment','reflection','learning_post','topic_collection')),
    source_id TEXT NOT NULL,
    timestamp_sec INTEGER,
    private_note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO collections_with_training_sources (id,owner_id,source_kind,source_id,timestamp_sec,private_note,version,created_at,updated_at)
SELECT id,owner_id,source_kind,source_id,timestamp_sec,private_note,version,created_at,updated_at FROM collections;
--> statement-breakpoint
DROP TABLE collections;
--> statement-breakpoint
ALTER TABLE collections_with_training_sources RENAME TO collections;
--> statement-breakpoint
CREATE UNIQUE INDEX collection_owner_source ON collections(owner_id,source_kind,source_id);
--> statement-breakpoint
ALTER TABLE reflections ADD COLUMN category TEXT CHECK (category IS NULL OR length(category) BETWEEN 1 AND 20);
