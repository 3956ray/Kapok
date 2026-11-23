ALTER TABLE topic_collections ADD COLUMN category TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE topic_collection_publications ADD COLUMN category TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE topic_collection_items_workspace (
    collection_id TEXT NOT NULL REFERENCES topic_collections(id),
    snapshot INTEGER NOT NULL CHECK (snapshot IN (0,1)),
    kind TEXT NOT NULL CHECK (kind IN ('post','video','training')),
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (collection_id,snapshot,kind,source_id),
    UNIQUE (collection_id,snapshot,position)
);
--> statement-breakpoint
INSERT INTO topic_collection_items_workspace SELECT collection_id,snapshot,kind,source_id,position FROM topic_collection_items;
--> statement-breakpoint
DROP TABLE topic_collection_items;
--> statement-breakpoint
ALTER TABLE topic_collection_items_workspace RENAME TO topic_collection_items;
--> statement-breakpoint
CREATE TABLE workspace_topic_shares (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL REFERENCES topic_collections(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    visibility_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL,
    published_at TEXT NOT NULL,
    items TEXT NOT NULL CHECK (json_valid(items)),
    UNIQUE(collection_id, version)
);
