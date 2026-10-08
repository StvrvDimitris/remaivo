ALTER TABLE `accounts` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `installment_plans` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `recurring_plans` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `v3_bucket_templates` ADD `archived_at` text;