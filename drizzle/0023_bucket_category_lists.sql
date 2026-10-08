ALTER TABLE `v3_bucket_periods` ADD `category_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `v3_bucket_templates` ADD `category_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `v3_bucket_periods` SET `category_ids` = json_array(`category_id`) WHERE `category_id` IS NOT NULL;--> statement-breakpoint
UPDATE `v3_bucket_templates` SET `category_ids` = json_array(`category_id`) WHERE `category_id` IS NOT NULL;
