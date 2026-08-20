CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`credit_limit_cents` integer,
	`color` text DEFAULT '#1f5b4e' NOT NULL,
	`icon` text DEFAULT 'wallet' NOT NULL,
	`include_spendable` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_accounts_user_active` ON `accounts` (`user_id`,`archived`);--> statement-breakpoint
CREATE TABLE `budget_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`period` text NOT NULL,
	`base_cents` integer DEFAULT 0 NOT NULL,
	`carry_mode` text DEFAULT 'reset' NOT NULL,
	`carry_cap_cents` integer,
	`anchor_date` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_budget_rules_user_period` ON `budget_rules` (`user_id`,`period`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`color` text DEFAULT '#cfe9d7' NOT NULL,
	`icon` text DEFAULT 'circle' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_categories_user_kind` ON `categories` (`user_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_categories_user_name_kind` ON `categories` (`user_id`,`name`,`kind`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target_cents` integer,
	`contributed_cents` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`color` text DEFAULT '#dff35f' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_goals_user_kind` ON `goals` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `installment_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`due_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`paid_transaction_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_installment_payments_user_due` ON `installment_payments` (`user_id`,`due_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_installment_payments_plan_sequence` ON `installment_payments` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`provider` text,
	`category_id` text,
	`total_cents` integer NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`installment_count` integer NOT NULL,
	`first_due_date` text NOT NULL,
	`frequency` text DEFAULT 'monthly' NOT NULL,
	`payment_account_id` text NOT NULL,
	`linked_credit_account_id` text,
	`include_daily_weekly` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_installment_plans_user_status` ON `installment_plans` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`week_start` integer DEFAULT 1 NOT NULL,
	`setup_complete` integer DEFAULT false NOT NULL,
	`spare_multiplier` integer DEFAULT 1 NOT NULL,
	`spare_destination_id` text,
	`spare_sweep_mode` text DEFAULT 'threshold' NOT NULL,
	`spare_threshold_cents` integer DEFAULT 1000 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`account_id` text,
	`destination_account_id` text,
	`category_id` text,
	`frequency` text NOT NULL,
	`interval_count` integer DEFAULT 1 NOT NULL,
	`next_date` text NOT NULL,
	`end_date` text,
	`auto_post` integer DEFAULT false NOT NULL,
	`committed` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recurring_user_next` ON `recurring_plans` (`user_id`,`next_date`);--> statement-breakpoint
CREATE TABLE `spare_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`destination_account_id` text,
	`base_cents` integer NOT NULL,
	`multiplied_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_spare_events_user_status` ON `spare_events` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text,
	`destination_account_id` text,
	`category_id` text,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'posted' NOT NULL,
	`committed` integer DEFAULT false NOT NULL,
	`counts_daily` integer DEFAULT true NOT NULL,
	`counts_weekly` integer DEFAULT true NOT NULL,
	`counts_monthly` integer DEFAULT true NOT NULL,
	`counts_general` integer DEFAULT true NOT NULL,
	`recurring_plan_id` text,
	`installment_plan_id` text,
	`spare_change_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_user_date` ON `transactions` (`user_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_user_account` ON `transactions` (`user_id`,`account_id`);