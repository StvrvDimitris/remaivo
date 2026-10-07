import { env } from "cloudflare:workers";
import { addCalendarInterval, financialToday, validTimeZone } from "../app/finance-dates";
import type { BudgetConfig } from "../app/v3-engine";
import { ensureFinanceSchema } from "./ensure";

type SetupAccount = { name?: unknown; type?: unknown; balance?: unknown; creditLimit?: unknown; color?: unknown; includeSpendable?: unknown };
type SetupPayload = { language?: unknown; currency?: unknown; timezone?: unknown; weekStart?: unknown; accounts?: unknown; budgets?: unknown; budgetMode?: unknown; carryMode?: unknown };

const categories = [
  ["Groceries", "expense", "#d8ead7"],
  ["Eating out", "expense", "#f5ddcf"],
  ["Transport", "expense", "#d9e9ec"],
  ["Home & bills", "expense", "#eadfcb"],
  ["Shopping", "expense", "#ead9e6"],
  ["Health", "expense", "#d8e7df"],
  ["Entertainment", "expense", "#e6e0f2"],
  ["Salary", "income", "#d8ead7"],
  ["Other income", "income", "#d9e9ec"],
] as const;

function moneyCents(value: unknown) {
  const number = Number(value);
  const amount = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Enter a valid nonnegative amount.");
  return amount;
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
  const budget = (payload.budgets || {}) as { monthly?: unknown };
  const target = moneyCents(budget.monthly ?? 0);
  const allocation = payload.budgetMode === "fixed_split" ? "even" : "adaptive";
  const carry: BudgetConfig["carry"] = allocation === "adaptive" ? "none" : payload.carryMode === "stack_unused" ? "positive" : payload.carryMode === "stack_signed" ? "signed" : "none";
  const weekStart = Math.max(0, Math.min(6, Math.round(Number(payload.weekStart) || 0)));
  const today = financialToday(timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const config: BudgetConfig = { name: "Main plan", target, period: "monthly", anchor: monthStart, end: addCalendarInterval(monthStart, "monthly"), payday: 1, allocation, carry, carryCap: 0, weights: [1, 1, 1, 1, 1, 1.4, 1.4], weekStart };

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
    const balance = moneyCents(input.balance || 0) * (type === "credit" ? -1 : 1);
    const creditLimit = input.creditLimit ? moneyCents(input.creditLimit) : null;
    const color = /^#[0-9a-fA-F]{6}$/.test(String(input.color)) ? String(input.color) : "#1f5b4e";
    const spendable = typeof input.includeSpendable === "boolean" ? input.includeSpendable : !["savings", "investment", "credit"].includes(type);
    const accountId = `opening:${userId}:${index}`;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO accounts (id, user_id, name, type, currency, balance_cents, credit_limit_cents, color, include_spendable) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${open}`)
      .bind(accountId, userId, name, type, currency, balance, creditLimit, color, spendable ? 1 : 0, userId));
  }
  for (const [name, kind, color] of categories) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO categories (id, user_id, name, kind, color) SELECT ?, ?, ?, ?, ? WHERE ${open}`)
      .bind(crypto.randomUUID(), userId, name, kind, color, userId));
  }
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO v3_versions (id, user_id, effective_from, config_json) SELECT ?, ?, '1900-01-01', ? WHERE ${open}`)
    .bind(`initial:${userId}`, userId, JSON.stringify(config), userId));
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO v3_events (id, user_id, kind, detail) SELECT ?, ?, 'setup', 'Current Plan created from opening balances.' WHERE ${open}`)
    .bind(`setup:${userId}`, userId, userId));
  statements.push(env.DB.prepare("UPDATE profiles SET setup_complete = 1 WHERE user_id = ? AND setup_complete = 0").bind(userId));
  await env.DB.batch(statements);
  return true;
}
