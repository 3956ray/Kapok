ALTER TABLE `uploads` ADD `cleanup_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `cleanup_target` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `cleanup_error` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `transfer_active` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `uploads` ADD `multipart_id` text;