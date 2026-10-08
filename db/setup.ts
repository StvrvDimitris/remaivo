import { env } from "cloudflare:workers";
import { addCalendarInterval, financialToday, validTimeZone } from "../app/finance-dates";
import type { BudgetConfig } from "../app/v3-engine";
import { ensureFinanceSchema } from "./ensure";
import { defaultCategories, defaultPlanName, nameLanguage, type NameLanguage } from "../app/default-names";

type SetupAccount = { name?: unknown; type?: unknown; balance?: unknown; creditLimit?: unknown; color?: unknown; includeSpendable?: unknown };
type SetupPlan = { target?: unknown; period?: unknown; payday?: unknown; anchor?: unknown; allocation?: unknown; carry?: unknown; carryCap?: unknown; weights?: unknown };
type SetupPayload = { language?: unknown; currency?: unknown; timezone?: unknown; weekStart?: unknown; accounts?: unknown; plan?: unknown; budgets?: unknown; budgetMode?: unknown; carryMode?: unknown };


// Balances may be negative: an overdrawn account, or a credit card that is in your favour.
function signedMoneyCents(value: unknown) {
  const number = Number(value);
  const amount = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(amount)) throw new Error("Enter a valid balance.");
  return amount;
}

function moneyCents(value: unknown) {
  const number = Number(value);
  const amount = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Enter a valid nonnegative amount.");
  return amount;
}

const defaultWeights = [1, 1, 1, 1, 1, 1.4, 1.4];
const validDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function setupConfig(payload: SetupPayload, weekStart: number, today: string, monthStart: string, language: NameLanguage): BudgetConfig {
  const base = { name: defaultPlanName[language], anchor: monthStart, end: addCalendarInterval(monthStart, "monthly"), payday: 1, carryCap: 0, weights: defaultWeights, weekStart };
  if (!payload.plan || typeof payload.plan !== "object") {
    // Earlier clients sent a monthly amount with adaptive or fixed pacing.
    const budget = (payload.budgets || {}) as { monthly?: unknown };
    const allocation = payload.budgetMode === "fixed_split" ? "even" : "adaptive";
    const carry: BudgetConfig["carry"] = allocation === "adaptive" ? "none" : payload.carryMode === "stack_unused" ? "positive" : payload.carryMode === "stack_signed" ? "signed" : "none";
    return { ...base, target: moneyCents(budget.monthly ?? 0), period: "monthly", allocation, carry };
  }
  const plan = payload.plan as SetupPlan;
  const period = String(plan.period || "monthly");
  if (!["monthly", "payday", "weekly", "fortnightly"].includes(period)) throw new Error("Choose a supported budget period.");
  const allocation = String(plan.allocation || "adaptive");
  if (!["adaptive", "even", "weighted"].includes(allocation)) throw new Error("Choose a supported pacing.");
  const carry = allocation === "adaptive" ? "none" : String(plan.carry || "none");
  if (!["none", "positive", "signed", "capped"].includes(carry)) throw new Error("Choose a supported carry setting.");
  const weights = Array.isArray(plan.weights) && plan.weights.length === 7 ? plan.weights.map((weight) => Math.max(0.1, Math.min(10, Number(weight) || 1))) : defaultWeights;
  return {
    ...base,
    target: moneyCents(plan.target ?? 0),
    period: period as BudgetConfig["period"],
    anchor: ["weekly", "fortnightly"].includes(period) ? (validDate(plan.anchor) && String(plan.anchor) <= today ? String(plan.anchor) : today) : monthStart,
    payday: Math.max(1, Math.min(31, Math.round(Number(plan.payday) || 1))),
    allocation: allocation as BudgetConfig["allocation"],
    carry: carry as BudgetConfig["carry"],
    carryCap: carry === "capped" ? moneyCents(plan.carryCap ?? 0) : 0,
    weights,
  };
}

