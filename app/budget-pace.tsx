"use client";

import { planEndForecast, planPace, plusDays, type BudgetConfig, type PlanEndForecastInput } from "./v3-engine";

type CurrentPlan = PlanEndForecastInput & {
  name: string;
  period: BudgetConfig["period"];
  funding: number;
};

const periodLabels: Record<CurrentPlan["period"], string> = {
  monthly: "Calendar month",
  weekly: "7-day cycle",
  fortnightly: "14-day cycle",
  payday: "Payday to payday",
  custom: "Custom dates",
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function fullDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function BudgetPace({ plan, currency, onConfigure }: { plan: CurrentPlan; currency: string; onConfigure: () => void }) {
  const pace = planPace(plan);
  const forecast = planEndForecast(plan);
  const position = pace ? pace.paceDifference > 0 ? "above" : pace.paceDifference < 0 ? "below" : "on" : "unset";
  const period = `${fullDate(plan.start)} – ${fullDate(plusDays(plan.end, -1))}`;
  return <section className="stat-panel plan-pace-panel" aria-labelledby="plan-pace-heading">
    <div className="stat-panel-heading plan-pace-heading">
      <div><p>CURRENT PLAN</p><h2 id="plan-pace-heading">Budget pace</h2><small>{plan.name} · {periodLabels[plan.period]} · {period}</small></div>
      <div className="plan-pace-heading-actions">{pace && <span className={`plan-pace-status ${position}`}>{position === "on" ? "On even pace" : `${position === "above" ? "Above" : "Below"} even pace`}</span>}<button type="button" className="plan-pace-edit" onClick={onConfigure}>Edit target</button></div>
    </div>
    {pace ? <>
      <div className="plan-pace-total"><strong>{money(plan.spent, currency)}</strong><span>used of {money(plan.target, currency)} spending target</span></div>
      <p className="plan-pace-funding">Funded from recorded cash: {money(plan.funding, currency)}. Pace follows the {money(plan.target, currency)} target set in Plan.</p>
      <div className="plan-pace-bars" aria-label="Plan use compared with elapsed time"><div><span>Target used <b>{pace.usedRatio.toFixed(0)}%</b></span><progress max="100" value={Math.min(100, pace.usedRatio)} /></div><div><span>Period elapsed <b>{pace.elapsedRatio.toFixed(0)}%</b></span><progress max="100" value={pace.elapsedRatio} /></div></div>
      <div className="plan-pace-details"><div><small>{pace.remaining < 0 ? "Above target" : "Target left"}</small><strong>{money(Math.abs(pace.remaining), currency)}</strong></div><div><small>Compared with even pace</small><strong className={position === "above" ? "is-over" : ""}>{position === "on" ? "On pace" : `${money(Math.abs(pace.paceDifference), currency)} ${position}`}</strong><span>{money(pace.expectedSpent, currency)} expected by today</span></div><div><small>At the same daily rate</small><strong>{pace.elapsedDays >= Math.min(3, pace.totalDays) && pace.projected !== null ? money(pace.projected, currency) : "—"}</strong><span>{pace.elapsedDays >= Math.min(3, pace.totalDays) ? "Straight-line estimate" : "Available after a few days"}</span></div></div>
      {forecast && <div className="plan-pace-forecast">
        <div className="plan-pace-forecast-result"><small>RECENT-TREND ESTIMATE</small><strong className={forecast.projected !== null && forecast.projected > plan.target ? "is-over" : ""}>{forecast.projected === null ? "Building a baseline" : money(forecast.projected, currency)}</strong><span>{forecast.projected === null ? "Available after 7 observed days" : forecast.confidence === "low" ? "Early estimate at plan end" : "Projected at plan end"}</span></div>
        <div className="plan-pace-forecast-explain">{forecast.projected === null ? <p>Keep recording activity. The estimate needs a week of observed days, including days without spending.</p> : <><p>{money(plan.spent, currency)} already spent + {money(forecast.scheduledRemaining, currency)} unpaid scheduled + {money(forecast.bucketExtra, currency)} left in buckets + {money(forecast.variableRemaining ?? 0, currency)} at the recent everyday pace.</p><p>Based on {forecast.sampleDays} completed days, with newer days weighted more heavily. {forecast.spikeDays > 0 ? `${forecast.spikeDays} unusually high ${forecast.spikeDays === 1 ? "day was" : "days were"} softened.` : "Scheduled payments are counted once."}</p></>}</div>
      </div>}
      <p className="plan-pace-note">This estimate assumes unreleased bucket protection will be used. Releasing protection removes that bucket’s remainder; separately scheduled payments still count. Only spending outside buckets enters the 7-day half-life trend, which looks back up to 28 completed days.</p>
    </> : <p className="plan-pace-empty">Set a spending target in Plan to see how your current period is tracking.</p>}
  </section>;
}
