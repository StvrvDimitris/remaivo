CREATE TABLE `goal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_goal_entries_user_goal_date` ON `goal_entries` (`user_id`,`goal_id`,`date`);--> statement-breakpoint
ALTER TABLE `goals` ADD `tracking_mode` text DEFAULT 'total' NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `start_date` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `end_date` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `baseline_cents` integer DEFAULT 0 NOT NULL;