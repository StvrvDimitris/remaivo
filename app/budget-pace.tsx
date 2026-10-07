"use client";

import { useTranslation } from "./i18n";

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

function money(cents: number, currency: string, locale = "en-IE") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function moneyExact(cents: number, currency: string, locale = "en-IE") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function fullDate(value: string, locale = "en-IE") {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function BudgetPace({ plan, currency, onConfigure }: { plan: CurrentPlan; currency: string; onConfigure: () => void }) {
 const { t: tr, locale } = useTranslation();

  const pace = planPace(plan);
  const forecast = planEndForecast(plan);
  const position = pace ? pace.paceDifference > 0 ? "above" : pace.paceDifference < 0 ? "below" : "on" : "unset";
  const period = `${fullDate(plan.start, locale)} – ${fullDate(plusDays(plan.end, -1), locale)}`;
  return <section className="stat-panel plan-pace-panel" aria-labelledby="plan-pace-heading">
    <div className="stat-panel-heading plan-pace-heading">
      <div><p>{tr("CURRENT PLAN")}</p><h2 id="plan-pace-heading">{tr("Budget pace")}</h2><small>{plan.name} · {tr(periodLabels[plan.period])} · {period}</small></div>
      <div className="plan-pace-heading-actions">{pace && <span className={`plan-pace-status ${tr(position === "above" ? "Above" : "Below")}`}>{position === "on" ? tr("On even pace") : tr(position === "above" ? "Above even pace" : "Below even pace")}</span>}<button type="button" className="plan-pace-edit" onClick={onConfigure}>{tr("Edit target")}</button></div>
    </div>
    {pace ? <>
      <div className="plan-pace-total"><strong>{money(plan.spent, currency, locale)}</strong><span>{tr("used of")} {money(plan.target, currency, locale)}  {tr("spending target")}</span></div>
      <p className="plan-pace-funding">{tr("Funded from recorded cash:")} {money(plan.funding, currency, locale)}{tr(". Pace follows the")} {money(plan.target, currency, locale)}  {tr("target set in Plan.")}</p>
      <div className="plan-pace-bars" aria-label={tr("Plan use compared with elapsed time")}><div><span>{tr("Target used")} <b>{pace.usedRatio.toFixed(0)}%</b></span><progress max="100" value={Math.min(100, pace.usedRatio)} /></div><div><span>{tr("Period elapsed")} <b>{pace.elapsedRatio.toFixed(0)}%</b></span><progress max="100" value={pace.elapsedRatio} /></div></div>
      <div className="plan-pace-details"><div><small>{pace.remaining < 0 ? tr("Above target") : tr("Target left")}</small><strong>{money(Math.abs(pace.remaining), currency, locale)}</strong></div><div><small>{tr("Compared with even pace")}</small><strong className={position === "above" ? "is-over" : ""}>{position === "on" ? tr("On pace") : `${money(Math.abs(pace.paceDifference), currency, locale)} ${tr(position === "above" ? "Above" : "Below")}`}</strong><span>{money(pace.expectedSpent, currency, locale)}  {tr("expected by today")}</span></div><div><small>{tr("At the same daily rate")}</small><strong>{pace.elapsedDays >= Math.min(3, pace.totalDays) && pace.projected !== null ? money(pace.projected, currency, locale) : "—"}</strong><span>{pace.elapsedDays >= Math.min(3, pace.totalDays) ? tr("Straight-line estimate") : tr("Available after a few days")}</span></div></div>
      {forecast && <div className="plan-pace-forecast">
        <div className="plan-pace-forecast-result"><small>{tr("RECENT-TREND ESTIMATE")}</small><strong className={forecast.projected !== null && forecast.projected > plan.target ? "is-over" : ""}>{forecast.projected === null ? tr("Building a baseline") : money(forecast.projected, currency, locale)}</strong><span>{forecast.projected === null ? tr("Available after 7 observed days") : forecast.confidence === "low" ? tr("Early estimate at plan end") : tr("Projected at plan end")}</span></div>
        <div className="plan-pace-forecast-explain">{forecast.projected === null ? <p>{tr("Keep recording activity. The estimate needs a week of observed days, including days without spending.")}</p> : <><p>{moneyExact(plan.spent, currency, locale)}  {tr("already spent +")} {moneyExact(forecast.scheduledRemaining, currency, locale)}  {tr("unpaid scheduled +")} {moneyExact(forecast.bucketExtra, currency, locale)}  {tr("left in buckets +")} {moneyExact(forecast.variableRemaining ?? 0, currency, locale)}  {tr("at the recent everyday pace.")}</p><p>{tr("Based on")} {forecast.sampleDays}  {tr("completed days, with newer days weighted more heavily.")} {forecast.spikeDays > 0 ? `${forecast.spikeDays} unusually high ${forecast.spikeDays === 1 ? "day was" : "days were"} softened.` : tr("Scheduled payments are counted once.")}</p></>}</div>
      </div>}
      <p className="plan-pace-note">{tr("This estimate assumes unreleased bucket protection will be used. Releasing protection removes that bucket’s remainder; separately scheduled payments still count. Only spending outside buckets enters the 7-day half-life trend, which looks back up to 28 completed days.")}</p>
    </> : <p className="plan-pace-empty">{tr("Set a spending target in Plan to see how your current period is tracking.")}</p>}
  </section>;
}
