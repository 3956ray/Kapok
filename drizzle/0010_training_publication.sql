ALTER TABLE `video_comments` ADD `reply_to_id` text REFERENCES video_comments(id);--> statement-breakpoint
ALTER TABLE `videos` ADD `publisher_id` text REFERENCES users(id);