"use client";

import { CSSProperties, FormEvent, HTMLAttributes, ReactNode, useCallback, useEffect, useState } from "react";
import type { v3Snapshot } from "../db/v3";
import { outstandingReserve, projectBudgetPlan, protectedCalendarWindow, type FixedCarryMode } from "./budget-math";
import { financialToday, outstandingDateInWindow } from "./finance-dates";
import { calculateInvestmentValue, type InvestmentValuationSnapshot, type InvestmentValueMetrics } from "./investment-valuations";
import { budgetCountsTransaction } from "./transaction-classification";
import { AnalyticsFilterBar, StatisticsPage, analyticsRange, useAnalyticsFilters } from "./statistics-page";

export type Account = { id: string; name: string; type: string; currency: string; balance_cents: number; opening_balance_cents: number; credit_limit_cents: number | null; color: string; include_spendable: number; archived: number };
export type Category = { id: string; name: string; kind: string; color: string; icon: string; archived: number };
export type Transaction = { id: string; account_id: string | null; destination_account_id: string | null; category_id: string | null; type: string; description: string; amount_cents: number; date: string; committed: number; counts_daily: number; counts_weekly: number; counts_monthly: number; counts_general: number; recurring_plan_id: string | null; installment_plan_id: string | null; replaces_transaction_id: string | null; spare_change_cents: number };
type BudgetRule = { id: string; period: string; base_cents: number; carry_mode: string; carry_cap_cents: number | null; anchor_date: string; source_type: string; parent_period: string | null; calculation_mode: string; percentage_basis_points: number; hard_reset: string; include_everyday: number; include_committed: number; include_savings: number; include_investments: number; active: number };
type BudgetResult = BudgetRule & { remaining: number; effective_base_cents: number; current_base_cents: number; carried_cents: number; spent_cents: number; planned_cents: number; window_start: string; window_end: string; source_note: string; unavailable: boolean; seven_day_allowance_cents?: number; remaining_days?: number };
type RecurringPlan = { id: string; title: string; type: string; amount_cents: number; account_id: string | null; destination_account_id: string | null; category_id: string | null; frequency: string; interval_count: number; next_date: string; anchor_day: number; end_date?: string | null; auto_post: number; committed: number };
type ExpenseReserve = { id: string; title: string; category_id: string; target_cents: number; period_id: string; period_category_id: string; month: string; period_target_cents: number; status: "open" | "finished"; finished_at: string | null };
type ReserveSummary = ExpenseReserve & { actual_cents: number; outstanding_cents: number; released_cents: number };
type UpcomingCommitment = { id: string; kind: "recurring" | "installment"; date: string; title: string; detail: string; amount_cents: number };
type InstallmentPlan = { id: string; title: string; provider: string | null; category_id: string | null; total_cents: number; paid_cents: number; installment_count: number; first_due_date: string; frequency: string; payment_account_id: string; linked_credit_account_id: string | null; include_daily_weekly: number; auto_post: number; status: string };
type InstallmentPayment = { id: string; plan_id: string; sequence: number; due_date: string; amount_cents: number; status: string };
type Goal = { id: string; name: string; kind: string; target_cents: number | null; contributed_cents: number; account_id: string | null; color: string };
type SpareEvent = { id: string; base_cents: number; multiplied_cents: number; destination_account_id: string | null };
type Profile = { currency: string; week_start: number; timezone: string; spare_multiplier: number; spare_destination_id: string | null; spare_sweep_mode: string; spare_threshold_cents: number };
export type Snapshot = {
  v3?: Awaited<ReturnType<typeof v3Snapshot>>;
  needsSetup: boolean;
  today: string;
  user: { displayName: string; email: string };
  profile?: Profile;
  accounts?: Account[];
  categories?: Category[];
  transactions?: Transaction[];
  budgets?: BudgetRule[];
  recurring?: RecurringPlan[];
  reserves?: ExpenseReserve[];
  installmentPlans?: InstallmentPlan[];
  installmentPayments?: InstallmentPayment[];
  goals?: Goal[];
  spareEvents?: SpareEvent[];
  investmentSnapshots?: InvestmentValuationSnapshot[];
  error?: string;
};

type TransactionSort = "description" | "date" | "account" | "amount";
type TransactionPageResult = { items: Transaction[]; page: number; pageSize: number; total: number; totalPages: number; from: string; to: string; today: string; error?: string };

export type ModalName = "transaction" | "account" | "budget" | "plan" | "reserve" | "category" | "spare" | "goal" | "week" | "timezone" | null;
type PageName = "overview" | "transactions" | "statistics" | "accounts" | "budget" | "plans" | "goals" | "settings";
export type EditTarget =
  | { kind: "transaction"; record: Transaction }
  | { kind: "account"; record: Account }
  | { kind: "category"; record: Category }
  | { kind: "recurring"; record: RecurringPlan }
  | { kind: "reserve"; record: ExpenseReserve }
  | { kind: "installment"; record: InstallmentPlan }
  | { kind: "goal"; record: Goal };

const navItems: { id: PageName; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "transactions", label: "Transactions", icon: "↕" },
  { id: "statistics", label: "Statistics", icon: "⌁" },
  { id: "accounts", label: "Accounts", icon: "◫" },
  { id: "budget", label: "Budget", icon: "◔" },
  { id: "plans", label: "Plans", icon: "↻" },
];

const carryLabels: Record<string, string> = {
  reset: "Reset",
  stack_unused: "Unused only",
  stack_capped: "Capped unused",
  stack_signed: "Signed (underspend and overspend)",
  manual: "Decide manually",
};

const resetLabels: Record<string, string> = {
  daily: "Every day",
  none: "Never hard-reset",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Reset with the year",
  parent: "Reset with the parent pool",
};

const weekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const commonTimezones = [
  "UTC", "Europe/Athens", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Helsinki",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function formatMoney(cents: number, currency = "EUR", digits = 2) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function movementMoney(cents: number, currency: string) {
  return `${cents > 0 ? "+" : ""}${formatMoney(cents, currency)}`;
}

