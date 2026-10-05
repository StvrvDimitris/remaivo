import { env } from "cloudflare:workers";
import { addCalendarInterval } from "../app/finance-dates";
import { archiveKinds, type ArchiveItem, type ArchiveKind } from "../app/archive-types";
import { currentPeriod } from "./v3";

export class ArchiveError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

// Only recoverable archive flags belong here. Paid, corrected and skipped history
// is deliberately not offered as an archived item.
// D1 caps compound SELECT terms; keep each UNION group below that limit.
const archiveQuery = `
  SELECT id, user_id, 'account' AS kind, name, type AS detail, balance_cents AS amount_cents, currency FROM accounts WHERE archived = 1
  UNION ALL SELECT id, user_id, 'category', name, kind, NULL, NULL FROM categories WHERE archived = 1
  UNION ALL SELECT id, user_id, 'goal', name, CASE WHEN account_id IS NULL THEN 'Independent tracking' ELSE 'Linked account goal' END, target_cents, NULL FROM goals WHERE archived = 1
  UNION ALL SELECT * FROM (
    SELECT id, user_id, 'recurring', title, frequency || ' · next date ' || next_date, amount_cents, NULL FROM recurring_plans WHERE active = 0
    UNION ALL SELECT id, user_id, 'installment', title, 'Unpaid balance', MAX(0, total_cents - paid_cents), NULL FROM installment_plans WHERE status = 'archived'
    UNION ALL SELECT id, user_id, 'bucket', name, CASE WHEN kind = 'goal' THEN 'Goal allocation' ELSE 'Protected spending' END, target_cents, NULL FROM v3_bucket_templates WHERE archived = 1
  )
`;

