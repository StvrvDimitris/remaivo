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

let schemaReady: Promise<void> | null = null;

export function ensureFinanceSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const result = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
      const existing = new Set(result.results.map((row) => row.name));
      if (requiredTables.some((table) => !existing.has(table))) {
        throw new Error("Your finance data is temporarily unavailable. Please try again shortly.");
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}
