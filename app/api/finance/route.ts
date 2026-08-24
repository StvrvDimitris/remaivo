import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureFinanceSchema } from "../../../db/ensure";
import { addCalendarInterval, financialToday, scheduledOccurrencesThrough, validTimeZone } from "../../finance-dates";

export const dynamic = "force-dynamic";

type FinanceUser = { userId: string; displayName: string; email: string };
type JsonObject = Record<string, unknown>;

const defaultCategories = [
  ["Groceries", "expense", "#d8ead7", "basket"],
  ["Eating out", "expense", "#f5ddcf", "cup"],
  ["Transport", "expense", "#d9e9ec", "car"],
  ["Home & bills", "expense", "#eadfcb", "home"],
  ["Shopping", "expense", "#ead9e6", "bag"],
  ["Health", "expense", "#d8e7df", "heart"],
  ["Entertainment", "expense", "#e6e0f2", "spark"],
  ["Salary", "income", "#d8ead7", "briefcase"],
  ["Other income", "income", "#d9e9ec", "plus"],
] as const;

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

  await processAutomaticPlans(user.userId, today);
  await processAutomaticInstallments(user.userId, today);

  const params = new URL(request.url).searchParams;
  const requestedFrom = calendarDate(params.get("from"));
  const requestedTo = calendarDate(params.get("to"));
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedFrom : monthStart;
  const to = requestedFrom && requestedTo && requestedFrom <= requestedTo ? requestedTo : today;
  const categoryId = text(params.get("categoryId"));
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

async function processAutomaticPlans(userId: string, today: string) {
  let reconciledPlans = 0;
  while (true) {
    const plans = await env.DB.prepare(
      "SELECT * FROM recurring_plans WHERE user_id = ? AND active = 1 AND auto_post = 1 AND next_date <= ? ORDER BY next_date LIMIT 100",
    ).bind(userId, today).all<Record<string, unknown>>();
    if (!plans.results.length) return;

    for (const plan of plans.results) {
      reconciledPlans += 1;
      if (reconciledPlans > 50_000) throw new Error("Automatic recurring reconciliation exceeded its safety limit.");
      const schedule = scheduledOccurrencesThrough(
        String(plan.next_date),
        String(plan.frequency),
        Number(plan.interval_count) || 1,
        today,
        plan.end_date ? String(plan.end_date) : null,
        Number(plan.anchor_day) || Number(String(plan.next_date).slice(8, 10)),
      );

      for (const scheduledDate of schedule.occurrences) {
        const transactionId = crypto.randomUUID();
        const amount = Number(plan.amount_cents);
        const type = String(plan.type);
        const committed = Number(plan.committed) === 1;
        const transaction = { type, amount_cents: amount, account_id: plan.account_id, destination_account_id: plan.destination_account_id };
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, recurring_plan_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ? WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE user_id = ? AND recurring_plan_id = ? AND date = ? AND status = 'posted')",
          ).bind(transactionId, userId, plan.account_id, plan.destination_account_id, plan.category_id, type, plan.title, amount, scheduledDate, committed ? 1 : 0, committed ? 0 : 1, committed ? 0 : 1, plan.id, userId, plan.id, scheduledDate),
          ...balanceStatements(userId, transaction, 1, { id: transactionId, status: "posted" }),
        ]);
      }

      await env.DB.prepare("UPDATE recurring_plans SET next_date = ?, active = CASE WHEN ? = 1 THEN 0 ELSE active END WHERE id = ? AND user_id = ?")
        .bind(schedule.nextDate, schedule.ended ? 1 : 0, plan.id, userId).run();
    }
  }
}

