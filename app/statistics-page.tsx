"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { StatisticsMode } from "./transaction-classification";

type ComparisonMode = "previousEquivalent" | "previousMonth" | "previousYear" | "none";
export type AnalyticsPeriod = "today" | "week" | "month" | "year" | "last7" | "last30" | "custom";
export type AnalyticsFilters = {
  period: AnalyticsPeriod;
  from: string;
  to: string;
  accountId: string;
  categoryId: string;
  transactionType: string;
  origin: string;
  description: string;
  comparison: ComparisonMode;
  mode: StatisticsMode;
  composition: "amount" | "percent";
  trend: "daily" | "cumulative";
};

type AnalyticsContext = {
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string; kind: string }[];
  today: string;
  currency: string;
  profile: { week_start: number };
};

type AmountChange = { amount: number; percent: number | null };
type StatisticsResult = {
  filters: AnalyticsFilters & { comparisonFrom: string | null; comparisonTo: string | null };
  summary: {
    spending: number; income: number; netOperatingCashFlow: number; cashRemaining: number;
    savedAndInvested: number; saving: number; investment: number; savingsRate: number | null;
    changes: { spending: AmountChange; income: AmountChange; netOperatingCashFlow: AmountChange; cashRemaining: AmountChange };
  };
  categoryBreakdown: { id: string; label: string; color: string; amount: number; share: number; change: AmountChange }[];
  descriptionBreakdown: { description: string; amount: number; count: number; share: number }[];
  dailyTrend: { date: string; amount: number; cumulative: number; comparisonAmount: number; comparisonCumulative: number }[];
  weekdayBreakdown: { day: number; label: string; totalAmount: number; averagePerOccurrence: number; calendarOccurrences: number; transactionCount: number }[];
  weekOfMonthBreakdown: { id: number; label: string; amount: number; averagePerOccurrence: number; occurrenceCount: number; startDate: string | null; endDate: string | null }[];
  transactionStats: { count: number; average: number; median: number; largest: { amount: number; description: string; date: string } | null; activeDays: number; zeroDays: number; averagePerActiveDay: number };
  concentration: { topCategoryShare: number; top3CategoryShare: number; topDescriptionShare: number; top5DescriptionShare: number };
  budget: null | { budget: number; spent: number; remaining: number; elapsedRatio: number; usedRatio: number; expectedSpend: number; paceDifference: number; projected: number; projectedDifference: number; elapsedDays: number; totalDays: number };
  budgetUnavailableReason: string | null;
  insights: { kind: string; text: string }[];
};

