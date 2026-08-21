CREATE TABLE `investment_valuation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`value_cents` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_investment_snapshots_user_account_date` ON `investment_valuation_snapshots` (`user_id`,`account_id`,`snapshot_date`);