async function recordInstallmentPayment(userId: string, paymentId: string) {
  const payment = await env.DB.prepare(
    "SELECT ip.*, p.title, p.payment_account_id, p.category_id, p.include_daily_weekly FROM installment_payments ip JOIN installment_plans p ON p.id = ip.plan_id WHERE ip.id = ? AND ip.user_id = ? AND ip.status = 'upcoming' AND p.status = 'active'",
  ).bind(paymentId, userId).first<Record<string, unknown>>();
  if (!payment) return false;

  const transactionId = crypto.randomUUID();
  const amount = Number(payment.amount_cents);
  const planId = String(payment.plan_id);
  const includeDailyWeekly = Number(payment.include_daily_weekly) === 1 ? 1 : 0;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE installment_payments SET status = 'paid', paid_transaction_id = ? WHERE id = ? AND user_id = ? AND status = 'upcoming'").bind(transactionId, paymentId, userId),
    env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, installment_plan_id) SELECT ?, ?, ?, ?, 'installment_payment', ?, ?, ?, 1, ?, ?, 1, 1, ? WHERE EXISTS (SELECT 1 FROM installment_payments WHERE id = ? AND user_id = ? AND paid_transaction_id = ?)").bind(transactionId, userId, payment.payment_account_id, payment.category_id, payment.title, amount, payment.due_date, includeDailyWeekly, includeDailyWeekly, planId, paymentId, userId, transactionId),
    env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM installment_payments WHERE id = ? AND user_id = ? AND paid_transaction_id = ?)").bind(amount, payment.payment_account_id, userId, paymentId, userId, transactionId),
    env.DB.prepare("UPDATE installment_plans SET paid_cents = COALESCE((SELECT SUM(amount_cents) FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'paid'), 0), status = CASE WHEN COALESCE((SELECT SUM(amount_cents) FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'paid'), 0) >= total_cents THEN 'complete' ELSE 'active' END WHERE id = ? AND user_id = ?").bind(planId, userId, planId, userId, planId, userId),
  ]);
  return Number(results[0].meta.changes) > 0;
}

async function processAutomaticInstallments(userId: string, today: string) {
  let reconciledPayments = 0;
  while (true) {
    const due = await env.DB.prepare(
      "SELECT ip.id FROM installment_payments ip JOIN installment_plans p ON p.id = ip.plan_id WHERE ip.user_id = ? AND ip.status = 'upcoming' AND ip.due_date <= ? AND p.status = 'active' AND p.auto_post = 1 ORDER BY ip.due_date LIMIT 100",
    ).bind(userId, today).all<Record<string, unknown>>();
    if (!due.results.length) return;
    for (const payment of due.results) {
      reconciledPayments += 1;
      if (reconciledPayments > 50_000) throw new Error("Automatic installment reconciliation exceeded its safety limit.");
      await recordInstallmentPayment(userId, String(payment.id));
    }
  }
}