export async function createCurrentPlan(userId: string, payload: SetupPayload) {
  await ensureFinanceSchema();
  const existing = await env.DB.prepare("SELECT setup_complete FROM profiles WHERE user_id = ?").bind(userId).first<{ setup_complete: number }>();
  if (existing?.setup_complete) return false;

  const language = payload.language === "el" ? "el" : "en";
  const currency = String(payload.currency || "EUR").toUpperCase();
  if (!["EUR", "USD", "GBP"].includes(currency)) throw new Error("Choose a supported currency.");
  const timezone = String(payload.timezone || "UTC");
  if (!validTimeZone(timezone)) throw new Error("Choose a valid financial timezone.");
  const rawAccounts = payload.accounts;
  if (!Array.isArray(rawAccounts) || rawAccounts.length < 1 || rawAccounts.length > 30) throw new Error("Add between 1 and 30 accounts.");
  const accounts = rawAccounts as SetupAccount[];
  const weekStart = Math.max(0, Math.min(6, Math.round(Number(payload.weekStart) || 0)));
  const today = financialToday(timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const config = setupConfig(payload, weekStart, today, monthStart, nameLanguage(language));

  const open = "EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND setup_complete = 0)";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("INSERT OR IGNORE INTO profiles (user_id, currency, week_start, timezone, setup_complete) VALUES (?, ?, ?, ?, 0)").bind(userId, currency, weekStart, timezone),
    env.DB.prepare("UPDATE profiles SET currency = ?, week_start = ?, timezone = ?, ui_language = ? WHERE user_id = ? AND setup_complete = 0").bind(currency, weekStart, timezone, language, userId),
  ];

  for (const [index, input] of accounts.entries()) {
    const type = String(input.type || "bank");
    if (!["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].includes(type)) throw new Error("Choose a valid account type.");
    const name = String(input.name || "").trim().slice(0, 120);
    if (!name) throw new Error("Give each account a name.");
    // Credit cards are entered as the amount owed.
    const balance = signedMoneyCents(input.balance || 0) * (type === "credit" ? -1 : 1);
    const creditLimit = input.creditLimit ? moneyCents(input.creditLimit) : null;
    const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color)) ? String(input.color) : "#1f5b4e";
    const spendable = typeof input.includeSpendable === "boolean" ? input.includeSpendable : !["savings", "investment", "credit"].includes(type);
    const accountId = `opening:${userId}:${index}`;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO accounts (id, user_id, name, type, currency, balance_cents, credit_limit_cents, color, include_spendable) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${open}`)
      .bind(accountId, userId, name, type, currency, balance, creditLimit, color, spendable ? 1 : 0, userId));
    // The starting balance is recorded as a one-account ledger entry: destination = money in, source = money out.
    if (balance) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly) SELECT ?, ?, ?, ?, 'opening_balance', 'Opening balance', ?, ?, 0, 0 WHERE ${open}`)
      .bind(`opening:${accountId}`, userId, balance < 0 ? accountId : null, balance > 0 ? accountId : null, Math.abs(balance), today, userId));
  }
  // Default categories start in the chosen interface language.
  for (const category of defaultCategories) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO categories (id, user_id, name, kind, color) SELECT ?, ?, ?, ?, ? WHERE ${open}`)
      .bind(crypto.randomUUID(), userId, category[nameLanguage(language)], category.kind, category.color, userId));
  }
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO v3_versions (id, user_id, effective_from, config_json) SELECT ?, ?, '1900-01-01', ? WHERE ${open}`)
    .bind(`initial:${userId}`, userId, JSON.stringify(config), userId));
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO v3_events (id, user_id, kind, detail) SELECT ?, ?, 'setup', 'Current Plan created from opening balances.' WHERE ${open}`)
    .bind(`setup:${userId}`, userId, userId));
  statements.push(env.DB.prepare("UPDATE profiles SET setup_complete = 1 WHERE user_id = ? AND setup_complete = 0").bind(userId));
  await env.DB.batch(statements);
  return true;
}
