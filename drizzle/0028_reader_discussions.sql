ALTER TABLE reflections ADD COLUMN discussion_epoch INTEGER NOT NULL DEFAULT 1 CHECK(discussion_epoch>0);
--> statement-breakpoint
ALTER TABLE announcements ADD COLUMN discussion_epoch INTEGER NOT NULL DEFAULT 1 CHECK(discussion_epoch>0);
--> statement-breakpoint
CREATE TRIGGER reflection_discussion_revoke AFTER UPDATE OF scope,deleted_at,author_epoch ON reflections
WHEN OLD.scope='team' AND OLD.deleted_at IS NULL AND
    (NEW.scope!='team' OR NEW.deleted_at IS NOT NULL OR NEW.author_epoch IS NOT OLD.author_epoch)
BEGIN
    UPDATE reflections SET discussion_epoch=OLD.discussion_epoch+1 WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER announcement_discussion_revoke AFTER UPDATE OF status ON announcements
WHEN OLD.status='published' AND NEW.status!='published'
BEGIN
    UPDATE announcements SET discussion_epoch=OLD.discussion_epoch+1 WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TABLE reader_discussions (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id),
    source_kind TEXT NOT NULL CHECK(source_kind IN ('reflection','announcement')),
    source_id TEXT NOT NULL,
    discussion_epoch INTEGER NOT NULL CHECK(discussion_epoch>0),
    author_id TEXT NOT NULL REFERENCES users(id),
    root_id TEXT REFERENCES reader_discussions(id),
    reply_to_id TEXT REFERENCES reader_discussions(id),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
    created_at TEXT NOT NULL,
    CHECK((root_id IS NULL)=(reply_to_id IS NULL)),
    CHECK((status='active' AND length(body) BETWEEN 1 AND 2000) OR (status='deleted' AND body=''))
);
--> statement-breakpoint
CREATE INDEX reader_discussions_source ON reader_discussions(team_id,source_kind,source_id,discussion_epoch,created_at,id);
--> statement-breakpoint
CREATE INDEX reader_discussions_author ON reader_discussions(author_id,created_at,id);
--> statement-breakpoint
CREATE INDEX reader_discussions_feed ON reader_discussions(team_id,created_at,id) WHERE status='active';
