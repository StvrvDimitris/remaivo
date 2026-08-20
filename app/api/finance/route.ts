import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureFinanceSchema } from "../../../db/ensure";

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

function addInterval(dateValue: string, frequency: string, interval = 1) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  if (frequency === "daily") date.setUTCDate(date.getUTCDate() + interval);
  else if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7 * interval);
  else if (frequency === "yearly") date.setUTCFullYear(date.getUTCFullYear() + interval);
  else date.setUTCMonth(date.getUTCMonth() + interval);
  return date.toISOString().slice(0, 10);
}

async function processAutomaticPlans(userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const plans = await env.DB.prepare(
    "SELECT * FROM recurring_plans WHERE user_id = ? AND active = 1 AND auto_post = 1 AND next_date <= ? ORDER BY next_date LIMIT 25",
  ).bind(userId, today).all<Record<string, unknown>>();

  for (const plan of plans.results) {
    let nextDate = String(plan.next_date);
    let guard = 0;
    while (nextDate <= today && guard < 12) {
      const transactionId = crypto.randomUUID();
      const amount = Number(plan.amount_cents);
      const type = String(plan.type);
      const committed = Number(plan.committed) === 1;
      const statements = [
        env.DB.prepare(
          "INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, recurring_plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)",
        ).bind(transactionId, userId, plan.account_id, plan.destination_account_id, plan.category_id, type, plan.title, amount, nextDate, committed ? 1 : 0, committed ? 0 : 1, committed ? 0 : 1, plan.id),
      ];

      if (type === "income") {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, plan.account_id, userId));
      } else if (["transfer", "saving", "investment"].includes(type)) {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, plan.account_id, userId));
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ?").bind(amount, plan.destination_account_id, userId));
      } else {
        statements.push(env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ?").bind(amount, plan.account_id, userId));
      }
      await env.DB.batch(statements);
      nextDate = addInterval(nextDate, String(plan.frequency), Number(plan.interval_count) || 1);
      guard += 1;
    }
    await env.DB.prepare("UPDATE recurring_plans SET next_date = ? WHERE id = ? AND user_id = ?").bind(nextDate, plan.id, userId).run();
  }
}

async function recordInstallmentPayment(userId: string, paymentId: string, date: string) {
  const payment = await env.DB.prepare(
    "SELECT ip.*, p.title, p.payment_account_id, p.include_daily_weekly FROM installment_payments ip JOIN installment_plans p ON p.id = ip.plan_id WHERE ip.id = ? AND ip.user_id = ? AND ip.status = 'upcoming' AND p.status = 'active'",
  ).bind(paymentId, userId).first<Record<string, unknown>>();
  if (!payment) return false;

  const transactionId = crypto.randomUUID();
  const amount = Number(payment.amount_cents);
  const planId = String(payment.plan_id);
  const includeDailyWeekly = Number(payment.include_daily_weekly) === 1 ? 1 : 0;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE installment_payments SET status = 'paid', paid_transaction_id = ? WHERE id = ? AND user_id = ? AND status = 'upcoming'").bind(transactionId, paymentId, userId),
    env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, installment_plan_id) SELECT ?, ?, ?, 'installment_payment', ?, ?, ?, 1, ?, ?, 1, 1, ? WHERE EXISTS (SELECT 1 FROM installment_payments WHERE id = ? AND user_id = ? AND paid_transaction_id = ?)").bind(transactionId, userId, payment.payment_account_id, payment.title, amount, date, includeDailyWeekly, includeDailyWeekly, planId, paymentId, userId, transactionId),
    env.DB.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM installment_payments WHERE id = ? AND user_id = ? AND paid_transaction_id = ?)").bind(amount, payment.payment_account_id, userId, paymentId, userId, transactionId),
    env.DB.prepare("UPDATE installment_plans SET paid_cents = COALESCE((SELECT SUM(amount_cents) FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'paid'), 0), status = CASE WHEN COALESCE((SELECT SUM(amount_cents) FROM installment_payments WHERE plan_id = ? AND user_id = ? AND status = 'paid'), 0) >= total_cents THEN 'complete' ELSE 'active' END WHERE id = ? AND user_id = ?").bind(planId, userId, planId, userId, planId, userId),
  ]);
  return Number(results[0].meta.changes) > 0;
}

