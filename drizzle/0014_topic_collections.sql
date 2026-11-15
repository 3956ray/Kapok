CREATE TABLE topic_collections (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id),
    owner_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX topic_collections_owner ON topic_collections(team_id,owner_id,updated_at,id);
--> statement-breakpoint
CREATE TABLE topic_collection_publications (
    collection_id TEXT PRIMARY KEY NOT NULL REFERENCES topic_collections(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    author_epoch INTEGER NOT NULL CHECK (author_epoch > 0),
    visibility_id TEXT NOT NULL,
    published_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE topic_collection_items (
    collection_id TEXT NOT NULL REFERENCES topic_collections(id),
    snapshot INTEGER NOT NULL CHECK (snapshot IN (0,1)),
    kind TEXT NOT NULL CHECK (kind IN ('post','video')),
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (collection_id,snapshot,kind,source_id),
    UNIQUE (collection_id,snapshot,position)
);
--> statement-breakpoint
CREATE TABLE topic_featured (
    team_id TEXT PRIMARY KEY NOT NULL REFERENCES teams(id),
    version INTEGER NOT NULL CHECK (version > 0),
    choices TEXT NOT NULL CHECK (json_valid(choices) AND json_type(choices)='array')
);
--> statement-breakpoint
CREATE TABLE topic_learning_associations (
    post_id TEXT NOT NULL REFERENCES learning_posts(id),
    published_version INTEGER NOT NULL CHECK (published_version > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','added-draft','added-published')),
    PRIMARY KEY (post_id,published_version)
);
