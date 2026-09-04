CREATE TABLE `expense_reserve_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reserve_id` text NOT NULL,
	`category_id` text NOT NULL,
	`month` text NOT NULL,
	`target_cents` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`finished_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_expense_reserve_periods_reserve_month` ON `expense_reserve_periods` (`reserve_id`,`month`);--> statement-breakpoint
CREATE INDEX `idx_expense_reserve_periods_user_month` ON `expense_reserve_periods` (`user_id`,`month`);--> statement-breakpoint
CREATE TABLE `expense_reserves` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`category_id` text NOT NULL,
	`target_cents` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_expense_reserves_user_active` ON `expense_reserves` (`user_id`,`active`);