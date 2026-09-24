import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

// Temporary owner-operated maintenance route. Remove it and its secrets after use.
const tables = [
  "accounts", "budget_rules", "categories", "expense_reserve_periods", "expense_reserves",
  "forecast_scenarios", "goals", "installment_payments", "installment_plans",
  "investment_valuation_snapshots", "profiles", "recurring_plans", "spare_events",
  "transactions", "v3_assignments", "v3_bucket_periods", "v3_bucket_templates",
  "v3_events", "v3_ledger_entries", "v3_migrations", "v3_occurrences",
  "v3_opening_anchors", "v3_payment_links", "v3_periods", "v3_versions",
] as const;

function authorized(request: Request) {
  const token = env.REMAIVO_PURGE_TOKEN;
  const owner = env.REMAIVO_OWNER_USER_ID;
  const other = env.REMAIVO_PURGE_OTHER_USER_ID;
  return Boolean(token && owner && other && token.length >= 48 && request.headers.get("x-remaivo-maintenance-token") === token);
}

async function report() {
  const owner = env.REMAIVO_OWNER_USER_ID!;
  const other = env.REMAIVO_PURGE_OTHER_USER_ID!;
  const profiles = await env.DB.prepare("SELECT user_id FROM profiles").all<{ user_id: string }>();
  if (!profiles.results.some(row => row.user_id === owner) || !profiles.results.some(row => row.user_id === other)) throw new Error("Expected owner and other user profiles are not both present.");
  const counts = await env.DB.batch(tables.map(table => env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(other)));
  const unknown = await env.DB.batch(tables.map(table => env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id NOT IN (?, ?)`).bind(owner, other)));
  if (unknown.some(result => Number((result.results[0] as { count: number }).count) !== 0)) throw new Error("A third user has records; the purge has been stopped.");
  const byTable = Object.fromEntries(tables.map((table, index) => [table, Number((counts[index].results[0] as { count: number }).count)]));
  const total = Object.values(byTable).reduce((sum, count) => sum + count, 0);
  return { byTable, total };
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 404 });
  try { return Response.json(await report(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Preflight failed." }, { status: 409 }); }
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 404 });
  try {
    const input = await request.json() as { expectedRows?: number };
    const before = await report();
    if (!Number.isSafeInteger(input.expectedRows) || input.expectedRows !== before.total || before.total < 1) return Response.json({ error: "Row counts changed; purge stopped." }, { status: 409 });
    const other = env.REMAIVO_PURGE_OTHER_USER_ID!;
    await env.DB.batch(tables.map(table => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(other)));
    const remaining = await env.DB.batch(tables.map(table => env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(other)));
    const remainingRows = remaining.reduce((sum, result) => sum + Number((result.results[0] as { count: number }).count), 0);
    return Response.json({ deletedRows: before.total, remainingRows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Purge failed." }, { status: 409 });
  }
}
