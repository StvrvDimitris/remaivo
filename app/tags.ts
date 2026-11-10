// Tags are optional labels on top of a category, such as "Essential" or
// "Trip". A transaction can carry any number of them.

export type Tag = { id: string; name: string; color: string; archived: number };

// Records store their tags as a JSON array of tag IDs.
export function parseTagIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (typeof value !== "string" || !value) return [];
  try { return parseTagIds(JSON.parse(value)); } catch { return []; }
}

export const hasTag = (tagIds: unknown, tagId: string) => parseTagIds(tagIds).includes(tagId);

// The tag picker in forms adds one hidden `tag_<tagId>` input per chosen tag.
export function tagIdsFromForm(values: Record<string, unknown>) {
  return Object.entries(values).filter(([key, value]) => key.startsWith("tag_") && typeof value === "string" && value).map(([, value]) => String(value));
}

export function tagNames(tagIds: unknown, tagById: Record<string, Tag>) {
  return parseTagIds(tagIds).map(id => tagById[id]?.name).filter((name): name is string => Boolean(name));
}

// Categories are at most one level deep. Pickers list each parent followed by
// its subcategories, labelled "Food › Delivery".
export type CategoryNode = { id: string; name: string; kind: string; archived: number; parent_id?: string | null };
export function categoryLabel(category: CategoryNode | undefined, byId: Record<string, CategoryNode>) {
  if (!category) return undefined;
  const parent = category.parent_id ? byId[category.parent_id] : undefined;
  return parent ? `${parent.name} › ${category.name}` : category.name;
}
export function categoryTree<T extends CategoryNode>(categories: T[]): { category: T; depth: 0 | 1 }[] {
  const ids = new Set(categories.map(category => category.id));
  const top = categories.filter(category => !category.parent_id || !ids.has(category.parent_id));
  return top.flatMap(parent => [{ category: parent, depth: 0 as const }, ...categories.filter(child => child.parent_id === parent.id).map(child => ({ category: child, depth: 1 as const }))]);
}
