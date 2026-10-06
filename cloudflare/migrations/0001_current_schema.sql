-- Current finance schema. New Cloudflare installations need no legacy tables.
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`credit_limit_cents` integer,
	`color` text DEFAULT '#1f5b4e' NOT NULL,
	`include_spendable` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`color` text DEFAULT '#cfe9d7' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `goal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

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
, `tracking_mode` text DEFAULT 'total' NOT NULL, `start_date` text, `end_date` text, `baseline_cents` integer DEFAULT 0 NOT NULL);

CREATE TABLE `installment_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`due_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL);

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
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
, `auto_post` integer DEFAULT false NOT NULL);

CREATE TABLE `investment_valuation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`value_cents` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`week_start` integer DEFAULT 1 NOT NULL,
	`setup_complete` integer DEFAULT false NOT NULL,
	`spare_multiplier` integer DEFAULT 1 NOT NULL,
	`spare_destination_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
, `timezone` text DEFAULT 'UTC' NOT NULL, `spare_enabled` integer DEFAULT false NOT NULL, `spare_source_id` text, `spare_auto_sweep_threshold_cents` integer DEFAULT 0 NOT NULL, `ui_theme` text DEFAULT 'indigo' NOT NULL, `default_expense_account_id` text);

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
, `anchor_day` integer DEFAULT 1 NOT NULL);

CREATE TABLE `spare_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`multiplied_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

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
	`counts_monthly` integer DEFAULT true NOT NULL,
	`recurring_plan_id` text,
	`installment_plan_id` text,
	`spare_change_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
, `replaces_transaction_id` text, `spare_excluded` integer DEFAULT false NOT NULL);

CREATE TABLE `v3_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`bucket_id` text NOT NULL,
	`amount_cents` integer NOT NULL
);

CREATE TABLE `v3_bucket_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`period_id` text NOT NULL,
	`bucket_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`category_id` text,
	`target_cents` integer NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`rollover` text DEFAULT 'none' NOT NULL,
	`rollover_cap` integer DEFAULT 0 NOT NULL,
	`destination_id` text,
	`released` integer DEFAULT 0 NOT NULL
);

CREATE TABLE `v3_bucket_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`category_id` text,
	`target_cents` integer NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`rollover` text DEFAULT 'none' NOT NULL,
	`rollover_cap` integer DEFAULT 0 NOT NULL,
	`destination_id` text,
	`archived` integer DEFAULT 0 NOT NULL
);

CREATE TABLE `v3_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `v3_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`due_date` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`destination_account_id` text,
	`category_id` text,
	`committed` integer DEFAULT 1 NOT NULL,
	`auto_post` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`transaction_id` text,
	`settlement_token` text
);

CREATE TABLE `v3_payment_links` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`occurrence_id` text NOT NULL
);

CREATE TABLE `v3_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`version_id` text NOT NULL,
	`funding_cents` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE `v3_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX `idx_accounts_user_active` ON `accounts` (`user_id`,`archived`);

CREATE INDEX `idx_categories_user_kind` ON `categories` (`user_id`,`kind`);

CREATE UNIQUE INDEX `idx_categories_user_name_kind` ON `categories` (`user_id`,`name`,`kind`);

CREATE INDEX `idx_goal_entries_user_goal_date` ON `goal_entries` (`user_id`,`goal_id`,`date`);

CREATE INDEX `idx_goals_user_kind` ON `goals` (`user_id`,`kind`);

CREATE UNIQUE INDEX `idx_installment_payments_plan_sequence` ON `installment_payments` (`plan_id`,`sequence`);

CREATE INDEX `idx_installment_payments_user_due` ON `installment_payments` (`user_id`,`due_date`);

CREATE INDEX `idx_installment_plans_user_status` ON `installment_plans` (`user_id`,`status`);

CREATE INDEX `idx_investment_snapshots_user_account_date` ON `investment_valuation_snapshots` (`user_id`,`account_id`,`snapshot_date`);

CREATE INDEX `idx_recurring_user_next` ON `recurring_plans` (`user_id`,`next_date`);

CREATE INDEX `idx_spare_events_user_status` ON `spare_events` (`user_id`,`status`);

CREATE INDEX `idx_transactions_user_account` ON `transactions` (`user_id`,`account_id`);

CREATE INDEX `idx_transactions_user_date` ON `transactions` (`user_id`,`date`);

CREATE INDEX `idx_transactions_user_status_category_date` ON `transactions` (`user_id`,`status`,`category_id`,`date`);

CREATE INDEX `idx_transactions_user_status_date` ON `transactions` (`user_id`,`status`,`date`);

CREATE UNIQUE INDEX `v3_assignments_user_id_transaction_id_bucket_id_unique` ON `v3_assignments` (`user_id`,`transaction_id`,`bucket_id`);

CREATE UNIQUE INDEX `v3_bucket_periods_period_id_bucket_id_unique` ON `v3_bucket_periods` (`period_id`,`bucket_id`);

CREATE INDEX `v3_occurrence_user` ON `v3_occurrences` (`user_id`,`status`,`due_date`);

CREATE UNIQUE INDEX `v3_occurrences_user_id_source_kind_source_id_scheduled_date_unique` ON `v3_occurrences` (`user_id`,`source_kind`,`source_id`,`scheduled_date`);

CREATE UNIQUE INDEX `v3_periods_user_id_start_date_end_date_unique` ON `v3_periods` (`user_id`,`start_date`,`end_date`);

CREATE INDEX `v3_versions_user` ON `v3_versions` (`user_id`,`effective_from`);
