CREATE TABLE `__new_auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "identity_provider" CHECK("__new_auth_identities"."provider" IN ('site','access')),
	CONSTRAINT "identity_issuer" CHECK(length("__new_auth_identities"."issuer")>0),
	CONSTRAINT "identity_subject_nonempty" CHECK(length("__new_auth_identities"."subject")>0)
);
--> statement-breakpoint
INSERT INTO `__new_auth_identities`("id", "provider", "issuer", "subject", "user_id") SELECT "id", "provider", 'sites:legacy', "subject", "user_id" FROM `auth_identities`;--> statement-breakpoint
DROP TABLE `auth_identities`;--> statement-breakpoint
ALTER TABLE `__new_auth_identities` RENAME TO `auth_identities`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_subject` ON `auth_identities` (`provider`,`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_user` ON `auth_identities` (`user_id`,`provider`,`issuer`);
