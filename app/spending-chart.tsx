"use client";

import { useTranslation } from "./i18n";

import { useId, useState } from "react";
import { consumesBudget, daysApart, planPace, plusDays, type MoneyTransaction } from "./v3-engine";

const W = 640, H = 232, LEFT = 52, RIGHT = 16, TOP = 18, BOTTOM = 30;
const PLOT_W = W - LEFT - RIGHT, PLOT_H = H - TOP - BOTTOM;
const VIEW_KEY = "remaivo:spend-chart-view";

function money(cents: number, currency: string, locale = "en-IE") {
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
}
function compact(cents: number, currency: string, locale = "en-IE") {
  return new Intl.NumberFormat(locale, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(cents / 100);
}
function shortDate(value: string, locale = "en-IE") {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
}
// A tidy gridline step (1, 2, 2.5 or 5 × a power of ten) of at least `value`.
function niceStep(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((n) => n * power >= value) ?? 10) * power;
}
// The axis ends at the first tidy step above the value, about six steps in all,
// so the plot uses its height instead of jumping to the next power of ten.
function tightCeiling(value: number) {
  const step = niceStep(Math.max(value, 100) / 6);
  return Math.ceil(value / step) * step;
}

/** Spending in the current plan period against an even pace toward the target,
 * either as a running total or as the gap from even pace day by day. */
