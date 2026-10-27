CREATE TABLE reflections (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=60),
    text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 5000),
    date TEXT NOT NULL,
    training_id TEXT REFERENCES trainings(id),
    video_id TEXT REFERENCES videos(id),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
    sharing_version INTEGER NOT NULL DEFAULT 1 CHECK(sharing_version>0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
    gate TEXT NOT NULL DEFAULT 'closed' CHECK(gate IN ('open','closed')),
    active_op_id TEXT,
    last_committed_op_id TEXT,
    scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','team','coach')),
    coach_id TEXT REFERENCES users(id),
    coach_epoch INTEGER,
    author_epoch INTEGER,
    published_at TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK((scope='coach' AND coach_id IS NOT NULL AND coach_epoch IS NOT NULL) OR (scope!='coach' AND coach_id IS NULL AND coach_epoch IS NULL)),
    CHECK(published_at IS NULL OR scope='team'),
    CHECK(gate='closed' OR (scope!='private' AND deleted_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX reflection_owner_date ON reflections(owner_id,date,id);
--> statement-breakpoint
CREATE INDEX reflection_team_scope ON reflections(team_id,scope,published_at,id);
--> statement-breakpoint
ALTER TABLE collections RENAME TO collections_before_reflections;
--> statement-breakpoint
CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('video','comment','reflection')),
    source_id TEXT NOT NULL,
    timestamp_sec INTEGER,
    private_note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO collections SELECT * FROM collections_before_reflections;
--> statement-breakpoint
DROP TABLE collections_before_reflections;
--> statement-breakpoint
CREATE UNIQUE INDEX collection_owner_source ON collections(owner_id,source_kind,source_id);
--> statement-breakpoint
CREATE TABLE announcements (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 5000),
    status TEXT NOT NULL CHECK(status IN ('draft','published','deleted')),
    version INTEGER NOT NULL DEFAULT 1,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_op_id TEXT
);
--> statement-breakpoint
CREATE TABLE video_events (
    video_id TEXT PRIMARY KEY NOT NULL REFERENCES videos(id),
    published_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO video_events(video_id,published_at) SELECT v.id,v.created_at FROM videos v JOIN trainings t ON t.id=v.training_id WHERE v.status='active' AND t.status='published';
--> statement-breakpoint
CREATE TRIGGER video_first_readable AFTER INSERT ON videos
WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM trainings WHERE id=NEW.training_id AND status='published')
BEGIN
    INSERT OR IGNORE INTO video_events(video_id,published_at) VALUES(NEW.id,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER training_first_readable AFTER UPDATE OF status ON trainings
WHEN NEW.status='published'
BEGIN
    INSERT OR IGNORE INTO video_events(video_id,published_at) SELECT id,NEW.updated_at FROM videos WHERE training_id=NEW.id AND status='active';
END;
--> statement-breakpoint
CREATE TRIGGER video_restored_readable AFTER UPDATE OF status ON videos
WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM trainings WHERE id=NEW.training_id AND status='published')
BEGIN
    INSERT OR IGNORE INTO video_events(video_id,published_at) VALUES(NEW.id,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER membership_reflection_revocation AFTER UPDATE OF status,epoch,role ON memberships
BEGIN
    UPDATE reflections SET scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,
        published_at=NULL,gate='closed',active_op_id=NULL,sharing_version=sharing_version+1
    WHERE (owner_id=NEW.user_id AND (NEW.status!='active' OR NEW.epoch!=OLD.epoch))
       OR (coach_id=NEW.user_id AND (NEW.status!='active' OR NEW.epoch!=OLD.epoch OR NEW.role!='coach'));
END;
--> statement-breakpoint
CREATE TRIGGER user_reflection_revocation AFTER UPDATE OF status ON users
WHEN NEW.status!='active'
BEGIN
    UPDATE reflections SET scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,
        published_at=NULL,gate='closed',active_op_id=NULL,sharing_version=sharing_version+1
    WHERE owner_id=NEW.id OR coach_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER membership_delete_reflection_revocation AFTER DELETE ON memberships
BEGIN
    UPDATE reflections SET scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,
        published_at=NULL,gate='closed',active_op_id=NULL,sharing_version=sharing_version+1
    WHERE owner_id=OLD.user_id OR coach_id=OLD.user_id;
END;
