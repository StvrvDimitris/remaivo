CREATE TABLE `v3_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`bucket_id` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v3_assignments_user_id_transaction_id_bucket_id_unique` ON `v3_assignments` (`user_id`,`transaction_id`,`bucket_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `v3_bucket_periods_period_id_bucket_id_unique` ON `v3_bucket_periods` (`period_id`,`bucket_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `v3_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `v3_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `v3_migrations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`snapshot_json` text NOT NULL,
	`summary_json` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `v3_occurrences_user_id_source_kind_source_id_scheduled_date_unique` ON `v3_occurrences` (`user_id`,`source_kind`,`source_id`,`scheduled_date`);--> statement-breakpoint
CREATE INDEX `v3_occurrence_user` ON `v3_occurrences` (`user_id`,`status`,`due_date`);--> statement-breakpoint
CREATE TABLE `v3_opening_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `v3_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`version_id` text NOT NULL,
	`funding_cents` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `v3_periods_user_id_start_date_end_date_unique` ON `v3_periods` (`user_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `v3_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `v3_versions_user` ON `v3_versions` (`user_id`,`effective_from`);