async function snapshot(user: FinanceUser) {
  await ensureFinanceSchema();
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  const today = financialToday(String(profile?.timezone || "UTC"));
  if (!profile?.setup_complete) {
    return { needsSetup: true, user, today };
  }

  await processAutomaticPlans(user.userId, today);
  await processAutomaticInstallments(user.userId, today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [accounts, categories, transactions, budgets, recurring, installmentPlans, installmentPayments, goals, spareEvents, investmentSnapshots] = await env.DB.batch([
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
    env.DB.prepare("SELECT * FROM budget_rules WHERE user_id = ? AND period IN ('daily', 'weekly', 'monthly') ORDER BY CASE period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END").bind(user.userId),
    env.DB.prepare("SELECT * FROM recurring_plans WHERE user_id = ? AND active = 1 ORDER BY next_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_plans WHERE user_id = ? AND status = 'active' ORDER BY first_due_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_payments WHERE user_id = ? AND status != 'cancelled' ORDER BY due_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM goals WHERE user_id = ? AND archived = 0 ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM spare_events WHERE user_id = ? AND status = 'pending' ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM investment_valuation_snapshots WHERE user_id = ? ORDER BY snapshot_date DESC, created_at DESC").bind(user.userId),
  ]);

  return {
    needsSetup: false,
    user,
    profile,
    accounts: accounts.results,
    categories: categories.results,
    transactions: transactions.results,
    budgets: budgets.results,
    recurring: recurring.results,
    installmentPlans: installmentPlans.results,
    installmentPayments: installmentPayments.results,
    goals: goals.results,
    spareEvents: spareEvents.results,
    investmentSnapshots: investmentSnapshots.results,
    today,
  };
}

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to continue." }, { status: 401 });
  try {
    if (new URL(request.url).searchParams.get("view") === "transactions") return Response.json(await pagedTransactions(user, request));
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

    if (action === "setup") {
      const currency = text(payload.currency, "EUR").slice(0, 3).toUpperCase();
      const timezone = text(payload.timezone, "UTC");
      if (!validTimeZone(timezone)) return Response.json({ error: "Choose a valid financial timezone." }, { status: 400 });
      const today = text(payload.startDate, financialToday(timezone));
      const inputAccounts = Array.isArray(payload.accounts) ? payload.accounts as JsonObject[] : [];
      if (!inputAccounts.length) return Response.json({ error: "Add at least one account." }, { status: 400 });

      const statements = [
        env.DB.prepare("INSERT INTO profiles (user_id, currency, week_start, timezone, setup_complete) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET currency = excluded.currency, week_start = excluded.week_start, timezone = excluded.timezone, setup_complete = 1").bind(user.userId, currency, Number(payload.weekStart) || 1, timezone),
      ];
      for (const account of inputAccounts) {
        const id = crypto.randomUUID();
        const amount = cents(account.balance);
        const signedAmount = text(account.type) === "credit" ? -amount : amount;
        statements.push(env.DB.prepare("INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_cents, balance_cents, credit_limit_cents, color, include_spendable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, user.userId, text(account.name, "My account"), text(account.type, "bank"), currency, signedAmount, signedAmount, cents(account.creditLimit) || null, text(account.color, "#1f5b4e"), bool(account.includeSpendable, !["savings", "investment", "credit"].includes(text(account.type))) ? 1 : 0));
      }
      for (const [name, kind, color, icon] of defaultCategories) {
        statements.push(env.DB.prepare("INSERT OR IGNORE INTO categories (id, user_id, name, kind, color, icon) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, name, kind, color, icon));
      }
      const budgetInput = (payload.budgets ?? {}) as JsonObject;
      const budgetMode = text(payload.budgetMode) === "fixed_split" ? "fixed_split" : "adaptive";
      const setupCarry = budgetMode === "adaptive" ? "reset" : (["reset", "stack_unused", "stack_signed", "stack_capped"].includes(text(payload.carryMode)) ? text(payload.carryMode) : "reset");
      const setupReset = ["daily", "weekly", "monthly"].includes(text(payload.resetBoundary)) ? text(payload.resetBoundary) : "monthly";
      for (const period of ["daily", "weekly", "monthly"]) {
        statements.push(env.DB.prepare("INSERT OR REPLACE INTO budget_rules (id, user_id, period, base_cents, carry_mode, anchor_date, source_type, parent_period, calculation_mode, percentage_basis_points, hard_reset, include_everyday, include_committed, include_savings, include_investments, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10000, ?, 1, 1, 1, 1, 1)").bind(crypto.randomUUID(), user.userId, period, cents(budgetInput.monthly), setupCarry, today, period === "monthly" ? "manual" : "derived", period === "monthly" ? null : "monthly", budgetMode, setupReset));
      }
      await env.DB.batch(statements);
    } else if (action === "addAccount") {
      const amount = cents(payload.balance);
      const type = text(payload.type, "bank");
      const signedAmount = type === "credit" ? -amount : amount;
      await env.DB.prepare("INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_cents, balance_cents, credit_limit_cents, color, include_spendable) SELECT ?, ?, ?, ?, currency, ?, ?, ?, ?, ? FROM profiles WHERE user_id = ?").bind(crypto.randomUUID(), user.userId, text(payload.name, "New account"), type, signedAmount, signedAmount, cents(payload.creditLimit) || null, text(payload.color, "#1f5b4e"), bool(payload.includeSpendable, !["savings", "investment", "credit"].includes(type)) ? 1 : 0, user.userId).run();
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
      await env.DB.prepare("INSERT INTO categories (id, user_id, name, kind, color, icon) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, text(payload.name), text(payload.kind, "expense"), text(payload.color, "#cfe9d7"), text(payload.icon, "circle")).run();
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
      const countsBudget = type === "expense" || type === "installment_payment" || type === "saving" || type === "investment";
      let spare = 0;
      const profile = await env.DB.prepare("SELECT spare_multiplier, spare_destination_id FROM profiles WHERE user_id = ?").bind(user.userId).first<{spare_multiplier:number; spare_destination_id:string | null}>();
      if (type === "expense" && bool(payload.useSpare) && profile?.spare_destination_id) {
        const base = (100 - (amount % 100)) % 100;
        spare = base * Math.max(1, profile.spare_multiplier);
      }
      const statements = [env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, spare_change_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, user.userId, payload.accountId || null, payload.destinationAccountId || null, payload.categoryId || null, type, text(payload.description), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget && !committed && !isMovement ? 1 : 0, countsBudget && !committed && !isMovement ? 1 : 0, countsBudget ? 1 : 0, countsBudget ? 1 : 0, spare)];
      if (type === "income") statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      else if (isMovement) {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, payload.destinationAccountId, user.userId));
      } else statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, payload.accountId, user.userId));
      if (spare && profile?.spare_destination_id) {
        statements.push(env.DB.prepare("INSERT INTO spare_events (id, user_id, transaction_id, destination_account_id, base_cents, multiplied_cents) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, id, profile.spare_destination_id, Math.round(spare / Math.max(1, profile.spare_multiplier)), spare));
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
      const countsBudget = ["expense", "saving", "investment"].includes(type);
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
        env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, recurring_plan_id, spare_change_cents, replaces_transaction_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(replacementId, user.userId, accountId, moving ? destinationAccountId : null, payload.categoryId || null, type, text(payload.description, "Corrected transaction"), amount, text(payload.date, actionToday), committed ? 1 : 0, countsBudget && !committed && !moving ? 1 : 0, countsBudget && !committed && !moving ? 1 : 0, countsBudget ? 1 : 0, countsBudget ? 1 : 0, original.recurring_plan_id || null, spare, original.id, original.id, user.userId, correctionMarker),
        ...balanceStatements(user.userId, replacement, 1, { id: replacementId, status: "posted" }),
      ];
      if (oldSpare?.status === "pending") statements.push(env.DB.prepare("UPDATE spare_events SET status = 'cancelled' WHERE transaction_id = ? AND user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(original.id, user.userId, original.id, user.userId, correctionMarker));
      if (spare && profile?.spare_destination_id) statements.push(env.DB.prepare("INSERT INTO spare_events (id, user_id, transaction_id, destination_account_id, base_cents, multiplied_cents) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ? AND status = ?)").bind(crypto.randomUUID(), user.userId, replacementId, profile.spare_destination_id, Math.round(spare / Math.max(1, profile.spare_multiplier)), spare, original.id, user.userId, correctionMarker));
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
      await env.DB.prepare("UPDATE recurring_plans SET title = ?, category_id = ?, amount_cents = ?, account_id = ?, frequency = ?, interval_count = ?, next_date = ?, anchor_day = ?, auto_post = ?, committed = ? WHERE id = ? AND user_id = ? AND active = 1").bind(text(payload.title, "Recurring plan"), categoryId, amount, payload.accountId || null, text(payload.frequency, "monthly"), Math.max(1, Number(payload.intervalCount) || 1), nextDate, anchorDay, bool(payload.autoPost) ? 1 : 0, bool(payload.committed) ? 1 : 0, payload.planId, user.userId).run();
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
        env.DB.prepare("INSERT INTO installment_plans (id, user_id, title, provider, category_id, total_cents, paid_cents, installment_count, first_due_date, frequency, payment_account_id, linked_credit_account_id, include_daily_weekly, auto_post) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)").bind(planId, user.userId, text(payload.title), text(payload.provider) || null, categoryId, total, count, firstDue, text(payload.frequency, "monthly"), payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.includeDailyWeekly) ? 1 : 0, bool(payload.autoPost) ? 1 : 0),
        env.DB.prepare("INSERT INTO transactions (id, user_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, installment_plan_id) VALUES (?, ?, ?, 'installment_purchase', ?, ?, ?, 1, 0, 0, 0, 0, ?)").bind(crypto.randomUUID(), user.userId, categoryId, text(payload.title), total, text(payload.purchaseDate, actionToday), planId),
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
      const paidCents = Number(paid?.paid_cents || 0);
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
        env.DB.prepare("UPDATE installment_plans SET title = ?, provider = ?, category_id = ?, total_cents = ?, paid_cents = ?, installment_count = ?, first_due_date = ?, frequency = ?, payment_account_id = ?, linked_credit_account_id = ?, include_daily_weekly = ?, auto_post = ? WHERE id = ? AND user_id = ? AND status = 'active'").bind(text(payload.title, "Pay-later plan"), text(payload.provider) || null, categoryId, total, paidCents, paidCount + remainingCount, paidCount ? plan.first_due_date : nextDueDate, frequency, payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.includeDailyWeekly) ? 1 : 0, bool(payload.autoPost) ? 1 : 0, payload.planId, user.userId),
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
    } else if (action === "payInstallment") {
      const recorded = await recordInstallmentPayment(user.userId, text(payload.paymentId));
      if (!recorded) return Response.json({ error: "Installment not found or already paid." }, { status: 404 });
    } else if (action === "updateBudget") {
      const calculationMode = text(payload.calculationMode) === "adaptive" ? "adaptive" : "fixed_split";
      const carryMode = calculationMode === "adaptive" ? "reset" : (["reset", "stack_unused", "stack_signed", "stack_capped"].includes(text(payload.carryMode)) ? text(payload.carryMode) : "reset");
      const hardReset = ["daily", "weekly", "monthly"].includes(text(payload.hardReset)) ? text(payload.hardReset) : "monthly";
      const values = {
        base: cents(payload.base),
        cap: cents(payload.carryCap) || null,
        anchor: text(payload.anchorDate, actionToday),
        everyday: bool(payload.includeEveryday, true) ? 1 : 0,
        committed: bool(payload.includeCommitted) ? 1 : 0,
        savings: bool(payload.includeSavings) ? 1 : 0,
        investments: bool(payload.includeInvestments) ? 1 : 0,
      };
      const statements = ["daily", "weekly", "monthly"].map((period) => env.DB.prepare("INSERT INTO budget_rules (id, user_id, period, base_cents, carry_mode, carry_cap_cents, anchor_date, source_type, parent_period, calculation_mode, percentage_basis_points, hard_reset, include_everyday, include_committed, include_savings, include_investments, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10000, ?, ?, ?, ?, ?, 1) ON CONFLICT(user_id, period) DO UPDATE SET base_cents = excluded.base_cents, carry_mode = excluded.carry_mode, carry_cap_cents = excluded.carry_cap_cents, anchor_date = excluded.anchor_date, source_type = excluded.source_type, parent_period = excluded.parent_period, calculation_mode = excluded.calculation_mode, percentage_basis_points = 10000, hard_reset = excluded.hard_reset, include_everyday = excluded.include_everyday, include_committed = excluded.include_committed, include_savings = excluded.include_savings, include_investments = excluded.include_investments, active = 1").bind(crypto.randomUUID(), user.userId, period, values.base, carryMode, values.cap, values.anchor, period === "monthly" ? "manual" : "derived", period === "monthly" ? null : "monthly", calculationMode, hardReset, values.everyday, values.committed, values.savings, values.investments));
      await env.DB.batch(statements);
    } else if (action === "updateWeekStart") {
      const weekStart = Math.max(0, Math.min(6, Math.round(Number(payload.weekStart) || 0)));
      await env.DB.prepare("UPDATE profiles SET week_start = ? WHERE user_id = ?").bind(weekStart, user.userId).run();
    } else if (action === "updateTimezone") {
      const timezone = text(payload.timezone);
      if (!validTimeZone(timezone)) return Response.json({ error: "Choose a valid financial timezone." }, { status: 400 });
      await env.DB.prepare("UPDATE profiles SET timezone = ? WHERE user_id = ?").bind(timezone, user.userId).run();
    } else if (action === "updateSpare") {
      await env.DB.prepare("UPDATE profiles SET spare_multiplier = ?, spare_destination_id = ?, spare_sweep_mode = ?, spare_threshold_cents = ? WHERE user_id = ?").bind(Math.max(1, Math.min(20, Number(payload.multiplier) || 1)), payload.destinationAccountId || null, text(payload.sweepMode, "threshold"), cents(payload.threshold), user.userId).run();
    } else if (action === "sweepSpare") {
      const total = await env.DB.prepare("SELECT COALESCE(SUM(multiplied_cents), 0) AS total FROM spare_events WHERE user_id = ? AND status = 'pending'").bind(user.userId).first<{total:number}>();
      const amount = Number(total?.total || 0);
      if (amount > 0 && payload.sourceAccountId && payload.destinationAccountId) {
        const transactionId = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general) VALUES (?, ?, ?, ?, 'investment', 'Spare change sweep', ?, ?, 1, 0, 0, 1, 1)").bind(transactionId, user.userId, payload.sourceAccountId, payload.destinationAccountId, amount, actionToday),
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
