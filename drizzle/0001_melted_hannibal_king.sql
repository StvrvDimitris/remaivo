ALTER TABLE `budget_rules` ADD `source_type` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `parent_period` text;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `calculation_mode` text DEFAULT 'adaptive' NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `percentage_basis_points` integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `hard_reset` text DEFAULT 'parent' NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `include_everyday` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `include_committed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `include_savings` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `budget_rules` ADD `include_investments` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `budget_rules` SET `parent_period` = CASE `period` WHEN 'daily' THEN 'weekly' WHEN 'weekly' THEN 'monthly' WHEN 'monthly' THEN 'general' ELSE NULL END;--> statement-breakpoint
UPDATE `budget_rules` SET `include_committed` = true, `include_savings` = true, `include_investments` = true WHERE `period` IN ('monthly', 'general');
