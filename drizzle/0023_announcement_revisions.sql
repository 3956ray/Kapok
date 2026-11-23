ALTER TABLE announcements ADD COLUMN revision_title TEXT;
--> statement-breakpoint
ALTER TABLE announcements ADD COLUMN revision_text TEXT;
--> statement-breakpoint
ALTER TABLE announcements ADD COLUMN revision_version INTEGER;
