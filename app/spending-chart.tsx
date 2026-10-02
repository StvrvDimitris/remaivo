"use client";

import { consumesBudget, daysApart, planPace, plusDays, type MoneyTransaction } from "./v3-engine";

const W = 640, H = 232, LEFT = 52, RIGHT = 16, TOP = 18, BOTTOM = 30;
const PLOT_W = W - LEFT - RIGHT, PLOT_H = H - TOP - BOTTOM;

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
}
function compact(cents: number, currency: string) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(cents / 100);
}
function shortDate(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
// Rounds the axis ceiling up to 1, 2 or 5 × a power of ten.
function niceCeiling(value: number) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * power >= value) ?? 10;
  return step * power;
}

/** Cumulative spending in the current plan period against an even pace toward the target. */
export function SpendingChart({ start, end, today, target, spent, transactions, currency }: { start: string; end: string; today: string; target: number; spent: number; transactions: MoneyTransaction[]; currency: string }) {
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
  const ceiling = niceCeiling(Math.max(target, spent, 1) * 1.08);
  const x = (day: number) => LEFT + (day / totalDays) * PLOT_W;
  const y = (cents: number) => TOP + PLOT_H - (Math.max(0, cents) / ceiling) * PLOT_H;
  const line = cumulative.map((value, day) => `${x(day).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const area = `${line} ${x(elapsed).toFixed(1)},${y(0)} ${x(0)},${y(0)}`;
  const todayX = x(elapsed);
  const spentY = y(spent);
  const expectedY = pace ? y(pace.expectedSpent) : null;
  const labelLeft = todayX > W - 150;
  const status = pace ? pace.paceDifference > 0 ? "above" : pace.paceDifference < 0 ? "below" : "on" : null;
  const summary = pace
    ? `Cumulative spending reached ${money(spent, currency)} by ${shortDate(today)}, against an even pace of ${money(pace.expectedSpent, currency)} and a ${money(target, currency)} target.`
    : `Cumulative spending reached ${money(spent, currency)} by ${shortDate(today)}. No spending target is set.`;

  return <div className="v3-spend-chart">
    <div className="v3-spend-chart-head">
      <div>
        <h2>Spending against your target</h2>
        <p>{pace ? `${money(spent, currency)} used of ${money(target, currency)} · ${pace.elapsedRatio.toFixed(0)}% of the period elapsed` : `${money(spent, currency)} spent so far. Set a spending target in Plan to compare pace.`}</p>
      </div>
      {pace && status && <span className={`v3-pace-pill ${status}`}><i />{status === "on" ? "On even pace" : `${money(Math.abs(pace.paceDifference), currency)} ${status} even pace`}</span>}
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
      {[0, 0.5, 1].map((share) => <g key={share}>
        <line className={share ? "grid" : "axis"} x1={LEFT} x2={W - RIGHT} y1={y(ceiling * share)} y2={y(ceiling * share)} />
        <text className="tick" x={LEFT - 8} y={y(ceiling * share) + 4} textAnchor="end">{compact(ceiling * share, currency)}</text>
      </g>)}
      {target > 0 && <>
        <line className="target" x1={LEFT} x2={W - RIGHT} y1={y(target)} y2={y(target)} />
        <text className="target-label" x={W - RIGHT - 2} y={y(target) - 6} textAnchor="end">Target {money(target, currency)}</text>
        <line className="pace" x1={x(0)} y1={y(0)} x2={x(totalDays)} y2={y(target)} />
      </>}
      <polygon className="area" points={area} />
      <polyline className="spent" points={line} />
      {elapsed < totalDays && <line className="today" x1={todayX} x2={todayX} y1={TOP} y2={y(0)} />}
      {expectedY !== null && <circle className="pace-dot" cx={todayX} cy={expectedY} r="3.5" />}
      <circle className="spent-dot" cx={todayX} cy={spentY} r="4.5" />
      <text className="value" x={labelLeft ? todayX - 10 : todayX + 10} y={spentY + 4} textAnchor={labelLeft ? "end" : "start"}>{money(spent, currency)}</text>
      {pace && expectedY !== null && Math.abs(expectedY - spentY) > 14 && <text className="tick" x={labelLeft ? todayX - 10 : todayX + 10} y={expectedY + 4} textAnchor={labelLeft ? "end" : "start"}>{money(pace.expectedSpent, currency)} pace</text>}
      <text className="tick" x={LEFT} y={H - 8}>{shortDate(start)}</text>
      {elapsed > totalDays * 0.15 && elapsed < totalDays * 0.85 && <text className="tick strong" x={todayX} y={H - 8} textAnchor="middle">Today</text>}
      <text className="tick" x={W - RIGHT} y={H - 8} textAnchor="end">{shortDate(plusDays(end, -1))}</text>
    </svg>
    <div className="v3-spend-chart-legend">
      <span><i className="spent" />Spent so far</span>
      {target > 0 && <><span><i className="pace" />Even pace</span><span><i className="target" />Spending target</span></>}
    </div>
  </div>;
}
