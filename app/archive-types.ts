export const archiveKinds = {
  account: "Accounts", category: "Categories", goal: "Goals",
  recurring: "Recurring plans", installment: "Pay-later plans", bucket: "Repeating buckets",
} as const;
export type ArchiveKind = keyof typeof archiveKinds;
export type ArchiveItem = {
  id: string; kind: ArchiveKind; name: string; detail: string;
  amount_cents: number | null; currency: string | null;
};
export type ArchivePage = { items: ArchiveItem[]; total: number; page: number; totalPages: number; error?: string };
