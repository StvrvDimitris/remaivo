import { env } from "cloudflare:workers";

// Export current user-owned data, including archived records and Plan history.
// The frozen pre-redesign snapshot in v3_migrations is deliberately excluded.
const TABLES = [
  "accounts", "budget_rules", "categories", "expense_reserve_periods",
  "expense_reserves", "forecast_scenarios", "goals", "installment_payments",
  "installment_plans", "investment_valuation_snapshots", "profiles",
  "recurring_plans", "spare_events", "transactions", "v3_assignments",
  "v3_bucket_periods", "v3_bucket_templates", "v3_events", "v3_ledger_entries",
  "v3_occurrences", "v3_opening_anchors", "v3_payment_links",
  "v3_periods", "v3_versions",
] as const;

type Table = (typeof TABLES)[number];
type BackupRow = Record<string, string | number | null>;

export type BackupEnvelope = {
  format: "remaivo-backup";
  version: 2;
  exportedAt: string;
  ownerId: string;
  tables: Record<Table, BackupRow[]>;
};

export async function exportBackup(user: string): Promise<BackupEnvelope> {
  const results = await env.DB.batch(TABLES.map(table =>
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).bind(user)
  ));
  const data = {} as Record<Table, BackupRow[]>;
  TABLES.forEach((table, index) => { data[table] = results[index].results as BackupRow[]; });
  return {
    format: "remaivo-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    ownerId: user,
    tables: data,
  };
}
