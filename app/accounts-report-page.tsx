"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "./i18n";
import { financePageCacheGeneration, readFinancePageCache, writeFinancePageCache } from "./finance-page-cache";
import type { AccountsReport, AccountsReportAccount, FlowBreakdown, ReportGroupId } from "./accounts-report";

const groupLabels: Record<ReportGroupId, string> = { cash: "Cash & bank", savings: "Savings", investments: "Investments", credit: "Credit" };
const flowLabels: [keyof Omit<FlowBreakdown, "total">, string][] = [["income", "Income"], ["spending", "Spending"], ["transfers", "Transfers"], ["adjustments", "Balance adjustments"], ["opening", "Opening balance"]];

function money(cents: number, currency: string, locale: string, signed = false) {
  const formatted = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100);
  return cents < 0 ? `−${formatted}` : signed && cents > 0 ? `+${formatted}` : formatted;
}
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;

function shiftPeriod(key: string, step: number) {
  if (key.length === 4) return String(Number(key) + step);
  const index = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + step;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function periodLabel(report: AccountsReport, locale: string) {
  if (report.period.kind === "year") return report.period.key;
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${report.period.from}T12:00:00Z`));
}

function AccountRow({ row, currency, locale }: { row: AccountsReportAccount; currency: string; locale: string }) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const details = flowLabels.filter(([key]) => row.in[key] || row.out[key]);
  return <>
    <button type="button" className="report-row report-account" aria-expanded={open} disabled={!details.length} onClick={() => setOpen(value => !value)}>
      <span><i style={{ background: row.color }} aria-hidden="true" />{row.name}{row.archived && <small>{tr("Archived")}</small>}</span>
      <span data-label={tr("Start")}>{money(row.start, currency, locale)}</span>
      <span data-label={tr("In")}>{row.in.total ? money(row.in.total, currency, locale, true) : "—"}</span>
      <span data-label={tr("Out")}>{row.out.total ? money(-row.out.total, currency, locale) : "—"}</span>
      <b data-label={tr("End")}>{money(row.end, currency, locale)}</b>
    </button>
    {open && <div className="report-breakdown">{details.map(([key, label]) => <div key={key}><span>{tr(label)}</span><span>{row.in[key] ? money(row.in[key], currency, locale, true) : ""}</span><span>{row.out[key] ? money(-row.out[key], currency, locale) : ""}</span></div>)}</div>}
  </>;
}

export function AccountsReportPage({ currency, revision }: { currency: string; revision: number }) {
  const { t: tr, locale } = useTranslation();
  const [period, setPeriod] = useState("");
  const [report, setReport] = useState<AccountsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/finance?${new URLSearchParams({ view: "accountsReport", ...(period ? { period } : {}) })}`;
    (async () => {
      const cached = readFinancePageCache<AccountsReport>(url);
      if (cached) { setReport(cached); setLoading(false); setError(""); return; }
      setLoading(true); setError("");
      const generation = financePageCacheGeneration();
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as AccountsReport & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load the accounts report.");
        if (!controller.signal.aborted && generation === financePageCacheGeneration()) {
          writeFinancePageCache(url, payload, generation);
          setReport(payload);
        }
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : tr("Unable to load the accounts report.")); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [period, revision, tr]);

  const key = report?.period.key ?? period;
  const kind = report?.period.kind ?? "month";
  const earliest = report?.firstDate ? (kind === "year" ? report.firstDate.slice(0, 4) : report.firstDate.slice(0, 7)) : key;
  const canGoBack = Boolean(report && shiftPeriod(key, -1) >= earliest);
  const canGoForward = Boolean(report && !report.period.partial);

  return <div className="statistics-page accounts-report">
    <section className="page-card report-controls">
      <div className="segmented" role="group" aria-label={tr("Report period")}>
        {(["month", "year"] as const).map(option => <button key={option} type="button" className={kind === option ? "active" : ""} aria-pressed={kind === option} onClick={() => report && setPeriod(option === "year" ? report.period.from.slice(0, 4) : report.period.to.slice(0, 7))}>{tr(option === "year" ? "Year" : "Month")}</button>)}
      </div>
      <div className="report-period-stepper">
        <button type="button" className="ghost-button" aria-label={tr("Previous period")} disabled={!canGoBack || loading} onClick={() => setPeriod(shiftPeriod(key, -1))}>‹</button>
        <strong>{report ? periodLabel(report, locale) : "…"}{report?.period.partial && <small>{tr("so far")}</small>}</strong>
        <button type="button" className="ghost-button" aria-label={tr("Next period")} disabled={!canGoForward || loading} onClick={() => setPeriod(shiftPeriod(key, 1))}>›</button>
      </div>
    </section>
    {error && <section className="page-card"><div className="empty-state"><strong>{tr("The accounts report could not load")}</strong><p>{error}</p></div></section>}
    {loading && !report && <section className="page-card stat-loading">{tr("Adding up your accounts…")}</section>}
    {report && <div className={loading ? "statistics-results is-loading" : "statistics-results"}>
      <section className="stat-summary-grid report-summary">
        <article><p>{tr("Net worth")}</p><strong>{money(report.netWorth.end, currency, locale)}</strong><small><b className={report.netWorth.change >= 0 ? "stat-positive" : "stat-negative"}>{money(report.netWorth.change, currency, locale, true)}</b>  {tr(report.period.partial ? "so far this period" : "this period")}</small></article>
        <article><p>{tr("Saved")}</p><strong>{money(report.bridge.saved, currency, locale)}</strong><small>{percent(report.rates.savedPercent)}  {tr("of income · income minus spending")}</small></article>
        <article><p>{tr("Invested")}</p><strong>{money(report.rates.invested, currency, locale)}</strong><small>{percent(report.rates.investedPercent)}  {tr("of income · moved into investment accounts")}</small></article>
      </section>

      <section className="stat-panel">
        <div className="stat-panel-heading"><div><p>{tr("Net worth bridge")}</p><h2>{tr("Why your net worth changed")}</h2></div></div>
        <div className="report-bridge">
          <div><span>{tr("Income")}</span><b>{money(report.bridge.income, currency, locale, true)}</b></div>
          <div><span>{tr("Spending")}</span><b>{money(-report.bridge.spending, currency, locale)}</b></div>
          <div className="subtotal"><span>{tr("Saved")}</span><b>{money(report.bridge.saved, currency, locale, true)}</b></div>
          {report.bridge.accountsAdded !== 0 && <div><span>{tr("Accounts added")}</span><b>{money(report.bridge.accountsAdded, currency, locale, true)}</b></div>}
          {report.bridge.adjustments !== 0 && <div><span>{tr("Balance adjustments")}</span><b>{money(report.bridge.adjustments, currency, locale, true)}</b></div>}
          <div className="total"><span>{tr("Change in net worth")}</span><b>{money(report.netWorth.change, currency, locale, true)}</b></div>
        </div>
        <p className="report-note">{tr("Transfers between your own accounts move money without changing net worth, so they never appear here. Investments are counted at the amount you put in; market value is shown separately below.")}</p>
      </section>

      <section className="stat-panel">
        <div className="stat-panel-heading"><div><p>{tr("Balances")}</p><h2>{tr("Where your money sits")}</h2></div></div>
        <div className="report-table">
          <div className="report-row report-labels"><span>{tr("Account")}</span><span>{tr("Start")}</span><span>{tr("In")}</span><span>{tr("Out")}</span><span>{tr("End")}</span></div>
          {report.groups.map(group => <div key={group.id} className="report-group">
            <div className="report-row report-group-row"><span>{tr(groupLabels[group.id])}</span><span data-label={tr("Start")}>{money(group.start, currency, locale)}</span><span data-label={tr("In")}>{group.in ? money(group.in, currency, locale, true) : "—"}</span><span data-label={tr("Out")}>{group.out ? money(-group.out, currency, locale) : "—"}</span><b data-label={tr("End")}>{money(group.end, currency, locale)}</b></div>
            {group.accounts.map(row => <AccountRow key={row.id} row={row} currency={currency} locale={locale} />)}
          </div>)}
          <div className="report-row report-total-row"><span>{tr("Net worth")}</span><span data-label={tr("Start")}>{money(report.netWorth.start, currency, locale)}</span><span /><span /><b data-label={tr("End")}>{money(report.netWorth.end, currency, locale)}</b></div>
        </div>
        <p className="report-note">{tr("Select an account to split its money in and out by kind.")}</p>
      </section>

      <section className="stat-two-column">
        <article className="stat-panel">
          <div className="stat-panel-heading"><div><p>{tr("Between your accounts")}</p><h2>{tr("Money moved between groups")}</h2></div></div>
          {report.groupFlows.length ? <div className="report-flows">{report.groupFlows.map(flow => <div key={`${flow.from}-${flow.to}`}><span>{tr(groupLabels[flow.from])} <i aria-hidden="true">→</i> {tr(groupLabels[flow.to])}</span><b>{money(flow.amount, currency, locale)}</b></div>)}</div> : <p className="empty-mini">{tr("No money moved between account groups in this period.")}</p>}
        </article>
        <article className="stat-panel">
          <div className="stat-panel-heading"><div><p>{tr("Investments")}</p><h2>{tr("Money in and estimated value")}</h2></div></div>
          {report.investments.length ? <div className="report-investments">{report.investments.map(item => <div key={item.id}>
            <strong>{item.name}</strong>
            <dl>
              <div><dt>{tr("Invested at start")}</dt><dd>{money(item.start, currency, locale)}</dd></div>
              <div><dt>{tr("Added this period")}</dt><dd>{money(item.added, currency, locale, true)}</dd></div>
              <div><dt>{tr("Invested at end")}</dt><dd>{money(item.end, currency, locale)}</dd></div>
              <div><dt>{tr("Estimated value")}</dt><dd>{item.estimatedValue === null ? "—" : money(item.estimatedValue, currency, locale)}</dd></div>
            </dl>
            <small>{item.snapshotDate ? `${tr("Based on the value snapshot from")} ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${item.snapshotDate}T12:00:00Z`))}` : tr("No value snapshot by the end of this period.")}</small>
          </div>)}</div> : <p className="empty-mini">{tr("No investment accounts in this period.")}</p>}
        </article>
      </section>
    </div>}
  </div>;
}
