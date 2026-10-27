CREATE TABLE `upload_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_id` text NOT NULL,
	`kind` text NOT NULL,
	`part_number` integer NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`multipart_id` text,
	`completed_parts` integer DEFAULT 0 NOT NULL,
	`generation` integer NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_attempt_kind" CHECK("upload_attempts"."kind" IN ('part','assembly')),
	CONSTRAINT "upload_attempt_state" CHECK("upload_attempts"."state" IN ('pending','committed','garbage','deleted')),
	CONSTRAINT "upload_attempt_active" CHECK("upload_attempts"."active" IN (0,1)),
	CONSTRAINT "upload_attempt_bytes" CHECK("upload_attempts"."bytes">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_attempt_key` ON `upload_attempts` (`object_key`);--> statement-breakpoint
CREATE INDEX `upload_attempt_upload` ON `upload_attempts` (`upload_id`,`kind`,`part_number`);--> statement-breakpoint
CREATE TABLE `upload_parts` (
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`attempt_id` text,
	`digest` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`upload_id`, `part_number`),
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `upload_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_part_number" CHECK("upload_parts"."part_number">0)
);
--> statement-breakpoint
ALTER TABLE `uploads` ADD `protocol_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `manifest_json` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `received_parts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `lease_until` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `reserved_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `assembly_id` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `validation_state` text;
--> statement-breakpoint
UPDATE uploads SET reserved_bytes=bytes;
--> statement-breakpoint
CREATE INDEX upload_team_lease ON uploads(team_id,lease_until);
--> statement-breakpoint
CREATE TABLE `upload_assembly_parts` (
	`attempt_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	PRIMARY KEY(`attempt_id`, `part_number`),
	FOREIGN KEY (`attempt_id`) REFERENCES `upload_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assembly_part_number" CHECK("upload_assembly_parts"."part_number">0),
	CONSTRAINT "assembly_etag" CHECK(length("upload_assembly_parts"."etag") BETWEEN 1 AND 1024)
);

--> statement-breakpoint
CREATE INDEX upload_attempt_active ON upload_attempts(active,upload_id);
--> statement-breakpoint
CREATE INDEX upload_attempt_cleanup ON upload_attempts(upload_id,state,id);
