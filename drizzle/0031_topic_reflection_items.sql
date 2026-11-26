CREATE TABLE topic_collection_items_with_reflections (
    collection_id TEXT NOT NULL REFERENCES topic_collections(id),
    snapshot INTEGER NOT NULL CHECK (snapshot IN (0,1)),
    kind TEXT NOT NULL CHECK (kind IN ('post','video','training','reflection')),
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (collection_id,snapshot,kind,source_id),
    UNIQUE (collection_id,snapshot,position)
);
--> statement-breakpoint
INSERT INTO topic_collection_items_with_reflections(collection_id,snapshot,kind,source_id,position)
SELECT collection_id,snapshot,kind,source_id,position FROM topic_collection_items;
--> statement-breakpoint
DROP TABLE topic_collection_items;
--> statement-breakpoint
ALTER TABLE topic_collection_items_with_reflections RENAME TO topic_collection_items;
