import { reconcileV3, v3Snapshot, v3Action } from "../../../db/v3";
import { exportBackup } from "../../../db/backup";
import { createCurrentPlan } from "../../../db/setup";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureFinanceSchema } from "../../../db/ensure";
import { addCalendarInterval, financialToday, validTimeZone } from "../../finance-dates";
import { buildStatistics, comparisonRange, type ComparisonMode, type StatisticsFilters, type StatisticsRow } from "../../statistics";
import { spareRoundUpCents, type SpareSettings } from "../../spare-change";
import type { StatisticsMode } from "../../transaction-classification";

export const dynamic = "force-dynamic";

type FinanceUser = { userId: string; displayName: string; email: string };
type JsonObject = Record<string, unknown>;

async function currentUser(): Promise<FinanceUser | null> {
  const user = await getChatGPTUser();
  if (user) return user;
  if (process.env.NODE_ENV !== "production") {
    return { userId: "local-demo-user", displayName: "Alex Morgan", email: "alex@example.com" };
  }
  return null;
}

function cents(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number * 100));
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function bool(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function calendarDate(value: unknown) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

type GoalRow = {
  id: string;
  name: string;
  kind: string;
  target_cents: number | null;
  contributed_cents: number;
  account_id: string | null;
  tracking_mode: string;
  start_date: string | null;
  end_date: string | null;
  baseline_cents: number;
  color: string;
};

function goalMoneyCents(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const amount = Math.round(Number(value) * 100);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

async function goalFields(userId: string, payload: JsonObject, today: string, existing?: GoalRow) {
  const name = text(payload.name, existing?.name ?? "").slice(0, 120);
  if (!name) return { error: "Give this goal a name." } as const;
  const kind = text(payload.kind, existing?.kind ?? "savings");
  if (kind !== "savings" && kind !== "investment") return { error: "Choose a valid goal type." } as const;
  const trackingMode = text(payload.trackingMode, existing?.tracking_mode ?? "total");
  if (!["total", "period", "new_money"].includes(trackingMode)) return { error: "Choose a valid tracking method." } as const;

  const accountId = Object.hasOwn(payload, "accountId") ? text(payload.accountId) : existing?.account_id ?? "";
  if (Object.hasOwn(payload, "accountId") && payload.accountId != null && typeof payload.accountId !== "string") {
    return { error: "Choose a valid account or track the goal independently." } as const;
  }
  const account = accountId
    ? await env.DB.prepare("SELECT id, balance_cents FROM accounts WHERE id = ? AND user_id = ? AND archived = 0")
      .bind(accountId, userId).first<{ id: string; balance_cents: number }>()
    : null;
  if (accountId && !account) return { error: "Choose an active account you own." } as const;

  const rawTarget = Object.hasOwn(payload, "target") ? payload.target : existing?.target_cents == null ? null : existing.target_cents / 100;
  const targetCents = rawTarget == null || rawTarget === "" ? null : goalMoneyCents(rawTarget);
  if (rawTarget != null && rawTarget !== "" && targetCents === null) return { error: "Enter a valid target amount." } as const;

  const rawContributed = Object.hasOwn(payload, "contributed") ? payload.contributed : existing?.contributed_cents == null ? 0 : existing.contributed_cents / 100;
  const parsedContributed = goalMoneyCents(rawContributed);
  if (parsedContributed === null) return { error: "Enter a valid starting amount." } as const;
  const contributedCents = accountId && existing ? existing.contributed_cents : parsedContributed;

  let startDate = trackingMode === "period"
    ? calendarDate(Object.hasOwn(payload, "startDate") ? payload.startDate : existing?.start_date)
    : null;
  const endDate = trackingMode === "period"
    ? calendarDate(Object.hasOwn(payload, "endDate") ? payload.endDate : existing?.end_date)
    : null;
  if (trackingMode === "period" && (!startDate || !endDate || startDate > endDate)) {
    return { error: "Choose a valid start and end date for this goal." } as const;
  }

  let baselineCents = 0;
  if (trackingMode === "new_money") {
    if (existing?.tracking_mode === "new_money" && (existing.account_id ?? "") === accountId) {
      baselineCents = existing.baseline_cents;
      startDate = existing.start_date ?? today;
    } else if (account) {
      baselineCents = account.balance_cents;
      startDate = today;
    } else {
      const entries = existing
        ? await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM goal_entries WHERE goal_id = ? AND user_id = ?")
          .bind(existing.id, userId).first<{ amount: number }>()
        : null;
      baselineCents = contributedCents + Number(entries?.amount ?? 0);
      startDate = today;
    }
  }
  return {
    name, kind, trackingMode, accountId: accountId || null, targetCents, contributedCents,
    startDate, endDate, baselineCents, color: text(payload.color, existing?.color ?? "#dff35f"),
  };
}

async function categoryIdFor(userId: string, value: unknown, kind: "expense" | "income") {
  const categoryId = text(value);
  if (!categoryId) return null;
  const category = await env.DB.prepare("SELECT id FROM categories WHERE id = ? AND user_id = ? AND kind = ? AND archived = 0")
    .bind(categoryId, userId, kind).first<{ id: string }>();
  return category?.id ?? null;
}

const transactionSortColumns: Record<string, string> = {
  description: "t.description COLLATE NOCASE",
  date: "t.date",
  account: "COALESCE(a.name, '') COLLATE NOCASE",
  amount: "t.amount_cents",
};

async function pagedTransactions(user: FinanceUser, request: Request) {
  await ensureFinanceSchema();
  const profile = await env.DB.prepare("SELECT setup_complete, timezone FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  const today = financialToday(String(profile?.timezone || "UTC"));
  if (!profile?.setup_complete) return { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1, today };

  await reconcileV3(user.userId, today);

  const params = new URL(request.url).searchParams;
  const requestedFrom = calendarDate(params.get("from"));
  const requestedTo = calendarDate(params.get("to"));
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedFrom : monthStart;
  const to = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedTo : today;
  const categoryId = text(params.get("categoryId"));
  const accountId = text(params.get("accountId"));
  const transactionType = text(params.get("transactionType"));
  const origin = text(params.get("origin"));
  const search = text(params.get("search")).slice(0, 120).toLowerCase();
  const sort = transactionSortColumns[text(params.get("sort"))] ? text(params.get("sort")) : "date";
  const direction = text(params.get("direction")) === "asc" ? "ASC" : "DESC";
  const requestedPage = Math.max(1, Math.min(100_000, Number(params.get("page")) || 1));
  const pageSize = 25;

  const where = ["t.user_id = ?", "t.status = 'posted'", "t.date >= ?", "t.date <= ?"];
  const bindings: unknown[] = [user.userId, from, to];
  if (categoryId) {
    where.push("t.category_id = ?");
    bindings.push(categoryId);
  }
  if (accountId) {
    where.push("(t.account_id = ? OR t.destination_account_id = ?)");
    bindings.push(accountId, accountId);
  }
  if (transactionType) {
    where.push("t.type = ?");
    bindings.push(transactionType);
  }
  if (origin === "recurring") where.push("t.recurring_plan_id IS NOT NULL");
  else if (origin === "nonrecurring") where.push("t.recurring_plan_id IS NULL");
  if (search) {
    where.push("(instr(lower(t.description), ?) > 0 OR instr(lower(COALESCE(c.name, '')), ?) > 0 OR instr(lower(COALESCE(a.name, '')), ?) > 0)");
    bindings.push(search, search, search);
  }

  const fromClause = "FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id";
  const whereClause = `WHERE ${where.join(" AND ")}`;
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total ${fromClause} ${whereClause}`).bind(...bindings).first<{ total: number }>();
  const total = Number(totalRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const orderColumn = transactionSortColumns[sort];
  const rows = await env.DB.prepare(
    `SELECT t.* ${fromClause} ${whereClause} ORDER BY ${orderColumn} ${direction}, t.date DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
  ).bind(...bindings, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>();

  return { items: rows.results, page, pageSize, total, totalPages, from, to, today };
}

async function statisticsResponse(user: FinanceUser, request: Request) {
  await ensureFinanceSchema();
  const profile = await env.DB.prepare("SELECT setup_complete, timezone, currency FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  const today = financialToday(String(profile?.timezone || "UTC"));
  if (!profile?.setup_complete) return { needsSetup: true, today };

  await reconcileV3(user.userId, today);

  const params = new URL(request.url).searchParams;
  const monthStart = `${today.slice(0, 7)}-01`;
  const requestedFrom = calendarDate(params.get("from"));
  const requestedTo = calendarDate(params.get("to"));
  const from = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedFrom : monthStart;
  const to = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedTo : today;
  const comparison = (["previousEquivalent", "previousMonth", "previousYear", "none"].includes(text(params.get("comparison"))) ? text(params.get("comparison")) : "previousMonth") as ComparisonMode;
  const mode = (["spending", "income", "cashflow"].includes(text(params.get("mode"))) ? text(params.get("mode")) : "spending") as StatisticsMode;
  const comparisonDates = comparisonRange(from, to, comparison);
  const filters: StatisticsFilters = {
    from,
    to,
    comparison,
    comparisonFrom: comparisonDates?.from ?? null,
    comparisonTo: comparisonDates?.to ?? null,
    mode,
    accountId: text(params.get("accountId")),
    categoryId: text(params.get("categoryId")),
    transactionType: text(params.get("transactionType")),
    origin: text(params.get("origin")),
    description: text(params.get("description")).slice(0, 120),
  };

  const prepareRows = (rangeFrom: string, rangeTo: string) => {
    const where = ["t.user_id = ?", "t.status = 'posted'", "t.date >= ?", "t.date <= ?"];
    const bindings: unknown[] = [user.userId, rangeFrom, rangeTo];
    if (filters.accountId) {
      where.push("(t.account_id = ? OR t.destination_account_id = ?)");
      bindings.push(filters.accountId, filters.accountId);
    }
    if (filters.categoryId) {
      where.push("t.category_id = ?");
      bindings.push(filters.categoryId);
    }
    if (filters.transactionType) {
      where.push("t.type = ?");
      bindings.push(filters.transactionType);
    }
    if (filters.origin === "recurring") where.push("t.recurring_plan_id IS NOT NULL");
    else if (filters.origin === "nonrecurring") where.push("t.recurring_plan_id IS NULL");
    if (filters.description) {
      where.push("instr(lower(t.description), ?) > 0");
      bindings.push(filters.description.toLowerCase());
    }
    return env.DB.prepare(`SELECT t.*, c.name AS category_name, c.color AS category_color FROM transactions t LEFT JOIN categories c ON c.id = t.category_id AND c.user_id = t.user_id WHERE ${where.join(" AND ")} ORDER BY t.date, t.created_at, t.id`).bind(...bindings);
  };

  const [currentRows, comparisonRows] = await env.DB.batch([
    prepareRows(from, to),
    comparisonDates ? prepareRows(comparisonDates.from, comparisonDates.to) : env.DB.prepare("SELECT t.*, NULL AS category_name, NULL AS category_color FROM transactions t WHERE 0"),
  ]);
  return buildStatistics({
    rows: currentRows.results as StatisticsRow[],
    comparisonRows: comparisonRows.results as StatisticsRow[],
    filters,
    currency: String(profile.currency || "EUR"),
  });
}

function balanceStatements(userId: string, transaction: Record<string, unknown>, direction: 1 | -1, guard?: { id: string; status: string }) {
  const amount = Number(transaction.amount_cents) * direction;
  const type = String(transaction.type);
  const guarded = (sql: string, ...values: unknown[]) => guard
    ? env.DB.prepare(`${sql} AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)` ).bind(...values, guard.id, userId, guard.status)
    : env.DB.prepare(sql).bind(...values);
  if (type === "income") {
    return [guarded("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?", amount, transaction.account_id, userId)];
  }
  if (["transfer", "saving", "investment"].includes(type)) {
    return [
      guarded("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?", amount, transaction.account_id, userId),
      guarded("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?", amount, transaction.destination_account_id, userId),
    ];
  }
  return [guarded("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?", amount, transaction.account_id, userId)];
}

async function snapshot(user: FinanceUser) {
  await ensureFinanceSchema();
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  const today = financialToday(String(profile?.timezone || "UTC"));
  if (!profile?.setup_complete) {
    return { needsSetup: true, user, today };
  }

  await reconcileV3(user.userId, today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [mainRows, v3] = await Promise.all([env.DB.batch([
    env.DB.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY archived, created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM categories WHERE user_id = ? ORDER BY archived, kind, name").bind(user.userId),
    env.DB.prepare(`WITH recent AS (
      SELECT id FROM transactions WHERE user_id = ? AND status = 'posted' ORDER BY date DESC, created_at DESC LIMIT 4
    ), latest_snapshots AS (
      SELECT account_id, MAX(snapshot_date) AS snapshot_date FROM investment_valuation_snapshots WHERE user_id = ? GROUP BY account_id
    )
    SELECT t.* FROM transactions t
    WHERE t.user_id = ? AND t.status = 'posted' AND (
      t.date >= ?
      OR t.id IN (SELECT id FROM recent)
      OR EXISTS (
        SELECT 1 FROM latest_snapshots s
        WHERE t.date > s.snapshot_date AND (t.account_id = s.account_id OR t.destination_account_id = s.account_id)
      )
    )
    ORDER BY t.date DESC, t.created_at DESC`).bind(user.userId, user.userId, user.userId, monthStart),
    env.DB.prepare("SELECT * FROM recurring_plans WHERE user_id = ? AND active = 1 ORDER BY next_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_plans WHERE user_id = ? AND status = 'active' ORDER BY first_due_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_payments WHERE user_id = ? AND status != 'cancelled' ORDER BY due_date").bind(user.userId),
    env.DB.prepare(`SELECT g.*,
      CASE WHEN g.account_id IS NOT NULL THEN
        CASE g.tracking_mode
          WHEN 'period' THEN MAX(0, COALESCE((
            SELECT SUM(
              CASE WHEN t.type = 'income' AND t.account_id = g.account_id THEN t.amount_cents ELSE 0 END
              + CASE WHEN t.type IN ('transfer', 'saving', 'investment') AND t.destination_account_id = g.account_id THEN t.amount_cents ELSE 0 END
              - CASE WHEN t.type IN ('expense', 'transfer', 'saving', 'investment', 'installment_payment') AND t.account_id = g.account_id THEN t.amount_cents ELSE 0 END
            ) FROM transactions t
            WHERE t.user_id = g.user_id AND t.status = 'posted'
              AND t.date BETWEEN g.start_date AND g.end_date
              AND (t.account_id = g.account_id OR t.destination_account_id = g.account_id)
          ), 0))
          WHEN 'new_money' THEN MAX(0, COALESCE(a.balance_cents, 0) - g.baseline_cents)
          ELSE COALESCE(a.balance_cents, 0)
        END
      ELSE
        CASE g.tracking_mode
          WHEN 'period' THEN MAX(0, COALESCE((
            SELECT SUM(e.amount_cents) FROM goal_entries e
            WHERE e.user_id = g.user_id AND e.goal_id = g.id
              AND e.date BETWEEN g.start_date AND g.end_date
          ), 0))
          WHEN 'new_money' THEN MAX(0, g.contributed_cents + COALESCE((
            SELECT SUM(e.amount_cents) FROM goal_entries e
            WHERE e.user_id = g.user_id AND e.goal_id = g.id
          ), 0) - g.baseline_cents)
          ELSE g.contributed_cents + COALESCE((
            SELECT SUM(e.amount_cents) FROM goal_entries e
            WHERE e.user_id = g.user_id AND e.goal_id = g.id
          ), 0)
        END
      END AS progress_cents
      FROM goals g
      LEFT JOIN accounts a ON a.id = g.account_id AND a.user_id = g.user_id
      WHERE g.user_id = ? AND g.archived = 0 ORDER BY g.created_at`).bind(user.userId),
    env.DB.prepare(`SELECT e.* FROM goal_entries e
      JOIN goals g ON g.id = e.goal_id AND g.user_id = e.user_id AND g.archived = 0
      WHERE e.user_id = ? ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT 200`).bind(user.userId),
    env.DB.prepare("SELECT * FROM spare_events WHERE user_id = ? AND status = 'pending' ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM investment_valuation_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC, created_at DESC").bind(user.userId),
  ]), v3Snapshot(user.userId, today)]);
  const [accounts, categories, transactions, recurring, installmentPlans, installmentPayments, goals, goalEntries, spareEvents, investmentSnapshots] = mainRows;

  return {
    needsSetup: false,
    user,
    profile,
    accounts: accounts.results,
    categories: categories.results,
    transactions: transactions.results,
    recurring: recurring.results,
    installmentPlans: installmentPlans.results,
    installmentPayments: installmentPayments.results,
    goals: goals.results,
    goalEntries: goalEntries.results,
    spareEvents: spareEvents.results,
    investmentSnapshots: investmentSnapshots.results,
    today,
    v3,
  };
}

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to continue." }, { status: 401 });
  try {
    const view = new URL(request.url).searchParams.get("view");
    if (view === "export") {
      const backup = await exportBackup(user.userId);
      const date = backup.exportedAt.slice(0, 10);
      return new Response(JSON.stringify(backup, null, 2), { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="remaivo-data-export-${date}.json"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    if (view === "transactions") return Response.json(await pagedTransactions(user, request));
    if (view === "statistics") return Response.json(await statisticsResponse(user, request));
    return Response.json(await snapshot(user));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load your finances." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to continue." }, { status: 401 });

  try {
    await ensureFinanceSchema();
    const body = await request.json() as JsonObject;
    const action = text(body.action);
    const payload = (body.payload ?? {}) as JsonObject;
    const storedClock = action === "setup" ? null : await env.DB.prepare("SELECT timezone FROM profiles WHERE user_id = ?").bind(user.userId).first<{timezone:string}>();
    const actionToday = financialToday(storedClock?.timezone || "UTC");

    if (["addTransaction", "correctTransaction", "updateTransaction"].includes(action) && (!calendarDate(payload.date) || String(payload.date) > actionToday)) return Response.json({error:"Use today or an earlier date for recorded activity. Add a plan for future payments."}, {status:400});
    if (["addRecurring","updateRecurring"].includes(action)) {
      if(payload.frequency==='once'){payload.frequency='monthly';payload.endDate=payload.nextDate;}
      const existing = action === "updateRecurring" ? await env.DB.prepare("SELECT type FROM recurring_plans WHERE id=? AND user_id=?").bind(payload.planId,user.userId).first<{type:string}>() : null;
      const kind = existing?.type || String(payload.type);
      if(!calendarDate(payload.nextDate)||!['daily','weekly','monthly','yearly'].includes(String(payload.frequency))||Number(payload.intervalCount)<1||Number(payload.intervalCount)>365||!cents(payload.amount)) return Response.json({error:'Enter a valid amount, date and repetition interval.'},{status:400});
      if(!await env.DB.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0').bind(payload.accountId||'',user.userId).first()) return Response.json({error:'Choose an active payment account.'},{status:400});
      if(["saving","investment"].includes(kind) && (!payload.destinationAccountId || payload.destinationAccountId===payload.accountId || !await env.DB.prepare("SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0").bind(payload.destinationAccountId,user.userId).first())) return Response.json({error:"Choose a different active destination account."},{status:400});
    }
    if (action.startsWith("v3")) {
      await v3Action(user.userId, actionToday, action, payload);
      return Response.json(await snapshot(user));
    }
    if (action === "setup") {
      await createCurrentPlan(user.userId, payload);
    } else if (action === "addAccount") {
      const amount = cents(payload.balance);
      const type = text(payload.type, "bank");
      const signedAmount = type === "credit" ? -amount : amount;
      await env.DB.prepare("INSERT INTO accounts (id, user_id, name, type, currency, balance_cents, credit_limit_cents, color, include_spendable) SELECT ?, ?, ?, ?, currency, ?, ?, ?, ? FROM profiles WHERE user_id = ?").bind(crypto.randomUUID(), user.userId, text(payload.name, "New account"), type, signedAmount, cents(payload.creditLimit) || null, text(payload.color, "#1f5b4e"), bool(payload.includeSpendable, !["savings", "investment", "credit"].includes(type)) ? 1 : 0, user.userId).run();
    } else if (action === "updateAccount") {
      const type = ["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].includes(text(payload.type)) ? text(payload.type) : "custom";
      const updated = await env.DB.prepare(`UPDATE accounts SET name = ?, type = ?, credit_limit_cents = ?, color = ?, include_spendable = ?
        WHERE id = ? AND user_id = ? AND NOT EXISTS (
          SELECT 1 FROM profiles WHERE user_id = ? AND (
            (spare_source_id = ? AND ? IN ('investment', 'credit')) OR
            (spare_destination_id = ? AND ? NOT IN ('savings', 'investment'))
          )
        )`).bind(text(payload.name, "Account"), type, cents(payload.creditLimit) || null, text(payload.color, "#1f5b4e"), bool(payload.includeSpendable) ? 1 : 0, payload.accountId, user.userId, user.userId, payload.accountId, type, payload.accountId, type).run();
      if (!Number(updated.meta.changes)) return Response.json({ error: "This account's type must support its spare-change role. Change the spare-change settings first." }, { status: 409 });
    } else if (action === "addInvestmentSnapshot" || action === "updateInvestmentSnapshot") {
      const accountId = text(payload.accountId);
      const snapshotDate = calendarDate(payload.snapshotDate);
      const numericValue = typeof payload.value === "number" ? payload.value : Number(payload.value);
      if (!snapshotDate) return Response.json({ error: "Choose a valid snapshot date." }, { status: 400 });
      if (!Number.isFinite(numericValue) || numericValue < 0) return Response.json({ error: "Enter a valid portfolio value of zero or more." }, { status: 400 });
      const valueCents = Math.round(numericValue * 100);
      const note = text(payload.note).slice(0, 500) || null;

      if (action === "addInvestmentSnapshot") {
        const result = await env.DB.prepare("INSERT INTO investment_valuation_snapshots (id, user_id, account_id, snapshot_date, value_cents, note, created_at) SELECT ?, ?, id, ?, ?, ?, ? FROM accounts WHERE id = ? AND user_id = ? AND type = 'investment' AND archived = 0")
          .bind(crypto.randomUUID(), user.userId, snapshotDate, valueCents, note, new Date().toISOString(), accountId, user.userId).run();
        if (!Number(result.meta.changes)) return Response.json({ error: "Choose an active investment account." }, { status: 404 });
      } else {
        const snapshotId = text(payload.snapshotId);
        const result = await env.DB.prepare("UPDATE investment_valuation_snapshots SET snapshot_date = ?, value_cents = ?, note = ? WHERE id = ? AND user_id = ? AND account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND user_id = ? AND type = 'investment' AND archived = 0)")
          .bind(snapshotDate, valueCents, note, snapshotId, user.userId, accountId, accountId, user.userId).run();
        if (!Number(result.meta.changes)) return Response.json({ error: "Valuation snapshot not found." }, { status: 404 });
      }
    } else if (action === "deleteInvestmentSnapshot") {
      const result = await env.DB.prepare("DELETE FROM investment_valuation_snapshots WHERE id = ? AND user_id = ?")
        .bind(text(payload.snapshotId), user.userId).run();
      if (!Number(result.meta.changes)) return Response.json({ error: "Valuation snapshot not found." }, { status: 404 });
    } else if (action === "addCategory") {
      await env.DB.prepare("INSERT INTO categories (id, user_id, name, kind, color) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, text(payload.name), text(payload.kind, "expense"), text(payload.color, "#cfe9d7")).run();
    } else if (action === "updateCategory") {
      await env.DB.prepare("UPDATE categories SET name = ?, kind = ?, color = ? WHERE id = ? AND user_id = ?").bind(text(payload.name), text(payload.kind, "expense") === "income" ? "income" : "expense", text(payload.color, "#cfe9d7"), payload.categoryId, user.userId).run();
    } else if (action === "archiveCategory") {
      await env.DB.prepare("UPDATE categories SET archived = 1 WHERE id = ? AND user_id = ?").bind(payload.categoryId, user.userId).run();
    } else if (action === "addTransaction") {
      const id = crypto.randomUUID();
      const amount = cents(payload.amount);
      const type = text(payload.type, "expense");
      const committed = bool(payload.committed);
      if (!amount || !text(payload.description)) return Response.json({ error: "Description and amount are required." }, { status: 400 });
      const isMovement = ["transfer", "saving", "investment"].includes(type);
      if (!payload.accountId || !await env.DB.prepare("SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0").bind(payload.accountId,user.userId).first()) return Response.json({error:"Choose an active account."},{status:400});
      if(isMovement && (!payload.destinationAccountId || payload.destinationAccountId === payload.accountId || !await env.DB.prepare("SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0").bind(payload.destinationAccountId,user.userId).first())) return Response.json({error:"Choose a different active destination account."},{status:400});
      const countsBudget = ["expense", "installment_payment", "saving", "investment"].includes(type) && !bool(payload.excludeFromBudget);
      const spareExcluded = type === "expense" && bool(payload.excludeFromSpare);
      const profile = type === "expense" ? await env.DB.prepare("SELECT spare_enabled, spare_source_id, spare_multiplier, spare_destination_id FROM profiles WHERE user_id = ?").bind(user.userId).first<SpareSettings>() : null;
      const spare = type === "expense" ? spareRoundUpCents(amount, text(payload.accountId), spareExcluded, profile) : 0;
      const statements = [env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_monthly, spare_change_cents, spare_excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, user.userId, payload.accountId || null, payload.destinationAccountId || null, payload.categoryId || null, type, text(payload.description), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget ? 1 : 0, spare, spareExcluded ? 1 : 0)];
      if (type === "income") statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      else if (isMovement) {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.destinationAccountId, user.userId));
      } else statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      if (spare) {
        statements.push(env.DB.prepare("INSERT INTO spare_events (id, user_id, transaction_id, multiplied_cents) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, id, spare));
      }
      await env.DB.batch(statements);
    } else if (action === "updateTransaction") {
      await env.DB.prepare("UPDATE transactions SET description = ?, date = ?, category_id = ? WHERE id = ? AND user_id = ? AND status = 'posted'").bind(text(payload.description, "Transaction"), text(payload.date, actionToday), payload.categoryId || null, payload.transactionId, user.userId).run();
    } else if (action === "correctTransaction") {
      const original = await env.DB.prepare(
        `WITH RECURSIVE correction_chain AS (
          SELECT * FROM transactions WHERE id = ? AND user_id = ?
          UNION ALL
          SELECT child.* FROM transactions child
          JOIN correction_chain parent ON child.replaces_transaction_id = parent.id
          WHERE child.user_id = ?
        )
        SELECT * FROM correction_chain WHERE status = 'posted' ORDER BY created_at DESC LIMIT 1`,
      ).bind(payload.transactionId, user.userId, user.userId).first<Record<string, unknown>>();
      if (!original) return Response.json({ error: "That transaction is no longer available to correct." }, { status: 404 });
      const type = String(original.type);
      if (["installment_payment", "installment_purchase"].includes(type)) return Response.json({ error: "Correct installment entries from their pay-later plan." }, { status: 409 });
      if (["investment", "saving"].includes(type) && String(original.description) === "Spare change sweep") return Response.json({ error: "A completed spare-change sweep needs a separate balancing transaction." }, { status: 409 });
      const oldSpare = await env.DB.prepare("SELECT status, multiplied_cents FROM spare_events WHERE transaction_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1").bind(original.id, user.userId).first<{status:string;multiplied_cents:number}>();
      if (oldSpare?.status === "swept") return Response.json({ error: "This transaction’s spare change has already been swept. Add a balancing transaction instead." }, { status: 409 });

      const amount = cents(payload.amount);
      const accountId = text(payload.accountId);
      const destinationAccountId = text(payload.destinationAccountId);
      const moving = ["transfer", "saving", "investment"].includes(type);
      if (!amount || !accountId || (moving && (!destinationAccountId || destinationAccountId === accountId))) return Response.json({ error: "Enter a valid amount and account selection." }, { status: 400 });
      const matchingAccounts = await env.DB.prepare("SELECT COUNT(*) AS total FROM accounts WHERE user_id = ? AND id IN (?, ?)").bind(user.userId, accountId, moving ? destinationAccountId : accountId).first<{total:number}>();
      if (Number(matchingAccounts?.total || 0) !== (moving ? 2 : 1)) return Response.json({ error: "One of those accounts is not available." }, { status: 400 });
      const committed = type === "expense" && bool(payload.committed);
      const countsBudget = ["expense", "saving", "investment"].includes(type) && !bool(payload.excludeFromBudget, Number(original.counts_monthly) === 0);
      const spareExcluded = type === "expense" && bool(payload.excludeFromSpare, Number(original.spare_excluded) === 1);
      const profile = type === "expense" ? await env.DB.prepare("SELECT spare_enabled, spare_source_id, spare_multiplier, spare_destination_id FROM profiles WHERE user_id = ?").bind(user.userId).first<SpareSettings>() : null;
      let spare = type === "expense" ? spareRoundUpCents(amount, accountId, spareExcluded, profile) : 0;
      if (type === "expense" && !profile?.spare_enabled && oldSpare?.status === "pending" &&
          !spareExcluded && accountId === original.account_id) {
        const originalBase = (100 - (Number(original.amount_cents) % 100)) % 100;
        const correctedBase = (100 - (amount % 100)) % 100;
        const earnedMultiplier = originalBase ? oldSpare.multiplied_cents / originalBase : 0;
        spare = Number.isInteger(earnedMultiplier) && earnedMultiplier > 0 ? correctedBase * earnedMultiplier : 0;
      }
      const replacementId = crypto.randomUUID();
      const replacement = {
        type,
        amount_cents: amount,
        account_id: accountId,
        destination_account_id: moving ? destinationAccountId : null,
      };
      const correctionMarker = `correcting:${replacementId}`;
      const statements = [
        env.DB.prepare("UPDATE transactions SET status = ? WHERE id = ? AND user_id = ? AND status = 'posted' AND NOT EXISTS (SELECT 1 FROM spare_events WHERE transaction_id = ? AND user_id = ? AND status = 'swept')").bind(correctionMarker, original.id, user.userId, original.id, user.userId),
        ...balanceStatements(user.userId, original, -1, { id: String(original.id), status: correctionMarker }),
        env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_monthly, recurring_plan_id, spare_change_cents, spare_excluded, replaces_transaction_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(replacementId, user.userId, accountId, moving ? destinationAccountId : null, payload.categoryId || null, type, text(payload.description, "Corrected transaction"), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget ? 1 : 0, original.recurring_plan_id || null, spare, spareExcluded ? 1 : 0, original.id, original.id, user.userId, correctionMarker),
        ...balanceStatements(user.userId, replacement, 1, { id: replacementId, status: "posted" }),
      ];
      if (oldSpare?.status === "pending") statements.push(env.DB.prepare("UPDATE spare_events SET status = 'cancelled' WHERE transaction_id = ? AND user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(original.id, user.userId, original.id, user.userId, correctionMarker));
      if (spare) statements.push(env.DB.prepare("INSERT INTO spare_events (id, user_id, transaction_id, multiplied_cents) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(crypto.randomUUID(), user.userId, replacementId, spare, original.id, user.userId, correctionMarker));
      statements.push(env.DB.prepare('UPDATE v3_assignments SET transaction_id=?,amount_cents=CAST(amount_cents*MIN(1.0,?*1.0/?) AS INTEGER) WHERE transaction_id=? AND user_id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status=?)').bind(replacementId,amount,original.amount_cents,original.id,user.userId,replacementId,'posted'));
      statements.push(env.DB.prepare('UPDATE v3_occurrences SET paid_cents=paid_cents+?,amount_cents=amount_cents+?,transaction_id=CASE WHEN transaction_id=? THEN ? ELSE transaction_id END WHERE user_id=? AND id IN (SELECT occurrence_id FROM v3_payment_links WHERE transaction_id=? AND user_id=?) AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status=?)').bind(amount-Number(original.amount_cents),amount-Number(original.amount_cents),original.id,replacementId,user.userId,original.id,user.userId,replacementId,'posted'));
      statements.push(env.DB.prepare('UPDATE v3_payment_links SET transaction_id=? WHERE user_id=? AND transaction_id=? AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND status=?)').bind(replacementId,user.userId,original.id,replacementId,'posted'));
      statements.push(env.DB.prepare("UPDATE transactions SET status = 'corrected' WHERE id = ? AND user_id = ? AND status = ?").bind(original.id, user.userId, correctionMarker));
      const results = await env.DB.batch(statements);
      if (Number(results[0].meta.changes) === 0) return Response.json({ error: "That transaction changed while you were editing it. Reopen it and try again." }, { status: 409 });
    } else if (action === "addRecurring") {
      const nextDate = text(payload.nextDate);
      const planType = ["income", "saving", "investment"].includes(text(payload.type)) ? text(payload.type) : "expense";
      const categoryKind = planType === "income" ? "income" : planType === "expense" ? "expense" : null;
      const categoryId = categoryKind ? await categoryIdFor(user.userId, payload.categoryId, categoryKind) : null;
      if (categoryKind && !categoryId) return Response.json({ error: `Choose an active ${categoryKind} category.` }, { status: 400 });
      await env.DB.prepare("INSERT INTO recurring_plans (id, user_id, title, type, amount_cents, account_id, destination_account_id, category_id, frequency, interval_count, next_date, anchor_day, end_date, auto_post, committed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, text(payload.title), planType, cents(payload.amount), payload.accountId || null, payload.destinationAccountId || null, categoryId, text(payload.frequency, "monthly"), Number(payload.intervalCount) || 1, nextDate, Number(nextDate.slice(8, 10)) || 1, payload.endDate || null, bool(payload.autoPost) ? 1 : 0, bool(payload.committed, true) ? 1 : 0).run();
    } else if (action === "updateRecurring") {
      const amount = cents(payload.amount);
      if (!amount) return Response.json({ error: "Amount is required." }, { status: 400 });
      const plan = await env.DB.prepare("SELECT type FROM recurring_plans WHERE id = ? AND user_id = ? AND active = 1").bind(payload.planId, user.userId).first<{ type: string }>();
      if (!plan) return Response.json({ error: "That recurring plan is no longer active." }, { status: 404 });
      const categoryKind = plan.type === "income" ? "income" : plan.type === "expense" ? "expense" : null;
      const categoryId = categoryKind ? await categoryIdFor(user.userId, payload.categoryId, categoryKind) : null;
      if (categoryKind && !categoryId) return Response.json({ error: `Choose an active ${categoryKind} category.` }, { status: 400 });
      const nextDate = text(payload.nextDate);
      const anchorDay = Math.max(1, Math.min(31, Math.round(Number(payload.anchorDay) || Number(nextDate.slice(8, 10)) || 1)));
      await env.DB.prepare("UPDATE recurring_plans SET title = ?, category_id = ?, amount_cents = ?, account_id = ?, destination_account_id = ?, frequency = ?, interval_count = ?, next_date = ?, anchor_day = ?, auto_post = ?, committed = ? WHERE id = ? AND user_id = ? AND active = 1").bind(text(payload.title, "Recurring plan"), categoryId, amount, payload.accountId || null, payload.destinationAccountId || null, text(payload.frequency, "monthly"), Math.max(1, Number(payload.intervalCount) || 1), nextDate, anchorDay, bool(payload.autoPost) ? 1 : 0, bool(payload.committed) ? 1 : 0, payload.planId, user.userId).run();
      await env.DB.prepare("DELETE FROM v3_occurrences WHERE user_id=? AND source_kind='recurring' AND source_id=? AND status='upcoming' AND paid_cents=0").bind(user.userId,payload.planId).run();
    } else if (action === "archiveRecurring") {
      await env.DB.prepare("UPDATE recurring_plans SET active = 0 WHERE id = ? AND user_id = ?").bind(payload.planId, user.userId).run();
    } else if (action === "addInstallment") {
      const planId = crypto.randomUUID();
      const total = cents(payload.total);
      const count = Math.max(1, Math.min(120, Number(payload.installmentCount) || 1));
      const firstDue = text(payload.firstDueDate);
      if (!total || !firstDue || !payload.paymentAccountId) return Response.json({ error: "Amount, installment count, first date, and payment account are required." }, { status: 400 });
      const categoryId = await categoryIdFor(user.userId, payload.categoryId, "expense");
      if (!categoryId) return Response.json({ error: "Choose an active expense category." }, { status: 400 });
      const base = Math.floor(total / count);
      const custom = Array.isArray(payload.customAmounts) ? payload.customAmounts.map(cents) : [];
      const statements = [
        env.DB.prepare("INSERT INTO installment_plans (id, user_id, title, provider, category_id, total_cents, paid_cents, installment_count, first_due_date, frequency, payment_account_id, linked_credit_account_id, auto_post) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)").bind(planId, user.userId, text(payload.title), text(payload.provider) || null, categoryId, total, count, firstDue, text(payload.frequency, "monthly"), payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.autoPost) ? 1 : 0),
        env.DB.prepare("INSERT INTO transactions (id, user_id, category_id, type, description, amount_cents, date, committed, counts_monthly, installment_plan_id) VALUES (?, ?, ?, 'installment_purchase', ?, ?, ?, 1, 0, ?)").bind(crypto.randomUUID(), user.userId, categoryId, text(payload.title), total, text(payload.purchaseDate, actionToday), planId),
      ];
      for (let index = 0; index < count; index += 1) {
        const amount = custom.length === count ? custom[index] : index === count - 1 ? total - base * (count - 1) : base;
        statements.push(env.DB.prepare("INSERT INTO installment_payments (id, user_id, plan_id, sequence, due_date, amount_cents) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, planId, index + 1, index === 0 ? firstDue : addCalendarInterval(firstDue, text(payload.frequency, "monthly"), index), amount));
      }
      await env.DB.batch(statements);
    } else if (action === "updateInstallmentPlan") {
      const plan = await env.DB.prepare("SELECT * FROM installment_plans WHERE id = ? AND user_id = ? AND status = 'active'").bind(payload.planId, user.userId).first<Record<string, unknown>>();
      if (!plan) return Response.json({ error: "That pay-later plan is no longer active." }, { status: 404 });
      const paid = await env.DB.prepare("SELECT COUNT(*) AS paid_count, COALESCE(SUM(amount_cents), 0) AS paid_cents FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'paid'").bind(payload.planId, user.userId).first<{paid_count:number; paid_cents:number}>();
      const paidCount = Number(paid?.paid_count || 0);
      const paidCents = Number(plan.paid_cents || 0);
      if (paidCount >= 120) return Response.json({ error: "This plan has reached the 120-payment limit and cannot add another payment." }, { status: 409 });
      const categoryId = await categoryIdFor(user.userId, payload.categoryId, "expense");
      if (!categoryId) return Response.json({ error: "Choose an active expense category." }, { status: 400 });
      const total = cents(payload.total);
      const nextDueDate = text(payload.nextDueDate);
      const frequency = text(payload.frequency, "monthly") === "weekly" ? "weekly" : "monthly";
      const remainingCount = Math.max(1, Math.min(120 - paidCount, Math.round(Number(payload.remainingCount) || 1)));
      if (!total || total <= paidCents || !nextDueDate || !payload.paymentAccountId) return Response.json({ error: paidCount ? "The corrected total must be greater than the amount already paid." : "Enter a valid total, schedule, and repayment account." }, { status: 400 });
      const repaymentAccount = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ? AND archived = 0").bind(payload.paymentAccountId, user.userId).first();
      if (!repaymentAccount) return Response.json({ error: "Choose an active repayment account." }, { status: 400 });
      if (payload.linkedCreditAccountId) {
        const creditAccount = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ? AND archived = 0 AND type = 'credit'").bind(payload.linkedCreditAccountId, user.userId).first();
        if (!creditAccount) return Response.json({ error: "Choose an active credit account or leave the plan standalone." }, { status: 400 });
      }
      const remainingTotal = total - paidCents;
      const base = Math.floor(remainingTotal / remainingCount);
      const statements = [
        env.DB.prepare("DELETE FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'upcoming'").bind(payload.planId, user.userId),
        env.DB.prepare("UPDATE installment_plans SET title = ?, provider = ?, category_id = ?, total_cents = ?, paid_cents = ?, installment_count = ?, first_due_date = ?, frequency = ?, payment_account_id = ?, linked_credit_account_id = ?, auto_post = ? WHERE id = ? AND user_id = ? AND status = 'active'").bind(text(payload.title, "Pay-later plan"), text(payload.provider) || null, categoryId, total, paidCents, paidCount + remainingCount, paidCount ? plan.first_due_date : nextDueDate, frequency, payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.autoPost) ? 1 : 0, payload.planId, user.userId),
        env.DB.prepare("UPDATE transactions SET description = ?, category_id = ?, amount_cents = CASE WHEN type = 'installment_purchase' THEN ? ELSE amount_cents END WHERE user_id = ? AND installment_plan_id = ? AND status = 'posted'").bind(text(payload.title, "Pay-later plan"), categoryId, total, user.userId, payload.planId),
      ];
      for (let index = 0; index < remainingCount; index += 1) {
        const amount = index === remainingCount - 1 ? remainingTotal - base * (remainingCount - 1) : base;
        statements.push(env.DB.prepare("INSERT INTO installment_payments (id, user_id, plan_id, sequence, due_date, amount_cents) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, payload.planId, paidCount + index + 1, index === 0 ? nextDueDate : addCalendarInterval(nextDueDate, frequency, index), amount));
      }
      await env.DB.batch(statements);
    } else if (action === "archiveInstallmentPlan") {
      await env.DB.batch([
        env.DB.prepare("UPDATE installment_plans SET status = 'archived' WHERE id = ? AND user_id = ? AND status = 'active'").bind(payload.planId, user.userId),
        env.DB.prepare("UPDATE installment_payments SET status = 'cancelled' WHERE plan_id = ? AND user_id = ? AND status = 'upcoming'").bind(payload.planId, user.userId),
      ]);
    } else if (action === "updateWeekStart") {
      const weekStart = Math.max(0, Math.min(6, Math.round(Number(payload.weekStart) || 0)));
      await env.DB.prepare("UPDATE profiles SET week_start = ? WHERE user_id = ?").bind(weekStart, user.userId).run();
      const current=await v3Snapshot(user.userId,actionToday);
      await v3Action(user.userId,actionToday,"v3Configure",{...current.config,target:current.config.target/100,carryCap:current.config.carryCap/100,weekStart});
    } else if (action === "updateTimezone") {
      const timezone = text(payload.timezone);
      if (!validTimeZone(timezone)) return Response.json({ error: "Choose a valid financial timezone." }, { status: 400 });
      await env.DB.prepare("UPDATE profiles SET timezone = ? WHERE user_id = ?").bind(timezone, user.userId).run();
    } else if (action === "updateSpare") {
      const enabled = bool(payload.enabled);
      const sourceId = text(payload.sourceAccountId) || null;
      const destinationId = text(payload.destinationAccountId) || null;
      if (enabled && (!sourceId || !destinationId)) return Response.json({ error: "Choose the account whose expenses earn round-ups and a savings or investment destination." }, { status: 400 });
      if (sourceId && sourceId === destinationId) return Response.json({ error: "Choose a destination different from the spending account." }, { status: 400 });
      const selected = await env.DB.prepare("SELECT id, type, archived FROM accounts WHERE user_id = ? AND id IN (?, ?)").bind(user.userId, sourceId, destinationId).all<{id:string;type:string;archived:number}>();
      const accountsById = new Map(selected.results.map(account => [account.id, account]));
      const source = sourceId ? accountsById.get(sourceId) : null;
      const destination = destinationId ? accountsById.get(destinationId) : null;
      if (sourceId && (!source || source.archived || ["investment", "credit"].includes(source.type))) return Response.json({ error: "Choose an active spending account that can fund the sweep." }, { status: 400 });
      if (destinationId && (!destination || destination.archived || !["savings", "investment"].includes(destination.type))) return Response.json({ error: "Choose an active savings or investment destination." }, { status: 400 });
      await env.DB.prepare("UPDATE profiles SET spare_enabled = ?, spare_source_id = ?, spare_multiplier = ?, spare_destination_id = ? WHERE user_id = ?")
        .bind(enabled ? 1 : 0, sourceId, Math.max(1, Math.min(20, Number(payload.multiplier) || 1)), destinationId, user.userId).run();
    } else if (action === "sweepSpare") {
      const transactionId = crypto.randomUUID();
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly)
          SELECT ?, ?, source.id, destination.id, CASE WHEN destination.type = 'investment' THEN 'investment' ELSE 'saving' END, 'Spare change sweep', pending.amount, ?, 1, 1
          FROM (SELECT COALESCE(SUM(multiplied_cents), 0) AS amount FROM spare_events WHERE user_id = ? AND status = 'pending') pending
          JOIN profiles profile ON profile.user_id = ?
          JOIN accounts source ON source.id = profile.spare_source_id AND source.user_id = profile.user_id AND source.archived = 0 AND source.type NOT IN ('investment', 'credit')
          JOIN accounts destination ON destination.id = profile.spare_destination_id AND destination.user_id = profile.user_id AND destination.archived = 0 AND destination.type IN ('savings', 'investment')
          WHERE pending.amount > 0 AND source.balance_cents >= pending.amount AND source.id <> destination.id`)
          .bind(transactionId, user.userId, actionToday, user.userId, user.userId),
        env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - (SELECT amount_cents FROM transactions WHERE id = ? AND user_id = ?) WHERE id = (SELECT account_id FROM transactions WHERE id = ? AND user_id = ?) AND user_id = ?")
          .bind(transactionId, user.userId, transactionId, user.userId, user.userId),
        env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + (SELECT amount_cents FROM transactions WHERE id = ? AND user_id = ?) WHERE id = (SELECT destination_account_id FROM transactions WHERE id = ? AND user_id = ?) AND user_id = ?")
          .bind(transactionId, user.userId, transactionId, user.userId, user.userId),
        env.DB.prepare("UPDATE spare_events SET status = 'swept' WHERE user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ?)")
          .bind(user.userId, transactionId, user.userId),
      ]);
      if (!Number(results[0].meta.changes)) return Response.json({ error: "Nothing was swept. Check the waiting amount and the spending account balance." }, { status: 409 });
    } else if (action === "addGoal") {
      const fields = await goalFields(user.userId, payload, actionToday);
      if ("error" in fields) return Response.json({ error: fields.error }, { status: 400 });
      await env.DB.prepare(`INSERT INTO goals
        (id, user_id, name, kind, target_cents, contributed_cents, account_id, tracking_mode, start_date, end_date, baseline_cents, color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), user.userId, fields.name, fields.kind, fields.targetCents,
          fields.contributedCents, fields.accountId, fields.trackingMode, fields.startDate, fields.endDate,
          fields.baselineCents, fields.color).run();
    } else if (action === "updateGoal") {
      const existing = await env.DB.prepare("SELECT * FROM goals WHERE id = ? AND user_id = ? AND archived = 0")
        .bind(text(payload.goalId), user.userId).first<GoalRow>();
      if (!existing) return Response.json({ error: "Goal not found." }, { status: 404 });
      const fields = await goalFields(user.userId, payload, actionToday, existing);
      if ("error" in fields) return Response.json({ error: fields.error }, { status: 400 });
      await env.DB.prepare(`UPDATE goals SET name = ?, kind = ?, target_cents = ?, contributed_cents = ?,
        account_id = ?, tracking_mode = ?, start_date = ?, end_date = ?, baseline_cents = ?, color = ?
        WHERE id = ? AND user_id = ? AND archived = 0`)
        .bind(fields.name, fields.kind, fields.targetCents, fields.contributedCents, fields.accountId,
          fields.trackingMode, fields.startDate, fields.endDate, fields.baselineCents, fields.color,
          existing.id, user.userId).run();
    } else if (action === "addGoalEntry") {
      const goalId = text(payload.goalId);
      const date = calendarDate(payload.date);
      const amountCents = goalMoneyCents(payload.amount);
      const kind = text(payload.kind);
      if (!date || date > actionToday) return Response.json({ error: "Use today or an earlier date for a goal entry." }, { status: 400 });
      if (amountCents === null || amountCents === 0 || (kind !== "add" && kind !== "remove")) {
        return Response.json({ error: "Enter an amount to add or remove." }, { status: 400 });
      }
      const goal = await env.DB.prepare("SELECT id, tracking_mode, start_date FROM goals WHERE id = ? AND user_id = ? AND archived = 0 AND account_id IS NULL")
        .bind(goalId, user.userId).first<{ id: string; tracking_mode: string; start_date: string | null }>();
      if (!goal) return Response.json({ error: "Choose an active independent goal." }, { status: 404 });
      if (goal.tracking_mode === "new_money" && goal.start_date && date < goal.start_date) {
        return Response.json({ error: "Use a date on or after this goal started." }, { status: 400 });
      }
      const result = await env.DB.prepare(`INSERT INTO goal_entries
        (id, user_id, goal_id, date, amount_cents, note)
        SELECT ?, ?, id, ?, ?, ? FROM goals
        WHERE id = ? AND user_id = ? AND archived = 0 AND account_id IS NULL
          AND (tracking_mode <> 'new_money' OR start_date IS NULL OR start_date <= ?)`)
        .bind(crypto.randomUUID(), user.userId, date, kind === "remove" ? -amountCents : amountCents,
          text(payload.note).slice(0, 240) || null, goalId, user.userId, date).run();
      if (!Number(result.meta.changes)) return Response.json({ error: "Goal changed. Reopen it and try again." }, { status: 409 });
    } else if (action === "deleteGoalEntry") {
      const result = await env.DB.prepare(`DELETE FROM goal_entries
        WHERE id = ? AND user_id = ? AND EXISTS (
          SELECT 1 FROM goals g WHERE g.id = goal_entries.goal_id AND g.user_id = goal_entries.user_id
            AND g.archived = 0 AND g.account_id IS NULL
        )`).bind(text(payload.entryId), user.userId).run();
      if (!Number(result.meta.changes)) return Response.json({ error: "Goal entry not found." }, { status: 404 });
    } else if (action === "archiveGoal") {
      await env.DB.prepare("UPDATE goals SET archived = 1 WHERE id = ? AND user_id = ?").bind(payload.goalId, user.userId).run();
    } else if (action === "archiveAccount") {
      const accountId = text(payload.accountId);
      const blocked = await env.DB.prepare("SELECT 1 AS blocked WHERE EXISTS (SELECT 1 FROM recurring_plans WHERE user_id = ? AND active = 1 AND (account_id = ? OR destination_account_id = ?)) OR EXISTS (SELECT 1 FROM installment_plans WHERE user_id = ? AND status = 'active' AND (payment_account_id = ? OR linked_credit_account_id = ?)) OR EXISTS (SELECT 1 FROM goals WHERE user_id = ? AND archived = 0 AND account_id = ?) OR EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND (spare_source_id = ? OR spare_destination_id = ?))").bind(user.userId, accountId, accountId, user.userId, accountId, accountId, user.userId, accountId, user.userId, accountId, accountId).first();
      if (blocked) return Response.json({ error: "Move active plans, goals, and spare-change accounts before archiving this account." }, { status: 409 });
      await env.DB.prepare("UPDATE accounts SET archived = 1 WHERE id = ? AND user_id = ?").bind(payload.accountId, user.userId).run();
    } else {
      return Response.json({ error: "Unknown action." }, { status: 400 });
    }

    return Response.json(await snapshot(user));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save your changes.";
    return Response.json({ error: message.includes("UNIQUE") ? "That item already exists." : message }, { status: 500 });
  }
}
