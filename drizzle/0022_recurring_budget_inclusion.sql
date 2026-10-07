ALTER TABLE recurring_plans ADD COLUMN counts_monthly INTEGER NOT NULL DEFAULT 1 CHECK (counts_monthly IN (0,1));
--> statement-breakpoint
ALTER TABLE v3_occurrences ADD COLUMN counts_monthly INTEGER NOT NULL DEFAULT 1 CHECK (counts_monthly IN (0,1));
--> statement-breakpoint