async function processAutomaticInstallments(userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const due = await env.DB.prepare(
    "SELECT ip.id, ip.due_date FROM installment_payments ip JOIN installment_plans p ON p.id = ip.plan_id WHERE ip.user_id = ? AND ip.status = 'upcoming' AND ip.due_date <= ? AND p.status = 'active' AND p.auto_post = 1 ORDER BY ip.due_date LIMIT 120",
  ).bind(userId, today).all<Record<string, unknown>>();
  for (const payment of due.results) {
    await recordInstallmentPayment(userId, String(payment.id), String(payment.due_date));
  }
}

async function snapshot(user: FinanceUser) {
  await ensureFinanceSchema();
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(user.userId).first<Record<string, unknown>>();
  if (!profile?.setup_complete) {
    return { needsSetup: true, user, today: new Date().toISOString().slice(0, 10) };
  }

  await processAutomaticPlans(user.userId);
  await processAutomaticInstallments(user.userId);
  const [accounts, categories, transactions, budgets, recurring, installmentPlans, installmentPayments, goals, spareEvents] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY archived, created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM categories WHERE user_id = ? ORDER BY archived, kind, name").bind(user.userId),
    env.DB.prepare("SELECT * FROM transactions WHERE user_id = ? AND status = 'posted' ORDER BY date DESC, created_at DESC LIMIT 250").bind(user.userId),
    env.DB.prepare("SELECT * FROM budget_rules WHERE user_id = ? AND period IN ('daily', 'weekly', 'monthly') ORDER BY CASE period WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END").bind(user.userId),
    env.DB.prepare("SELECT * FROM recurring_plans WHERE user_id = ? AND active = 1 ORDER BY next_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_plans WHERE user_id = ? AND status = 'active' ORDER BY first_due_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM installment_payments WHERE user_id = ? AND status != 'cancelled' ORDER BY due_date").bind(user.userId),
    env.DB.prepare("SELECT * FROM goals WHERE user_id = ? AND archived = 0 ORDER BY created_at").bind(user.userId),
    env.DB.prepare("SELECT * FROM spare_events WHERE user_id = ? AND status = 'pending' ORDER BY created_at").bind(user.userId),
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
    today: new Date().toISOString().slice(0, 10),
  };
}

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in with ChatGPT to continue." }, { status: 401 });
  try {
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

    if (action === "setup") {
      const currency = text(payload.currency, "EUR").slice(0, 3).toUpperCase();
      const today = text(payload.startDate, new Date().toISOString().slice(0, 10));
      const inputAccounts = Array.isArray(payload.accounts) ? payload.accounts as JsonObject[] : [];
      if (!inputAccounts.length) return Response.json({ error: "Add at least one account." }, { status: 400 });

      const statements = [
        env.DB.prepare("INSERT INTO profiles (user_id, currency, week_start, setup_complete) VALUES (?, ?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET currency = excluded.currency, week_start = excluded.week_start, setup_complete = 1").bind(user.userId, currency, Number(payload.weekStart) || 1),
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
      const carryInput = (payload.carryModes ?? {}) as JsonObject;
      for (const period of ["daily", "weekly", "monthly"]) {
        const derived = period === "daily" || period === "weekly";
        const parent = period === "daily" ? "weekly" : period === "weekly" ? "monthly" : null;
        const reset = period === "daily" ? "weekly" : period === "weekly" ? "monthly" : "yearly";
        const broadPool = period === "monthly";
        statements.push(env.DB.prepare("INSERT OR REPLACE INTO budget_rules (id, user_id, period, base_cents, carry_mode, anchor_date, source_type, parent_period, calculation_mode, percentage_basis_points, hard_reset, include_everyday, include_committed, include_savings, include_investments, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'adaptive', 10000, ?, 1, ?, ?, ?, 1)").bind(crypto.randomUUID(), user.userId, period, cents(budgetInput[period]), derived ? "reset" : text(carryInput[period], "reset"), today, derived ? "derived" : "manual", parent, reset, broadPool ? 1 : 0, broadPool ? 1 : 0, broadPool ? 1 : 0));
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
      const statements = [env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, spare_change_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, user.userId, payload.accountId || null, payload.destinationAccountId || null, payload.categoryId || null, type, text(payload.description), amount, text(payload.date, new Date().toISOString().slice(0, 10)), committed ? 1 : 0, countsBudget && !committed && !isMovement ? 1 : 0, countsBudget && !committed && !isMovement ? 1 : 0, countsBudget ? 1 : 0, countsBudget ? 1 : 0, spare)];
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
      await env.DB.prepare("UPDATE transactions SET description = ?, date = ?, category_id = ? WHERE id = ? AND user_id = ? AND status = 'posted'").bind(text(payload.description, "Transaction"), text(payload.date, new Date().toISOString().slice(0, 10)), payload.categoryId || null, payload.transactionId, user.userId).run();
    } else if (action === "addRecurring") {
      await env.DB.prepare("INSERT INTO recurring_plans (id, user_id, title, type, amount_cents, account_id, destination_account_id, category_id, frequency, interval_count, next_date, end_date, auto_post, committed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, text(payload.title), text(payload.type, "expense"), cents(payload.amount), payload.accountId || null, payload.destinationAccountId || null, payload.categoryId || null, text(payload.frequency, "monthly"), Number(payload.intervalCount) || 1, text(payload.nextDate), payload.endDate || null, bool(payload.autoPost) ? 1 : 0, bool(payload.committed, true) ? 1 : 0).run();
    } else if (action === "updateRecurring") {
      const amount = cents(payload.amount);
      if (!amount) return Response.json({ error: "Amount is required." }, { status: 400 });
      await env.DB.prepare("UPDATE recurring_plans SET title = ?, amount_cents = ?, account_id = ?, frequency = ?, interval_count = ?, next_date = ?, auto_post = ?, committed = ? WHERE id = ? AND user_id = ? AND active = 1").bind(text(payload.title, "Recurring plan"), amount, payload.accountId || null, text(payload.frequency, "monthly"), Math.max(1, Number(payload.intervalCount) || 1), text(payload.nextDate), bool(payload.autoPost) ? 1 : 0, bool(payload.committed) ? 1 : 0, payload.planId, user.userId).run();
    } else if (action === "archiveRecurring") {
      await env.DB.prepare("UPDATE recurring_plans SET active = 0 WHERE id = ? AND user_id = ?").bind(payload.planId, user.userId).run();
    } else if (action === "addInstallment") {
      const planId = crypto.randomUUID();
      const total = cents(payload.total);
      const count = Math.max(1, Math.min(120, Number(payload.installmentCount) || 1));
      const firstDue = text(payload.firstDueDate);
      if (!total || !firstDue || !payload.paymentAccountId) return Response.json({ error: "Amount, installment count, first date, and payment account are required." }, { status: 400 });
      const base = Math.floor(total / count);
      const custom = Array.isArray(payload.customAmounts) ? payload.customAmounts.map(cents) : [];
      const statements = [
        env.DB.prepare("INSERT INTO installment_plans (id, user_id, title, provider, category_id, total_cents, paid_cents, installment_count, first_due_date, frequency, payment_account_id, linked_credit_account_id, include_daily_weekly, auto_post) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)").bind(planId, user.userId, text(payload.title), text(payload.provider) || null, payload.categoryId || null, total, count, firstDue, text(payload.frequency, "monthly"), payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.includeDailyWeekly) ? 1 : 0, bool(payload.autoPost) ? 1 : 0),
        env.DB.prepare("INSERT INTO transactions (id, user_id, category_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general, installment_plan_id) VALUES (?, ?, ?, 'installment_purchase', ?, ?, ?, 1, 0, 0, 0, 0, ?)").bind(crypto.randomUUID(), user.userId, payload.categoryId || null, text(payload.title), total, text(payload.purchaseDate, new Date().toISOString().slice(0, 10)), planId),
      ];
      for (let index = 0; index < count; index += 1) {
        const amount = custom.length === count ? custom[index] : index === count - 1 ? total - base * (count - 1) : base;
        statements.push(env.DB.prepare("INSERT INTO installment_payments (id, user_id, plan_id, sequence, due_date, amount_cents) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.userId, planId, index + 1, addInterval(firstDue, text(payload.frequency, "monthly"), index), amount));
      }
      await env.DB.batch(statements);
    } else if (action === "updateInstallmentPlan") {
      await env.DB.batch([
        env.DB.prepare("UPDATE installment_plans SET title = ?, provider = ?, payment_account_id = ?, linked_credit_account_id = ?, include_daily_weekly = ?, auto_post = ? WHERE id = ? AND user_id = ? AND status = 'active'").bind(text(payload.title, "Pay-later plan"), text(payload.provider) || null, payload.paymentAccountId, payload.linkedCreditAccountId || null, bool(payload.includeDailyWeekly) ? 1 : 0, bool(payload.autoPost) ? 1 : 0, payload.planId, user.userId),
        env.DB.prepare("UPDATE transactions SET description = ? WHERE user_id = ? AND installment_plan_id = ? AND type = 'installment_purchase'").bind(text(payload.title, "Pay-later plan"), user.userId, payload.planId),
      ]);
    } else if (action === "archiveInstallmentPlan") {
      await env.DB.batch([
        env.DB.prepare("UPDATE installment_plans SET status = 'archived' WHERE id = ? AND user_id = ? AND status = 'active'").bind(payload.planId, user.userId),
        env.DB.prepare("UPDATE installment_payments SET status = 'cancelled' WHERE plan_id = ? AND user_id = ? AND status = 'upcoming'").bind(payload.planId, user.userId),
      ]);
    } else if (action === "payInstallment") {
      const recorded = await recordInstallmentPayment(user.userId, text(payload.paymentId), text(payload.date, new Date().toISOString().slice(0, 10)));
      if (!recorded) return Response.json({ error: "Installment not found or already paid." }, { status: 404 });
    } else if (action === "updateBudget") {
      const period = text(payload.period, "daily");
      if (!["daily", "weekly", "monthly"].includes(period)) return Response.json({ error: "Unknown budget window." }, { status: 400 });
      const sourceType = text(payload.sourceType, "manual") === "derived" && period !== "monthly" ? "derived" : "manual";
      const calculationMode = ["adaptive", "fixed_split", "percentage"].includes(text(payload.calculationMode)) ? text(payload.calculationMode) : "adaptive";
      const percentageBasisPoints = Math.max(1, Math.min(10000, Math.round((Number(payload.percentage) || 100) * 100)));
      const parentDefaults: Record<string, string | null> = { daily: "weekly", weekly: "monthly", monthly: null };
      const hardResetDefaults: Record<string, string> = { daily: "weekly", weekly: "monthly", monthly: "yearly" };
      await env.DB.prepare("INSERT INTO budget_rules (id, user_id, period, base_cents, carry_mode, carry_cap_cents, anchor_date, source_type, parent_period, calculation_mode, percentage_basis_points, hard_reset, include_everyday, include_committed, include_savings, include_investments, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, period) DO UPDATE SET base_cents = excluded.base_cents, carry_mode = excluded.carry_mode, carry_cap_cents = excluded.carry_cap_cents, anchor_date = excluded.anchor_date, source_type = excluded.source_type, parent_period = excluded.parent_period, calculation_mode = excluded.calculation_mode, percentage_basis_points = excluded.percentage_basis_points, hard_reset = excluded.hard_reset, include_everyday = excluded.include_everyday, include_committed = excluded.include_committed, include_savings = excluded.include_savings, include_investments = excluded.include_investments, active = excluded.active").bind(crypto.randomUUID(), user.userId, period, cents(payload.base), text(payload.carryMode, "reset"), cents(payload.carryCap) || null, text(payload.anchorDate, new Date().toISOString().slice(0, 10)), sourceType, sourceType === "derived" ? text(payload.parentPeriod, parentDefaults[period] ?? "") || parentDefaults[period] : parentDefaults[period], calculationMode, percentageBasisPoints, text(payload.hardReset, hardResetDefaults[period] ?? "none"), bool(payload.includeEveryday, true) ? 1 : 0, bool(payload.includeCommitted) ? 1 : 0, bool(payload.includeSavings) ? 1 : 0, bool(payload.includeInvestments) ? 1 : 0, bool(payload.enabled, true) ? 1 : 0).run();
    } else if (action === "updateWeekStart") {
      const weekStart = Math.max(0, Math.min(6, Math.round(Number(payload.weekStart) || 0)));
      await env.DB.prepare("UPDATE profiles SET week_start = ? WHERE user_id = ?").bind(weekStart, user.userId).run();
    } else if (action === "updateSpare") {
      await env.DB.prepare("UPDATE profiles SET spare_multiplier = ?, spare_destination_id = ?, spare_sweep_mode = ?, spare_threshold_cents = ? WHERE user_id = ?").bind(Math.max(1, Math.min(20, Number(payload.multiplier) || 1)), payload.destinationAccountId || null, text(payload.sweepMode, "threshold"), cents(payload.threshold), user.userId).run();
    } else if (action === "sweepSpare") {
      const total = await env.DB.prepare("SELECT COALESCE(SUM(multiplied_cents), 0) AS total FROM spare_events WHERE user_id = ? AND status = 'pending'").bind(user.userId).first<{total:number}>();
      const amount = Number(total?.total || 0);
      if (amount > 0 && payload.sourceAccountId && payload.destinationAccountId) {
        const transactionId = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_daily, counts_weekly, counts_monthly, counts_general) VALUES (?, ?, ?, ?, 'investment', 'Spare change sweep', ?, ?, 1, 0, 0, 1, 1)").bind(transactionId, user.userId, payload.sourceAccountId, payload.destinationAccountId, amount, new Date().toISOString().slice(0, 10)),
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