export function SpendingChart({ start, end, today, target, spent, transactions, currency }: { start: string; end: string; today: string; target: number; spent: number; transactions: MoneyTransaction[]; currency: string }) {
  const { t: tr, locale } = useTranslation();
  const clip = useId().replace(/:/g, "");
  // The chart renders only in the browser, after the plan loads, so the saved
  // choice can be read when it starts.
  // Vs pace opens by default; Total sticks once chosen in this browser.
  const [view, setView] = useState<"total" | "pace">(() => {
    try { return typeof window !== "undefined" && localStorage.getItem(VIEW_KEY) === "total" ? "total" : "pace"; } catch { return "pace"; }
  });
  const choose = (next: "total" | "pace") => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* the choice lasts for this visit only */ }
  };

  const totalDays = Math.max(1, daysApart(start, end));
  const elapsed = Math.max(0, Math.min(totalDays, daysApart(start, plusDays(today, 1))));
  const daily = Array.from({ length: totalDays }, () => 0);
  // Same rule as buildBudget's `counted`, so the line ends at the period's total spent.
  for (const t of transactions) {
    if (!consumesBudget(t) || t.date < start || t.date >= end || t.date > today) continue;
    daily[daysApart(start, t.date)] += t.amount_cents;
  }
  let running = 0;
  const cumulative = [0, ...daily.slice(0, elapsed).map((amount) => (running += amount))];
  const pace = planPace({ start, end, today, target, spent });
  const paceAt = (day: number) => target * day / totalDays;
  const showPace = Boolean(pace) && target > 0;
  const paceView = view === "pace" && showPace;
  const x = (day: number) => LEFT + (day / totalDays) * PLOT_W;
  const todayX = x(elapsed);
  const labelLeft = todayX > W - 150;
  const status = pace ? pace.paceDifference > 0 ? "above" : pace.paceDifference < 0 ? "below" : "on" : null;
  const summary = pace
    ? `${tr("Cumulative spending reached")} ${money(spent, currency, locale)} ${tr("by")} ${shortDate(today, locale)}, ${tr("against an even pace of")} ${money(pace.expectedSpent, currency, locale)} ${tr("and a target of")} ${money(target, currency, locale)}.`
    : `${tr("Cumulative spending reached")} ${money(spent, currency, locale)} ${tr("by")} ${shortDate(today, locale)}. ${tr("No spending target is set.")}`;
  const dates = <>
    <text className="tick" x={LEFT} y={H - 8}>{shortDate(start, locale)}</text>
    {elapsed > totalDays * 0.15 && elapsed < totalDays * 0.85 && <text className="tick strong" x={todayX} y={H - 8} textAnchor="middle">{tr("Today")}</text>}
    <text className="tick" x={W - RIGHT} y={H - 8} textAnchor="end">{shortDate(plusDays(end, -1), locale)}</text>
  </>;

  let chart;
  if (paceView) {
    // Each day's gap from even pace: above zero is spending faster than pace.
    const gaps = cumulative.map((value, day) => value - paceAt(day));
    const reach = tightCeiling(Math.max(...gaps.map(Math.abs), 1) * 1.15);
    const y = (cents: number) => TOP + PLOT_H / 2 - (cents / reach) * (PLOT_H / 2);
    const zero = y(0);
    const line = gaps.map((gap, day) => `${x(day).toFixed(1)},${y(gap).toFixed(1)}`).join(" ");
    const band = `${line} ${x(elapsed).toFixed(1)},${zero} ${x(0)},${zero}`;
    const gapNow = gaps[gaps.length - 1] ?? 0;
    const gapY = y(gapNow);
    chart = <>
      <defs>
        <clipPath id={`${clip}-over`}><rect x={LEFT} y={TOP} width={PLOT_W} height={zero - TOP} /></clipPath>
        <clipPath id={`${clip}-under`}><rect x={LEFT} y={zero} width={PLOT_W} height={TOP + PLOT_H - zero} /></clipPath>
      </defs>
      {[1, 0.5, -0.5, -1].map((share) => <line key={share} className="grid" x1={LEFT} x2={W - RIGHT} y1={y(reach * share)} y2={y(reach * share)} />)}
      {[1, -1].map((share) => <text key={share} className="tick" x={LEFT - 8} y={y(reach * share) + 4} textAnchor="end">{share > 0 ? "+" : "−"}{compact(reach, currency, locale)}</text>)}
      <line className="pace" x1={LEFT} x2={W - RIGHT} y1={zero} y2={zero} />
      <text className="tick" x={LEFT - 8} y={zero + 4} textAnchor="end">0</text>
      <text className="tick zone-label over" x={W - RIGHT - 2} y={TOP + 12} textAnchor="end">{tr("Faster than even pace")}</text>
      <text className="tick zone-label under" x={W - RIGHT - 2} y={TOP + PLOT_H - 6} textAnchor="end">{tr("Slower than even pace")}</text>
      <polygon className="gap-over" points={band} clipPath={`url(#${clip}-over)`} />
      <polygon className="gap-under" points={band} clipPath={`url(#${clip}-under)`} />
      <polyline className="spent" points={line} />
      {elapsed < totalDays && <line className="today" x1={todayX} x2={todayX} y1={TOP} y2={TOP + PLOT_H} />}
      <circle className="spent-dot" cx={todayX} cy={gapY} r="4.5" />
      <text className="value" x={labelLeft ? todayX - 10 : todayX + 10} y={gapY + 4} textAnchor={labelLeft ? "end" : "start"}>{gapNow > 0 ? "+" : gapNow < 0 ? "−" : ""}{money(Math.abs(gapNow), currency, locale)}</text>
      {dates}
    </>;
  } else {
    const ceiling = tightCeiling(Math.max(target, spent, 1) * 1.08);
    const y = (cents: number) => TOP + PLOT_H - (Math.max(0, cents) / ceiling) * PLOT_H;
    const line = cumulative.map((value, day) => `${x(day).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const area = `${line} ${x(elapsed).toFixed(1)},${y(0)} ${x(0)},${y(0)}`;
    // The band between spending and even pace, green where spending is lower and red where it is higher.
    const paceBack = cumulative.map((_, day) => `${x(day).toFixed(1)},${y(paceAt(day)).toFixed(1)}`).reverse().join(" ");
    const gapBand = `${line} ${paceBack}`;
    const paceLine = `${x(0)},${y(0)} ${x(totalDays)},${y(target)}`;
    const spentY = y(spent);
    const expectedY = pace ? y(pace.expectedSpent) : null;
    chart = <>
      {showPace && <defs>
        <clipPath id={`${clip}-over`}><polygon points={`${paceLine} ${x(totalDays)},${TOP} ${x(0)},${TOP}`} /></clipPath>
        <clipPath id={`${clip}-under`}><polygon points={`${paceLine} ${x(totalDays)},${y(0)}`} /></clipPath>
      </defs>}
      {[0, 0.5, 1].map((share) => <g key={share}>
        <line className={share ? "grid" : "axis"} x1={LEFT} x2={W - RIGHT} y1={y(ceiling * share)} y2={y(ceiling * share)} />
        <text className="tick" x={LEFT - 8} y={y(ceiling * share) + 4} textAnchor="end">{compact(ceiling * share, currency, locale)}</text>
      </g>)}
      {target > 0 && <>
        <line className="target" x1={LEFT} x2={W - RIGHT} y1={y(target)} y2={y(target)} />
        <text className="target-label" x={W - RIGHT - 2} y={y(target) - 6} textAnchor="end">{tr("Target")} {money(target, currency, locale)}</text>
        <line className="pace" x1={x(0)} y1={y(0)} x2={x(totalDays)} y2={y(target)} />
      </>}
      <polygon className="area" points={area} />
      {showPace && <>
        <polygon className="gap-over" points={gapBand} clipPath={`url(#${clip}-over)`} />
        <polygon className="gap-under" points={gapBand} clipPath={`url(#${clip}-under)`} />
      </>}
      <polyline className="spent" points={line} />
      {elapsed < totalDays && <line className="today" x1={todayX} x2={todayX} y1={TOP} y2={y(0)} />}
      {expectedY !== null && <circle className="pace-dot" cx={todayX} cy={expectedY} r="3.5" />}
      <circle className="spent-dot" cx={todayX} cy={spentY} r="4.5" />
      <text className="value" x={labelLeft ? todayX - 10 : todayX + 10} y={spentY + 4} textAnchor={labelLeft ? "end" : "start"}>{money(spent, currency, locale)}</text>
      {pace && expectedY !== null && Math.abs(expectedY - spentY) > 14 && <text className="tick" x={labelLeft ? todayX - 10 : todayX + 10} y={expectedY + 4} textAnchor={labelLeft ? "end" : "start"}>{money(pace.expectedSpent, currency, locale)}  {tr("pace")}</text>}
      {dates}
    </>;
  }

  return <div className="v3-spend-chart">
    <div className="v3-spend-chart-head">
      <div>
        <h2>{tr("Spending against your target")}</h2>
        <p>{pace ? `${money(spent, currency, locale)} ${tr("used of")} ${money(target, currency, locale)} · ${pace.elapsedRatio.toFixed(0)}% ${tr("of the period elapsed")}` : `${money(spent, currency, locale)} ${tr("spent so far. Set a spending target in Plan to compare pace.")}`}</p>
      </div>
      <div className="v3-spend-chart-actions">
        {pace && status && <span className={`v3-pace-pill ${status}`}><i />{status === "on" ? tr("On even pace") : `${money(Math.abs(pace.paceDifference), currency, locale)} ${tr(status === "above" ? "above even pace" : "below even pace")}`}</span>}
        {showPace && <div className="mini-toggle" role="group" aria-label={tr("Chart view")}>{([["pace", "Vs pace"], ["total", "Total"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} className={view === value ? "active" : ""} onClick={() => choose(value)}>{tr(label)}</button>)}</div>}
      </div>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>{chart}</svg>
    <div className="v3-spend-chart-legend">
      {paceView ? <>
        <span><i className="spent" />{tr("Gap from even pace")}</span>
        <span><i className="gap-over" />{tr("Spending faster")}</span>
        <span><i className="gap-under" />{tr("Spending slower")}</span>
      </> : <>
        <span><i className="spent" />{tr("Spent so far")}</span>
        {target > 0 && <><span><i className="pace" />{tr("Even pace")}</span><span><i className="target" />{tr("Spending target")}</span></>}
      </>}
    </div>
  </div>;
}
