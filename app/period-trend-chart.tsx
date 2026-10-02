"use client";

import { useEffect, useRef, useState } from "react";

type TrendDay = { date: string; amount: number; cumulative: number; comparisonAmount: number; comparisonCumulative: number };

/** Both series share a scale, including negative cash flow and comparison peaks. */
export function PeriodTrendChart({ days, cumulative, compare, currency }: { days: TrendDay[]; cumulative: boolean; compare: boolean; currency: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const format = (value: number) => new Intl.NumberFormat("en-IE", { style: "currency", currency, maximumFractionDigits: 0 }).format(value / 100);
  const date = (value: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
  const series = days.map(day => ({ date: day.date, current: cumulative ? day.cumulative : day.amount, previous: cumulative ? day.comparisonCumulative : day.comparisonAmount }));
  const values = series.flatMap(day => compare ? [day.current, day.previous] : [day.current]);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values) || (low === 0 ? 100 : 0);
  const height = width < 500 ? 210 : 250;
  const left = 54, right = width - 8, top = 12, bottom = height - 30;
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  const zero = y(0);
  const step = (right - left) / Math.max(1, days.length);
  const barWidth = Math.min(36, step * (compare ? .38 : .72));
  const barGap = Math.min(3, step * .08);
  const ticks = Array.from({ length: 4 }, (_, index) => low + (high - low) * index / 3);
  const labelCount = Math.min(days.length, width < 500 ? 3 : 4);
  const labels = new Set(Array.from({ length: labelCount }, (_, index) => labelCount === 1 ? 0 : Math.round(index * (days.length - 1) / (labelCount - 1))));
  return <div ref={host} className="period-trend-plot">
    {days.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${cumulative ? "Cumulative" : "Daily"} movement from ${date(days[0].date)} to ${date(days[days.length - 1].date)}${compare ? ", with comparison on the same scale" : ""}`}>
      {ticks.map((value, index) => <g key={index}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="period-trend-grid" /><text x={left - 8} y={y(value) + 4} textAnchor="end" className="period-trend-label">{format(value)}</text></g>)}
      <line x1={left} x2={right} y1={zero} y2={zero} className="period-trend-baseline" />
      {series.map((day, index) => {
        const x = left + step * index + (step - (compare ? 2 * barWidth + barGap : barWidth)) / 2;
        return <g key={day.date}>
          <title>{date(day.date)}: {format(day.current)}{compare ? ` · comparison ${format(day.previous)}` : ""}</title>
          <rect x={x} y={Math.min(zero, y(day.current))} width={barWidth} height={Math.abs(y(day.current) - zero)} rx={Math.min(2, barWidth / 2)} className="period-trend-current" />
          {compare && <rect x={x + barWidth + barGap} y={Math.min(zero, y(day.previous))} width={barWidth} height={Math.abs(y(day.previous) - zero)} rx={Math.min(2, barWidth / 2)} className="period-trend-comparison" />}
          {labels.has(index) && <text x={index === 0 ? left : index === days.length - 1 ? right : x + step / 2} y={height - 8} textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"} className="period-trend-label">{date(day.date)}</text>}
        </g>;
      })}
    </svg> : <p className="empty-mini">No activity to chart in this period.</p>}
  </div>;
}
