CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "identity_provider" CHECK("auth_identities"."provider"='site')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_subject` ON `auth_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_user` ON `auth_identities` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `bootstraps` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`op_id` text NOT NULL,
	`initialized_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bootstrap_slot" CHECK("bootstraps"."id"='site')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_team` ON `bootstraps` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_operation` ON `bootstraps` (`op_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`max_uses` integer NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	`recipient_subject` text,
	`last_op_id` text,
	`created_by` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_op_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invite_max" CHECK("invites"."max_uses">0),
	CONSTRAINT "invite_used" CHECK("invites"."used_count">=0 AND "invites"."used_count"<="invites"."max_uses"),
	CONSTRAINT "invite_revoked" CHECK("invites"."revoked" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `join_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`invite_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`epoch` integer NOT NULL,
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invite_id`) REFERENCES `invites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_epoch" CHECK("join_receipts"."epoch">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_operation` ON `join_receipts` (`op_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_member_epoch` ON `join_receipts` (`membership_id`,`epoch`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`epoch` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "membership_role" CHECK("memberships"."role" IN ('admin','coach','member')),
	CONSTRAINT "membership_status" CHECK("memberships"."status" IN ('active','paused','left')),
	CONSTRAINT "membership_epoch" CHECK("memberships"."epoch">0),
	CONSTRAINT "membership_version" CHECK("memberships"."version">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_team_user` ON `memberships` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`key` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	CONSTRAINT "operation_status" CHECK("operations"."status" IN ('pending','done','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_key` ON `operations` (`actor_id`,`kind`,`target_id`,`key`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`disc_name` text NOT NULL,
	`jersey_number` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profile_disc_name" CHECK(length("profiles"."disc_name") BETWEEN 1 AND 20),
	CONSTRAINT "profile_jersey" CHECK(length("profiles"."jersey_number") BETWEEN 1 AND 4),
	CONSTRAINT "profile_version" CHECK("profiles"."version">0)
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "team_slot" CHECK("teams"."singleton"=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_singleton` ON `teams` (`singleton`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "users_status" CHECK("users"."status" IN ('active','deleted')),
	CONSTRAINT "users_version" CHECK("users"."version">0)
);
--> statement-breakpoint
CREATE TABLE `write_guards` (
	`op_id` text NOT NULL,
	`phase` text NOT NULL,
	`pass` integer NOT NULL,
	PRIMARY KEY(`op_id`, `phase`),
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "write_guard_pass" CHECK("write_guards"."pass"=1)
);
