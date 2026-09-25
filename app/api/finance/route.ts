import { reconcileV3, v3Snapshot, v3Action } from "../../../db/v3";
import { exportBackup } from "../../../db/backup";
import { createCurrentPlan } from "../../../db/setup";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureFinanceSchema } from "../../../db/ensure";
import { addCalendarInterval, financialToday, validTimeZone } from "../../finance-dates";
import { buildStatistics, comparisonRange, type ComparisonMode, type StatisticsFilters, type StatisticsRow } from "../../statistics";
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

async function snapshot(user: FinanceUser, mark?: (stage: string) => void) {
  await ensureFinanceSchema();
  mark?.("schema");
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  mark?.("profile");
  const today = financialToday(String(profile?.timezone || "UTC"));
  if (!profile?.setup_complete) {
    return { needsSetup: true, user, today };
  }

  await reconcileV3(user.userId, today);
  mark?.("reconcile");
  const monthStart = `${today.slice(0, 7)}-01`;
  const [accounts, categories, transactions, recurring, installmentPlans, installmentPayments, goals, spareEvents, investmentSnapshots] = await env.DB.batch([
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
    env.DB.prepare("SELECT * FROM goals WHERE user_id = ? AND archived = 0 ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM spare_events WHERE user_id = ? AND status = 'pending' ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM investment_valuation_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC, created_at DESC").bind(user.userId),
  ]);
  mark?.("main batch");
  const v3 = await v3Snapshot(user.userId, today);
  mark?.("plan snapshot");

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
    spareEvents: spareEvents.results,
    investmentSnapshots: investmentSnapshots.results,
    today,
    v3,
  };
}