export async function listArchive(user: string, params: URLSearchParams) {
  const kind = params.get("kind") || "all";
  if (kind !== "all" && !Object.hasOwn(archiveKinds, kind)) throw new ArchiveError("Choose an available archive type.", 400);
  const query = (params.get("q") || "").trim().slice(0, 200);
  const requestedPage = Math.max(1, Math.min(100000, Number(params.get("page")) || 1)) | 0;
  const filter = "WHERE user_id = ? AND (? = 'all' OR kind = ?) AND (? = '' OR INSTR(LOWER(name || ' ' || detail), LOWER(?)) > 0)";
  const args = [user, kind, kind, query, query];
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM (${archiveQuery}) ${filter}`).bind(...args).first<{total: number}>();
  const total = Number(count?.total || 0), totalPages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(requestedPage, totalPages);
  const result = await env.DB.prepare(`SELECT id, kind, name, detail, amount_cents, currency FROM (${archiveQuery}) ${filter} ORDER BY LOWER(name), kind, id LIMIT 25 OFFSET ?`).bind(...args, (page - 1) * 25).all<ArchiveItem>();
  return { items: result.results, total, page, totalPages };
}

const definitions = {
  account: ["accounts", "archived = 1"], category: ["categories", "archived = 1"],
  goal: ["goals", "archived = 1"], recurring: ["recurring_plans", "active = 0"],
  installment: ["installment_plans", "status = 'archived'"], bucket: ["v3_bucket_templates", "archived = 1"],
} as const;

export async function restoreArchive(user: string, today: string, payload: Record<string, unknown>) {
  const kind = String(payload.kind);
  if (!Object.hasOwn(definitions, kind)) throw new ArchiveError("Choose an available archive type.", 400);
  const [table, predicate] = definitions[kind as ArchiveKind];
  const id = String(payload.id || "");
  const item = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ? AND ${predicate}`).bind(id, user).first<Record<string, unknown>>();
  if (!item) throw new ArchiveError("This item is no longer archived. Refresh the archive.", 404);
  async function requireActive(tableName: "accounts" | "categories", linkedId: unknown) {
    if (!linkedId) return;
    const linked = await env.DB.prepare(`SELECT name, archived FROM ${tableName} WHERE id = ? AND user_id = ?`).bind(linkedId, user).first<{name: string; archived: number}>();
    if (!linked || linked.archived) throw new ArchiveError(`Restore the linked ${tableName === "accounts" ? "account" : "category"}${linked ? ` “${linked.name}”` : ""} first.`);
  }
  await requireActive("accounts", item.account_id || item.payment_account_id || item.destination_id);
  await requireActive("accounts", item.destination_account_id || item.linked_credit_account_id);
  await requireActive("categories", item.category_id);
  if (kind === "account" || kind === "category" || kind === "goal") {
    await env.DB.prepare(`UPDATE ${table} SET archived = 0 WHERE id = ? AND user_id = ? AND archived = 1`).bind(id, user).run();
    return;
  }
  if (kind === "bucket") {
    const { period } = await currentPeriod(user, today);
    if (item.category_id) {
      const conflict = await env.DB.prepare(`SELECT name FROM v3_bucket_templates WHERE user_id = ? AND archived = 0 AND category_id = ? AND id != ?
        UNION ALL SELECT name FROM v3_bucket_periods WHERE user_id = ? AND period_id = ? AND category_id = ? AND bucket_id != ? LIMIT 1`)
        .bind(user, item.category_id, id, user, period.id, item.category_id, id).first<{name: string}>();
      if (conflict) throw new ArchiveError(`“${conflict.name}” already uses this category. Change its category before restoring this bucket.`);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE v3_bucket_templates SET archived = 0 WHERE id = ? AND user_id = ? AND archived = 1").bind(id, user),
      env.DB.prepare(`INSERT INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period_id,bucket_id) DO UPDATE SET released = 0`)
        .bind(`${period.id}:${id}`, user, period.id, id, item.name, item.kind, item.category_id, item.target_cents, item.priority, item.rollover, item.rollover_cap, item.destination_id),
    ]);
    return;
  }
  const nextDate = String(payload.nextDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || Number.isNaN(Date.parse(nextDate)) || new Date(nextDate).toISOString().slice(0, 10) !== nextDate || nextDate < today) {
    throw new ArchiveError("Choose today or a future date to restart payments.", 400);
  }
  if (kind === "recurring") {
    if (item.end_date && nextDate > String(item.end_date)) throw new ArchiveError(`This plan ended on ${item.end_date}. Create a new plan if you want it to continue.`);
    await env.DB.batch([
      env.DB.prepare("UPDATE recurring_plans SET active = 1, auto_post = 0, next_date = ?, anchor_day = ? WHERE id = ? AND user_id = ? AND active = 0")
        .bind(nextDate, nextDate === item.next_date ? item.anchor_day : Number(nextDate.slice(8)), id, user),
      env.DB.prepare(`UPDATE v3_occurrences SET status = CASE WHEN paid_cents > 0 THEN 'partial' ELSE 'upcoming' END, auto_post = 0
        WHERE user_id = ? AND source_kind = 'recurring' AND source_id = ? AND status = 'cancelled' AND scheduled_date >= ? AND (? IS NULL OR scheduled_date <= ?)`)
        .bind(user, id, nextDate, item.end_date, item.end_date),
    ]);
    return;
  }
  const payments = await env.DB.prepare("SELECT id FROM installment_payments WHERE user_id = ? AND plan_id = ? AND status IN ('cancelled', 'upcoming') ORDER BY sequence").bind(user, id).all<{id: string}>();
  if (!payments.results.length || Number(item.paid_cents) >= Number(item.total_cents)) throw new ArchiveError("This plan has no unpaid payments to restore. Its paid history is already preserved.");
  const statements = [env.DB.prepare("UPDATE installment_plans SET status = 'active', auto_post = 0 WHERE id = ? AND user_id = ? AND status = 'archived'").bind(id, user)];
  payments.results.forEach((payment, index) => {
    const date = index === 0 ? nextDate : addCalendarInterval(nextDate, String(item.frequency), index);
    statements.push(env.DB.prepare("UPDATE installment_payments SET status = 'upcoming', due_date = ? WHERE id = ? AND user_id = ? AND status IN ('cancelled', 'upcoming')").bind(date, payment.id, user));
    statements.push(env.DB.prepare(`UPDATE v3_occurrences SET due_date = ?, auto_post = 0, status = CASE WHEN paid_cents > 0 THEN 'partial' ELSE 'upcoming' END
      WHERE user_id = ? AND source_kind = 'installment' AND source_id = ? AND status IN ('cancelled', 'upcoming', 'partial')`).bind(date, user, payment.id));
  });
  await env.DB.batch(statements);
}