function movementPercent(percent: number | null) {
  return percent === null ? "—" : `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function movementTone(value: number) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

function parseDate(value: string) {
  return new Date(`${value}T12:00:00Z`);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function periodStart(value: string, period: string, weekStart: number) {
  const date = parseDate(value);
  if (period === "weekly") {
    const offset = (date.getUTCDay() - weekStart + 7) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
  } else if (period === "monthly") {
    date.setUTCDate(1);
  }
  return dateKey(date);
}

function nextPeriod(start: string, period: string) {
  const date = parseDate(start);
  if (period === "daily") date.setUTCDate(date.getUTCDate() + 1);
  else if (period === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return dateKey(date);
}

function daysBetween(start: string, end: string) {
  return Math.max(0, Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86400000));
}

function transactionCounts(rule: BudgetRule, transaction: Transaction) {
  return budgetCountsTransaction(rule, transaction);
}

function plannedBreakdown(rule: BudgetRule, recurring: RecurringPlan[], payments: InstallmentPayment[], start: string, end: string, includeOverdue = false) {
  const recurringAmount = recurring.filter((plan) => outstandingDateInWindow(plan.next_date, start, end, includeOverdue) && plan.committed === 1 && (
    (plan.type === "expense" && rule.include_committed === 1)
    || (plan.type === "saving" && rule.include_savings === 1)
    || (plan.type === "investment" && rule.include_investments === 1)
  )).reduce((sum, plan) => sum + plan.amount_cents, 0);
  const installmentAmount = rule.include_committed === 1
    ? payments.filter((payment) => payment.status === "upcoming" && outstandingDateInWindow(payment.due_date, start, end, includeOverdue)).reduce((sum, payment) => sum + payment.amount_cents, 0)
    : 0;
  return { recurringAmount, installmentAmount };
}

function plannedFor(rule: BudgetRule, recurring: RecurringPlan[], payments: InstallmentPayment[], start: string, end: string, includeOverdue = false) {
  const breakdown = plannedBreakdown(rule, recurring, payments, start, end, includeOverdue);
  return breakdown.recurringAmount + breakdown.installmentAmount;
}

function summarizeReserves(reserves: ExpenseReserve[], transactions: Transaction[], rule: BudgetRule | undefined, today: string): ReserveSummary[] {
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = nextPeriod(monthStart, "monthly");
  return reserves.map((reserve) => {
    const actual = transactions.filter((transaction) => transaction.category_id === reserve.period_category_id
      && transaction.date >= monthStart
      && transaction.date < monthEnd
      && (rule ? transactionCounts(rule, transaction) : ["expense", "installment_payment"].includes(transaction.type)))
      .reduce((sum, transaction) => sum + transaction.amount_cents, 0);
    const target = reserve.period_target_cents;
    return {
      ...reserve,
      actual_cents: actual,
      outstanding_cents: outstandingReserve(target, actual, reserve.status),
      released_cents: reserve.status === "finished" ? Math.max(0, target - actual) : 0,
    };
  });
}

function calculateBudgetResults(rules: BudgetRule[], transactions: Transaction[], recurring: RecurringPlan[], payments: InstallmentPayment[], today: string, weekStart: number, outstandingReserves = 0, nextMonthReserveTargets = 0) {
  const byPeriod = Object.fromEntries(rules.map((rule) => [rule.period, rule]));
  const root = byPeriod.monthly as BudgetRule | undefined;
  if (!root) return [];
  const inherited = (period: string): BudgetRule => ({
    ...root,
    ...(byPeriod[period] ?? {}),
    period,
    base_cents: root.base_cents,
    carry_mode: root.carry_mode,
    carry_cap_cents: root.carry_cap_cents,
    calculation_mode: root.calculation_mode,
    hard_reset: root.hard_reset,
    include_everyday: root.include_everyday,
    include_committed: root.include_committed,
    include_savings: root.include_savings,
    include_investments: root.include_investments,
    active: root.active,
  });
  if (root.active !== 1) return ["daily", "weekly", "monthly"].map((period) => ({ ...inherited(period), remaining: 0, effective_base_cents: 0, current_base_cents: 0, carried_cents: 0, spent_cents: 0, planned_cents: 0, window_start: today, window_end: today, source_note: "Budget plan is paused", unavailable: false }));

  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = nextPeriod(monthStart, "monthly");
  const weekStartDate = periodStart(today, "weekly", weekStart);
  const weekEnd = nextPeriod(weekStartDate, "weekly");
  const currentMonthWeekStart = weekStartDate > monthStart ? weekStartDate : monthStart;
  const currentMonthWeekEnd = weekEnd < monthEnd ? weekEnd : monthEnd;
  const tomorrow = nextPeriod(today, "daily");
  const todayDate = parseDate(today);
  const daysInMonth = daysBetween(monthStart, monthEnd);
  const todayIndex = todayDate.getUTCDate() - 1;
  const counted = transactions.filter((transaction) => transaction.date >= monthStart && transaction.date < monthEnd && transactionCounts(root, transaction));
  const spentBeforeToday = counted.filter((transaction) => transaction.date < today).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const spentToday = counted.filter((transaction) => transaction.date === today).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const spentBeforeWeek = counted.filter((transaction) => transaction.date < currentMonthWeekStart).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const spentThisWeek = counted.filter((transaction) => transaction.date >= currentMonthWeekStart && transaction.date <= today).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const reservedMonth = plannedFor(root, recurring, payments, today, monthEnd, true) + outstandingReserves;
  const reservedFromWeekStart = plannedFor(root, recurring, payments, currentMonthWeekStart, monthEnd, true) + outstandingReserves;
  const reservedCurrentWeek = plannedFor(root, recurring, payments, today, currentMonthWeekEnd, true);
  const boundary = ["daily", "weekly", "monthly"].includes(root.hard_reset) ? root.hard_reset : "monthly";
  const resetStart = boundary === "daily" ? today : boundary === "weekly" ? (periodStart(today, "weekly", weekStart) < monthStart ? monthStart : periodStart(today, "weekly", weekStart)) : monthStart;
  const spentSinceReset = counted.filter((transaction) => transaction.date >= resetStart && transaction.date < today).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const spentSinceWeeklyResetBeforeWeek = resetStart < currentMonthWeekStart
    ? counted.filter((transaction) => transaction.date >= resetStart && transaction.date < currentMonthWeekStart).reduce((sum, transaction) => sum + transaction.amount_cents, 0)
    : 0;
  const mode = root.calculation_mode === "adaptive" ? "adaptive" : "fixed";
  const carryMode = (["reset", "stack_unused", "stack_signed", "stack_capped"].includes(root.carry_mode) ? root.carry_mode : "reset") as FixedCarryMode;
  const projection = projectBudgetPlan({
    monthlyBudget: root.base_cents,
    daysInMonth,
    todayIndex,
    remainingWeekDays: daysBetween(today, currentMonthWeekEnd),
    mode,
    carryMode,
    carryCap: root.carry_cap_cents,
    resetStartIndex: daysBetween(monthStart, resetStart),
    spentBeforeToday,
    spentSinceResetBeforeToday: spentSinceReset,
    spentToday,
    weekStartIndex: daysBetween(monthStart, currentMonthWeekStart),
    weekDaysInMonth: daysBetween(currentMonthWeekStart, currentMonthWeekEnd),
    spentBeforeWeek,
    spentThisWeek,
    spentSinceWeeklyResetBeforeWeek,
    reservedMonth,
    reservedFromWeekStart,
    weeklySpreadReserve: outstandingReserves,
    reservedRemainingWeek: reservedCurrentWeek,
  });

  let weeklyBase = projection.weeklyBase;
  let weeklyRemaining = projection.weeklyRemaining;
  let weeklyPlanned = mode === "fixed" ? reservedCurrentWeek : 0;
  if (weekEnd > monthEnd) {
    const nextMonthEnd = nextPeriod(monthEnd, "monthly");
    const nextMonthDays = daysBetween(monthEnd, nextMonthEnd);
    const nextWeekDays = daysBetween(monthEnd, weekEnd);
    const nextReservedMonth = plannedFor(root, recurring, payments, monthEnd, nextMonthEnd);
    const nextSpreadReserve = mode === "fixed" ? nextMonthReserveTargets : nextReservedMonth + nextMonthReserveTargets;
    const extraBase = protectedCalendarWindow(root.base_cents, nextSpreadReserve, nextMonthDays, 0, nextWeekDays);
    const nextWeekReserved = mode === "fixed" ? plannedFor(root, recurring, payments, monthEnd, weekEnd) : 0;
    weeklyBase += extraBase;
    weeklyRemaining += extraBase - nextWeekReserved;
    weeklyPlanned += nextWeekReserved;
  }

  const monthly: BudgetResult = { ...inherited("monthly"), remaining: projection.monthlyRemaining, effective_base_cents: root.base_cents, current_base_cents: root.base_cents, carried_cents: 0, spent_cents: spentBeforeToday + spentToday, planned_cents: reservedMonth, window_start: monthStart, window_end: monthEnd, source_note: "Actual monthly funds after posted and reserved spending", unavailable: false };
  const weeklyCarry = mode === "fixed" ? (projection.weeklyCarry ?? 0) : projection.carry;
  const weekly: BudgetResult = { ...inherited("weekly"), source_type: "derived", parent_period: "monthly", remaining: weeklyRemaining, effective_base_cents: weeklyBase + weeklyCarry, current_base_cents: weeklyBase, carried_cents: weeklyCarry, spent_cents: spentThisWeek, planned_cents: weeklyPlanned, window_start: weekStartDate, window_end: weekEnd, remaining_days: daysBetween(today, weekEnd), source_note: mode === "adaptive" ? `Recalculated from transactions through last ${weekdayLabels[(weekStart + 6) % 7]}; this week’s spending only reduces what remains` : `The week’s allocation stays fixed; carry comes only from completed weeks since the ${boundary} reset`, unavailable: false };
  const daily: BudgetResult = { ...inherited("daily"), source_type: "derived", parent_period: "monthly", remaining: projection.dailyRemaining, effective_base_cents: projection.dailyBase + projection.carry, current_base_cents: projection.dailyBase, carried_cents: projection.carry, spent_cents: spentToday, planned_cents: 0, window_start: today, window_end: tomorrow, remaining_days: 1, source_note: mode === "adaptive" ? "Recalculated from transactions through yesterday; today’s spending only reduces what remains" : `Safe discretionary calendar-day base after monthly commitments, with ${carryLabels[carryMode].toLowerCase()}`, unavailable: false };
  return [daily, weekly, monthly];
}

function budgetEquation(rule: BudgetResult, currency: string) {
  const parts = [formatMoney(rule.current_base_cents, currency)];
  if (rule.carried_cents !== 0) parts.push(`${rule.carried_cents > 0 ? "+" : "−"} ${formatMoney(Math.abs(rule.carried_cents), currency)} carried`);
  if (rule.spent_cents !== 0) parts.push(`− ${formatMoney(rule.spent_cents, currency)} transactions`);
  if (rule.planned_cents !== 0) parts.push(`− ${formatMoney(rule.planned_cents, currency)} planned`);
  return `${parts.join(" ")} = ${formatMoney(rule.remaining, currency)}`;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(parseDate(value));
}

function typeLabel(type: string) {
  const labels: Record<string, string> = { bank: "Bank account", savings: "Savings", cash: "Cash", credit: "Credit", investment: "Investment", wallet: "Digital wallet", custom: "Custom", income: "Income", expense: "Expense", transfer: "Transfer", saving: "Saving", installment_payment: "Installment", installment_purchase: "Installment purchase" };
  return labels[type] ?? type.replaceAll("_", " ");
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function editableProps(onEdit: () => void): HTMLAttributes<HTMLElement> {
  let timer: number | undefined;
  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  return {
    role: "button",
    tabIndex: 0,
    title: "Double-click or hold to edit",
    onDoubleClick: onEdit,
    onPointerDown: () => {
      clear();
      timer = window.setTimeout(onEdit, 650);
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (event) => event.preventDefault(),
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onEdit();
      }
    },
  };
}

export function FinanceClient({ displayName, email, signOutHref }: { displayName: string; email: string; signOutHref: string }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<PageName>(() => {
    if (typeof window === "undefined") return "overview";
    const candidate = new URLSearchParams(window.location.search).get("view");
    return (["overview", "transactions", "statistics", "accounts", "budget", "plans", "goals", "settings"].includes(candidate ?? "") ? candidate : "overview") as PageName;
  });
  const [modal, setModal] = useState<ModalName>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [valuationAccountId, setValuationAccountId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/finance", { cache: "no-store" });
    const payload = await response.json() as Snapshot;
    if (!response.ok) throw new Error(payload.error || "Unable to load Remaivo.");
    setData(payload);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this effect loads the server snapshot on mount.
    load().catch((error) => setNotice(error instanceof Error ? error.message : "Unable to load Remaivo."));
  }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (page === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", page);
    window.history.replaceState({}, "", url);
  }, [page]);

  async function mutate(action: string, payload: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/finance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) });
      const next = await response.json() as Snapshot;
      if (!response.ok) throw new Error(next.error || "Unable to save that change.");
      setData(next);
      setRevision((value) => value + 1);
      setNotice("Saved");
      window.setTimeout(() => setNotice(""), 2200);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save that change.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <main className="loading-screen"><span className="loading-logo remaivo-logo-mark" aria-hidden="true" /><p>Getting your money in view…</p>{notice && <small>{notice}</small>}</main>;
  }

  if (data.needsSetup) {
    return <Onboarding displayName={displayName} busy={busy} onComplete={(payload) => mutate("setup", payload)} />;
  }

  const allAccounts = data.accounts ?? [];
  const allCategories = data.categories ?? [];
  const accounts = allAccounts.filter((account) => account.archived !== 1);
  const categories = allCategories.filter((category) => category.archived !== 1);
  const transactions = data.transactions ?? [];
  const budgets = data.budgets ?? [];
  const recurring = data.recurring ?? [];
  const reserves = data.reserves ?? [];
  const installmentPlans = data.installmentPlans ?? [];
  const installmentPayments = data.installmentPayments ?? [];
  const goals = data.goals ?? [];
  const spareEvents = data.spareEvents ?? [];
  const investmentSnapshots = data.investmentSnapshots ?? [];
  const profile = data.profile!;
  const currency = profile.currency;

  const accountById = Object.fromEntries(allAccounts.map((account) => [account.id, account]));
  const categoryById = Object.fromEntries(allCategories.map((category) => [category.id, category]));
  const spendable = accounts.filter((account) => account.include_spendable === 1).reduce((sum, account) => sum + account.balance_cents, 0);
  const savings = accounts.filter((account) => account.type === "savings").reduce((sum, account) => sum + account.balance_cents, 0);
  const investmentAccounts = accounts.filter((account) => account.type === "investment");
  const investmentMetrics = Object.fromEntries(investmentAccounts.map((account) => [account.id, calculateInvestmentValue({ accountId: account.id, rawInvested: account.balance_cents, transactions, snapshots: investmentSnapshots })])) as Record<string, InvestmentValueMetrics>;
  const rawInvested = investmentAccounts.reduce((sum, account) => sum + account.balance_cents, 0);
  const invested = investmentAccounts.reduce((sum, account) => sum + investmentMetrics[account.id].estimatedCurrentValue, 0);
  const investmentMovement = invested - rawInvested;
  const investmentMovementPercent = rawInvested !== 0 ? investmentMovement / rawInvested * 100 : null;
  const totalBalance = accounts.filter((account) => account.type !== "investment").reduce((sum, account) => sum + account.balance_cents, 0) + invested;
  const outstandingInstallments = installmentPlans.reduce((sum, plan) => sum + plan.total_cents - plan.paid_cents, 0);
  const monthKey = data.today.slice(0, 7);
  const monthEnd = nextPeriod(`${monthKey}-01`, "monthly");
  const monthlyPlan = budgets.find((rule) => rule.period === "monthly");
  const reserveSummaries = summarizeReserves(reserves, transactions, monthlyPlan, data.today);
  const reserveOutstandingThisMonth = reserveSummaries.reduce((sum, reserve) => sum + reserve.outstanding_cents, 0);
  const monthlyPlanned = monthlyPlan ? plannedBreakdown(monthlyPlan, recurring, installmentPayments, data.today, monthEnd, true) : { recurringAmount: 0, installmentAmount: 0 };
  const paymentReservedThisMonth = monthlyPlanned.recurringAmount;
  const installmentReservedThisMonth = monthlyPlanned.installmentAmount;
  const reservedThisMonth = paymentReservedThisMonth + installmentReservedThisMonth + reserveOutstandingThisMonth;
  const nextMonthReserveTargets = reserves.reduce((sum, reserve) => sum + reserve.target_cents, 0);
  const budgetResults = calculateBudgetResults(budgets, transactions, recurring, installmentPayments, data.today, profile.week_start, reserveOutstandingThisMonth, nextMonthReserveTargets);
  const primaryBudget = budgetResults.find((rule) => rule.active === 1 && !rule.unavailable) ?? null;
  const availableNow = primaryBudget?.remaining ?? spendable;
  const activeWindowStart = primaryBudget?.window_start ?? data.today;
  const activeWindowEnd = primaryBudget?.window_end ?? nextPeriod(data.today, "daily");
  const spentInActiveWindow = primaryBudget ? transactions.filter((transaction) => transaction.date >= activeWindowStart && transaction.date < activeWindowEnd && transactionCounts(primaryBudget, transaction)).reduce((sum, transaction) => sum + transaction.amount_cents, 0) : 0;
  const totalActiveAvailable = Math.max(primaryBudget?.effective_base_cents ?? spendable, availableNow + spentInActiveWindow);
  const sparePot = spareEvents.reduce((sum, event) => sum + event.multiplied_cents, 0);
  const upcomingCommitments: UpcomingCommitment[] = [
    ...recurring.filter((plan) => plan.committed === 1 && plan.type !== "income").map((plan) => ({ id: `recurring-${plan.id}`, kind: "recurring" as const, date: plan.next_date, title: plan.title, detail: `Recurring ${typeLabel(plan.type).toLowerCase()} · ${plan.frequency}`, amount_cents: plan.amount_cents })),
    ...installmentPayments.filter((payment) => payment.status === "upcoming").map((payment) => { const plan = installmentPlans.find((item) => item.id === payment.plan_id); return { id: `installment-${payment.id}`, kind: "installment" as const, date: payment.due_date, title: plan?.title ?? "Installment", detail: `Payment ${payment.sequence} of ${plan?.installment_count ?? "?"}`, amount_cents: payment.amount_cents }; }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  const context = { accounts, categories, transactions, budgets, recurring, reserves, reserveSummaries, reserveOutstandingThisMonth, paymentReservedThisMonth, installmentReservedThisMonth, installmentPlans, installmentPayments, goals, investmentSnapshots, investmentMetrics, profile, currency, accountById, categoryById, budgetResults, reservedThisMonth, spendable, savings, rawInvested, invested, investmentMovement, investmentMovementPercent, totalBalance, outstandingInstallments, sparePot, upcomingCommitments, today: data.today };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand-mark brand-button" onClick={() => setPage("overview")} aria-label="Remaivo home"><span className="remaivo-logo-mark" aria-hidden="true" /><strong>Remaivo</strong></button>
        <nav aria-label="Main navigation">
          {navItems.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}><span>{item.icon}</span>{item.label}</button>)}
          <button className={`nav-item mobile-settings-nav ${page === "settings" ? "active" : ""}`} onClick={() => setPage("settings")}><span>⚙</span>Settings</button>
        </nav>
        <div className="sidebar-bottom">
          <button className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => setPage("settings")}><span>⚙</span>Settings</button>
          <div className="profile"><span className="avatar">{initials(displayName)}</span><span><strong>{displayName}</strong><small>{email}</small></span><a href={signOutHref} title="Sign out">↗</a></div>
        </div>
      </aside>

      <section className="workspace">
        <AppHeader page={page} displayName={displayName} today={data.today} onAdd={() => setModal("transaction")} />
        {page === "overview" && <Overview context={context} primaryBudget={primaryBudget} availableNow={availableNow} spentInActiveWindow={spentInActiveWindow} totalActiveAvailable={totalActiveAvailable} setPage={setPage} onAdd={() => setModal("transaction")} onEditTransaction={(record) => setEditTarget({ kind: "transaction", record })} />}
        {page === "transactions" && <TransactionsPage context={context} revision={revision} onAdd={() => setModal("transaction")} onEdit={(record) => setEditTarget({ kind: "transaction", record })} />}
        {page === "statistics" && <StatisticsPage context={context} revision={revision} />}
        {page === "accounts" && <AccountsPage context={context} onAdd={() => setModal("account")} onEdit={(record) => setEditTarget({ kind: "account", record })} onSnapshot={(record) => setValuationAccountId(record.id)} />}
        {page === "budget" && <BudgetPage context={context} onEdit={() => setModal("budget")} />}
        {page === "plans" && <PlansPage context={context} onAdd={() => setModal("plan")} onAddReserve={() => setModal("reserve")} onPay={async (paymentId) => { if (window.confirm("Mark this installment as paid on its scheduled date?")) await mutate("payInstallment", { paymentId }); }} onFinishReserve={async (reserve) => { if (window.confirm(`Finish ${reserve.title} for this month? ${formatMoney(Math.max(0, reserve.period_target_cents - reserve.actual_cents), currency)} will be released.`)) await mutate("finishReserve", { reserveId: reserve.id }); }} onReopenReserve={(reserve) => mutate("reopenReserve", { reserveId: reserve.id })} onEditRecurring={(record) => setEditTarget({ kind: "recurring", record })} onEditReserve={(record) => setEditTarget({ kind: "reserve", record })} onEditInstallment={(record) => setEditTarget({ kind: "installment", record })} />}
        {page === "goals" && <GoalsPage context={context} onGoal={() => setModal("goal")} onSpare={() => setModal("spare")} onSweep={async () => { const source = accounts.find((account) => account.include_spendable === 1); if (source && profile.spare_destination_id) await mutate("sweepSpare", { sourceAccountId: source.id, destinationAccountId: profile.spare_destination_id }); }} onEdit={(record) => setEditTarget({ kind: "goal", record })} />}
        {page === "settings" && <SettingsPage context={context} onCategory={() => setModal("category")} onGoals={() => setPage("goals")} onWeek={() => setModal("week")} onTimezone={() => setModal("timezone")} onEditCategory={(record) => setEditTarget({ kind: "category", record })} />}
      </section>

      {notice && <div className={`toast ${notice === "Saved" ? "success" : ""}`}>{notice}</div>}
      {modal && <FinanceModal name={modal} context={context} busy={busy} close={() => setModal(null)} save={async (action, payload) => { const ok = await mutate(action, payload); if (ok) setModal(null); }} />}
      {editTarget && <EditModal target={editTarget} context={context} busy={busy} close={() => setEditTarget(null)} save={async (action, payload) => { const ok = await mutate(action, payload); if (ok) setEditTarget(null); }} />}
      {valuationAccountId && accountById[valuationAccountId]?.type === "investment" && <ValuationModal account={accountById[valuationAccountId]} snapshots={investmentSnapshots.filter((snapshot) => snapshot.account_id === valuationAccountId)} currency={currency} today={data.today} busy={busy} close={() => setValuationAccountId(null)} save={mutate} />}
    </main>
  );
}

function AppHeader({ page, displayName, today, onAdd }: { page: PageName; displayName: string; today: string; onAdd: () => void }) {
  const title: Record<PageName, string> = { overview: `Good morning, ${displayName.split(" ")[0]}.`, transactions: "Transactions", statistics: "Statistics", accounts: "Your accounts", budget: "Budgets", plans: "Plans & commitments", goals: "Save & invest", settings: "Settings" };
  const now = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(parseDate(today));
  return <header className="topbar"><div><p className="eyebrow">{page === "overview" ? now.toUpperCase() : "REMAIVO PERSONAL FINANCE"}</p><h1>{title[page]}</h1></div><div className="top-actions"><button className="icon-button" aria-label="Notifications">●</button><button className="primary-button" onClick={onAdd}><span>＋</span>Add transaction</button></div></header>;
}

export type Context = { accounts: Account[]; categories: Category[]; transactions: Transaction[]; budgets: BudgetRule[]; recurring: RecurringPlan[]; reserves: ExpenseReserve[]; reserveSummaries: ReserveSummary[]; reserveOutstandingThisMonth: number; paymentReservedThisMonth: number; installmentReservedThisMonth: number; installmentPlans: InstallmentPlan[]; installmentPayments: InstallmentPayment[]; goals: Goal[]; investmentSnapshots: InvestmentValuationSnapshot[]; investmentMetrics: Record<string, InvestmentValueMetrics>; profile: Profile; currency: string; accountById: Record<string, Account>; categoryById: Record<string, Category>; budgetResults: BudgetResult[]; reservedThisMonth: number; spendable: number; savings: number; rawInvested: number; invested: number; investmentMovement: number; investmentMovementPercent: number | null; totalBalance: number; outstandingInstallments: number; sparePot: number; upcomingCommitments: UpcomingCommitment[]; today: string };

function Overview({ context, primaryBudget, availableNow, spentInActiveWindow, totalActiveAvailable, setPage, onAdd, onEditTransaction }: { context: Context; primaryBudget: BudgetResult | null; availableNow: number; spentInActiveWindow: number; totalActiveAvailable: number; setPage: (page: PageName) => void; onAdd: () => void; onEditTransaction: (record: Transaction) => void }) {
  const { currency, totalBalance, spendable, savings, invested, investmentMovement, investmentMovementPercent, budgetResults, upcomingCommitments, accountById, transactions, categoryById, reservedThisMonth, paymentReservedThisMonth, installmentReservedThisMonth, reserveOutstandingThisMonth } = context;
  const hasInvestmentSnapshot = context.investmentSnapshots.length > 0;
  const percent = totalActiveAvailable > 0 ? Math.max(0, Math.min(100, availableNow / totalActiveAvailable * 100)) : 0;
  const windowLabel = primaryBudget?.period === "daily" ? "TODAY" : primaryBudget?.period === "weekly" ? "THIS WEEK" : primaryBudget?.period === "monthly" ? "THIS MONTH" : "NOW";
  const [availableMajor, availableMinor = "00"] = formatMoney(availableNow, currency).split(".");
  return <div className="dashboard-grid">
    <section className="hero-card"><div className="hero-copy"><p>AVAILABLE TO SPEND {windowLabel}</p><h2>{availableMajor}<span>.{availableMinor}</span></h2><div className="budget-status"><i /> {primaryBudget?.remaining !== undefined && primaryBudget.remaining < 0 ? "Over budget" : "Within budget"}</div><small>{primaryBudget ? primaryBudget.source_note : "Turn on a budget window to set your spending limit."}</small><button className="hero-action" onClick={onAdd}>Add spending →</button></div><div className="hero-visual"><div className="dial" style={{ background: `conic-gradient(var(--lime) 0 ${percent}%, rgba(255,255,255,.12) ${percent}% 100%)` }}><span className="dial-inner"><b>{Math.round(percent)}%</b><small>available</small></span></div><p>{formatMoney(spentInActiveWindow, currency)} spent {windowLabel.toLowerCase()}</p></div></section>
    <section className="balance-card"><div className="card-heading"><span><p>TOTAL BALANCE</p><h3>{formatMoney(totalBalance, currency)}</h3></span><button aria-label="More balance options">•••</button></div><div className="balance-breakdown"><div><i className="dot spending"/><span><p>Spendable</p><strong>{formatMoney(spendable, currency)}</strong></span></div><div><i className="dot savings"/><span><p>Savings</p><strong>{formatMoney(savings, currency)}</strong></span></div><div className="investment-breakdown"><i className="dot investing"/><span><p>Investments</p><strong>{formatMoney(invested, currency)}</strong>{hasInvestmentSnapshot && <><small className="investment-snapshot-label">Latest value snapshot</small><small className={`investment-movement ${movementTone(investmentMovement)}`}>{movementMoney(investmentMovement, currency)} · {movementPercent(investmentMovementPercent)}</small></>}</span></div></div><button className="text-link" onClick={() => setPage("accounts")}>View all accounts <span>→</span></button></section>
    <section className="budget-card"><div className="section-heading"><div><p>YOUR BUDGET</p><h3>Daily safety, weekly cash flow, monthly control.</h3></div><button className="ghost-button" onClick={() => setPage("budget")}>Manage budget</button></div><div className="budget-windows">{budgetResults.filter((rule) => rule.active === 1).map((rule, index) => <article key={rule.id} className={`budget-window ${["mint", "sky", "sand"][index]}`}><span>{rule.period === "daily" ? "Today remaining" : rule.period === "weekly" ? "This week remaining" : "Month remaining"}</span><strong>{formatMoney(rule.remaining, currency)}</strong><small>{rule.unavailable ? rule.source_note : budgetEquation(rule, currency)}</small><div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, rule.remaining / Math.max(1, rule.effective_base_cents) * 100))}%` }} /></div></article>)}{budgetResults.filter((rule) => rule.active === 1).length === 0 && <EmptyMini text="Set a monthly budget to activate all three views." />}</div></section>
    <section className="commitments-card"><div className="section-heading compact"><div><p>UP NEXT</p><h3>Committed money</h3></div><button className="text-link" onClick={() => setPage("plans")}>See plans</button></div><div className="commitment-list">{upcomingCommitments.slice(0, 3).map((item) => <div key={item.id} className={`commitment-item ${item.kind}`}><span className="date-block"><b>{parseDate(item.date).getUTCDate()}</b><small>{parseDate(item.date).toLocaleString("en", { month: "short", timeZone: "UTC" }).toUpperCase()}</small></span><span><strong>{item.title}</strong><small>{item.detail}</small></span><b>{formatMoney(item.amount_cents, currency, 0)}</b></div>)}{upcomingCommitments.length === 0 && <EmptyMini text="No committed payments coming up." />}</div><div className="reserved-note"><div className="reserved-total"><span>✓</span><p><strong>{formatMoney(reservedThisMonth, currency)} reserved</strong><small>Included in this month’s budget.</small></p></div><dl className="reserved-breakdown"><div><dt>Payments</dt><dd>{formatMoney(paymentReservedThisMonth, currency)}</dd></div><div><dt>Installments</dt><dd>{formatMoney(installmentReservedThisMonth, currency)}</dd></div><div><dt>Reserves</dt><dd>{formatMoney(reserveOutstandingThisMonth, currency)}</dd></div></dl></div></section>
    <section className="activity-card"><div className="section-heading compact"><div><p>LATEST ACTIVITY</p><h3>Recent transactions</h3></div><button className="text-link" onClick={() => setPage("transactions")}>View all</button></div><div className="activity-list">{transactions.slice(0, 4).map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} accountById={accountById} categoryById={categoryById} currency={currency} onEdit={() => onEditTransaction(transaction)} />)}{transactions.length === 0 && <EmptyMini text="Your first transactions will appear here." />}</div></section>
  </div>;
}

