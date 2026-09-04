import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  currency: text("currency").notNull().default("EUR"),
  weekStart: integer("week_start").notNull().default(1),
  timezone: text("timezone").notNull().default("UTC"),
  setupComplete: integer("setup_complete", { mode: "boolean" }).notNull().default(false),
  spareMultiplier: integer("spare_multiplier").notNull().default(1),
  spareDestinationId: text("spare_destination_id"),
  spareSweepMode: text("spare_sweep_mode").notNull().default("threshold"),
  spareThresholdCents: integer("spare_threshold_cents").notNull().default(1000),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  currency: text("currency").notNull().default("EUR"),
  openingBalanceCents: integer("opening_balance_cents").notNull().default(0),
  balanceCents: integer("balance_cents").notNull().default(0),
  creditLimitCents: integer("credit_limit_cents"),
  color: text("color").notNull().default("#1f5b4e"),
  icon: text("icon").notNull().default("wallet"),
  includeSpendable: integer("include_spendable", { mode: "boolean" }).notNull().default(true),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_accounts_user_active").on(table.userId, table.archived)]);

export const investmentValuationSnapshots = sqliteTable("investment_valuation_snapshots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull(),
  snapshotDate: text("snapshot_date").notNull(),
  valueCents: integer("value_cents").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_investment_snapshots_user_account_date").on(table.userId, table.accountId, table.snapshotDate)]);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  color: text("color").notNull().default("#cfe9d7"),
  icon: text("icon").notNull().default("circle"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_categories_user_kind").on(table.userId, table.kind),
  uniqueIndex("idx_categories_user_name_kind").on(table.userId, table.name, table.kind),
]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id"),
  destinationAccountId: text("destination_account_id"),
  categoryId: text("category_id"),
  type: text("type").notNull(),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  date: text("date").notNull(),
  status: text("status").notNull().default("posted"),
  committed: integer("committed", { mode: "boolean" }).notNull().default(false),
  countsDaily: integer("counts_daily", { mode: "boolean" }).notNull().default(true),
  countsWeekly: integer("counts_weekly", { mode: "boolean" }).notNull().default(true),
  countsMonthly: integer("counts_monthly", { mode: "boolean" }).notNull().default(true),
  countsGeneral: integer("counts_general", { mode: "boolean" }).notNull().default(true),
  recurringPlanId: text("recurring_plan_id"),
  installmentPlanId: text("installment_plan_id"),
  replacesTransactionId: text("replaces_transaction_id"),
  spareChangeCents: integer("spare_change_cents").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_transactions_user_date").on(table.userId, table.date),
  index("idx_transactions_user_account").on(table.userId, table.accountId),
  index("idx_transactions_user_status_date").on(table.userId, table.status, table.date),
  index("idx_transactions_user_status_category_date").on(table.userId, table.status, table.categoryId, table.date),
]);

export const budgetRules = sqliteTable("budget_rules", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  period: text("period").notNull(),
  baseCents: integer("base_cents").notNull().default(0),
  carryMode: text("carry_mode").notNull().default("reset"),
  carryCapCents: integer("carry_cap_cents"),
  anchorDate: text("anchor_date").notNull(),
  sourceType: text("source_type").notNull().default("manual"),
  parentPeriod: text("parent_period"),
  calculationMode: text("calculation_mode").notNull().default("adaptive"),
  percentageBasisPoints: integer("percentage_basis_points").notNull().default(10000),
  hardReset: text("hard_reset").notNull().default("parent"),
  includeEveryday: integer("include_everyday", { mode: "boolean" }).notNull().default(true),
  includeCommitted: integer("include_committed", { mode: "boolean" }).notNull().default(false),
  includeSavings: integer("include_savings", { mode: "boolean" }).notNull().default(false),
  includeInvestments: integer("include_investments", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_budget_rules_user_period").on(table.userId, table.period)]);

export const recurringPlans = sqliteTable("recurring_plans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  accountId: text("account_id"),
  destinationAccountId: text("destination_account_id"),
  categoryId: text("category_id"),
  frequency: text("frequency").notNull(),
  intervalCount: integer("interval_count").notNull().default(1),
  nextDate: text("next_date").notNull(),
  anchorDay: integer("anchor_day").notNull().default(1),
  endDate: text("end_date"),
  autoPost: integer("auto_post", { mode: "boolean" }).notNull().default(false),
  committed: integer("committed", { mode: "boolean" }).notNull().default(true),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_recurring_user_next").on(table.userId, table.nextDate)]);

export const expenseReserves = sqliteTable("expense_reserves", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  categoryId: text("category_id").notNull(),
  targetCents: integer("target_cents").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_expense_reserves_user_active").on(table.userId, table.active)]);

export const expenseReservePeriods = sqliteTable("expense_reserve_periods", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  reserveId: text("reserve_id").notNull(),
  categoryId: text("category_id").notNull(),
  month: text("month").notNull(),
  targetCents: integer("target_cents").notNull(),
  status: text("status").notNull().default("open"),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_expense_reserve_periods_reserve_month").on(table.reserveId, table.month),
  index("idx_expense_reserve_periods_user_month").on(table.userId, table.month),
]);

export const installmentPlans = sqliteTable("installment_plans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  provider: text("provider"),
  categoryId: text("category_id"),
  totalCents: integer("total_cents").notNull(),
  paidCents: integer("paid_cents").notNull().default(0),
  installmentCount: integer("installment_count").notNull(),
  firstDueDate: text("first_due_date").notNull(),
  frequency: text("frequency").notNull().default("monthly"),
  paymentAccountId: text("payment_account_id").notNull(),
  linkedCreditAccountId: text("linked_credit_account_id"),
  includeDailyWeekly: integer("include_daily_weekly", { mode: "boolean" }).notNull().default(false),
  autoPost: integer("auto_post", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_installment_plans_user_status").on(table.userId, table.status)]);

export const installmentPayments = sqliteTable("installment_payments", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  planId: text("plan_id").notNull(),
  sequence: integer("sequence").notNull(),
  dueDate: text("due_date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("upcoming"),
  paidTransactionId: text("paid_transaction_id"),
}, (table) => [
  index("idx_installment_payments_user_due").on(table.userId, table.dueDate),
  uniqueIndex("idx_installment_payments_plan_sequence").on(table.planId, table.sequence),
]);

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  targetCents: integer("target_cents"),
  contributedCents: integer("contributed_cents").notNull().default(0),
  accountId: text("account_id"),
  color: text("color").notNull().default("#dff35f"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_goals_user_kind").on(table.userId, table.kind)]);

export const spareEvents = sqliteTable("spare_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  transactionId: text("transaction_id").notNull(),
  destinationAccountId: text("destination_account_id"),
  baseCents: integer("base_cents").notNull(),
  multipliedCents: integer("multiplied_cents").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_spare_events_user_status").on(table.userId, table.status)]);
