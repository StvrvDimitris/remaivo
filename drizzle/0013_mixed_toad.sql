ALTER TABLE `profiles` ADD `spare_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `spare_source_id` text;--> statement-breakpoint
ALTER TABLE `profiles` ADD `spare_debit_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `spare_excluded` integer DEFAULT false NOT NULL;