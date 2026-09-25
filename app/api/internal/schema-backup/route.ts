import { env } from "cloudflare:workers";

const tables = [
  "accounts", "categories", "goals", "installment_payments",
  "installment_plans", "investment_valuation_snapshots", "profiles",
  "recurring_plans", "spare_events", "transactions", "v3_assignments",
  "v3_bucket_periods", "v3_bucket_templates", "v3_events", "v3_occurrences",
  "v3_payment_links", "v3_periods", "v3_versions",
] as const;

function sameSecret(actual: string, expected: string) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  const runtime = env as unknown as { DB: D1Database; MAINTENANCE_EXPORT_KEY?: string; MAINTENANCE_OWNER_ID?: string };
  const key = runtime.MAINTENANCE_EXPORT_KEY;
  const owner = runtime.MAINTENANCE_OWNER_ID;
  if (!key || key.length < 40 || !owner || !sameSecret(request.headers.get("x-remaivo-maintenance-key") || "", key)) {
    return new Response(null, { status: 404 });
  }

  try {
    const profiles = await runtime.DB.prepare("SELECT user_id FROM profiles").all<{ user_id: string }>();
    if (profiles.results.length !== 1 || profiles.results[0].user_id !== owner) {
      return Response.json({ error: "Owner preflight failed." }, { status: 409 });
    }
    const queries = tables.flatMap((table) => [
      runtime.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).bind(owner),
      runtime.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id <> ?`).bind(owner),
    ]);
    const results = await runtime.DB.batch(queries);
    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (let index = 0; index < tables.length; index += 1) {
      const otherCount = Number((results[index * 2 + 1].results[0] as { count: number }).count);
      if (otherCount !== 0) return Response.json({ error: "Unexpected owner data found." }, { status: 409 });
      data[tables[index]] = results[index * 2].results;
      counts[tables[index]] = results[index * 2].results.length;
    }
    return Response.json({ format: "remaivo-pre-cleanup-backup", version: 1, exportedAt: new Date().toISOString(), ownerId: owner, counts, tables: data }, {
      headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return Response.json({ error: "Backup could not be completed." }, { status: 500 });
  }
}
