"use client";

import { translateInsight } from "./ui-language";
import { useTranslation } from "./i18n";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PeriodTrendChart } from "./period-trend-chart";
import type { StatisticsMode } from "./transaction-classification";
import { comparisonOptions, effectiveComparison, inclusiveDayCount } from "./statistics";
import { financePageCacheGeneration, readFinancePageCache, writeFinancePageCache } from "./finance-page-cache";

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
  mode: Exclude<StatisticsMode, "cashflow">;
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
  trackingStart: string | null;
  comparisonCoverage: "none" | "partial" | "full" | null;
  summary: {
    spending: number; income: number; netOperatingCashFlow: number; cashRemaining: number;
    saving: number; investment: number; savingsContributionRate: number | null; investmentContributionRate: number | null;
    changes: { spending: AmountChange; income: AmountChange; netOperatingCashFlow: AmountChange; cashRemaining: AmountChange };
  };
  categoryBreakdown: { id: string; label: string; color: string; amount: number; comparisonAmount: number; share: number; change: AmountChange }[];
  descriptionBreakdown: { description: string; amount: number; count: number; share: number }[];
  dailyTrend: { date: string; amount: number; cumulative: number; comparisonAmount: number; comparisonCumulative: number }[];
  weekdayBreakdown: { day: number; label: string; totalAmount: number; averagePerOccurrence: number; calendarOccurrences: number; transactionCount: number }[];
  weekOfMonthBreakdown: { id: number; label: string; amount: number; averagePerOccurrence: number; occurrenceCount: number; startDate: string | null; endDate: string | null }[];
  transactionStats: { count: number; average: number; median: number; largest: { amount: number; description: string; date: string } | null; activeDays: number; zeroDays: number; averagePerActiveDay: number };
  concentration: { topCategoryShare: number; top3CategoryShare: number; topDescriptionShare: number; top5DescriptionShare: number };
  insights: { kind: string; text: string }[];
};

function parseDate(value: string) { return new Date(`${value}T12:00:00Z`); }
function dateKey(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(value: string, amount: number) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + amount); return dateKey(date); }
function periodStart(value: string, weekStart: number) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekStart + 7) % 7)); return dateKey(date); }
function money(cents: number, currency: string, digits = 0, locale = "en-IE") { return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100); }
function shortDate(value: string, locale = "en") { return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(parseDate(value)); }

function baseDefaults(context: AnalyticsContext): AnalyticsFilters {
  return {
    period: "month",
    from: `${context.today.slice(0, 7)}-01`,
    to: context.today,
    accountId: "",
    categoryId: "",
    transactionType: "",
    origin: "",
    description: "",
    comparison: "previousEquivalent",
    mode: "spending",
    composition: "amount",
    trend: "daily",
  };
}