function parseDate(value: string) { return new Date(`${value}T12:00:00Z`); }
function dateKey(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(value: string, amount: number) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + amount); return dateKey(date); }
function periodStart(value: string, weekStart: number) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekStart + 7) % 7)); return dateKey(date); }
function money(cents: number, currency: string, digits = 0) { return new Intl.NumberFormat("en-IE", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(parseDate(value)); }

function defaults(context: AnalyticsContext): AnalyticsFilters {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const allowedPeriods = ["today", "week", "month", "year", "last7", "last30", "custom"];
  const period = (allowedPeriods.includes(params.get("period") ?? "") ? params.get("period") : "month") as AnalyticsPeriod;
  return {
    period,
    from: params.get("from") || `${context.today.slice(0, 7)}-01`,
    to: params.get("to") || context.today,
    accountId: params.get("accountId") || "",
    categoryId: params.get("categoryId") || "",
    transactionType: params.get("transactionType") || "",
    origin: params.get("origin") || "",
    description: params.get("description") || "",
    comparison: (["previousEquivalent", "previousMonth", "previousYear", "none"].includes(params.get("comparison") ?? "") ? params.get("comparison") : "previousMonth") as ComparisonMode,
    mode: (["spending", "income", "cashflow"].includes(params.get("mode") ?? "") ? params.get("mode") : "spending") as StatisticsMode,
    composition: params.get("composition") === "percent" ? "percent" : "amount",
    trend: params.get("trend") === "cumulative" ? "cumulative" : "daily",
  };
}

export function analyticsRange(filters: AnalyticsFilters, context: AnalyticsContext) {
  if (filters.period === "today") return { from: context.today, to: context.today };
  if (filters.period === "week") return { from: periodStart(context.today, context.profile.week_start), to: context.today };
  if (filters.period === "month") return { from: `${context.today.slice(0, 7)}-01`, to: context.today };
  if (filters.period === "year") return { from: `${context.today.slice(0, 4)}-01-01`, to: context.today };
  if (filters.period === "last7") return { from: addDays(context.today, -6), to: context.today };
  if (filters.period === "last30") return { from: addDays(context.today, -29), to: context.today };
  return { from: filters.from || `${context.today.slice(0, 7)}-01`, to: filters.to || context.today };
}

export function useAnalyticsFilters(context: AnalyticsContext) {
  const [filters, setState] = useState(() => defaults(context));
  useEffect(() => {
    const restore = () => setState(defaults(context));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [context]);
  const setFilters = useCallback((change: Partial<AnalyticsFilters> | ((value: AnalyticsFilters) => AnalyticsFilters), replace = false) => {
    setState((current) => {
      const next = typeof change === "function" ? change(current) : { ...current, ...change };
      const url = new URL(window.location.href);
      const values: Record<string, string> = { period: next.period, from: next.from, to: next.to, accountId: next.accountId, categoryId: next.categoryId, transactionType: next.transactionType, origin: next.origin, description: next.description, comparison: next.comparison, mode: next.mode, composition: next.composition, trend: next.trend };
      for (const [key, value] of Object.entries(values)) {
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
      }
      window.history[replace ? "replaceState" : "pushState"]({}, "", url);
      return next;
    });
  }, []);
  return [filters, setFilters] as const;
}

export function AnalyticsFilterBar({ context, filters, setFilters, action }: { context: AnalyticsContext; filters: AnalyticsFilters; setFilters: ReturnType<typeof useAnalyticsFilters>[1]; action?: ReactNode }) {
  const range = analyticsRange(filters, context);
  const advanced = Boolean(filters.accountId || filters.categoryId || filters.transactionType || filters.origin || filters.period === "custom");
  const quick: { id: AnalyticsPeriod; label: string }[] = [{ id: "today", label: "Today" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }, { id: "year", label: "Year" }, { id: "last7", label: "Last 7" }, { id: "last30", label: "Last 30" }];
  const reset = () => setFilters({ ...defaults(context), description: "", comparison: filters.comparison, mode: filters.mode, composition: filters.composition, trend: filters.trend });
  return <div className="analytics-filter-shell"><div className="page-toolbar"><label className="search-box"><span>⌕</span><input value={filters.description} onChange={(event) => setFilters({ description: event.target.value }, true)} placeholder="Search descriptions" /></label>{action}</div><div className="transaction-filter-bar"><div className="quick-filters" aria-label="Analysis period">{quick.map((item) => <button type="button" key={item.id} className={filters.period === item.id ? "active" : ""} onClick={() => setFilters({ period: item.id })}>{item.label}</button>)}</div><details className="advanced-filters"><summary>More filters{advanced ? " · Active" : ""}</summary><div><label><span>From</span><input type="date" max={filters.to || context.today} value={filters.period === "custom" ? filters.from : range.from} onChange={(event) => setFilters({ period: "custom", from: event.target.value })} /></label><label><span>To</span><input type="date" min={filters.from} max={context.today} value={filters.period === "custom" ? filters.to : range.to} onChange={(event) => setFilters({ period: "custom", to: event.target.value })} /></label><label><span>Account</span><select value={filters.accountId} onChange={(event) => setFilters({ accountId: event.target.value })}><option value="">All accounts</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label><label><span>Category</span><select value={filters.categoryId} onChange={(event) => setFilters({ categoryId: event.target.value })}><option value="">All categories</option>{context.categories.map((category) => <option value={category.id} key={category.id}>{category.name} · {category.kind}</option>)}</select></label><label><span>Type</span><select value={filters.transactionType} onChange={(event) => setFilters({ transactionType: event.target.value })}><option value="">All types</option><option value="expense">Expense</option><option value="income">Income</option><option value="installment_payment">Installment payment</option><option value="saving">Saving</option><option value="investment">Investment</option><option value="transfer">Transfer</option></select></label><label><span>Origin</span><select value={filters.origin} onChange={(event) => setFilters({ origin: event.target.value })}><option value="">All transactions</option><option value="recurring">Recurring</option><option value="nonrecurring">Non-recurring</option></select></label><button type="button" className="clear-filter" onClick={reset}>Reset</button></div></details></div><div className="active-filter-line"><span>{shortDate(range.from)}–{shortDate(range.to)}</span>{filters.accountId && <span>{context.accounts.find((item) => item.id === filters.accountId)?.name}</span>}{filters.categoryId && <span>{context.categories.find((item) => item.id === filters.categoryId)?.name}</span>}{filters.transactionType && <span>{filters.transactionType.replaceAll("_", " ")}</span>}{filters.origin && <span>{filters.origin === "nonrecurring" ? "Non-recurring" : "Recurring"}</span>}</div></div>;
}

function Change({ value, comparison, currency, inverse = false }: { value: AmountChange; comparison: ComparisonMode; currency: string; inverse?: boolean }) {
  if (comparison === "none") return <small>No comparison selected</small>;
  const good = inverse ? value.amount <= 0 : value.amount >= 0;
  return <small className={good ? "stat-positive" : "stat-negative"}>{value.amount > 0 ? "+" : ""}{value.percent === null ? money(value.amount, currency) : `${value.percent.toFixed(1)}%`} vs comparison</small>;
}

export function StatisticsPage({ context, revision }: { context: AnalyticsContext; revision: number }) {
  const [filters, setFilters] = useAnalyticsFilters(context);
  const [result, setResult] = useState<StatisticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const range = analyticsRange(filters, context);
  const { accountId, categoryId, comparison, description, mode, origin, transactionType } = filters;
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError("");
      const params = new URLSearchParams({ view: "statistics", from: range.from, to: range.to, comparison, mode });
      const optional = { accountId, categoryId, transactionType, origin, description };
      for (const [key, value] of Object.entries(optional)) if (value) params.set(key, value);
      try {
        const response = await fetch(`/api/finance?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as StatisticsResult & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load statistics.");
        setResult(payload);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load statistics."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, description ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [accountId, categoryId, comparison, description, mode, origin, range.from, range.to, revision, transactionType]);

  const maxAllocation = Math.max(1, ...(result?.categoryBreakdown.map((item) => item.amount) ?? [1]));
  const trendValues = result?.dailyTrend.map((item) => filters.trend === "daily" ? item.amount : item.cumulative) ?? [];
  const maxTrend = Math.max(1, ...trendValues.map(Math.abs));
  const maxWeekday = Math.max(1, ...(result?.weekdayBreakdown.map((item) => item.averagePerOccurrence) ?? [1]));
  const cards = result ? [
    { label: "Spending", value: result.summary.spending, change: result.summary.changes.spending, inverse: true },
    { label: "Income", value: result.summary.income, change: result.summary.changes.income },
    { label: "Net operating cash flow", value: result.summary.netOperatingCashFlow, change: result.summary.changes.netOperatingCashFlow },
    { label: "Cash remaining", value: result.summary.cashRemaining, change: result.summary.changes.cashRemaining },
  ] : [];

  return <div className="statistics-page"><section className="page-card"><AnalyticsFilterBar context={context} filters={filters} setFilters={setFilters} /><div className="statistics-controls"><div className="mode-switch" aria-label="Statistics mode">{(["spending", "income", "cashflow"] as StatisticsMode[]).map((mode) => <button key={mode} className={filters.mode === mode ? "active" : ""} onClick={() => setFilters({ mode })}>{mode === "cashflow" ? "Cash Flow" : mode[0].toUpperCase() + mode.slice(1)}</button>)}</div><label><span>Compare with</span><select value={filters.comparison} onChange={(event) => setFilters({ comparison: event.target.value as ComparisonMode })}><option value="previousEquivalent">Previous equivalent period</option><option value="previousMonth">Same dates previous month</option><option value="previousYear">Same period last year</option><option value="none">No comparison</option></select></label></div></section>
    {error && <section className="page-card"><div className="empty-state"><strong>Statistics could not load</strong><p>{error}</p></div></section>}
    {loading && !result && <section className="page-card stat-loading">Calculating your financial picture…</section>}
    {result && <div className={loading ? "statistics-results is-loading" : "statistics-results"}>
      <section className="stat-summary-grid">{cards.map((card) => <article key={card.label}><p>{card.label.toUpperCase()}</p><strong>{money(card.value, context.currency)}</strong><Change value={card.change} comparison={filters.comparison} currency={context.currency} inverse={card.inverse} /></article>)}</section>
      <section className="allocation-strip"><div><p>SAVED & INVESTED</p><strong>{money(result.summary.savedAndInvested, context.currency)}</strong><small>{money(result.summary.saving, context.currency)} saved · {money(result.summary.investment, context.currency)} invested</small></div><div><p>SAVINGS RATE</p><strong>{result.summary.savingsRate === null ? "—" : `${result.summary.savingsRate.toFixed(1)}%`}</strong><small>of income allocated to savings and investments</small></div></section>
      <section className="stat-two-column"><article className="stat-panel allocation-panel"><div className="stat-panel-heading"><div><p>{filters.mode === "income" ? "INCOME SOURCES" : filters.mode === "cashflow" ? "CASH FLOW COMPOSITION" : "SPENDING ALLOCATION"}</p><h2>What is consuming the period?</h2></div><div className="mini-toggle"><button className={filters.composition === "amount" ? "active" : ""} onClick={() => setFilters({ composition: "amount" })}>Amount</button><button className={filters.composition === "percent" ? "active" : ""} onClick={() => setFilters({ composition: "percent" })}>%</button></div></div><div className="ranked-bars">{result.categoryBreakdown.map((item) => <button key={item.id} type="button" disabled={filters.mode === "cashflow" || item.id === "uncategorized"} onClick={() => setFilters({ categoryId: item.id })}><span className="ranked-label"><i style={{ background: item.color }} /><b>{item.label}</b><em>{filters.composition === "percent" ? `${item.share.toFixed(1)}%` : money(item.amount, context.currency)}</em></span><span className="ranked-track"><i style={{ width: `${item.amount / maxAllocation * 100}%`, background: item.color }} /></span><small>{filters.comparison === "none" ? `${item.share.toFixed(1)}% of total` : `${item.change.amount > 0 ? "+" : ""}${money(item.change.amount, context.currency)} vs comparison`}</small></button>)}{result.categoryBreakdown.length === 0 && <p className="empty-mini">No qualifying activity in this period.</p>}</div></article>
        <article className="stat-panel"><div className="stat-panel-heading"><div><p>DESCRIPTION BREAKDOWN</p><h2>Where amounts repeat</h2></div></div><div className="description-list">{result.descriptionBreakdown.map((item, index) => <div key={`${item.description}-${index}`}><span><b>{item.description}</b><small>{item.count} transaction{item.count === 1 ? "" : "s"}</small></span><span><strong>{money(item.amount, context.currency)}</strong><small>{item.share.toFixed(1)}%</small></span></div>)}{result.descriptionBreakdown.length === 0 && <p className="empty-mini">No descriptions to rank.</p>}</div></article></section>
      <section className="stat-panel trend-panel"><div className="stat-panel-heading"><div><p>PERIOD TREND</p><h2>{filters.trend === "daily" ? "Daily movement" : "Cumulative movement"}</h2></div><div className="mini-toggle"><button className={filters.trend === "daily" ? "active" : ""} onClick={() => setFilters({ trend: "daily" })}>Daily</button><button className={filters.trend === "cumulative" ? "active" : ""} onClick={() => setFilters({ trend: "cumulative" })}>Cumulative</button></div></div><div className="trend-chart" aria-label="Period trend">{result.dailyTrend.map((item) => { const value = filters.trend === "daily" ? item.amount : item.cumulative; const comparison = filters.trend === "daily" ? item.comparisonAmount : item.comparisonCumulative; return <div key={item.date} title={`${shortDate(item.date)}: ${money(value, context.currency)}`}><span className="trend-bar current" style={{ height: `${Math.max(value ? 4 : 0, Math.abs(value) / maxTrend * 100)}%` }} />{filters.comparison !== "none" && <span className="trend-bar comparison" style={{ height: `${Math.max(comparison ? 3 : 0, Math.abs(comparison) / maxTrend * 100)}%` }} />}<small>{result.dailyTrend.length <= 12 || item.date.endsWith("-01") ? shortDate(item.date) : ""}</small></div>})}</div></section>
      <section className="stat-two-column"><article className="stat-panel"><div className="stat-panel-heading"><div><p>DAY OF WEEK</p><h2>Average per calendar occurrence</h2></div></div><div className="weekday-bars">{result.weekdayBreakdown.map((item) => <div key={item.day}><span><b>{item.label.slice(0, 3)}</b><small>{money(item.averagePerOccurrence, context.currency)}</small></span><i><b style={{ width: `${item.averagePerOccurrence / maxWeekday * 100}%` }} /></i></div>)}</div></article><article className="stat-panel"><div className="stat-panel-heading"><div><p>WEEK OF MONTH</p><h2>Calendar-day bands</h2></div></div><div className="week-band-grid">{result.weekOfMonthBreakdown.map((item) => <div key={item.id}><span>{item.label}</span><strong>{money(item.averagePerOccurrence, context.currency)}</strong><small>{item.startDate && item.endDate ? `${shortDate(item.startDate)}–${shortDate(item.endDate)}` : `${item.occurrenceCount} month band${item.occurrenceCount === 1 ? "" : "s"}`}</small></div>)}</div></article></section>
      <section className="stat-metric-grid"><article><p>TRANSACTIONS</p><strong>{result.transactionStats.count}</strong><small>{money(result.transactionStats.average, context.currency)} average</small></article><article><p>MEDIAN</p><strong>{money(result.transactionStats.median, context.currency)}</strong><small>{money(result.transactionStats.averagePerActiveDay, context.currency)} per active day</small></article><article><p>ACTIVE / ZERO DAYS</p><strong>{result.transactionStats.activeDays} / {result.transactionStats.zeroDays}</strong><small>Days with and without qualifying activity</small></article><article><p>LARGEST</p><strong>{result.transactionStats.largest ? money(result.transactionStats.largest.amount, context.currency) : "—"}</strong><small>{result.transactionStats.largest?.description ?? "No transaction"}</small></article></section>
      <section className="stat-two-column"><article className="stat-panel concentration-panel"><div className="stat-panel-heading"><div><p>CONCENTRATION</p><h2>How focused is the activity?</h2></div></div><div className="concentration-grid"><div><strong>{result.concentration.top3CategoryShare.toFixed(0)}%</strong><small>Top 3 categories / sources</small></div><div><strong>{result.concentration.top5DescriptionShare.toFixed(0)}%</strong><small>Top 5 descriptions</small></div></div></article><article className="stat-panel insight-panel"><div className="stat-panel-heading"><div><p>STRONGEST SIGNALS</p><h2>Useful observations only</h2></div></div>{result.insights.length ? <ol>{result.insights.map((item, index) => <li key={`${item.kind}-${index}`}><span>{index + 1}</span><p>{item.text}</p></li>)}</ol> : <p className="empty-mini">No material pattern clears the insight threshold yet.</p>}</article></section>
      {filters.mode === "spending" && <section className="stat-panel budget-pace-panel"><div className="stat-panel-heading"><div><p>BUDGET PACE</p><h2>Current-month global pace</h2></div></div>{result.budget ? <div className="budget-pace-content"><div><strong>{result.budget.usedRatio.toFixed(0)}%</strong><small>budget used · {result.budget.elapsedRatio.toFixed(0)}% of month elapsed</small></div><span><i style={{ width: `${Math.min(100, result.budget.usedRatio)}%` }} /></span><div><b>{money(Math.abs(result.budget.paceDifference), context.currency)} {result.budget.paceDifference > 0 ? "ahead of" : "below"} expected pace</b><small>Simple run-rate projection: {money(result.budget.projected, context.currency)}</small></div></div> : <p className="budget-unavailable">{result.budgetUnavailableReason}</p>}</section>}
    </div>}
  </div>;
}