export function TransactionRow({ transaction, accountById, categoryById, currency, onEdit }: { transaction: Transaction; accountById: Record<string, Account>; categoryById: Record<string, Category>; currency: string; onEdit: () => void }) {
  const positive = transaction.type === "income";
  const neutral = ["transfer", "saving", "investment", "installment_purchase"].includes(transaction.type);
  return <div className="editable-record" {...editableProps(onEdit)}><span className="activity-icon" style={{ background: categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description.slice(0, 1).toUpperCase()}</span><span><strong>{transaction.description}</strong><small>{categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)} · {accountById[transaction.account_id ?? ""]?.name ?? "Plan"}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? " · Excluded from budget" : ""}{transaction.replaces_transaction_id ? " · Corrected" : ""}</small></span><b className={positive ? "income" : neutral ? "neutral" : ""}>{positive ? "+" : neutral ? "" : "−"}{formatMoney(transaction.amount_cents, currency)}</b></div>;
}

function Pager({ page, totalPages, total, pageSize, label, onPage }: { page: number; totalPages: number; total: number; pageSize: number; label: string; onPage: (page: number) => void }) {
  if (totalPages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return <nav className="pager" aria-label={`${label} pages`}><span>{first}–{last} of {total}</span><div><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={`Previous ${label} page`}>←</button><b>Page {page} of {totalPages}</b><button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label={`Next ${label} page`}>→</button></div></nav>;
}

export function TransactionsPage({ context, revision, onAdd, onEdit }: { context: Context; revision: number; onAdd: () => void; onEdit: (record: Transaction) => void }) {
  const [filters, setFilters] = useAnalyticsFilters(context);
  const { accountId, categoryId, description, origin, transactionType } = filters;
  const [sort, setSort] = useState<TransactionSort>("date");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [transactionPage, setTransactionPage] = useState(1);
  const [result, setResult] = useState<TransactionPageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const range = analyticsRange(filters, context);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setLoadError("");
      const params = new URLSearchParams({ view: "transactions", from: range.from, to: range.to, page: String(transactionPage), sort, direction });
      if (description.trim()) params.set("search", description.trim());
      const optional = { accountId, categoryId, transactionType, origin };
      for (const [key, value] of Object.entries(optional)) if (value) params.set(key, value);
      try {
        const response = await fetch(`/api/finance?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as TransactionPageResult;
        if (!response.ok) throw new Error(payload.error || "Unable to load transactions.");
        setResult(payload);
        if (payload.page !== transactionPage) setTransactionPage(payload.page);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Unable to load transactions.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, description.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [accountId, categoryId, description, direction, origin, range.from, range.to, revision, sort, transactionPage, transactionType]);

  const changeSort = (value: TransactionSort) => {
    if (sort === value) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(value); setDirection(value === "description" || value === "account" ? "asc" : "desc"); }
    setTransactionPage(1);
  };
  const sortLabel = (value: TransactionSort, label: string) => `${label}${sort === value ? direction === "asc" ? " ↑" : " ↓" : ""}`;
  const items = result?.items ?? [];

  return <section className="page-card transaction-page"><AnalyticsFilterBar context={context} filters={filters} setFilters={(change, replace) => { setTransactionPage(1); setFilters(change, replace); }} action={<button className="ghost-button" onClick={onAdd}>＋ New transaction</button>} /><p className="edit-hint">Filters are shared with Statistics and saved in the URL. Double-click or hold a transaction to correct it.</p><div className={`transaction-table ${loading ? "is-loading" : ""}`} aria-busy={loading}><div className="table-head"><button onClick={() => changeSort("description")}>{sortLabel("description", "Transaction")}</button><button onClick={() => changeSort("date")}>{sortLabel("date", "Date")}</button><button onClick={() => changeSort("account")}>{sortLabel("account", "Account")}</button><button onClick={() => changeSort("amount")}>{sortLabel("amount", "Amount")}</button></div>{items.map((transaction) => <div className="table-row editable-record" {...editableProps(() => onEdit(transaction))} key={transaction.id}><span className="transaction-name"><i style={{ background: context.categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description[0]}</i><span><strong>{transaction.description}</strong><small>{context.categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)}{transaction.committed ? " · Committed" : ""}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? " · Excluded from budget" : ""}{transaction.replaces_transaction_id ? " · Corrected" : ""}</small></span></span><span>{shortDate(transaction.date)}</span><span>{context.accountById[transaction.account_id ?? ""]?.name ?? "Plan"}</span><b className={transaction.type === "income" ? "income" : ""}>{transaction.type === "income" ? "+" : transaction.type === "expense" ? "−" : ""}{formatMoney(transaction.amount_cents, context.currency)}</b></div>)}{!loading && !loadError && items.length === 0 && <EmptyState title="No transactions found" copy="Try a broader date range, clear a filter, or add a transaction." />}{loadError && <EmptyState title="Transactions could not load" copy={loadError} />}</div>{result && <Pager page={result.page} totalPages={result.totalPages} total={result.total} pageSize={result.pageSize} label="transactions" onPage={setTransactionPage} />}</section>;
}

export function AccountsPage({ context, onAdd, onEdit, onSnapshot }: { context: Context; onAdd: () => void; onEdit: (record: Account) => void; onSnapshot: (record: Account) => void }) {
  return <><section className="summary-strip"><div><p>NET BALANCE</p><strong>{formatMoney(context.totalBalance, context.currency)}</strong></div><div><p>AVAILABLE CASH</p><strong>{formatMoney(context.spendable, context.currency)}</strong></div><div><p>INSTALLMENT DEBT</p><strong>{formatMoney(context.outstandingInstallments, context.currency)}</strong></div></section><p className="edit-hint page-edit-hint">Double-click or hold an account to edit its details. Balance changes belong in transactions.</p><section className="accounts-grid">{context.accounts.map((account) => {
    const metrics = context.investmentMetrics[account.id];
    return <article className={`account-card editable-record ${metrics ? "investment-account-card" : ""}`} {...editableProps(() => onEdit(account))} key={account.id} style={{ "--account-color": account.color } as CSSProperties}><div className="account-card-top"><span className="account-icon">{account.type === "cash" ? "¤" : account.type === "investment" ? "↗" : account.type === "savings" ? "◇" : account.type === "credit" ? "▰" : "◫"}</span></div><p>{typeLabel(account.type)}</p><h3>{account.name}</h3><strong>{formatMoney(account.balance_cents, account.currency)}</strong><small>{metrics ? "Raw / net amount invested" : account.include_spendable ? "Included in available money" : "Excluded from available money"}</small>{metrics && <div className="valuation-summary"><span><small>Estimated / current value</small><strong>{formatMoney(metrics.estimatedCurrentValue, account.currency)}</strong><em>{metrics.latestSnapshot ? `Snapshot ${formatMoney(metrics.latestSnapshot.value_cents, account.currency)} · ${shortDate(metrics.latestSnapshot.snapshot_date)}` : "No valuation snapshot yet"}</em></span><span className={`movement-pill ${movementTone(metrics.movement)}`}><b>{movementMoney(metrics.movement, account.currency)}</b><small>{movementPercent(metrics.movementPercent)}</small></span></div>}{metrics && <button className="snapshot-action" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSnapshot(account); }}>＋ Add value snapshot</button>}</article>;
  })}<button className="add-card" onClick={onAdd}><span>＋</span><strong>Add custom account</strong><small>Bank, cash, savings, credit, investment, or anything else.</small></button></section></>;
}

function BudgetPage({ context, onEdit }: { context: Context; onEdit: () => void }) {
  const ordered = ["daily", "weekly", "monthly"].map((period) => context.budgetResults.find((rule) => rule.period === period)).filter(Boolean) as BudgetResult[];
  return <div className="budget-page"><section className="budget-explainer"><div><p className="eyebrow">ONE PLAN, THREE DECISIONS</p><h2>Safe daily spending, due-date weekly cash flow, full-month control.</h2><p>Fixed Daily protects every outstanding monthly commitment. Fixed Weekly spreads flexible reserves across the month, then deducts recurring payments and installments when they are due.</p></div><button className="primary-button" onClick={onEdit}><span>⚙</span>Configure plan</button></section><section className="budget-rule-grid">{ordered.map((rule) => <article key={rule.id} className={rule.active === 1 ? "" : "budget-rule-disabled"}><div className="budget-rule-top"><span className="budget-period-icon">{rule.period === "daily" ? "D" : rule.period === "weekly" ? "W" : "M"}</span><em>{rule.calculation_mode === "adaptive" ? "Adaptive" : "Fixed"}</em></div><p>{rule.period === "daily" ? "TODAY REMAINING" : rule.period === "weekly" ? "THIS WEEK REMAINING" : "MONTH REMAINING"}</p><h3>{rule.active === 1 ? formatMoney(rule.remaining, context.currency) : "Paused"}</h3><small>{rule.period === "monthly" ? `${formatMoney(rule.current_base_cents, context.currency)} monthly budget` : rule.period === "daily" && rule.calculation_mode !== "adaptive" ? `${formatMoney(rule.current_base_cents, context.currency)} safe discretionary base` : `${formatMoney(rule.current_base_cents, context.currency)} allocation base`}</small>{rule.active === 1 && <div className="budget-equation">{budgetEquation(rule, context.currency)}</div>}<div className="wide-progress"><i style={{ width: `${rule.active === 1 ? Math.max(0, Math.min(100, rule.remaining / Math.max(1, rule.effective_base_cents) * 100)) : 0}%` }} /></div><div className="rule-note"><span>↻</span><p><strong>{rule.source_note}</strong><small>{rule.calculation_mode === "adaptive" ? "Live historical recalculation · no stored snapshot" : `${carryLabels[rule.carry_mode]} · resets ${resetLabels[rule.hard_reset]?.toLowerCase() ?? rule.hard_reset}`}</small></p></div><div className="budget-counts"><span className={rule.include_everyday ? "on" : ""}>Everyday</span><span className={rule.include_committed ? "on" : ""}>Committed</span><span className={rule.include_savings ? "on" : ""}>Savings</span><span className={rule.include_investments ? "on" : ""}>Investing</span></div></article>)}</section>{context.reserveSummaries.length > 0 && <section className="page-card budget-reserve-card"><div className="section-heading compact"><div><p>FLEXIBLE RESERVES</p><h3>{formatMoney(context.reserveOutstandingThisMonth, context.currency)} still protected</h3></div></div><div className="budget-reserve-list">{context.reserveSummaries.map((reserve) => <div key={reserve.id}><span><i style={{ background: context.categoryById[reserve.period_category_id]?.color }}/><strong>{reserve.title}</strong><small>{reserve.status === "finished" ? `${formatMoney(reserve.released_cents, context.currency)} released` : `${formatMoney(reserve.actual_cents, context.currency)} spent of ${formatMoney(reserve.period_target_cents, context.currency)}`}</small></span><b>{reserve.status === "finished" ? "Finished" : `${formatMoney(reserve.outstanding_cents, context.currency)} reserved`}</b></div>)}</div></section>}<section className="cashflow-note"><span>✓</span><div><strong>Commitments stay protected</strong><p>{formatMoney(context.reservedThisMonth, context.currency)} is reserved across the month, including {formatMoney(context.reserveOutstandingThisMonth, context.currency)} for flexible category spending. Transactions replace that reserve as they happen, so nothing is counted twice.</p></div></section></div>;
}

function PlansPage({ context, onAdd, onAddReserve, onPay, onFinishReserve, onReopenReserve, onEditRecurring, onEditReserve, onEditInstallment }: { context: Context; onAdd: () => void; onAddReserve: () => void; onPay: (id: string) => void; onFinishReserve: (reserve: ReserveSummary) => void; onReopenReserve: (reserve: ReserveSummary) => void; onEditRecurring: (record: RecurringPlan) => void; onEditReserve: (record: ExpenseReserve) => void; onEditInstallment: (record: InstallmentPlan) => void }) {
  const pageSize = 5;
  const [recurringPage, setRecurringPage] = useState(1);
  const [installmentPage, setInstallmentPage] = useState(1);
  const recurringPages = Math.max(1, Math.ceil(context.recurring.length / pageSize));
  const installmentPages = Math.max(1, Math.ceil(context.installmentPlans.length / pageSize));
  const visibleRecurringPage = Math.min(recurringPage, recurringPages);
  const visibleInstallmentPage = Math.min(installmentPage, installmentPages);
  const recurringItems = context.recurring.slice((visibleRecurringPage - 1) * pageSize, visibleRecurringPage * pageSize);
  const installmentItems = context.installmentPlans.slice((visibleInstallmentPage - 1) * pageSize, visibleInstallmentPage * pageSize);
  return <div className="plans-layout"><section className="page-card reserve-section"><div className="section-heading"><div><p>FLEXIBLE RESERVES</p><h3>Monthly estimates that adjust as you spend</h3></div><button className="ghost-button" onClick={onAddReserve}>＋ Add reserve</button></div><p className="edit-hint">A reserve protects the unspent part of its target. Finish it to release any remainder without changing next month.</p><div className="reserve-list">{context.reserveSummaries.map((reserve) => { const percent = reserve.period_target_cents ? Math.min(100, reserve.actual_cents / reserve.period_target_cents * 100) : 0; return <article key={reserve.id} className={reserve.status === "finished" ? "finished" : ""}><div className="reserve-main"><span className="reserve-symbol" style={{ background: context.categoryById[reserve.period_category_id]?.color }}>{context.categoryById[reserve.period_category_id]?.name?.[0] ?? reserve.title[0]}</span><span><strong>{reserve.title}</strong><small>{context.categoryById[reserve.period_category_id]?.name ?? "Expense category"} · {reserve.status === "finished" ? `${formatMoney(reserve.released_cents, context.currency)} released` : `${formatMoney(reserve.outstanding_cents, context.currency)} still reserved`}</small></span><b>{formatMoney(reserve.actual_cents, context.currency)} <small>of {formatMoney(reserve.period_target_cents, context.currency)}</small></b></div><div className="wide-progress"><i style={{ width: `${percent}%` }} /></div><div className="reserve-actions"><span>{reserve.status === "finished" ? "Finished for this month" : "Transactions in this category reduce the reserve automatically."}</span><button className="text-link" onClick={() => onEditReserve(reserve)}>Edit</button><button className={reserve.status === "finished" ? "ghost-button compact-button" : "primary-button compact-button"} onClick={() => reserve.status === "finished" ? onReopenReserve(reserve) : onFinishReserve(reserve)}>{reserve.status === "finished" ? "Reopen" : "Finish month"}</button></div></article>})}{context.reserveSummaries.length === 0 && <EmptyState title="No flexible reserves yet" copy="Add an estimate for fuel, groceries, utilities, or another expense that happens every month but varies a little." />}</div></section><section className="page-card"><div className="section-heading"><div><p>RECURRING</p><h3>Income, bills & auto-invest</h3></div><button className="ghost-button" onClick={onAdd}>＋ Add plan</button></div><p className="edit-hint">Double-click or hold a plan to edit or archive it.</p><div className="plan-list">{recurringItems.map((plan) => <article className="editable-record" {...editableProps(() => onEditRecurring(plan))} key={plan.id}><span className={`plan-symbol ${plan.type}`}>{plan.type === "income" ? "+" : plan.type === "investment" ? "↗" : "↻"}</span><span><strong>{plan.title}</strong><small>Every {plan.interval_count > 1 ? `${plan.interval_count} ` : ""}{plan.frequency.replace("ly", "")} · Next {shortDate(plan.next_date)}</small></span><b>{formatMoney(plan.amount_cents, context.currency)}</b><em>{plan.auto_post ? "Auto" : "Confirm"}</em></article>)}{context.recurring.length === 0 && <EmptyState title="No recurring plans yet" copy="Add salary, bills, subscriptions, savings, or auto-invest schedules." />}</div><Pager page={visibleRecurringPage} totalPages={recurringPages} total={context.recurring.length} pageSize={pageSize} label="recurring plans" onPage={setRecurringPage} /></section><section className="page-card"><div className="section-heading"><div><p>PAY LATER</p><h3>Deferred & split purchases</h3></div><button className="ghost-button" onClick={onAdd}>＋ Add purchase</button></div><p className="edit-hint">Double-click or hold a purchase to edit or archive it.</p><div className="installment-list">{installmentItems.map((plan) => { const payments = context.installmentPayments.filter((payment) => payment.plan_id === plan.id); const next = payments.find((payment) => payment.status === "upcoming"); const percent = plan.total_cents ? plan.paid_cents / plan.total_cents * 100 : 0; return <article className="editable-record" {...editableProps(() => onEditInstallment(plan))} key={plan.id}><div className="installment-top"><span><strong>{plan.title}</strong><small>{plan.provider || (plan.installment_count === 1 ? "Pay-later purchase" : "Installment purchase")} · {plan.installment_count} {plan.installment_count === 1 ? "payment" : "payments"}{plan.auto_post ? " · Auto-pay" : ""}</small></span><b>{formatMoney(plan.total_cents - plan.paid_cents, context.currency)} left</b></div><div className="wide-progress"><i style={{ width: `${percent}%` }} /></div><div className="installment-bottom"><span>{Math.round(percent)}% paid</span>{next ? <span>Next: {formatMoney(next.amount_cents, context.currency)} on {shortDate(next.due_date)}</span> : <span>Complete</span>}</div>{next && plan.auto_post !== 1 && <div className="plan-actions"><button className="text-link" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onPay(next.id); }}>Mark next payment paid →</button></div>}</article>})}{context.installmentPlans.length === 0 && <EmptyState title="No pay-later purchases" copy="Schedule one full future payment or split a purchase into as many payments as you need." />}</div><Pager page={visibleInstallmentPage} totalPages={installmentPages} total={context.installmentPlans.length} pageSize={pageSize} label="installment plans" onPage={setInstallmentPage} /></section></div>;
}

export function GoalsPage({ context, onGoal, onSpare, onSweep, onEdit }: { context: Context; onGoal: () => void; onSpare: () => void; onSweep: () => void; onEdit: (record: Goal) => void }) {
  const destination = context.accountById[context.profile.spare_destination_id ?? ""];
  return <div className="goals-page"><section className="spare-hero"><div><p className="eyebrow">SPARE-CHANGE ACCELERATOR</p><h2>{formatMoney(context.sparePot, context.currency)} waiting</h2><p>Round-ups are multiplied ×{context.profile.spare_multiplier} and collected before moving to {destination?.name ?? "a destination you choose"}.</p><div className="spare-actions"><button className="primary-button" onClick={onSpare}><span>⚙</span>Configure</button><button className="ghost-button" disabled={!context.sparePot || !destination} onClick={onSweep}>Sweep now</button></div></div><div className="spare-orbit"><span>×{context.profile.spare_multiplier}</span><small>{context.profile.spare_sweep_mode}</small></div></section><div className="section-heading goal-heading"><div><p>SAVINGS & RAW INVESTMENTS</p><h3>Your pots and contribution targets</h3><small className="edit-hint">Double-click or hold a pot to edit or archive it.</small></div><button className="ghost-button" onClick={onGoal}>＋ New goal</button></div><section className="goal-grid">{context.goals.map((goal) => { const contributed = goal.account_id ? context.accountById[goal.account_id]?.balance_cents ?? goal.contributed_cents : goal.contributed_cents; const percent = goal.target_cents ? contributed / goal.target_cents * 100 : 0; return <article className="editable-record" {...editableProps(() => onEdit(goal))} key={goal.id}><span className="goal-kind">{goal.kind === "investment" ? "RAW INVESTED" : "SAVINGS"}</span><h3>{goal.name}</h3><strong>{formatMoney(contributed, context.currency)}</strong>{goal.target_cents && <><small>of {formatMoney(goal.target_cents, context.currency)}</small><div className="wide-progress"><i style={{ width: `${Math.min(100, percent)}%`, background: goal.color }} /></div><p>{Math.round(percent)}% complete</p></>}</article>})}{context.goals.length === 0 && <button className="add-card" onClick={onGoal}><span>＋</span><strong>Create your first goal</strong><small>Track savings or raw investment contributions without market prices.</small></button>}</section></div>;
}

export function SettingsPage({ context, onCategory, onGoals, onWeek, onTimezone, onEditCategory }: { context: Context; onCategory: () => void; onGoals: () => void; onWeek: () => void; onTimezone: () => void; onEditCategory: (record: Category) => void }) {
  return <div className="settings-grid"><section className="page-card"><div className="section-heading"><div><p>CATEGORIES</p><h3>Custom income & expense labels</h3></div><button className="ghost-button" onClick={onCategory}>＋ Add category</button></div><p className="edit-hint">Double-click or hold a category to edit or archive it.</p><div className="category-cloud">{context.categories.map((category) => <span className="editable-record" {...editableProps(() => onEditCategory(category))} key={category.id} style={{ background: category.color }}><i>{category.name[0]}</i>{category.name}<small>{category.kind}</small></span>)}</div></section><section className="page-card setting-stack"><div><span className="setting-icon">¤</span><span><strong>Currency</strong><small>Primary display and manual entry currency</small></span><b>{context.profile.currency}</b></div><button onClick={onTimezone}><span className="setting-icon">◷</span><span><strong>Financial timezone</strong><small>Controls today, due dates, resets, and automatic catch-up</small></span><b>{context.profile.timezone} →</b></button><button onClick={onGoals}><span className="setting-icon">◇</span><span><strong>Save & invest</strong><small>Goals, raw investments, and spare-change accelerator</small></span><b>→</b></button><button onClick={onWeek}><span className="setting-icon">7</span><span><strong>Week starts</strong><small>Calendar-week anchor for weekly and daily windows</small></span><b>{weekdayLabels[context.profile.week_start]} →</b></button><div><span className="setting-icon">☁</span><span><strong>Cross-device data</strong><small>Stored privately with your ChatGPT sign-in</small></span><b>Active</b></div></section></div>;
}

export function ValuationModal({ account, snapshots, currency, today, busy, close, save }: { account: Account; snapshots: InvestmentValuationSnapshot[]; currency: string; today: string; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<boolean> }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = snapshots.find((snapshot) => snapshot.id === editingId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const ok = await save(editing ? "updateInvestmentSnapshot" : "addInvestmentSnapshot", { ...values, accountId: account.id, snapshotId: editing?.id });
    if (ok) setEditingId(null);
  }

  async function remove(snapshot: InvestmentValuationSnapshot) {
    if (!window.confirm(`Delete the ${shortDate(snapshot.snapshot_date)} valuation snapshot? This will not delete any transaction.`)) return;
    const ok = await save("deleteInvestmentSnapshot", { snapshotId: snapshot.id });
    if (ok && editingId === snapshot.id) setEditingId(null);
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card valuation-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={close} aria-label="Close">×</button><ModalTitle eyebrow="MANUAL INVESTMENT VALUATION" title={account.name} copy="A snapshot records portfolio value only. It never creates a transaction or changes raw invested history or budgets."/><form key={editing?.id ?? "new"} onSubmit={submit}><div className="form-grid"><Field label="Portfolio value"><input name="value" type="number" min="0" step="0.01" defaultValue={editing ? editing.value_cents / 100 : ""} required placeholder="0.00"/></Field><Field label="Snapshot date"><input name="snapshotDate" type="date" max={today} defaultValue={editing?.snapshot_date ?? today} required/></Field></div><Field label="Note (optional)"><input name="note" maxLength={500} defaultValue={editing?.note ?? ""} placeholder="Broker statement, manual check…"/></Field><div className="valuation-form-actions">{editing && <button type="button" className="ghost-button" onClick={() => setEditingId(null)}>Cancel edit</button>}<Submit busy={busy} label={editing ? "Save snapshot changes" : "Add value snapshot"}/></div></form><div className="valuation-history"><div className="section-heading compact"><div><p>VALUATION HISTORY</p><h3>{snapshots.length ? `${snapshots.length} manual ${snapshots.length === 1 ? "snapshot" : "snapshots"}` : "No snapshots yet"}</h3></div></div>{snapshots.map((snapshot, index) => <article key={snapshot.id}><span><strong>{formatMoney(snapshot.value_cents, currency)}</strong><small>{shortDate(snapshot.snapshot_date)}{index === 0 ? " · Latest" : ""}{snapshot.note ? ` · ${snapshot.note}` : ""}</small></span><span><button type="button" className="text-link" disabled={busy} onClick={() => setEditingId(snapshot.id)}>Edit</button><button type="button" className="delete-snapshot" disabled={busy} onClick={() => remove(snapshot)}>Delete</button></span></article>)}{snapshots.length === 0 && <EmptyMini text="Add the value from a statement or broker screen whenever you want to refresh the estimate." />}</div></section></div>;
}

/* eslint-disable jsx-a11y/label-has-associated-control -- modal labels wrap their controls and visible descriptions. */
export function FinanceModal({ name, context, busy, close, save }: { name: Exclude<ModalName, null>; context: Context; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [planType, setPlanType] = useState<"recurring" | "installment">("recurring");
  const [transactionType, setTransactionType] = useState("expense");
  const [recurringType, setRecurringType] = useState("expense");
  const [installmentCount, setInstallmentCount] = useState(3);
  const [installmentTotal, setInstallmentTotal] = useState("");

  function submit(action: string, transform?: (values: Record<string, FormDataEntryValue>) => Record<string, unknown>) {
    return async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await save(action, transform ? transform(values) : values);
    };
  }

  const moving = ["transfer", "saving", "investment"].includes(transactionType);
  const activeCategories = context.categories.filter((category) => category.archived !== 1);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card" role="dialog" aria-modal="true"><button className="modal-close" onClick={close} aria-label="Close">×</button>
    {name === "transaction" && <><ModalTitle eyebrow="MANUAL ENTRY" title="Add a transaction" copy="One entry updates every relevant balance and budget window."/><form onSubmit={submit("addTransaction", (values) => ({ ...values, type: transactionType, committed: values.committed === "on", useSpare: values.useSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="segmented">{["expense", "income", "transfer", "saving", "investment"].map((type) => <button type="button" className={transactionType === type ? "active" : ""} key={type} onClick={() => setTransactionType(type)}>{typeLabel(type)}</button>)}</div><Field label="Description"><input name="description" required placeholder={transactionType === "income" ? "Salary" : "What was it?"}/></Field><div className="form-grid"><Field label="Amount"><input name="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"/></Field><Field label="Date"><input name="date" type="date" max={context.today} defaultValue={context.today} required/></Field></div><Field label={moving ? "From account" : "Account"}><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {formatMoney(account.balance_cents, account.currency)}</option>)}</select></Field>{moving && <Field label="To account"><select name="destinationAccountId" required defaultValue=""><option value="" disabled>Choose destination</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>}{!moving && <Field label="Category"><select name="categoryId" defaultValue=""><option value="">Uncategorised</option>{context.categories.filter((category) => category.kind === (transactionType === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}{["expense", "saving", "investment"].includes(transactionType) && <label className="single-check"><input type="checkbox" name="excludeFromBudget"/> Exclude from budget — still updates account balances and spending history</label>}{transactionType === "expense" && <div className="check-stack"><label><input type="checkbox" name="committed"/> Cover this from committed money, outside everyday guidance</label><label><input type="checkbox" name="useSpare" disabled={!context.profile.spare_destination_id}/> Apply ×{context.profile.spare_multiplier} spare change{!context.profile.spare_destination_id ? " (configure a destination first)" : ""}</label></div>}<Submit busy={busy} label="Save transaction"/></form></>}
    {name === "account" && <><ModalTitle eyebrow="CUSTOM ACCOUNT" title="Add where your money lives" copy="Opening balances create a snapshot—not fake income."/><form onSubmit={submit("addAccount", (values) => ({ ...values, includeSpendable: values.includeSpendable === "on" }))}><Field label="Account name"><input name="name" required placeholder="Holiday cash, Revolut, Trading 212…"/></Field><div className="form-grid"><Field label="Type"><select name="type" defaultValue="bank">{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select></Field><Field label="Current balance"><input name="balance" type="number" min="0" step="0.01" required placeholder="0.00"/></Field></div><Field label="Credit limit (optional)"><input name="creditLimit" type="number" min="0" step="0.01" placeholder="0.00"/></Field><Field label="Account color"><input name="color" type="color" defaultValue="#1f5b4e"/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked/> Include this balance in available-to-spend money</label><Submit busy={busy} label="Add account"/></form></>}
    {name === "category" && <><ModalTitle eyebrow="CUSTOM CATEGORY" title="Create your own label" copy="Categories organise reports without forcing category budgets."/><form onSubmit={submit("addCategory")}><Field label="Category name"><input name="name" required placeholder="Pets, Side work, Coffee…"/></Field><div className="form-grid"><Field label="Type"><select name="kind"><option value="expense">Expense</option><option value="income">Income</option></select></Field><Field label="Color"><input name="color" type="color" defaultValue="#cfe9d7"/></Field></div><Submit busy={busy} label="Add category"/></form></>}
    {name === "week" && <><ModalTitle eyebrow="CALENDAR WEEKS" title="Choose when your week starts" copy="The weekly view simply adds the daily allocations that fall inside this calendar week."/><form onSubmit={submit("updateWeekStart")}><Field label="First day of the week"><select name="weekStart" defaultValue={context.profile.week_start}>{weekdayLabels.map((label, value) => <option value={value} key={label}>{label}</option>)}</select></Field><div className="budget-form-note"><span>7</span><p><strong>Changing this redraws the weekly view</strong><small>Transactions and daily allocations stay unchanged. Month-crossing weeks take each date’s allocation from its own month.</small></p></div><Submit busy={busy} label="Save week start"/></form></>}
    {name === "timezone" && <><ModalTitle eyebrow="FINANCIAL CALENDAR" title="Choose your financial timezone" copy="This timezone defines today for budgets, resets, scheduled payments, and automatic reconciliation on every device."/><form onSubmit={submit("updateTimezone")}><Field label="Timezone"><select name="timezone" defaultValue={context.profile.timezone}>{Array.from(new Set([context.profile.timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><div className="budget-form-note"><span>◷</span><p><strong>One calendar across every device</strong><small>After saving, Remaivo immediately catches up through today in the new timezone before recalculating balances and budgets.</small></p></div><Submit busy={busy} label="Save timezone"/></form></>}
    {name === "budget" && <BudgetEditor context={context} busy={busy} save={save}/>}
    {name === "reserve" && <><ModalTitle eyebrow="FLEXIBLE MONTHLY RESERVE" title="Protect a realistic estimate" copy="Choose one expense category and the amount you expect to need. Its transactions replace the reserve instead of being counted twice."/><form onSubmit={submit("addReserve")}><Field label="Reserve name"><input name="title" required placeholder="Fuel, groceries, electricity…"/></Field><Field label="Expense category"><select name="categoryId" defaultValue="" required><option value="" disabled>Choose category</option>{activeCategories.filter((category) => category.kind === "expense" && !context.reserves.some((reserve) => reserve.category_id === category.id)).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><Field label="Monthly estimate"><input name="target" type="number" min="0.01" step="0.01" required placeholder="170.00"/></Field><div className="budget-form-note"><span>≈</span><p><strong>The estimate repeats, not the actual</strong><small>Finishing this month releases its unused amount. Next month starts again from this estimate.</small></p></div><Submit busy={busy} label="Create flexible reserve"/></form></>}
    {name === "plan" && <><ModalTitle eyebrow="FUTURE MONEY" title="Add a plan" copy="Schedule a repeating item, one future payment, or a purchase split into installments."/><div className="segmented plan-switch"><button type="button" className={planType === "recurring" ? "active" : ""} onClick={() => setPlanType("recurring")}>Recurring</button><button type="button" className={planType === "installment" ? "active" : ""} onClick={() => setPlanType("installment")}>Pay later / installments</button></div>{planType === "recurring" ? <form onSubmit={submit("addRecurring", (values) => ({ ...values, type: recurringType, autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label="Plan name"><input name="title" required placeholder="Rent, salary, VWCE auto-invest…"/></Field><div className="form-grid"><Field label="Type"><select name="type" value={recurringType} onChange={(event) => setRecurringType(event.target.value)}><option value="expense">Expense</option><option value="income">Income</option><option value="saving">Savings transfer</option><option value="investment">Auto-invest</option></select></Field><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required/></Field></div>{["expense", "income"].includes(recurringType) ? <Field label="Category"><select name="categoryId" defaultValue="" required><option value="" disabled>Choose category</option>{activeCategories.filter((category) => category.kind === recurringType).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field> : <input type="hidden" name="categoryId" value=""/>}{["saving","investment"].includes(recurringType) && <Field label="Destination account"><select name="destinationAccountId" required defaultValue=""><option value="" disabled>Choose destination</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label="Payment account"><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Frequency"><select name="frequency"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="daily">Daily</option></select></Field><Field label="Next date"><input name="nextDate" type="date" defaultValue={context.today} required/></Field></div><div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked/> Protect upcoming payments in the plan</label><label><input type="checkbox" name="autoPost"/> Add automatically when due</label></div><Submit busy={busy} label="Create recurring plan"/></form> : <form onSubmit={submit("addInstallment", (values) => ({ ...values, total: installmentTotal, installmentCount, includeDailyWeekly: values.includeDailyWeekly === "on", autoPost: values.autoPost === "on" }))}><Field label="Purchase"><input name="title" required placeholder="Laptop, flights, furniture…"/></Field><Field label="Expense category"><select name="categoryId" defaultValue="" required><option value="" disabled>Choose category</option>{activeCategories.filter((category) => category.kind === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label="Total purchase"><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min="0.01" step="0.01" required/></Field><Field label="Number of payments"><input value={installmentCount} onChange={(event) => setInstallmentCount(Number(event.target.value))} type="number" min="1" max="120" required/></Field></div><div className="installment-preview"><span>{Array.from({length: Math.min(6, installmentCount)}).map((_, index) => <i key={index} />)}</span><p>{installmentTotal ? installmentCount === 1 ? `${formatMoney(Math.round(Number(installmentTotal) * 100), context.currency)} due in one payment` : `About ${formatMoney(Math.round(Number(installmentTotal) * 100 / Math.max(1, installmentCount)), context.currency)} each` : "Enter a total to preview payments"}</p></div><div className="form-grid"><Field label={installmentCount === 1 ? "Payment due date" : "First installment"}><input name="firstDueDate" type="date" defaultValue={context.today} required/></Field><Field label="Frequency"><select name="frequency" disabled={installmentCount === 1}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field></div>{installmentCount === 1 && <input type="hidden" name="frequency" value="monthly"/>}<Field label="Repayment account"><select name="paymentAccountId" required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Provider label (optional)"><input name="provider" placeholder="Klarna, store finance…"/></Field><Field label="Linked credit account (optional)"><select name="linkedCreditAccountId" defaultValue=""><option value="">Standalone plan</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="check-stack"><label><input type="checkbox" name="autoPost"/> Mark payments paid automatically on their due date</label></div><Submit busy={busy} label="Create pay-later plan"/></form>}</>}
    {name === "spare" && <><ModalTitle eyebrow="SPARE CHANGE" title="Accelerate every round-up" copy="A €3.60 purchase creates €0.40; at ×3 the pot receives €1.20."/><form onSubmit={submit("updateSpare")}><Field label="Multiplier"><select name="multiplier" defaultValue={context.profile.spare_multiplier}>{[1,2,3,4,5,6,8,10].map((value) => <option value={value} key={value}>×{value}</option>)}</select></Field><Field label="Destination"><select name="destinationAccountId" defaultValue={context.profile.spare_destination_id ?? ""} required><option value="" disabled>Choose savings or investment account</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Sweep method"><select name="sweepMode" defaultValue={context.profile.spare_sweep_mode}><option value="threshold">At threshold</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="manual">Manually</option></select></Field><Field label="Threshold"><input name="threshold" type="number" min="1" step="1" defaultValue={context.profile.spare_threshold_cents / 100}/></Field></div><Submit busy={busy} label="Save spare-change rule"/></form></>}
    {name === "goal" && <><ModalTitle eyebrow="GOAL OR POT" title="Track purposeful money" copy="Investment goals measure raw cash contributed, never market performance."/><form onSubmit={submit("addGoal")}><Field label="Name"><input name="name" required placeholder="Rainy day, Home deposit, VWCE…"/></Field><div className="form-grid"><Field label="Kind"><select name="kind"><option value="savings">Savings</option><option value="investment">Raw investment</option></select></Field><Field label="Target (optional)"><input name="target" type="number" min="0" step="0.01"/></Field></div><Field label="Linked account (optional)"><select name="accountId" defaultValue=""><option value="">Track independently</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><Field label="Already contributed"><input name="contributed" type="number" min="0" step="0.01" defaultValue="0"/></Field><Submit busy={busy} label="Create goal"/></form></>}
  </section></div>;
}

export function EditModal({ target, context, busy, close, save }: { target: EditTarget; context: Context; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [goalAccountId, setGoalAccountId] = useState(target.kind === "goal" ? target.record.account_id ?? "" : "");
  const editingTransaction = target.kind === "transaction" ? target.record : null;
  const transactionMoving = editingTransaction ? ["transfer", "saving", "investment"].includes(editingTransaction.type) : false;
  const transactionCorrectable = editingTransaction ? !["installment_purchase", "installment_payment"].includes(editingTransaction.type) : false;
  const correctionAccounts = editingTransaction
    ? Object.values(context.accountById).filter((account) => account.archived !== 1 || account.id === editingTransaction.account_id || account.id === editingTransaction.destination_account_id)
    : context.accounts;
  const correctionCategories = editingTransaction
    ? Object.values(context.categoryById).filter((category) => category.archived !== 1 || category.id === editingTransaction.category_id)
    : context.categories;
  const editingInstallment = target.kind === "installment" ? target.record : null;
  const editingPlanPayments = editingInstallment ? context.installmentPayments.filter((payment) => payment.plan_id === editingInstallment.id) : [];
  const paidInstallments = editingPlanPayments.filter((payment) => payment.status === "paid");
  const nextUnpaidInstallment = editingPlanPayments.find((payment) => payment.status === "upcoming");
  const [installmentTotal, setInstallmentTotal] = useState(editingInstallment ? String(editingInstallment.total_cents / 100) : "");
  const [installmentRemainingCount, setInstallmentRemainingCount] = useState(editingInstallment ? Math.max(1, editingInstallment.installment_count - paidInstallments.length) : 1);
  const [installmentNextDue, setInstallmentNextDue] = useState(nextUnpaidInstallment?.due_date ?? editingInstallment?.first_due_date ?? context.today);
  const [installmentFrequency, setInstallmentFrequency] = useState(editingInstallment?.frequency ?? "monthly");
  const installmentRemainingCents = editingInstallment ? Math.max(0, Math.round(Number(installmentTotal || 0) * 100) - editingInstallment.paid_cents) : 0;

  function submit(action: string, transform?: (values: Record<string, FormDataEntryValue>) => Record<string, unknown>) {
    return async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await save(action, transform ? transform(values) : values);
    };
  }

  const archive = async (action: string, idName: string, id: string, label: string) => {
    if (window.confirm(`Archive ${label}? Existing history will be kept.`)) await save(action, { [idName]: id });
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card" role="dialog" aria-modal="true"><button className="modal-close" onClick={close} aria-label="Close">×</button>
    {target.kind === "transaction" && <><ModalTitle eyebrow="CORRECT TRANSACTION" title={target.record.description} copy={transactionCorrectable ? "Remaivo reverses the original balance and budget effects, then posts this corrected replacement with an audit link." : "This entry belongs to a pay-later plan, so its accounting details must be corrected from that plan."}/>{transactionCorrectable ? <form onSubmit={submit("correctTransaction", (values) => ({ ...values, transactionId: target.record.id, committed: values.committed === "on", useSpare: values.useSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="correction-note"><span>↻</span><p><strong>The original is never erased</strong><small>It becomes a corrected audit entry while this replacement becomes the active transaction.</small></p></div><Field label="Description"><input name="description" defaultValue={target.record.description} required/></Field><div className="form-grid"><Field label="Correct amount"><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field><Field label="Date"><input name="date" type="date" defaultValue={target.record.date} required/></Field></div><Field label={transactionMoving ? "From account" : "Account"}><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>Choose account</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>{transactionMoving && <Field label="To account"><select name="destinationAccountId" defaultValue={target.record.destination_account_id ?? ""} required><option value="" disabled>Choose destination</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>}{!transactionMoving && <Field label="Category"><select name="categoryId" defaultValue={target.record.category_id ?? ""}><option value="">Uncategorised</option>{correctionCategories.filter((category) => category.kind === (target.record.type === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.archived ? "Archived · " : ""}{category.name}</option>)}</select></Field>}{["expense", "saving", "investment"].includes(target.record.type) && <label className="single-check"><input type="checkbox" name="excludeFromBudget" defaultChecked={target.record.counts_monthly === 0}/> Exclude from budget — still updates account balances and spending history</label>}{target.record.type === "expense" && <div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/> Treat as committed spending</label><label><input type="checkbox" name="useSpare" defaultChecked={target.record.spare_change_cents > 0} disabled={!context.profile.spare_destination_id}/> Apply ×{context.profile.spare_multiplier} spare change</label></div>}<Submit busy={busy} label="Post corrected transaction"/></form> : <div className="locked-summary"><span>{formatMoney(target.record.amount_cents, context.currency)}</span><small>Open Plans and correct the linked purchase or remaining payment schedule there.</small></div>}</>}

    {target.kind === "account" && <><ModalTitle eyebrow="EDIT ACCOUNT" title={target.record.name} copy="Edit how this account is described and counted. Use transactions whenever its balance changes."/><form onSubmit={submit("updateAccount", (values) => ({ ...values, accountId: target.record.id, includeSpendable: values.includeSpendable === "on" }))}><div className="locked-summary"><span>{formatMoney(target.record.balance_cents, target.record.currency)}</span><small>Current balance · changed only by transactions</small></div><Field label="Account name"><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label="Type"><select name="type" defaultValue={target.record.type}>{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select></Field><Field label="Credit limit (optional)"><input name="creditLimit" type="number" min="0" step="0.01" defaultValue={(target.record.credit_limit_cents ?? 0) / 100}/></Field></div><Field label="Account color"><input name="color" type="color" defaultValue={target.record.color}/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked={target.record.include_spendable === 1}/> Include this balance in available-to-spend money</label><Submit busy={busy} label="Save account details"/></form><ArchiveAction busy={busy} label="Archive account" onClick={() => archive("archiveAccount", "accountId", target.record.id, target.record.name)} /></>}

    {target.kind === "category" && <><ModalTitle eyebrow="EDIT CATEGORY" title={target.record.name} copy="Renaming keeps existing transaction links intact. Archive it when you no longer want it available for new entries."/><form onSubmit={submit("updateCategory", (values) => ({ ...values, categoryId: target.record.id }))}><Field label="Category name"><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label="Type"><select name="kind" defaultValue={target.record.kind}><option value="expense">Expense</option><option value="income">Income</option></select></Field><Field label="Color"><input name="color" type="color" defaultValue={target.record.color}/></Field></div><Submit busy={busy} label="Save category"/></form><ArchiveAction busy={busy} label="Archive category" onClick={() => archive("archiveCategory", "categoryId", target.record.id, target.record.name)} /></>}

    {target.kind === "recurring" && <><ModalTitle eyebrow="EDIT RECURRING PLAN" title={target.record.title} copy={`This remains a ${typeLabel(target.record.type).toLowerCase()} plan. Update its category, amount, timing, account, and automation whenever the real arrangement changes.`}/><form onSubmit={submit("updateRecurring", (values) => ({ ...values, planId: target.record.id, anchorDay: values.nextDate === target.record.next_date ? target.record.anchor_day : Number(String(values.nextDate).slice(8, 10)), autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label="Plan name"><input name="title" defaultValue={target.record.title} required/></Field>{["expense", "income"].includes(target.record.type) && <Field label="Category"><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>Choose category</option>{context.categories.filter((category) => category.kind === target.record.type && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}<div className="form-grid"><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field>{["saving","investment"].includes(target.record.type) && <Field label="Destination account"><select name="destinationAccountId" required defaultValue={target.record.destination_account_id||""}><option value="" disabled>Choose destination</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label="Payment account"><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>Choose account</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="form-grid"><Field label="Frequency"><select name="frequency" defaultValue={target.record.frequency}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every"><input name="intervalCount" type="number" min="1" max="365" defaultValue={target.record.interval_count} required/></Field></div><Field label="Next date"><input name="nextDate" type="date" defaultValue={target.record.next_date} required/></Field>{["monthly", "yearly"].includes(target.record.frequency) && target.record.anchor_day >= 29 && <div className="budget-form-note"><span>31</span><p><strong>Short months use their final day</strong><small>The plan returns to day {target.record.anchor_day} whenever that day exists again.</small></p></div>}<div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/> Reserve before calculating spendable money</label><label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/> Add automatically when due</label></div><Submit busy={busy} label="Save recurring plan"/></form><ArchiveAction busy={busy} label="Archive recurring plan" onClick={() => archive("archiveRecurring", "planId", target.record.id, target.record.title)} /></>}

    {target.kind === "reserve" && <><ModalTitle eyebrow="EDIT FLEXIBLE RESERVE" title={target.record.title} copy="Changes apply to future months and to this month while it is still open. A finished month keeps its original estimate."/><form onSubmit={submit("updateReserve", (values) => ({ ...values, reserveId: target.record.id }))}><Field label="Reserve name"><input name="title" defaultValue={target.record.title} required/></Field><Field label="Expense category"><select name="categoryId" defaultValue={target.record.category_id} required>{context.categories.filter((category) => category.kind === "expense" && (category.id === target.record.category_id || !context.reserves.some((reserve) => reserve.id !== target.record.id && reserve.category_id === category.id))).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><Field label="Monthly estimate"><input name="target" type="number" min="0.01" step="0.01" defaultValue={target.record.target_cents / 100} required/></Field>{target.record.status === "finished" && <div className="budget-form-note"><span>✓</span><p><strong>This month is already finished</strong><small>Saving changes the reusable estimate only. This month keeps {formatMoney(target.record.period_target_cents, context.currency)} for accurate history.</small></p></div>}<Submit busy={busy} label="Save reserve"/></form><ArchiveAction busy={busy} label="Archive reserve" onClick={() => archive("archiveReserve", "reserveId", target.record.id, target.record.title)} /></>}

    {target.kind === "installment" && <><ModalTitle eyebrow="CORRECT PAY-LATER PLAN" title={target.record.title} copy={paidInstallments.length ? "Paid entries stay locked. Change the category or plan total and rebuild only the unpaid schedule." : "Nothing has been paid yet, so the category, full amount, and payment schedule can be corrected safely."}/><form onSubmit={submit("updateInstallmentPlan", (values) => ({ ...values, planId: target.record.id, total: installmentTotal, remainingCount: installmentRemainingCount, nextDueDate: installmentNextDue, frequency: installmentFrequency, includeDailyWeekly: values.includeDailyWeekly === "on", autoPost: values.autoPost === "on" }))}>{paidInstallments.length > 0 && <div className="locked-summary"><span>{formatMoney(target.record.paid_cents, context.currency)} already paid</span><small>{paidInstallments.length} {paidInstallments.length === 1 ? "payment stays" : "payments stay"} untouched · only {formatMoney(installmentRemainingCents, context.currency)} is rescheduled</small></div>}<Field label="Purchase"><input name="title" defaultValue={target.record.title} required/></Field><Field label="Expense category"><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>Choose category</option>{context.categories.filter((category) => category.kind === "expense" && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label="Correct total"><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min={(target.record.paid_cents + 1) / 100} step="0.01" required/></Field><Field label={paidInstallments.length ? "Remaining payments" : "Number of payments"}><input value={installmentRemainingCount} onChange={(event) => setInstallmentRemainingCount(Number(event.target.value))} type="number" min="1" max={Math.max(1, 120 - paidInstallments.length)} required/></Field></div><div className="installment-preview"><span>{Array.from({ length: Math.min(6, installmentRemainingCount) }).map((_, index) => <i key={index} />)}</span><p>{installmentRemainingCents ? `About ${formatMoney(Math.round(installmentRemainingCents / Math.max(1, installmentRemainingCount)), context.currency)} per remaining payment` : "Enter a total above the paid amount"}</p></div><div className="form-grid"><Field label={paidInstallments.length ? "Next unpaid date" : "First payment date"}><input value={installmentNextDue} onChange={(event) => setInstallmentNextDue(event.target.value)} type="date" required/></Field><Field label="Frequency"><select value={installmentFrequency} onChange={(event) => setInstallmentFrequency(event.target.value)}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field></div><div className="form-grid"><Field label="Provider label (optional)"><input name="provider" defaultValue={target.record.provider ?? ""} placeholder="Klarna, store finance…"/></Field><Field label="Repayment account"><select name="paymentAccountId" defaultValue={target.record.payment_account_id} required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><Field label="Linked credit account (optional)"><select name="linkedCreditAccountId" defaultValue={target.record.linked_credit_account_id ?? ""}><option value="">Standalone plan</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="check-stack"><label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/> Mark payments paid automatically on their due date</label></div><Submit busy={busy} label={paidInstallments.length ? "Rebuild unpaid schedule" : "Save corrected plan"}/></form><ArchiveAction busy={busy} label="Archive pay-later plan" onClick={() => archive("archiveInstallmentPlan", "planId", target.record.id, target.record.title)} /></>}

    {target.kind === "goal" && <><ModalTitle eyebrow="EDIT GOAL OR POT" title={target.record.name} copy="Link it to an account for live contributions, or track the raw contributed amount independently."/><form onSubmit={submit("updateGoal", (values) => ({ ...values, goalId: target.record.id }))}><Field label="Name"><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label="Kind"><select name="kind" defaultValue={target.record.kind}><option value="savings">Savings</option><option value="investment">Raw investment</option></select></Field><Field label="Target (optional)"><input name="target" type="number" min="0" step="0.01" defaultValue={(target.record.target_cents ?? 0) / 100}/></Field></div><Field label="Linked account (optional)"><select name="accountId" value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)}><option value="">Track independently</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><Field label={goalAccountId ? "Contribution comes from linked account" : "Raw amount contributed"}><input name="contributed" type="number" min="0" step="0.01" defaultValue={target.record.contributed_cents / 100} disabled={Boolean(goalAccountId)}/></Field><Field label="Pot color"><input name="color" type="color" defaultValue={target.record.color}/></Field><Submit busy={busy} label="Save goal"/></form><ArchiveAction busy={busy} label="Archive goal" onClick={() => archive("archiveGoal", "goalId", target.record.id, target.record.name)} /></>}
  </section></div>;
}

function ArchiveAction({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return <div className="archive-zone"><span><strong>Remove from active views</strong><small>History stays in your Remaivo data.</small></span><button type="button" disabled={busy} onClick={onClick}>{label}</button></div>;
}

function BudgetEditor({ context, busy, save }: { context: Context; busy: boolean; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const root = context.budgets.find((rule) => rule.period === "monthly") ?? context.budgets[0];
  const [calculation, setCalculation] = useState(root?.calculation_mode === "adaptive" ? "adaptive" : "fixed_split");
  const [carry, setCarry] = useState(["reset", "stack_unused", "stack_signed", "stack_capped"].includes(root?.carry_mode ?? "") ? root.carry_mode : "reset");

  async function submitBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await save("updateBudget", {
      ...values,
      anchorDate: root?.anchor_date ?? context.today,
      enabled: true,
      calculationMode: calculation,
      carryMode: calculation === "adaptive" ? "reset" : carry,
      includeEveryday: values.includeEveryday === "on",
      includeCommitted: values.includeCommitted === "on",
      includeSavings: values.includeSavings === "on",
      includeInvestments: values.includeInvestments === "on",
    });
  }

  return <><ModalTitle eyebrow="BUDGET PLAN" title="One monthly budget, three purposeful views" copy="Daily protects the full month; Weekly spreads flexible reserves and follows dated plans; Monthly shows the complete plan."/><form onSubmit={submitBudget}>
    <Field label="Monthly budget"><input name="base" type="number" min="0" step="0.01" defaultValue={(root?.base_cents ?? 0) / 100} required/></Field>
    <Field label="Allocation"><select value={calculation} onChange={(event) => setCalculation(event.target.value)}><option value="fixed_split">Fixed</option><option value="adaptive">Adaptive</option></select></Field>
    {calculation === "adaptive" ? <div className="budget-form-note"><span>↻</span><p><strong>Correction-aware redistribution</strong><small>Today uses transactions through yesterday; this week uses transactions through the previous week. Spending inside either window reduces what remains without changing its allocation base.</small></p></div> : <><div className="form-grid"><Field label="Fixed carry"><select value={carry} onChange={(event) => setCarry(event.target.value)}>{["reset", "stack_unused", "stack_signed", "stack_capped"].map((value) => <option value={value} key={value}>{carryLabels[value]}</option>)}</select></Field><Field label="Reset carry"><select name="hardReset" defaultValue={["daily", "weekly", "monthly"].includes(root?.hard_reset ?? "") ? root?.hard_reset : "monthly"}>{["daily", "weekly", "monthly"].map((value) => <option value={value} key={value}>{resetLabels[value]}</option>)}</select></Field></div>{carry === "stack_capped" ? <Field label="Maximum carried amount"><input name="carryCap" type="number" min="0" step="0.01" defaultValue={(root?.carry_cap_cents ?? 0) / 100}/></Field> : <input type="hidden" name="carryCap" value={(root?.carry_cap_cents ?? 0) / 100}/>}</>}
    {calculation === "adaptive" && <><input type="hidden" name="hardReset" value="monthly"/><input type="hidden" name="carryCap" value="0"/></>}
    <fieldset className="budget-inclusions"><legend>Transactions included everywhere</legend><label><input type="checkbox" name="includeEveryday" defaultChecked={root?.include_everyday !== 0}/><span><strong>Everyday expenses</strong><small>Groceries, eating out, shopping and other flexible spending</small></span></label><label><input type="checkbox" name="includeCommitted" defaultChecked={root?.include_committed === 1}/><span><strong>Committed payments</strong><small>Bills and installments reserved by the plan</small></span></label><label><input type="checkbox" name="includeSavings" defaultChecked={root?.include_savings === 1}/><span><strong>Savings transfers</strong><small>Money moved into savings accounts</small></span></label><label><input type="checkbox" name="includeInvestments" defaultChecked={root?.include_investments === 1}/><span><strong>Investment contributions</strong><small>Auto-invest and manual investment transfers</small></span></label></fieldset>
    <Submit busy={busy} label="Save budget plan"/>
  </form></>;
}

/* eslint-enable jsx-a11y/label-has-associated-control */
function ModalTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <div className="modal-title"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{copy}</p></div> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="form-field"><span>{label}</span>{children}</label> }
function Submit({ busy, label }: { busy: boolean; label: string }) { return <button className="primary-button modal-submit" disabled={busy} type="submit">{busy ? "Saving…" : label}<span>→</span></button> }
function EmptyMini({ text }: { text: string }) { return <p className="empty-mini">{text}</p> }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>＋</span><strong>{title}</strong><p>{copy}</p></div> }

function Onboarding({ displayName, busy, onComplete }: { displayName: string; busy: boolean; onComplete: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const [step, setStep] = useState(0);
  const [currency, setCurrency] = useState("EUR");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [startDate, setStartDate] = useState(() => financialToday(browserTimezone()));
  const [accounts, setAccounts] = useState([{ id: crypto.randomUUID(), name: "Main account", type: "bank", balance: "", includeSpendable: true, color: "#1f5b4e" }]);
  const [budgets, setBudgets] = useState({ monthly: "1200" });
  const [budgetMode, setBudgetMode] = useState("adaptive");
  const [carryMode, setCarryMode] = useState("stack_signed");
  const [resetBoundary, setResetBoundary] = useState("monthly");

  function updateAccount(id: string, key: string, value: string | boolean) { setAccounts((items) => items.map((item) => item.id === id ? { ...item, [key]: value } : item)); }
  async function finish() { await onComplete({ currency, timezone, startDate, weekStart: 1, accounts, budgets, budgetMode, carryMode, resetBoundary }); }
  return <main className="onboarding-screen"><aside className="onboarding-aside"><div className="brand-mark"><span className="remaivo-logo-mark" aria-hidden="true" /><strong>Remaivo</strong></div><div><p className="eyebrow">YOUR OPENING SNAPSHOT</p><h1>Start where your money is today.</h1><p>No fake income. No starting from zero. Add what already exists, then Remaivo takes it from here.</p></div><ol>{["Basics", "Accounts", "Budgets", "Review"].map((label, index) => <li className={step === index ? "active" : step > index ? "done" : ""} key={label}><span>{step > index ? "✓" : index + 1}</span>{label}</li>)}</ol><small>Signed in as {displayName}</small></aside><section className="onboarding-main">
    {step === 0 && <div className="setup-panel"><p className="eyebrow">WELCOME, {displayName.split(" ")[0].toUpperCase()}</p><h2>Let’s set your financial starting line.</h2><p>Choose the few basics Remaivo needs to organise every amount correctly.</p><div className="setup-form"><Field label="Primary currency"><select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="EUR">Euro · EUR</option><option value="USD">US dollar · USD</option><option value="GBP">British pound · GBP</option></select></Field><Field label="Financial timezone"><select value={timezone} onChange={(event) => { setTimezone(event.target.value); setStartDate(financialToday(event.target.value)); }}>{Array.from(new Set([timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><Field label="Opening snapshot date"><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}/></Field><div className="setup-note"><span>✓</span><p><strong>This date is not income.</strong><small>Opening balances stay out of spending and income reports. Your timezone controls every financial calendar date.</small></p></div></div></div>}
    {step === 1 && <div className="setup-panel wide"><p className="eyebrow">FINANCIAL ACCOUNTS</p><h2>Add where your money already lives.</h2><p>Include spending, savings, cash, raw investments, or credit. You can add custom accounts later.</p><div className="setup-accounts">{accounts.map((account, index) => <article key={account.id}><span className="setup-account-number">{index + 1}</span><input aria-label="Account name" value={account.name} onChange={(event) => updateAccount(account.id, "name", event.target.value)} placeholder="Account name"/><select aria-label="Account type" value={account.type} onChange={(event) => { const type = event.target.value; updateAccount(account.id, "type", type); updateAccount(account.id, "includeSpendable", !["savings", "investment", "credit"].includes(type)); }}><option value="bank">Bank</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="custom">Custom</option></select><label><span>{currency}</span><input aria-label="Opening balance" type="number" min="0" step="0.01" value={account.balance} onChange={(event) => updateAccount(account.id, "balance", event.target.value)} placeholder="0.00"/></label>{accounts.length > 1 && <button aria-label="Remove account" onClick={() => setAccounts((items) => items.filter((item) => item.id !== account.id))}>×</button>}</article>)}<button className="add-account-line" onClick={() => setAccounts((items) => [...items, { id: crypto.randomUUID(), name: "", type: "bank", balance: "", includeSpendable: true, color: ["#d68b64", "#4c8b98", "#705f83"][items.length % 3] }])}>＋ Add another account</button></div></div>}
    {step === 2 && <div className="setup-panel wide"><p className="eyebrow">ONE BUDGET PLAN</p><h2>Start with one monthly pool.</h2><p>Remaivo allocates that pool by calendar day. Today and Week are always derived views of the same plan.</p><div className="setup-budget-grid"><article><span>M</span><strong>Monthly budget</strong><label><small>Spending pool</small><div><i>{currency}</i><input type="number" min="0" step="1" value={budgets.monthly} onChange={(event) => setBudgets({ monthly: event.target.value })}/></div></label></article><article><span>↻</span><strong>Allocation</strong><label><small>Mode</small><select value={budgetMode} onChange={(event) => setBudgetMode(event.target.value)}><option value="adaptive">Adaptive</option><option value="fixed_split">Fixed</option></select></label><div className="setup-derived"><b>{budgetMode === "adaptive" ? "Redistributes each morning" : "Same calendar-day base"}</b><small>{budgetMode === "adaptive" ? "Today stays frozen after it starts" : "Transactions never change the base"}</small></div></article>{budgetMode === "fixed_split" && <article><span>＋</span><strong>Fixed carry</strong><label><small>Mode</small><select value={carryMode} onChange={(event) => setCarryMode(event.target.value)}>{["reset", "stack_unused", "stack_signed", "stack_capped"].map((value) => <option value={value} key={value}>{carryLabels[value]}</option>)}</select></label><label><small>Reset</small><select value={resetBoundary} onChange={(event) => setResetBoundary(event.target.value)}>{["daily", "weekly", "monthly"].map((value) => <option value={value} key={value}>{resetLabels[value]}</option>)}</select></label></article>}</div><div className="stack-example"><span>7</span><p><strong>Weeks are views, not separate budgets</strong><small>Remaivo adds the daily allocations inside each calendar week, including weeks that cross into a new month.</small></p></div></div>}
    {step === 3 && <div className="setup-panel"><p className="eyebrow">READY TO BEGIN</p><h2>Your opening snapshot is set.</h2><p>Remaivo will create these balances and rules without counting any of them as new activity.</p><div className="review-list"><div><span>◫</span><p><strong>{accounts.length} financial {accounts.length === 1 ? "account" : "accounts"}</strong><small>{accounts.map((account) => account.name || typeLabel(account.type)).join(" · ")}</small></p></div><div><span>◔</span><p><strong>{currency} {budgets.monthly} monthly spending pool</strong><small>Weekly and daily allowances adapt automatically</small></p></div><div><span>☁</span><p><strong>Private cross-device space</strong><small>Connected to your ChatGPT sign-in</small></p></div></div></div>}
    <footer className="setup-actions"><button className="ghost-button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>Back</button>{step < 3 ? <button className="primary-button" onClick={() => setStep((value) => value + 1)}>Continue <span>→</span></button> : <button className="primary-button" disabled={busy} onClick={finish}>{busy ? "Creating your space…" : "Open Remaivo"}<span>→</span></button>}</footer>
  </section></main>;
}
