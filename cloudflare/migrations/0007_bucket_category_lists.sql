ALTER TABLE v3_bucket_periods ADD COLUMN category_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE v3_bucket_templates ADD COLUMN category_ids TEXT NOT NULL DEFAULT '[]';
UPDATE v3_bucket_periods SET category_ids = json_array(category_id) WHERE category_id IS NOT NULL;
UPDATE v3_bucket_templates SET category_ids = json_array(category_id) WHERE category_id IS NOT NULL;
ALTER TABLE v3_bucket_periods DROP COLUMN category_id;
ALTER TABLE v3_bucket_templates DROP COLUMN category_id;
