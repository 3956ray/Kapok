-- Apply this entire file as one D1 transaction with foreign key enforcement enabled.
-- The parent table is replaced in place so its incoming references retain the same name.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `videos_0012` (
	`id` text PRIMARY KEY NOT NULL,
	`training_id` text NOT NULL,
	`team_id` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`url` text,
	`upload_id` text,
	`position` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`publisher_id` text REFERENCES users(id),
	FOREIGN KEY (`training_id`) REFERENCES `trainings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "video_source" CHECK("videos_0012"."source" IN ('bilibili','youtube','upload')),
	CONSTRAINT "video_status" CHECK("videos_0012"."status" IN ('active','hidden','deleted'))
);
--> statement-breakpoint
INSERT INTO videos_0012 (id,training_id,team_id,title,source,url,upload_id,position,status,version,created_at,updated_at,publisher_id)
SELECT id,training_id,team_id,title,source,url,upload_id,position,status,version,created_at,updated_at,publisher_id FROM videos;
--> statement-breakpoint
DROP TRIGGER training_first_readable;
--> statement-breakpoint
DROP TABLE videos;
--> statement-breakpoint
ALTER TABLE videos_0012 RENAME TO videos;
--> statement-breakpoint
CREATE UNIQUE INDEX videos_upload_id_unique ON videos (upload_id);
--> statement-breakpoint
CREATE INDEX video_training_order ON videos (training_id,position,id);
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
-- SQLite's deferred counters remember the old DROP despite the restored parent.
-- Check the whole resulting graph before clearing those counters in this transaction.
CREATE TABLE video_platforms_0012_guard (pass INTEGER NOT NULL CHECK(pass=1));
--> statement-breakpoint
INSERT INTO video_platforms_0012_guard (pass) SELECT NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
--> statement-breakpoint
DROP TABLE video_platforms_0012_guard;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
