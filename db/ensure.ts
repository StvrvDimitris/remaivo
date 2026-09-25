import { env } from "cloudflare:workers";

// Site migrations own the schema. Runtime requests only check that the
// current tables are available; they never create or upgrade old tables.
const requiredTables = [
  "profiles", "accounts", "categories", "transactions",
  "investment_valuation_snapshots", "recurring_plans", "installment_plans",
  "installment_payments", "goals", "spare_events", "v3_versions",
  "v3_periods", "v3_bucket_templates", "v3_bucket_periods",
  "v3_assignments", "v3_occurrences", "v3_events", "v3_payment_links",
] as const;
const retiredTables = [
  "budget_rules", "expense_reserves", "expense_reserve_periods",
  "forecast_scenarios", "v3_migrations", "v3_ledger_entries",
  "v3_opening_anchors",
] as const;
const retiredColumns: Record<string, string[]> = {
  profiles: ["spare_sweep_mode", "spare_threshold_cents"],
  accounts: ["opening_balance_cents", "icon"],
  categories: ["icon"],
  transactions: ["counts_daily", "counts_weekly", "counts_general"],
  installment_plans: ["include_daily_weekly"],
  installment_payments: ["paid_transaction_id"],
  spare_events: ["destination_account_id", "base_cents"],
};

let schemaReady: Promise<void> | null = null;

export function ensureFinanceSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
      const existing = new Set(result.results.map((row) => row.name));
      if (requiredTables.some((table) => !existing.has(table)) ||
          retiredTables.some((table) => existing.has(table))) {
        throw new Error("Your finance data is temporarily unavailable. Please try again shortly.");
      }
      await Promise.all(Object.entries(retiredColumns).map(async ([table, names]) => {
        const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
        const present = new Set(columns.results.map((column) => column.name));
        if (names.some((name) => present.has(name))) {
          throw new Error("Your finance data is temporarily unavailable. Please try again shortly.");
        }
      }));
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
