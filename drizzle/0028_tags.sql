CREATE TABLE `tag_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tag_groups_user_name` ON `tag_groups` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#cfe9d7' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tags_user_group_name` ON `tags` (`user_id`,`group_id`,`name`);--> statement-breakpoint
ALTER TABLE `installment_plans` ADD `tag_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_plans` ADD `tag_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `tag_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `v3_bucket_periods` ADD `tag_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `v3_bucket_templates` ADD `tag_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `v3_occurrences` ADD `tag_ids` text DEFAULT '[]' NOT NULL;