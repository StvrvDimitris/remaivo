// Names Remaivo creates for new users, in every interface language. Stored names are
// the user's own text; these lists let setup use the chosen language and let a
// language switch rename defaults the user never changed.

export type NameLanguage = "en" | "el";
type Names = Record<NameLanguage, string>;

export const defaultCategories: (Names & { kind: "expense" | "income"; color: string })[] = [
  { en: "Groceries", el: "Σούπερ μάρκετ", kind: "expense", color: "#d8ead7" },
  { en: "Eating out", el: "Φαγητό έξω", kind: "expense", color: "#f5ddcf" },
  { en: "Transport", el: "Μετακινήσεις", kind: "expense", color: "#d9e9ec" },
  { en: "Home & bills", el: "Σπίτι & λογαριασμοί", kind: "expense", color: "#eadfcb" },
  { en: "Shopping", el: "Αγορές", kind: "expense", color: "#ead9e6" },
  { en: "Health", el: "Υγεία", kind: "expense", color: "#d8e7df" },
  { en: "Entertainment", el: "Ψυχαγωγία", kind: "expense", color: "#e6e0f2" },
  { en: "Salary", el: "Μισθός", kind: "income", color: "#d8ead7" },
  { en: "Other income", el: "Άλλα έσοδα", kind: "income", color: "#d9e9ec" },
];

export const defaultPlanName: Names = { en: "Main plan", el: "Κύριο πλάνο" };
export const defaultAccountName: Names = { en: "Main account", el: "Κύριος λογαριασμός" };

export const nameLanguage = (value: unknown): NameLanguage => value === "el" ? "el" : "en";

// The same default in the other languages, which a switch to `language` should rename.
export const otherNames = (names: Names, language: NameLanguage) =>
  (Object.keys(names) as NameLanguage[]).filter(key => key !== language).map(key => names[key]);