export async function GET(request: Request) {
  const startedAt = performance.now();
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
    if (new URL(request.url).searchParams.get("__perf") === "1") {
      const stages: Array<{ stage: string; ms: number }> = [];
      let previous = startedAt;
      const mark = (stage: string) => {
        const now = performance.now();
        stages.push({ stage, ms: Math.round(now - previous) });
        previous = now;
      };
      mark("auth");
      const result = await snapshot(user, mark);
      const response = Response.json(result);
      mark("serialize");
      console.log("remaivo-snapshot-timing", JSON.stringify(stages));
      return response;
    }
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
      await env.DB.prepare("UPDATE accounts SET name = ?, type = ?, credit_limit_cents = ?, color = ?, include_spendable = ? WHERE id = ? AND user_id = ?").bind(text(payload.name, "Account"), type, cents(payload.creditLimit) || null, text(payload.color, "#1f5b4e"), bool(payload.includeSpendable) ? 1 : 0, payload.accountId, user.userId).run();
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
      let spare = 0;
      const profile = await env.DB.prepare("SELECT spare_multiplier, spare_destination_id FROM profiles WHERE user_id = ?").bind(user.userId).first<{spare_multiplier:number; spare_destination_id:string | null}>();
      if (type === "expense" && bool(payload.useSpare) && profile?.spare_destination_id) {
        const base = (100 - (amount % 100)) % 100;
        spare = base * Math.max(1, profile.spare_multiplier);
      }
      const statements = [env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_monthly, spare_change_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, user.userId, payload.accountId || null, payload.destinationAccountId || null, payload.categoryId || null, type, text(payload.description), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget ? 1 : 0, spare)];
      if (type === "income") statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      else if (isMovement) {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.destinationAccountId, user.userId));
      } else statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      if (spare && profile?.spare_destination_id) {
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
      if (type === "investment" && String(original.description) === "Spare change sweep") return Response.json({ error: "A completed spare-change sweep needs a separate balancing transaction." }, { status: 409 });
      const oldSpare = await env.DB.prepare("SELECT status FROM spare_events WHERE transaction_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1").bind(original.id, user.userId).first<{status:string}>();
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
      const profile = await env.DB.prepare("SELECT spare_multiplier, spare_destination_id FROM profiles WHERE user_id = ?").bind(user.userId).first<{spare_multiplier:number; spare_destination_id:string | null}>();
      let spare = 0;
      if (type === "expense" && bool(payload.useSpare) && profile?.spare_destination_id) {
        spare = ((100 - (amount % 100)) % 100) * Math.max(1, profile.spare_multiplier);
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
        env.DB.prepare("UPDATE transactions SET status = ? WHERE id = ? AND user_id = ? AND status = 'posted'").bind(correctionMarker, original.id, user.userId),
        ...balanceStatements(user.userId, original, -1, { id: String(original.id), status: correctionMarker }),
        env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_monthly, recurring_plan_id, spare_change_cents, replaces_transaction_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(replacementId, user.userId, accountId, moving ? destinationAccountId : null, payload.categoryId || null, type, text(payload.description, "Corrected transaction"), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget ? 1 : 0, original.recurring_plan_id || null, spare, original.id, original.id, user.userId, correctionMarker),
        ...balanceStatements(user.userId, replacement, 1, { id: replacementId, status: "posted" }),
      ];
      if (oldSpare?.status === "pending") statements.push(env.DB.prepare("UPDATE spare_events SET status = 'cancelled' WHERE transaction_id = ? AND user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(original.id, user.userId, original.id, user.userId, correctionMarker));
      if (spare && profile?.spare_destination_id) statements.push(env.DB.prepare("INSERT INTO spare_events (id, user_id, transaction_id, multiplied_cents) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(crypto.randomUUID(), user.userId, replacementId, spare, original.id, user.userId, correctionMarker));
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
      await env.DB.prepare("UPDATE profiles SET spare_multiplier = ?, spare_destination_id = ? WHERE user_id = ?").bind(Math.max(1, Math.min(20, Number(payload.multiplier) || 1)), payload.destinationAccountId || null, user.userId).run();
    } else if (action === "sweepSpare") {
      const total = await env.DB.prepare("SELECT COALESCE(SUM(multiplied_cents), 0) AS total FROM spare_events WHERE user_id = ? AND status = 'pending'").bind(user.userId).first<{total:number}>();
      const amount = Number(total?.total || 0);
      if (amount > 0 && payload.sourceAccountId && payload.destinationAccountId) {
        const transactionId = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly) VALUES (?, ?, ?, ?, 'investment', 'Spare change sweep', ?, ?, 1, 1)").bind(transactionId, user.userId, payload.sourceAccountId, payload.destinationAccountId, amount, actionToday),
          env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.sourceAccountId, user.userId),
          env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.destinationAccountId, user.userId),
          env.DB.prepare("UPDATE spare_events SET status = 'swept' WHERE user_id = ? AND status = 'pending'").bind(user.userId),
        ]);
      }
    } else if (action === "addGoal") {
      await env.DB.prepare("INSERT INTO goals (id, user_id, name, kind, target_cents, contributed_cents, account_id, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, text(payload.name), text(payload.kind, "savings"), cents(payload.target) || null, cents(payload.contributed), payload.accountId || null, text(payload.color, "#dff35f")).run();
    } else if (action === "updateGoal") {
      await env.DB.prepare("UPDATE goals SET name = ?, kind = ?, target_cents = ?, contributed_cents = CASE WHEN ? IS NULL THEN ? ELSE contributed_cents END, account_id = ?, color = ? WHERE id = ? AND user_id = ? AND archived = 0").bind(text(payload.name, "Goal"), text(payload.kind, "savings") === "investment" ? "investment" : "savings", cents(payload.target) || null, payload.accountId || null, cents(payload.contributed), payload.accountId || null, text(payload.color, "#dff35f"), payload.goalId, user.userId).run();
    } else if (action === "archiveGoal") {
      await env.DB.prepare("UPDATE goals SET archived = 1 WHERE id = ? AND user_id = ?").bind(payload.goalId, user.userId).run();
    } else if (action === "archiveAccount") {
      const accountId = text(payload.accountId);
      const blocked = await env.DB.prepare("SELECT 1 AS blocked WHERE EXISTS (SELECT 1 FROM recurring_plans WHERE user_id = ? AND active = 1 AND (account_id = ? OR destination_account_id = ?)) OR EXISTS (SELECT 1 FROM installment_plans WHERE user_id = ? AND status = 'active' AND (payment_account_id = ? OR linked_credit_account_id = ?)) OR EXISTS (SELECT 1 FROM goals WHERE user_id = ? AND archived = 0 AND account_id = ?) OR EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND spare_destination_id = ?)").bind(user.userId, accountId, accountId, user.userId, accountId, accountId, user.userId, accountId, user.userId, accountId).first();
      if (blocked) return Response.json({ error: "Move active plans, goals, and spare change away from this account before archiving it." }, { status: 409 });
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
