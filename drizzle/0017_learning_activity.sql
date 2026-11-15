CREATE TABLE learning_activity_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    id TEXT UNIQUE NOT NULL,
    post_id TEXT NOT NULL REFERENCES learning_posts(id),
    author_epoch INTEGER NOT NULL CHECK(author_epoch > 0),
    shared_at TEXT NOT NULL,
    revoked_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX learning_activity_current ON learning_activity_events(post_id, author_epoch) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX learning_activity_post ON learning_activity_events(post_id, author_epoch, sequence);
