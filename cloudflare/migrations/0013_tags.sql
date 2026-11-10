-- Tags are a second way to sort activity besides categories. People create
-- their own tag groups (for example "Need" with "Daily" and "Leisure"), and a
-- transaction carries at most one tag from each group. Remaivo ships no tags.
CREATE TABLE tag_groups (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  archived INTEGER DEFAULT false NOT NULL,
  archived_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX idx_tag_groups_user_name ON tag_groups (user_id, name);
CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#cfe9d7' NOT NULL,
  archived INTEGER DEFAULT false NOT NULL,
  archived_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX idx_tags_user_group_name ON tags (user_id, group_id, name);
-- Each record lists its tag IDs as a JSON array. Plans pass their tags on to
-- the payments they schedule and post; buckets can require a tag.
ALTER TABLE transactions ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
ALTER TABLE recurring_plans ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
ALTER TABLE installment_plans ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
ALTER TABLE v3_occurrences ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
ALTER TABLE v3_bucket_templates ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
ALTER TABLE v3_bucket_periods ADD COLUMN tag_ids TEXT DEFAULT '[]' NOT NULL;
