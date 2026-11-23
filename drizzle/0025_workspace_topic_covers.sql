CREATE TABLE workspace_topic_cover_revisions (
    collection_id TEXT NOT NULL REFERENCES topic_collections(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0),
    digest TEXT,
    image TEXT,
    PRIMARY KEY(collection_id, version),
    CHECK((digest IS NULL AND image IS NULL) OR
          (digest IS NOT NULL AND length(digest) = 64 AND image IS NOT NULL AND length(image) BETWEEN 1 AND 410000))
);
