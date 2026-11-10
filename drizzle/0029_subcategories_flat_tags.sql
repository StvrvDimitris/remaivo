-- Categories can have subcategories, one level deep (Food > Delivery).
ALTER TABLE categories ADD COLUMN parent_id TEXT;--> statement-breakpoint
-- Tags no longer belong to groups. Tags of an archived group are archived, and
-- a name used in two groups keeps the group name so names stay unique.
UPDATE tags SET archived = 1, archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP) WHERE archived = 0 AND group_id IN (SELECT id FROM tag_groups WHERE archived = 1);--> statement-breakpoint
UPDATE tags SET name = name || ' (' || COALESCE((SELECT g.name FROM tag_groups g WHERE g.id = tags.group_id), 'group') || ')' WHERE EXISTS (SELECT 1 FROM tags other WHERE other.user_id = tags.user_id AND other.name = tags.name AND other.id <> tags.id);--> statement-breakpoint
DROP INDEX idx_tags_user_group_name;--> statement-breakpoint
ALTER TABLE tags DROP COLUMN group_id;--> statement-breakpoint
CREATE UNIQUE INDEX idx_tags_user_name ON tags (user_id, name);--> statement-breakpoint
DROP TABLE tag_groups;
