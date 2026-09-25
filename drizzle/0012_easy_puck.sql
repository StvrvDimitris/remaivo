DROP TABLE `budget_rules`;--> statement-breakpoint
DROP TABLE `expense_reserve_periods`;--> statement-breakpoint
DROP TABLE `expense_reserves`;--> statement-breakpoint
DROP TABLE `forecast_scenarios`;--> statement-breakpoint
DROP TABLE `v3_ledger_entries`;--> statement-breakpoint
DROP TABLE `v3_migrations`;--> statement-breakpoint
DROP TABLE `v3_opening_anchors`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `opening_balance_cents`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `icon`;--> statement-breakpoint
ALTER TABLE `categories` DROP COLUMN `icon`;--> statement-breakpoint
ALTER TABLE `installment_payments` DROP COLUMN `paid_transaction_id`;--> statement-breakpoint
ALTER TABLE `installment_plans` DROP COLUMN `include_daily_weekly`;--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `spare_sweep_mode`;--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `spare_threshold_cents`;--> statement-breakpoint
ALTER TABLE `spare_events` DROP COLUMN `destination_account_id`;--> statement-breakpoint
ALTER TABLE `spare_events` DROP COLUMN `base_cents`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `counts_daily`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `counts_weekly`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `counts_general`;