function defaults(context: AnalyticsContext): AnalyticsFilters {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const allowedPeriods = ["today", "week", "month", "year", "last7", "last30", "custom"];
  const base = baseDefaults(context);
  const period = (allowedPeriods.includes(params.get("period") ?? "") ? params.get("period") : base.period) as AnalyticsPeriod;
  return {
    period,
    from: params.get("from") || base.from,
    to: params.get("to") || base.to,
    accountId: params.get("accountId") || base.accountId,
    categoryId: params.get("categoryId") || base.categoryId,
    transactionType: params.get("transactionType") || base.transactionType,
    origin: params.get("origin") || base.origin,
    description: params.get("description") || base.description,
    comparison: (["previousEquivalent", "previousMonth", "previousYear", "none"].includes(params.get("comparison") ?? "") ? params.get("comparison") : base.comparison) as ComparisonMode,
    mode: (["spending", "income"].includes(params.get("mode") ?? "") ? params.get("mode") : base.mode) as AnalyticsFilters["mode"],
    composition: params.get("composition") === "percent" ? "percent" : base.composition,
    trend: params.get("trend") === "cumulative" ? "cumulative" : base.trend,
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
    const restore = () => {
      const restored = defaults(context);
      const url = new URL(window.location.href);
      if (url.searchParams.get("mode") === "cashflow") {
        url.searchParams.set("mode", restored.mode);
        window.history.replaceState({}, "", url);
      }
      setState(restored);
    };
    restore();
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

const transactionTypes: [string, string][] = [["expense", "Expense"], ["income", "Income"], ["installment_payment", "Installment payment"], ["saving", "Saving"], ["investment", "Investment"], ["transfer", "Transfer"], ["opening_balance", "Opening balance"], ["balance_adjustment", "Balance adjustment"]];

export function AnalyticsFilterBar({ context, filters, setFilters, action, categoryKind, typeOptions }: { context: AnalyticsContext; filters: AnalyticsFilters; setFilters: ReturnType<typeof useAnalyticsFilters>[1]; action?: ReactNode; categoryKind?: string; typeOptions?: string[] }) {
 const { t: tr, locale } = useTranslation();

  const range = analyticsRange(filters, context);
  const advanced = Boolean(filters.accountId || filters.categoryId || filters.transactionType || filters.origin || filters.period === "custom");
  const quick: { id: AnalyticsPeriod; label: string }[] = [{ id: "today", label: tr("Today") }, { id: "week", label: tr("Week") }, { id: "month", label: tr("Month") }, { id: "year", label: tr("Year") }, { id: "last7", label: tr("Last 7") }, { id: "last30", label: tr("Last 30") }];
  const reset = () => setFilters({ ...baseDefaults(context), comparison: filters.comparison, mode: filters.mode, composition: filters.composition, trend: filters.trend });
  return <div className="analytics-filter-shell"><div className="page-toolbar"><label className="search-box"><span>⌕</span><input value={filters.description} onChange={(event) => setFilters({ description: event.target.value }, true)} aria-label={tr("Search descriptions")} placeholder={tr("Search descriptions")} /></label><details className="advanced-filters"><summary>{tr("More filters")}{advanced ? " · Active" : ""}</summary><div><label><span>{tr("From")}</span><input type="date" max={filters.to || context.today} value={filters.period === "custom" ? filters.from : range.from} onInput={(event) => setFilters({ period: "custom", from: event.currentTarget.value })} /></label><label><span>{tr("To")}</span><input type="date" min={filters.from} max={context.today} value={filters.period === "custom" ? filters.to : range.to} onInput={(event) => setFilters({ period: "custom", to: event.currentTarget.value })} /></label><label><span>{tr("Account")}</span><select value={filters.accountId} onChange={(event) => setFilters({ accountId: event.target.value })}><option value="">{tr("All accounts")}</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label><label><span>{tr("Category")}</span><select value={filters.categoryId} onChange={(event) => setFilters({ categoryId: event.target.value })}><option value="">{tr("All categories")}</option>{context.categories.filter((category) => !categoryKind || category.kind === categoryKind).map((category) => <option value={category.id} key={category.id}>{category.name} · {category.kind}</option>)}</select></label><label><span>{tr("Type")}</span><select value={filters.transactionType} onChange={(event) => setFilters({ transactionType: event.target.value })}><option value="">{tr("All types")}</option>{transactionTypes.filter(([value]) => !typeOptions || typeOptions.includes(value)).map(([value, label]) => <option key={value} value={value}>{tr(label)}</option>)}</select></label><label><span>{tr("Origin")}</span><select value={filters.origin} onChange={(event) => setFilters({ origin: event.target.value })}><option value="">{tr("All transactions")}</option><option value="recurring">{tr("Recurring")}</option><option value="nonrecurring">{tr("Non-recurring")}</option></select></label><button type="button" className="clear-filter" onClick={reset}>{tr("Reset")}</button></div></details>{action}</div><div className="transaction-filter-bar"><div className="quick-filters" role="group" aria-label={tr("Analysis period")}>{quick.map((item) => <button type="button" key={item.id} aria-pressed={filters.period === item.id} className={filters.period === item.id ? "active" : ""} onClick={() => setFilters({ period: item.id })}>{tr(item.label)}</button>)}</div><div className="active-filter-line"><span>{shortDate(range.from, locale)}–{shortDate(range.to, locale)}</span>{filters.accountId && <span>{context.accounts.find((item) => item.id === filters.accountId)?.name}</span>}{filters.categoryId && <span>{context.categories.find((item) => item.id === filters.categoryId)?.name}</span>}{filters.transactionType && <span>{filters.transactionType.replaceAll("_", " ")}</span>}{filters.origin && <span>{filters.origin === "nonrecurring" ? tr("Non-recurring") : tr("Recurring")}</span>}</div></div></div>;
}

function Change({ value, comparisonValue, comparison, currency, inverse = false, unavailable = false }: { value: AmountChange; comparisonValue: number; comparison: ComparisonMode; currency: string; inverse?: boolean; unavailable?: boolean }) {
 const { t: tr, locale } = useTranslation();

  if (unavailable) return <small>{tr("Nothing recorded in the comparison period")}</small>;
  if (comparison === "none") return <small>{tr("No comparison selected")}</small>;
  const good = inverse ? value.amount <= 0 : value.amount >= 0;
  const movement = value.percent === null ? `${value.amount > 0 ? "+" : ""}${money(value.amount, currency, 0, locale)}` : `${value.percent > 0 ? "+" : ""}${value.percent.toFixed(1)}%`;
  return <small><b className={good ? "stat-positive" : "stat-negative"}>{movement}</b>  {tr("· comparison")} {money(comparisonValue, currency, 0, locale)}</small>;
}

export function StatisticsPage({ context, revision }: { context: AnalyticsContext; revision: number }) {
 const { t: tr, locale, language } = useTranslation();

  const [filters, setFilters] = useAnalyticsFilters(context);
  const [result, setResult] = useState<StatisticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const range = analyticsRange(filters, context);
  const { accountId, description, mode, origin } = filters;
  // Insights counts only spending or income, so filters for anything else would empty the page.
  const categoryKind = mode === "income" ? "income" : "expense";
  const typeOptions = mode === "income" ? ["income"] : ["expense", "installment_payment"];
  const categoryId = context.categories.find((category) => category.id === filters.categoryId)?.kind === categoryKind ? filters.categoryId : "";
  const transactionType = typeOptions.includes(filters.transactionType) ? filters.transactionType : "";
  const rangeDays = inclusiveDayCount(range.from, range.to);
  // Only comparisons that suit the selected range are offered; anything else falls back to the previous period.
  const comparison = effectiveComparison(filters.comparison, filters.period, range.from, range.to);
  const comparisonChoices = [...comparisonOptions(filters.period, range.from, range.to), "none" as const];
  const comparisonLabel = (option: ComparisonMode) => {
    if (option === "none") return tr("No comparison");
    if (option === "previousMonth") return tr("Same dates previous month");
    if (option === "previousYear") return tr(filters.period === "today" ? "Same day last year" : filters.period === "month" ? "Same month last year, same dates" : "Same dates last year");
    return tr({ today: "Previous day", week: "Previous week, same days", month: "Previous month, same dates", year: "Previous year, same dates", last7: "Previous 7 days", last30: "Previous 30 days", custom: "Previous period of the same length" }[filters.period]);
  };
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ view: "statistics", period: filters.period, from: range.from, to: range.to, comparison, mode });
    const optional = { accountId, categoryId, transactionType, origin, description };
    for (const [key, value] of Object.entries(optional)) if (value) params.set(key, value);
    const url = `/api/finance?${params}`;
    const timer = window.setTimeout(async () => {
      const cached = readFinancePageCache<StatisticsResult>(url);
      if (cached) { setResult(cached); setLoading(false); setError(""); return; }
      setLoading(true); setError("");
      const requestGeneration = financePageCacheGeneration();
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as StatisticsResult & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load statistics.");
        if (!controller.signal.aborted && requestGeneration === financePageCacheGeneration()) {
          writeFinancePageCache(url, payload, requestGeneration);
          setResult(payload);
        }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : tr("Unable to load statistics.")); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, description ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [accountId, categoryId, comparison, description, filters.period, mode, origin, range.from, range.to, revision, transactionType, tr]);

  const compareShown = comparison !== "none" && result?.comparisonCoverage !== "none";
  const maxAllocation = Math.max(1, ...(result?.categoryBreakdown.map((item) => item.amount) ?? [1]));
  const maxWeekday = Math.max(1, ...(result?.weekdayBreakdown.map((item) => item.averagePerOccurrence) ?? [1]));
  const cards = result ? [
    { label: tr("Spending"), value: result.summary.spending, change: result.summary.changes.spending, inverse: true },
    { label: tr("Income"), value: result.summary.income, change: result.summary.changes.income },
  ] : [];

  return <div className="statistics-page"><section className="page-card"><AnalyticsFilterBar context={context} filters={filters} setFilters={setFilters} categoryKind={categoryKind} typeOptions={typeOptions} /><div className="statistics-controls"><div className="mode-switch" role="group" aria-label={tr("Statistics mode")}>{(["spending", "income"] as AnalyticsFilters["mode"][]).map((mode) => <button key={mode} aria-pressed={filters.mode === mode} className={filters.mode === mode ? "active" : ""} onClick={() => setFilters({ mode, ...(context.categories.find((category) => category.id === filters.categoryId)?.kind !== (mode === "income" ? "income" : "expense") ? { categoryId: "" } : {}), ...(!(mode === "income" ? ["income"] : ["expense", "installment_payment"]).includes(filters.transactionType) ? { transactionType: "" } : {}) })}>{tr(mode === "income" ? "Income" : "Spending")}</button>)}</div><label><span>{tr("Compare with")}</span><select value={comparison} onChange={(event) => setFilters({ comparison: event.target.value as ComparisonMode })}>{comparisonChoices.map((option) => <option key={option} value={option}>{comparisonLabel(option)}</option>)}</select></label>{result?.filters.comparisonFrom && result.filters.comparisonTo && comparison !== "none" && <span className="comparison-range">{shortDate(result.filters.comparisonFrom, locale)}–{shortDate(result.filters.comparisonTo, locale)}{result.filters.comparisonFrom.slice(0, 4) !== range.from.slice(0, 4) ? ` ${result.filters.comparisonFrom.slice(0, 4)}` : ""}{result.comparisonCoverage === "none" ? ` · ${tr("before your records start")}` : result.comparisonCoverage === "partial" && result.trackingStart ? ` · ${tr("records start")} ${shortDate(result.trackingStart, locale)}` : ""}</span>}</div></section>
    {error && <section className="page-card"><div className="empty-state"><strong>{tr("Statistics could not load")}</strong><p>{error}</p></div></section>}
    {loading && !result && <section className="page-card stat-loading">{tr("Calculating your financial picture…")}</section>}
    {result && <div className={loading ? "statistics-results is-loading" : "statistics-results"}>
      <section className="stat-summary-grid">{cards.map((card) => <article key={card.label}><p>{card.label}</p><strong>{money(card.value, context.currency, 0, locale)}</strong><Change value={card.change} comparisonValue={card.value - card.change.amount} comparison={compareShown ? comparison : "none"} unavailable={comparison !== "none" && !compareShown} currency={context.currency} inverse={card.inverse} /></article>)}</section>
      <section className="stat-two-column"><article className="stat-panel allocation-panel"><div className="stat-panel-heading"><div><p>{filters.mode === "income" ? tr("Income sources") : tr("Spending allocation")}</p><h2>{tr("What is consuming the period?")}</h2></div><div className="mini-toggle" role="group" aria-label={tr("Composition")}><button aria-pressed={filters.composition === "amount"} className={filters.composition === "amount" ? "active" : ""} onClick={() => setFilters({ composition: "amount" })}>{tr("Amount")}</button><button aria-pressed={filters.composition === "percent"} className={filters.composition === "percent" ? "active" : ""} onClick={() => setFilters({ composition: "percent" })}>%</button></div></div><div className="ranked-bars">{result.categoryBreakdown.map((item) => <button key={item.id} type="button" disabled={item.id === "uncategorized"} onClick={() => setFilters({ categoryId: item.id })}><span className="ranked-label"><i style={{ background: item.color }} /><b>{item.id === "uncategorized" ? tr(item.label) : item.label}</b><em>{filters.composition === "percent" ? `${item.share.toFixed(1)}%` : money(item.amount, context.currency, 0, locale)}</em></span><span className="ranked-track"><i style={{ width: `${item.amount / maxAllocation * 100}%`, background: item.color }} /></span><small>{!compareShown ? `${item.share.toFixed(1)}% ${tr("of total")}` : `${item.change.percent === null ? `${item.change.amount > 0 ? "+" : ""}${money(item.change.amount, context.currency, 0, locale)}` : `${item.change.percent > 0 ? "+" : ""}${item.change.percent.toFixed(1)}%`} · ${tr("comparison")} ${money(item.comparisonAmount, context.currency, 0, locale)}`}</small></button>)}{result.categoryBreakdown.length === 0 && <p className="empty-mini">{tr("No qualifying activity in this period.")}</p>}</div></article>
        <article className="stat-panel"><div className="stat-panel-heading"><div><p>{tr("Description breakdown")}</p><h2>{tr("Where amounts repeat")}</h2></div></div><div className="description-list">{result.descriptionBreakdown.map((item, index) => <div key={`${item.description}-${index}`}><span><b>{item.description}</b><small>{item.count}  {tr(item.count === 1 ? "transaction" : "transactions")}</small></span><span><strong>{money(item.amount, context.currency, 0, locale)}</strong><small>{item.share.toFixed(1)}%</small></span></div>)}{result.descriptionBreakdown.length === 0 && <p className="empty-mini">{tr("No descriptions to rank.")}</p>}</div></article></section>
      <section className="stat-panel trend-panel"><div className="stat-panel-heading"><div><p>{tr("Period trend")}</p><h2>{filters.trend === "daily" ? tr("Daily movement") : tr("Cumulative movement")}</h2></div><div className="trend-heading-controls"><div className="period-trend-legend"><span><i className="current" />{tr("This period")}</span>{compareShown && <span><i className="comparison" />{tr("Comparison")}</span>}</div><div className="mini-toggle" role="group" aria-label={tr("Trend")}><button aria-pressed={filters.trend === "daily"} className={filters.trend === "daily" ? "active" : ""} onClick={() => setFilters({ trend: "daily" })}>{tr("Daily")}</button><button aria-pressed={filters.trend === "cumulative"} className={filters.trend === "cumulative" ? "active" : ""} onClick={() => setFilters({ trend: "cumulative" })}>{tr("Cumulative")}</button></div></div></div><PeriodTrendChart days={result.dailyTrend} cumulative={filters.trend === "cumulative"} compare={compareShown} currency={context.currency} /></section>
      <section className="stat-two-column"><article className="stat-panel"><div className="stat-panel-heading"><div><p>{tr("Day of week")}</p><h2>{tr("Average per calendar occurrence")}</h2></div></div>{rangeDays >= 2 ? <div className="weekday-bars">{result.weekdayBreakdown.map((item) => <div key={item.day}><b>{item.label.slice(0, 3)}</b><i><b style={{ width: `${item.averagePerOccurrence / maxWeekday * 100}%` }} /></i><strong>{money(item.averagePerOccurrence, context.currency, 0, locale)}</strong></div>)}</div> : <p className="empty-mini">{tr("Choose more than one day to compare weekdays.")}</p>}</article><article className="stat-panel"><div className="stat-panel-heading"><div><p>{tr("Week of month")}</p><h2>{tr("Calendar-day bands")}</h2></div></div>{rangeDays >= 28 ? <div className="week-band-grid">{result.weekOfMonthBreakdown.map((item) => <div key={item.id}><span>{tr(item.label)}</span><strong>{money(item.averagePerOccurrence, context.currency, 0, locale)}</strong><small>{item.startDate && item.endDate ? `${shortDate(item.startDate)}–${shortDate(item.endDate)}` : `${item.occurrenceCount} month band${item.occurrenceCount === 1 ? "" : "s"}`}</small></div>)}</div> : <p className="empty-mini">{tr("Choose at least four weeks to compare parts of the month.")}</p>}</article></section>
      <section className="stat-metric-grid"><article><p>{tr("Transactions")}</p><strong>{result.transactionStats.count}</strong><small>{money(result.transactionStats.average, context.currency, 0, locale)}  {tr("average")}</small></article><article><p>{tr("Median")}</p><strong>{money(result.transactionStats.median, context.currency, 0, locale)}</strong><small>{money(result.transactionStats.averagePerActiveDay, context.currency, 0, locale)}  {tr("per active day")}</small></article><article><p>{tr("Active / zero days")}</p><strong>{result.transactionStats.activeDays} / {result.transactionStats.zeroDays}</strong><small>{tr("Days with and without qualifying activity")}</small></article><article><p>{tr("Largest")}</p><strong>{result.transactionStats.largest ? money(result.transactionStats.largest.amount, context.currency, 0, locale) : "—"}</strong><small>{result.transactionStats.largest?.description ?? "No transaction"}</small></article></section>
      <section className="stat-two-column"><article className="stat-panel concentration-panel"><div className="stat-panel-heading"><div><p>{tr("Concentration")}</p><h2>{tr("How focused is the activity?")}</h2></div></div><div className="concentration-grid"><div><strong>{categoryId ? "—" : `${result.concentration.top3CategoryShare.toFixed(0)}%`}</strong><small>{tr("Top 3 categories / sources")}</small></div><div><strong>{result.concentration.top5DescriptionShare.toFixed(0)}%</strong><small>{tr("Top 5 descriptions")}</small></div></div></article><article className="stat-panel insight-panel"><div className="stat-panel-heading"><div><p>{tr("Strongest signals")}</p><h2>{tr("Useful observations only")}</h2></div></div>{result.insights.length ? <ol>{result.insights.map((item, index) => <li key={`${item.kind}-${index}`}><span>{index + 1}</span><p>{translateInsight(item.text, language)}</p></li>)}</ol> : <p className="empty-mini">{tr("No material pattern clears the insight threshold yet.")}</p>}</article></section>
    </div>}
  </div>;
}
