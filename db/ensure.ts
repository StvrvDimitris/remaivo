import { env } from "cloudflare:workers";

let schemaReady: Promise<void> | null = null;

const statements = [
  `CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, currency TEXT NOT NULL DEFAULT 'EUR', week_start INTEGER NOT NULL DEFAULT 1, setup_complete INTEGER NOT NULL DEFAULT 0, spare_multiplier INTEGER NOT NULL DEFAULT 1, spare_destination_id TEXT, spare_sweep_mode TEXT NOT NULL DEFAULT 'threshold', spare_threshold_cents INTEGER NOT NULL DEFAULT 1000, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', opening_balance_cents INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL DEFAULT 0, credit_limit_cents INTEGER, color TEXT NOT NULL DEFAULT '#1f5b4e', icon TEXT NOT NULL DEFAULT 'wallet', include_spendable INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#cfe9d7', icon TEXT NOT NULL DEFAULT 'circle', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT, destination_account_id TEXT, category_id TEXT, type TEXT NOT NULL, description TEXT NOT NULL, amount_cents INTEGER NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted', committed INTEGER NOT NULL DEFAULT 0, counts_daily INTEGER NOT NULL DEFAULT 1, counts_weekly INTEGER NOT NULL DEFAULT 1, counts_monthly INTEGER NOT NULL DEFAULT 1, counts_general INTEGER NOT NULL DEFAULT 1, recurring_plan_id TEXT, installment_plan_id TEXT, spare_change_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS budget_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL, base_cents INTEGER NOT NULL DEFAULT 0, carry_mode TEXT NOT NULL DEFAULT 'reset', carry_cap_cents INTEGER, anchor_date TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'manual', parent_period TEXT, calculation_mode TEXT NOT NULL DEFAULT 'adaptive', percentage_basis_points INTEGER NOT NULL DEFAULT 10000, hard_reset TEXT NOT NULL DEFAULT 'parent', include_everyday INTEGER NOT NULL DEFAULT 1, include_committed INTEGER NOT NULL DEFAULT 0, include_savings INTEGER NOT NULL DEFAULT 0, include_investments INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS recurring_plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, amount_cents INTEGER NOT NULL, account_id TEXT, destination_account_id TEXT, category_id TEXT, frequency TEXT NOT NULL, interval_count INTEGER NOT NULL DEFAULT 1, next_date TEXT NOT NULL, end_date TEXT, auto_post INTEGER NOT NULL DEFAULT 0, committed INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS installment_plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, provider TEXT, category_id TEXT, total_cents INTEGER NOT NULL, paid_cents INTEGER NOT NULL DEFAULT 0, installment_count INTEGER NOT NULL, first_due_date TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'monthly', payment_account_id TEXT NOT NULL, linked_credit_account_id TEXT, include_daily_weekly INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS installment_payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, sequence INTEGER NOT NULL, due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'upcoming', paid_transaction_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, target_cents INTEGER, contributed_cents INTEGER NOT NULL DEFAULT 0, account_id TEXT, color TEXT NOT NULL DEFAULT '#dff35f', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS spare_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL, destination_account_id TEXT, base_cents INTEGER NOT NULL, multiplied_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_user_active ON accounts(user_id, archived)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_name_kind ON categories(user_id, name, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_categories_user_kind ON categories(user_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_user_account ON transactions(user_id, account_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_rules_user_period ON budget_rules(user_id, period)`,
  `CREATE INDEX IF NOT EXISTS idx_recurring_user_next ON recurring_plans(user_id, next_date)`,
  `CREATE INDEX IF NOT EXISTS idx_installment_plans_user_status ON installment_plans(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_installment_payments_user_due ON installment_payments(user_id, due_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_installment_payments_plan_sequence ON installment_payments(plan_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_user_kind ON goals(user_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_spare_events_user_status ON spare_events(user_id, status)`,
];

const budgetUpgrades = [
  `ALTER TABLE budget_rules ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE budget_rules ADD COLUMN parent_period TEXT`,
  `ALTER TABLE budget_rules ADD COLUMN calculation_mode TEXT NOT NULL DEFAULT 'adaptive'`,
  `ALTER TABLE budget_rules ADD COLUMN percentage_basis_points INTEGER NOT NULL DEFAULT 10000`,
  `ALTER TABLE budget_rules ADD COLUMN hard_reset TEXT NOT NULL DEFAULT 'parent'`,
  `ALTER TABLE budget_rules ADD COLUMN include_everyday INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE budget_rules ADD COLUMN include_committed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE budget_rules ADD COLUMN include_savings INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE budget_rules ADD COLUMN include_investments INTEGER NOT NULL DEFAULT 0`,
];

export function ensureFinanceSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      let budgetColumnsAdded = false;
      for (const statement of budgetUpgrades) {
        try {
          await env.DB.prepare(statement).run();
          budgetColumnsAdded = true;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.toLowerCase().includes("duplicate column")) throw error;
        }
      }
      await env.DB.prepare("UPDATE budget_rules SET parent_period = CASE period WHEN 'daily' THEN 'weekly' WHEN 'weekly' THEN 'monthly' ELSE NULL END WHERE parent_period IS NULL").run();
      await env.DB.prepare("UPDATE budget_rules SET source_type = 'manual', parent_period = NULL WHERE period = 'monthly'").run();
      await env.DB.prepare("UPDATE budget_rules SET active = 0 WHERE period = 'general'").run();
      if (budgetColumnsAdded) {
        await env.DB.prepare("UPDATE budget_rules SET include_committed = 1, include_savings = 1, include_investments = 1 WHERE period = 'monthly'").run();
      }
      await env.DB.prepare("PRAGMA optimize").run();
    })();
  }
  return schemaReady;
}
