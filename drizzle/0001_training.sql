CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`timestamp_sec` integer,
	`private_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collection_kind" CHECK("collections"."source_kind" IN ('video','comment'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_owner_source` ON `collections` (`owner_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `comment_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `video_comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `moderation_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trainings` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "training_title" CHECK(length("trainings"."title") BETWEEN 1 AND 80),
	CONSTRAINT "training_status" CHECK("trainings"."status" IN ('draft','published','archived','hidden','deleted'))
);
--> statement-breakpoint
CREATE INDEX `training_team_date` ON `trainings` (`team_id`,`date`,`id`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text NOT NULL,
	`object_key` text,
	`content_key` text,
	`mime` text,
	`duration_sec` real,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_bytes" CHECK("uploads"."bytes">0),
	CONSTRAINT "upload_status" CHECK("uploads"."status" IN ('pending','receiving','received','ready','rejected','cancelled'))
);
--> statement-breakpoint
CREATE TABLE `video_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`team_id` text NOT NULL,
	`author_id` text NOT NULL,
	`root_id` text,
	`text` text NOT NULL,
	`timestamp_sec` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `video_comments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comment_status" CHECK("video_comments"."status" IN ('active','hidden','deleted'))
);
--> statement-breakpoint
CREATE INDEX `comment_video` ON `video_comments` (`video_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `videos` (
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
	FOREIGN KEY (`training_id`) REFERENCES `trainings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "video_source" CHECK("videos"."source" IN ('bilibili','upload')),
	CONSTRAINT "video_status" CHECK("videos"."status" IN ('active','hidden','deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_upload_id_unique` ON `videos` (`upload_id`);--> statement-breakpoint
CREATE INDEX `video_training_order` ON `videos` (`training_id`,`position`,`id`);