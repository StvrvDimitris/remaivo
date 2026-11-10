// Tags are a second way to sort activity besides categories. People make their
// own tag groups, such as "Need" with "Daily" and "Leisure"; a transaction
// carries at most one tag from each group, so totals within a group add up.

export type TagGroup = { id: string; name: string; archived: number };
export type Tag = { id: string; group_id: string; name: string; color: string; archived: number };

// Records store their tags as a JSON array of tag IDs.
export function parseTagIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (typeof value !== "string" || !value) return [];
  try { return parseTagIds(JSON.parse(value)); } catch { return []; }
}

export const hasTag = (tagIds: unknown, tagId: string) => parseTagIds(tagIds).includes(tagId);

// Buckets match tags with bucketCovers and bucketsOverlap in v3-engine.ts.

// Tag pickers in forms are named `tag_<groupId>`, one per group.
export function tagIdsFromForm(values: Record<string, unknown>) {
  return Object.entries(values).filter(([key, value]) => key.startsWith("tag_") && typeof value === "string" && value).map(([, value]) => String(value));
}

export function tagNames(tagIds: unknown, tagById: Record<string, Tag>) {
  return parseTagIds(tagIds).map(id => tagById[id]?.name).filter((name): name is string => Boolean(name));
}
