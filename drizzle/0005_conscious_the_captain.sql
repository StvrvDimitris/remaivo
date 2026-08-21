ALTER TABLE `recurring_plans` ADD `anchor_day` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `recurring_plans` SET `anchor_day` = CAST(substr(`next_date`, 9, 2) AS integer);
