import { budgetCountsTransaction, includedInMode, operatingCashEffect, reportingClass, type StatisticsMode } from "./transaction-classification.ts";

export type ComparisonMode = "previousEquivalent" | "previousMonth" | "previousYear" | "none";

export type StatisticsRow = {
  id: string;
  account_id: string | null;
  destination_account_id: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  type: string;
  description: string;
  amount_cents: number;
  date: string;
  committed: number;
  counts_monthly?: number;
  recurring_plan_id: string | null;
};

export type StatisticsBudgetRule = {
  base_cents: number;
  include_everyday: number;
  include_committed: number;
  include_savings: number;
  include_investments: number;
  active: number;
};

export type StatisticsFilters = {
  from: string;
  to: string;
  comparison: ComparisonMode;
  comparisonFrom: string | null;
  comparisonTo: string | null;
  mode: StatisticsMode;
  accountId: string;
  categoryId: string;
  transactionType: string;
  origin: string;
  description: string;
};

function parseCalendar(value: string) {
  return new Date(`${value}T12:00:00.000Z`);
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function addCalendarDays(value: string, days: number) {
  const date = parseCalendar(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

export function inclusiveDayCount(from: string, to: string) {
  return Math.max(1, Math.round((parseCalendar(to).getTime() - parseCalendar(from).getTime()) / 86400000) + 1);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function shiftCalendarMonth(value: string, months: number) {
  const source = parseCalendar(value);
  const targetFirst = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1, 12));
  targetFirst.setUTCDate(Math.min(source.getUTCDate(), daysInMonth(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth())));
  return dateKey(targetFirst);
}

export function shiftCalendarYear(value: string, years: number) {
  const source = parseCalendar(value);
  const target = new Date(Date.UTC(source.getUTCFullYear() + years, source.getUTCMonth(), 1, 12));
  target.setUTCDate(Math.min(source.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return dateKey(target);
}

export function comparisonRange(from: string, to: string, comparison: ComparisonMode) {
  if (comparison === "none") return null;
  if (comparison === "previousEquivalent") {
    const comparisonTo = addCalendarDays(from, -1);
    return { from: addCalendarDays(comparisonTo, -(inclusiveDayCount(from, to) - 1)), to: comparisonTo };
  }
  if (comparison === "previousMonth") return { from: shiftCalendarMonth(from, -1), to: shiftCalendarMonth(to, -1) };
  return { from: shiftCalendarYear(from, -1), to: shiftCalendarYear(to, -1) };
}

function round(value: number) {
  return Math.round(Number(value) || 0);
}

function totals(rows: StatisticsRow[]) {
  let income = 0;
  let spending = 0;
  let saving = 0;
  let investment = 0;
  for (const row of rows) {
    const amount = round(row.amount_cents);
    const classification = reportingClass(row.type);
    if (classification === "income") income += amount;
    else if (classification === "spending") spending += amount;
    else if (classification === "saving") saving += amount;
    else if (classification === "investment") investment += amount;
  }
  return {
    income,
    spending,
    netOperatingCashFlow: income - spending,
    saving,
    investment,
    savedAndInvested: saving + investment,
    cashRemaining: income - spending - saving - investment,
    savingsRate: income > 0 ? (saving + investment) / income * 100 : null,
  };
}

function delta(current: number, previous: number) {
  return { amount: current - previous, percent: previous !== 0 ? (current - previous) / Math.abs(previous) * 100 : null };
}

function modeAmount(row: StatisticsRow, mode: StatisticsMode) {
  if (mode === "spending") return reportingClass(row.type) === "spending" ? round(row.amount_cents) : 0;
  if (mode === "income") return reportingClass(row.type) === "income" ? round(row.amount_cents) : 0;
  return operatingCashEffect(row);
}

function allocationKey(row: StatisticsRow, mode: StatisticsMode) {
  if (mode === "cashflow") {
    const classification = reportingClass(row.type);
    if (classification === "income") return { id: "income", label: "Income", color: "#78a98d" };
    if (classification === "spending") return { id: "spending", label: "Spending", color: "#f28b72" };
    if (classification === "saving") return { id: "saving", label: "Savings", color: "#8ebbc5" };
    if (classification === "investment") return { id: "investment", label: "Investments", color: "#8476a8" };
    return null;
  }
  return { id: row.category_id || "uncategorized", label: row.category_name || "Uncategorized", color: row.category_color || "#d9ddd5" };
}

function allocation(rows: StatisticsRow[], comparisonRows: StatisticsRow[], mode: StatisticsMode) {
  const current = new Map<string, { id: string; label: string; color: string; amount: number }>();
  const previous = new Map<string, number>();
  for (const row of rows) {
    if (!includedInMode(row.type, mode)) continue;
    const key = allocationKey(row, mode);
    if (!key) continue;
    const existing = current.get(key.id) ?? { ...key, amount: 0 };
    existing.amount += Math.abs(mode === "cashflow" ? round(row.amount_cents) : modeAmount(row, mode));
    current.set(key.id, existing);
  }
  for (const row of comparisonRows) {
    if (!includedInMode(row.type, mode)) continue;
    const key = allocationKey(row, mode);
    if (key) previous.set(key.id, (previous.get(key.id) ?? 0) + Math.abs(mode === "cashflow" ? round(row.amount_cents) : modeAmount(row, mode)));
  }
  const total = [...current.values()].reduce((sum, item) => sum + item.amount, 0);
  return [...current.values()].sort((left, right) => right.amount - left.amount).map((item) => ({
    ...item,
    share: total > 0 ? item.amount / total * 100 : 0,
    comparisonAmount: previous.get(item.id) ?? 0,
    change: delta(item.amount, previous.get(item.id) ?? 0),
  }));
}

function descriptions(rows: StatisticsRow[], mode: StatisticsMode) {
  const grouped = new Map<string, { description: string; amount: number; count: number }>();
  for (const row of rows) {
    if (!includedInMode(row.type, mode)) continue;
    const key = row.description.trim().toLocaleLowerCase();
    const existing = grouped.get(key) ?? { description: row.description.trim() || "Untitled", amount: 0, count: 0 };
    existing.amount += Math.abs(round(row.amount_cents));
    existing.count += 1;
    grouped.set(key, existing);
  }
  const total = [...grouped.values()].reduce((sum, item) => sum + item.amount, 0);
  return [...grouped.values()].sort((left, right) => right.amount - left.amount).slice(0, 8).map((item) => ({ ...item, share: total > 0 ? item.amount / total * 100 : 0 }));
}

function allDates(from: string, to: string) {
  const dates: string[] = [];
  for (let value = from; value <= to; value = addCalendarDays(value, 1)) dates.push(value);
  return dates;
}

function trends(rows: StatisticsRow[], comparisonRows: StatisticsRow[], filters: StatisticsFilters) {
  const dates = allDates(filters.from, filters.to);
  const comparisonDates = filters.comparisonFrom && filters.comparisonTo ? allDates(filters.comparisonFrom, filters.comparisonTo) : [];
  const current = new Map<string, { income: number; spending: number; net: number }>();
  const previous = new Map<string, number>();
  for (const row of rows) {
    const item = current.get(row.date) ?? { income: 0, spending: 0, net: 0 };
    const classification = reportingClass(row.type);
    if (classification === "income") item.income += round(row.amount_cents);
    if (classification === "spending") item.spending += round(row.amount_cents);
    item.net += operatingCashEffect(row);
    current.set(row.date, item);
  }
  for (const row of comparisonRows) previous.set(row.date, (previous.get(row.date) ?? 0) + modeAmount(row, filters.mode));
  let cumulative = 0;
  let comparisonCumulative = 0;
  return dates.map((date, index) => {
    const value = current.get(date) ?? { income: 0, spending: 0, net: 0 };
    const amount = filters.mode === "spending" ? value.spending : filters.mode === "income" ? value.income : value.net;
    const comparisonAmount = comparisonDates[index] ? previous.get(comparisonDates[index]) ?? 0 : 0;
    cumulative += amount;
    comparisonCumulative += comparisonAmount;
    return { date, amount, income: value.income, spending: value.spending, net: value.net, cumulative, comparisonAmount, comparisonCumulative };
  });
}

function weekdayBreakdown(rows: StatisticsRow[], filters: StatisticsFilters) {
  const labels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const occurrences = Array(7).fill(0) as number[];
  for (const date of allDates(filters.from, filters.to)) occurrences[parseCalendar(date).getUTCDay()] += 1;
  return labels.map((label, day) => {
    const matching = rows.filter((row) => parseCalendar(row.date).getUTCDay() === day && includedInMode(row.type, filters.mode));
    const totalAmount = matching.reduce((sum, row) => sum + Math.abs(modeAmount(row, filters.mode)), 0);
    return { day, label, totalAmount, averagePerOccurrence: occurrences[day] ? totalAmount / occurrences[day] : 0, calendarOccurrences: occurrences[day], transactionCount: matching.length };
  });
}

function weekOfMonthBreakdown(rows: StatisticsRow[], filters: StatisticsFilters) {
  const definitions = [
    { id: 1, label: "Week 1", first: 1, last: 7 },
    { id: 2, label: "Week 2", first: 8, last: 14 },
    { id: 3, label: "Week 3", first: 15, last: 21 },
    { id: 4, label: "Week 4+", first: 22, last: 31 },
  ];
  const sameMonth = filters.from.slice(0, 7) === filters.to.slice(0, 7);
  return definitions.map((definition) => {
    const matching = rows.filter((row) => {
      const day = Number(row.date.slice(8, 10));
      return day >= definition.first && day <= definition.last && includedInMode(row.type, filters.mode);
    });
    const occurrences = new Set(allDates(filters.from, filters.to).filter((date) => {
      const day = Number(date.slice(8, 10));
      return day >= definition.first && day <= definition.last;
    }).map((date) => `${date.slice(0, 7)}-${definition.id}`)).size;
    const amount = matching.reduce((sum, row) => sum + Math.abs(modeAmount(row, filters.mode)), 0);
    const month = filters.from.slice(0, 7);
    const startDate = sameMonth ? `${month}-${String(Math.max(definition.first, Number(filters.from.slice(8, 10)))).padStart(2, "0")}` : null;
    const endDay = sameMonth ? Math.min(definition.last, Number(filters.to.slice(8, 10))) : 0;
    return { ...definition, amount, averagePerOccurrence: occurrences ? amount / occurrences : 0, occurrenceCount: occurrences, startDate, endDate: sameMonth && endDay >= definition.first ? `${month}-${String(endDay).padStart(2, "0")}` : null };
  });
}

function transactionStats(rows: StatisticsRow[], filters: StatisticsFilters) {
  const included = rows.filter((row) => includedInMode(row.type, filters.mode));
  const amounts = included.map((row) => Math.abs(round(row.amount_cents))).sort((left, right) => left - right);
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const midpoint = Math.floor(amounts.length / 2);
  const median = amounts.length === 0 ? 0 : amounts.length % 2 ? amounts[midpoint] : (amounts[midpoint - 1] + amounts[midpoint]) / 2;
  const activeDates = new Set(included.filter((row) => Math.abs(modeAmount(row, filters.mode)) > 0).map((row) => row.date));
  const days = inclusiveDayCount(filters.from, filters.to);
  const largest = included.sort((left, right) => right.amount_cents - left.amount_cents)[0] ?? null;
  return {
    count: amounts.length,
    average: amounts.length ? total / amounts.length : 0,
    median,
    largest: largest ? { amount: round(largest.amount_cents), description: largest.description, date: largest.date } : null,
    activeDays: activeDates.size,
    zeroDays: Math.max(0, days - activeDates.size),
    averagePerActiveDay: activeDates.size ? total / activeDates.size : 0,
  };
}

function budgetPace(rows: StatisticsRow[], budget: StatisticsBudgetRule | null, eligible: boolean, today: string) {
  if (!eligible || !budget || budget.active !== 1 || budget.base_cents <= 0) return null;
  const spent = rows.filter((row) => budgetCountsTransaction(budget, row)).reduce((sum, row) => sum + round(row.amount_cents), 0);
  const todayDate = parseCalendar(today);
  const elapsedDays = todayDate.getUTCDate();
  const totalDays = daysInMonth(todayDate.getUTCFullYear(), todayDate.getUTCMonth());
  const expected = budget.base_cents * elapsedDays / totalDays;
  const projected = elapsedDays ? spent / elapsedDays * totalDays : spent;
  return {
    budget: budget.base_cents,
    spent,
    remaining: budget.base_cents - spent,
    elapsedRatio: elapsedDays / totalDays * 100,
    usedRatio: spent / budget.base_cents * 100,
    expectedSpend: expected,
    paceDifference: spent - expected,
    projected,
    projectedDifference: projected - budget.base_cents,
    elapsedDays,
    totalDays,
  };
}

function insights(input: {
  mode: StatisticsMode;
  allocation: ReturnType<typeof allocation>;
  descriptions: ReturnType<typeof descriptions>;
  weekday: ReturnType<typeof weekdayBreakdown>;
  budget: ReturnType<typeof budgetPace>;
  summary: ReturnType<typeof totals>;
  comparisonSummary: ReturnType<typeof totals>;
  currency: string;
}) {
  const candidates: { score: number; kind: string; text: string }[] = [];
  const money = (cents: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency: input.currency, maximumFractionDigits: 0 }).format(Math.abs(cents) / 100);
  for (const category of input.allocation) {
    const absoluteChange = Math.abs(category.change.amount);
    const percentage = Math.abs(category.change.percent ?? 0);
    if (absoluteChange >= 2000 && percentage >= 20) candidates.push({ score: absoluteChange * (1 + percentage / 100), kind: "allocation", text: `${category.label} ${category.change.amount > 0 ? "increased" : "decreased"} by ${money(category.change.amount)} (${percentage.toFixed(0)}%) versus the comparison period.` });
  }
  const weekend = input.weekday.filter((item) => item.day === 0 || item.day === 6).reduce((sum, item) => sum + item.totalAmount, 0);
  const weekdayTotal = input.weekday.reduce((sum, item) => sum + item.totalAmount, 0);
  const weekendShare = weekdayTotal ? weekend / weekdayTotal * 100 : 0;
  if (weekend >= 5000 && weekendShare >= 40) candidates.push({ score: weekend * weekendShare / 100, kind: "timing", text: `${weekendShare.toFixed(0)}% of ${input.mode === "income" ? "income" : "activity"} occurred on weekends.` });
  const topDescription = input.descriptions[0];
  if (topDescription && topDescription.amount >= 5000 && topDescription.share >= 20) candidates.push({ score: topDescription.amount * topDescription.share / 100, kind: "description", text: `${topDescription.description} was the largest description at ${topDescription.share.toFixed(0)}% across ${topDescription.count} transaction${topDescription.count === 1 ? "" : "s"}.` });
  if (input.budget && Math.abs(input.budget.projectedDifference) >= Math.max(2000, input.budget.budget * .05)) candidates.push({ score: Math.abs(input.budget.projectedDifference) * 2, kind: "budget", text: `At the current run rate, spending is projected to finish ${money(input.budget.projectedDifference)} ${input.budget.projectedDifference > 0 ? "above" : "below"} budget.` });
  if (input.summary.savingsRate !== null && input.comparisonSummary.savingsRate !== null) {
    const movement = input.summary.savingsRate - input.comparisonSummary.savingsRate;
    if (Math.abs(movement) >= 5) candidates.push({ score: Math.abs(movement) * 1000, kind: "saving", text: `Savings rate ${movement > 0 ? "improved" : "fell"} by ${Math.abs(movement).toFixed(1)} percentage points.` });
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 5);
}

export function buildStatistics(input: {
  rows: StatisticsRow[];
  comparisonRows: StatisticsRow[];
  filters: StatisticsFilters;
  budget: StatisticsBudgetRule | null;
  budgetEligible: boolean;
  today: string;
  currency: string;
}) {
  const summary = totals(input.rows);
  const comparisonSummary = totals(input.comparisonRows);
  const categoryBreakdown = allocation(input.rows, input.comparisonRows, input.filters.mode);
  const descriptionBreakdown = descriptions(input.rows, input.filters.mode);
  const weekday = weekdayBreakdown(input.rows, input.filters);
  const budget = budgetPace(input.rows, input.budget, input.budgetEligible, input.today);
  return {
    filters: input.filters,
    summary: {
      ...summary,
      comparison: comparisonSummary,
      changes: {
        spending: delta(summary.spending, comparisonSummary.spending),
        income: delta(summary.income, comparisonSummary.income),
        netOperatingCashFlow: delta(summary.netOperatingCashFlow, comparisonSummary.netOperatingCashFlow),
        cashRemaining: delta(summary.cashRemaining, comparisonSummary.cashRemaining),
      },
    },
    categoryBreakdown,
    descriptionBreakdown,
    dailyTrend: trends(input.rows, input.comparisonRows, input.filters),
    weekdayBreakdown: weekday,
    weekOfMonthBreakdown: weekOfMonthBreakdown(input.rows, input.filters),
    transactionStats: transactionStats(input.rows, input.filters),
    concentration: {
      topCategoryShare: categoryBreakdown[0]?.share ?? 0,
      top3CategoryShare: categoryBreakdown.slice(0, 3).reduce((sum, item) => sum + item.share, 0),
      topDescriptionShare: descriptionBreakdown[0]?.share ?? 0,
      top5DescriptionShare: descriptionBreakdown.slice(0, 5).reduce((sum, item) => sum + item.share, 0),
    },
    budget,
    budgetUnavailableReason: input.budgetEligible ? null : "Budget pace is only available for the current month without account, category, type, description, or recurring filters.",
    insights: insights({ mode: input.filters.mode, allocation: categoryBreakdown, descriptions: descriptionBreakdown, weekday, budget, summary, comparisonSummary, currency: input.currency }),
  };
}
