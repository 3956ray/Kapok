CREATE TABLE team_bulletins (
    team_id TEXT PRIMARY KEY NOT NULL REFERENCES teams(id),
    selection TEXT,
    version INTEGER NOT NULL CHECK (version > 0)
);
--> statement-breakpoint
ALTER TABLE trainings ADD COLUMN bulletin_epoch INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE videos ADD COLUMN bulletin_epoch INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE learning_posts ADD COLUMN bulletin_epoch INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TRIGGER training_bulletin_revoke AFTER UPDATE OF status ON trainings
WHEN OLD.status IN ('published','archived') AND NEW.status NOT IN ('published','archived')
BEGIN UPDATE trainings SET bulletin_epoch=OLD.bulletin_epoch+1 WHERE id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER video_bulletin_revoke AFTER UPDATE OF status ON videos
WHEN OLD.status='active' AND NEW.status<>'active'
BEGIN UPDATE videos SET bulletin_epoch=OLD.bulletin_epoch+1 WHERE id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER learning_bulletin_revoke AFTER UPDATE OF status ON learning_posts
WHEN OLD.status='published' AND NEW.status<>'published'
BEGIN UPDATE learning_posts SET bulletin_epoch=OLD.bulletin_epoch+1 WHERE id=NEW.id; END;
--> statement-breakpoint
ALTER TABLE video_comments ADD COLUMN bulletin_epoch INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TRIGGER video_comments_bulletin_revoke AFTER UPDATE OF status ON video_comments
WHEN OLD.status='active' AND NEW.status<>'active'
BEGIN UPDATE video_comments SET bulletin_epoch=OLD.bulletin_epoch+1 WHERE id=NEW.id; END;
--> statement-breakpoint
ALTER TABLE learning_comments ADD COLUMN bulletin_epoch INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TRIGGER learning_comments_bulletin_revoke AFTER UPDATE OF status ON learning_comments
WHEN OLD.status='active' AND NEW.status<>'active'
BEGIN UPDATE learning_comments SET bulletin_epoch=OLD.bulletin_epoch+1 WHERE id=NEW.id; END;
