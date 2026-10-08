ALTER TABLE `accounts` ADD `archived_at` text;
ALTER TABLE `categories` ADD `archived_at` text;
ALTER TABLE `goals` ADD `archived_at` text;
ALTER TABLE `installment_plans` ADD `archived_at` text;
ALTER TABLE `recurring_plans` ADD `archived_at` text;
ALTER TABLE `v3_bucket_templates` ADD `archived_at` text;