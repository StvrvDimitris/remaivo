"use client";

import { LanguageSelect, useTranslation } from "./i18n";

import { CSSProperties, FormEvent, HTMLAttributes, useEffect, useState } from "react";
import { DialogFrame, DialogHeading, DialogSubmit as Submit, FormField as Field, ColorPicker, ChoiceField } from "./dialog-ui";
import { defaultExpenseAccountId } from "./expense-account";
import { isLedgerType } from "./transaction-classification";
import { defaultAccountName, nameLanguage, otherNames } from "./default-names";
import type { v3Snapshot } from "../db/v3";
import type { InvestmentValuationSnapshot, InvestmentValueMetrics } from "./investment-valuations";
import { AnalyticsFilterBar, analyticsRange, useAnalyticsFilters } from "./statistics-page";
import { financePageCacheGeneration, readFinancePageCache, writeFinancePageCache } from "./finance-page-cache";

export type Account = { id: string; name: string; type: string; currency: string; balance_cents: number; credit_limit_cents: number | null; color: string; include_spendable: number; archived: number };
export type Category = { id: string; name: string; kind: string; color: string; archived: number };
export type Transaction = { id: string; account_id: string | null; destination_account_id: string | null; category_id: string | null; type: string; description: string; amount_cents: number; date: string; committed: number; counts_monthly: number; recurring_plan_id: string | null; installment_plan_id: string | null; replaces_transaction_id: string | null; spare_change_cents: number; spare_excluded: number };
type RecurringPlan = { counts_monthly?: number; id: string; title: string; type: string; amount_cents: number; account_id: string | null; destination_account_id: string | null; category_id: string | null; frequency: string; interval_count: number; next_date: string; anchor_day: number; end_date?: string | null; auto_post: number; committed: number };
// A one-off planned payment is stored as a plan whose end date is its only due date.
export const isOncePlan = (plan: Pick<RecurringPlan, "next_date" | "end_date">) => !!plan.end_date && plan.end_date === plan.next_date;
type InstallmentPlan = { id: string; title: string; provider: string | null; category_id: string | null; total_cents: number; paid_cents: number; installment_count: number; first_due_date: string; frequency: string; payment_account_id: string; linked_credit_account_id: string | null; auto_post: number; status: string };
type InstallmentPayment = { id: string; plan_id: string; sequence: number; due_date: string; amount_cents: number; status: string };
export type Goal = { id: string; name: string; kind: string; target_cents: number | null; contributed_cents: number; account_id: string | null; color: string; tracking_mode: "total" | "period" | "new_money"; start_date: string | null; end_date: string | null; baseline_cents: number; progress_cents: number };
export type GoalEntry = { id: string; goal_id: string; date: string; amount_cents: number; note: string | null; created_at: string };
type SpareEvent = { id: string; multiplied_cents: number };
type Profile = { planning_enabled?: number; ui_language?: string; default_expense_account_id?: string | null; ui_theme?: string; currency: string; week_start: number; timezone: string; spare_multiplier: number; spare_enabled: number; spare_source_id: string | null; spare_destination_id: string | null; spare_auto_sweep_threshold_cents: number; };
export type Snapshot = {
  v3?: Awaited<ReturnType<typeof v3Snapshot>>;
  needsSetup: boolean;
  today: string;
  user: { displayName: string; email: string };
  profile?: Profile;
  accounts?: Account[];
  categories?: Category[];
  transactions?: Transaction[];
  recurring?: RecurringPlan[];
  installmentPlans?: InstallmentPlan[];
  installmentPayments?: InstallmentPayment[];
  goals?: Goal[];
  goalEntries?: GoalEntry[];
  spareEvents?: SpareEvent[];
  investmentSnapshots?: InvestmentValuationSnapshot[];
  month?: { start: string; previousStart: string; previousThrough: string; income: number; spending: number; previousIncome: number; previousSpending: number };
  error?: string;
};

type TransactionSort = "description" | "date" | "account" | "amount";
type TransactionPageResult = { items: Transaction[]; page: number; pageSize: number; total: number; totalPages: number; from: string; to: string; today: string; error?: string };

export type ModalName = "transaction" | "account" | "plan" | "category" | "spare" | "goal" | "week" | "timezone" | null;
export type EditTarget =
  | { kind: "transaction"; record: Transaction }
  | { kind: "account"; record: Account }
  | { kind: "category"; record: Category }
  | { kind: "recurring"; record: RecurringPlan }
  | { kind: "installment"; record: InstallmentPlan }
  | { kind: "goal"; record: Goal };


const weekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const commonTimezones = [
  "UTC", "Europe/Athens", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Helsinki",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function formatMoney(cents: number, currency = "EUR", digits = 2, locale = "en-IE") {
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function movementMoney(cents: number, currency: string, locale = "en-IE") {
  return `${cents > 0 ? "+" : ""}${formatMoney(cents, currency, 2, locale)}`;
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

function shortDate(value: string, locale = "en-IE") {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(parseDate(value));
}

function goalDate(value: string, locale = "en-IE") {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(parseDate(value));
}

function GoalTrackingFields({ mode, setMode, startDate, endDate }: { mode: Goal["tracking_mode"]; setMode: (mode: Goal["tracking_mode"]) => void; startDate?: string | null; endDate?: string | null }) {
 const { t: tr } = useTranslation();

  return <><Field label={tr("How to track progress")}><select name="trackingMode" value={mode} onChange={(event) => setMode(event.target.value as Goal["tracking_mode"])}><option value="total">{tr("Total value now")}</option><option value="period">{tr("Net money added in a date range")}</option><option value="new_money">{tr("New money since goal start")}</option></select></Field>
    {mode === "period" && <div className="form-grid"><Field label={tr("From")}><input name="startDate" type="date" defaultValue={startDate ?? ""} required/></Field><Field label={tr("Through")}><input name="endDate" type="date" defaultValue={endDate ?? ""} required/></Field></div>}
    <p className="edit-hint">{mode === "total" ? tr("Counts the full current account balance, or the full manual tally when independent.") : mode === "period" ? tr("Counts net account money in this date range, or dated manual entries when independent. Existing balances do not count.") : tr("Captures the current balance or manual tally the first time you select it. Later net growth counts; ordinary edits keep that starting point.")}</p>
  </>;
}

function typeLabel(type: string) {
  const labels: Record<string, string> = { bank: "Bank account", savings: "Savings", cash: "Cash", credit: "Credit", investment: "Investment", wallet: "Digital wallet", custom: "Custom", income: "Income", expense: "Expense", transfer: "Transfer", saving: "Saving", installment_payment: "Installment", installment_purchase: "Installment purchase", opening_balance: "Opening balance", balance_adjustment: "Balance adjustment" };
  return labels[type] ?? type.replaceAll("_", " ");
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

export type Context = { accounts: Account[]; categories: Category[]; transactions: Transaction[]; recurring: RecurringPlan[]; installmentPlans: InstallmentPlan[]; installmentPayments: InstallmentPayment[]; goals: Goal[]; goalEntries: GoalEntry[]; investmentSnapshots: InvestmentValuationSnapshot[]; investmentMetrics: Record<string, InvestmentValueMetrics>; profile: Profile; currency: string; accountById: Record<string, Account>; categoryById: Record<string, Category>; spendable: number; savings: number; rawInvested: number; invested: number; investmentMovement: number; investmentMovementPercent: number | null; totalBalance: number; outstandingInstallments: number; sparePot: number; today: string; adaptivePlan?: boolean; planning?: boolean };

export function TransactionRow({ transaction, accountById, categoryById, currency, onEdit }: { transaction: Transaction; accountById: Record<string, Account>; categoryById: Record<string, Category>; currency: string; onEdit: () => void }) {
  const { t: tr, locale } = useTranslation();
  const ledger = isLedgerType(transaction.type);
  const positive = transaction.type === "income";
  const neutral = ledger || ["transfer", "saving", "investment", "installment_purchase"].includes(transaction.type);
  const sign = positive || (ledger && transaction.destination_account_id) ? "+" : ledger ? "−" : neutral ? "" : "−";
  return <div className="editable-record" {...editableProps(onEdit)}><span className="activity-icon" style={{ background: categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description.slice(0, 1).toUpperCase()}</span><span><strong>{transaction.description}</strong><small>{categoryById[transaction.category_id ?? ""]?.name ?? tr(typeLabel(transaction.type))} · {accountById[transaction.account_id ?? transaction.destination_account_id ?? ""]?.name ?? tr("Plan")}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? ` · ${tr("Excluded from budget")}` : ""}{transaction.replaces_transaction_id ? ` · ${tr("Corrected")}` : ""}</small></span><b className={positive ? "income" : neutral ? "neutral" : ""}>{sign}{formatMoney(transaction.amount_cents, currency, 2, locale)}</b></div>;
}

function Pager({ page, totalPages, total, pageSize, label, onPage }: { page: number; totalPages: number; total: number; pageSize: number; label: string; onPage: (page: number) => void }) {
 const { t: tr } = useTranslation();

  if (totalPages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return <nav className="pager" aria-label={`${label} pages`}><span>{first}–{last}  {tr("of")} {total}</span><div><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={`Previous ${label} page`}>←</button><b>{tr("Page")} {page}  {tr("of")} {totalPages}</b><button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label={`Next ${label} page`}>→</button></div></nav>;
}

export function TransactionsPage({ context, revision, onAdd, onEdit }: { context: Context; revision: number; onAdd: () => void; onEdit: (record: Transaction) => void }) {
 const { t: tr, locale } = useTranslation();

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
    const params = new URLSearchParams({ view: "transactions", from: range.from, to: range.to, page: String(transactionPage), sort, direction });
    if (description.trim()) params.set("search", description.trim());
    const optional = { accountId, categoryId, transactionType, origin };
    for (const [key, value] of Object.entries(optional)) if (value) params.set(key, value);
    const url = `/api/finance?${params}`;
    const timer = window.setTimeout(async () => {
      const cached = readFinancePageCache<TransactionPageResult>(url);
      if (cached) { setResult(cached); setLoading(false); setLoadError(""); return; }
      setLoading(true);
      setLoadError("");
      const requestGeneration = financePageCacheGeneration();
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as TransactionPageResult;
        if (!response.ok) throw new Error(payload.error || "Unable to load transactions.");
        if (!controller.signal.aborted && requestGeneration === financePageCacheGeneration()) {
          writeFinancePageCache(url, payload, requestGeneration);
          setResult(payload);
          if (payload.page !== transactionPage) setTransactionPage(payload.page);
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : tr("Unable to load transactions."));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, description.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [accountId, categoryId, description, direction, origin, range.from, range.to, revision, sort, transactionPage, transactionType, tr]);

  const changeSort = (value: TransactionSort) => {
    if (sort === value) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(value); setDirection(value === "description" || value === "account" ? "asc" : "desc"); }
    setTransactionPage(1);
  };
  const sortLabel = (value: TransactionSort, label: string) => `${label}${sort === value ? direction === "asc" ? " ↑" : " ↓" : ""}`;
  const items = result?.items ?? [];

  return <section className="page-card transaction-page"><AnalyticsFilterBar context={context} filters={filters} setFilters={(change, replace) => { setTransactionPage(1); setFilters(change, replace); }} action={<button className="ghost-button" onClick={onAdd}>{tr("＋ New transaction")}</button>} /><p className="edit-hint">{tr("Double-click or hold a transaction to edit it. Filters also apply to Insights.")}</p><div className={`transaction-table ${loading ? "is-loading" : ""}`} aria-busy={loading}><div className="table-head"><button onClick={() => changeSort("description")}>{sortLabel("description", tr("Transaction"))}</button><button onClick={() => changeSort("date")}>{sortLabel("date", tr("Date"))}</button><button onClick={() => changeSort("account")}>{sortLabel("account", tr("Account"))}</button><button onClick={() => changeSort("amount")}>{sortLabel("amount", tr("Amount"))}</button></div>{items.map((transaction) => <div className="table-row editable-record" {...editableProps(() => onEdit(transaction))} key={transaction.id}><span className="transaction-name"><i style={{ background: context.categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description[0]}</i><span><strong>{transaction.description}</strong><small>{context.categoryById[transaction.category_id ?? ""]?.name ?? tr(typeLabel(transaction.type))}{transaction.committed ? " · Committed" : ""}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? ` · ${tr("Excluded from budget")}` : ""}{transaction.replaces_transaction_id ? ` · ${tr("Corrected")}` : ""}</small></span></span><span>{shortDate(transaction.date, locale)}</span><span>{context.accountById[transaction.account_id ?? transaction.destination_account_id ?? ""]?.name ?? tr("Plan")}</span><b className={transaction.type === "income" ? "income" : ""}>{transaction.type === "income" ? "+" : transaction.type === "expense" ? "−" : ""}{formatMoney(transaction.amount_cents, context.currency, 2, locale)}</b></div>)}{!loading && !loadError && items.length === 0 && <EmptyState title={tr("No transactions found")} copy={tr("Try a broader date range, clear a filter, or add a transaction.")} />}{loadError && <EmptyState title={tr("Transactions could not load")} copy={loadError} />}</div>{result && <Pager page={result.page} totalPages={result.totalPages} total={result.total} pageSize={result.pageSize} label={"transactions"} onPage={setTransactionPage} />}</section>;
}

export function AccountsPage({ context, onAdd, onEdit, onSnapshot, onDefaultExpense, busy }: { onDefaultExpense: (account: Account) => void; busy: boolean; context: Context; onAdd: () => void; onEdit: (record: Account) => void; onSnapshot: (record: Account) => void }) {
 const { t: tr, locale } = useTranslation();

  const defaultId = defaultExpenseAccountId(context.accounts, context.profile.default_expense_account_id);
  return <><section className="summary-strip"><div><p>{tr("Net balance")}</p><strong>{formatMoney(context.totalBalance, context.currency, 2, locale)}</strong></div><div><p>{tr("Available cash")}</p><strong>{formatMoney(context.spendable, context.currency, 2, locale)}</strong></div><div><p>{tr("Installment debt")}</p><strong>{formatMoney(context.outstandingInstallments, context.currency, 2, locale)}</strong></div></section><p className="edit-hint page-edit-hint">{tr("Double-click or hold an account to edit its details. Balance changes belong in transactions.")}</p><section className="accounts-grid">{[...context.accounts].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id)).map((account) => {
    const metrics = context.investmentMetrics[account.id];
    return <article className={`account-card editable-record ${metrics ? "investment-account-card" : ""}`} {...editableProps(() => onEdit(account))} key={account.id} style={{ "--account-color": account.color } as CSSProperties}><div className="account-card-top"><div className="account-type"><span className="account-icon">{account.type === "cash" ? "¤" : account.type === "investment" ? "↗" : account.type === "savings" ? "◇" : account.type === "credit" ? "▰" : "◫"}</span><span>{tr(typeLabel(account.type))}</span></div><button type="button" className="account-expense-default" aria-pressed={defaultId === account.id} aria-label={defaultId === account.id ? `${account.name} is the default for expenses` : `Use ${account.name} as default for expenses`} disabled={busy || defaultId === account.id} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDefaultExpense(account); }}>{defaultId === account.id ? "✓ Default" : tr("Set default")}</button></div><h3>{account.name}</h3>{metrics ? <>
      <div className="investment-card-values">
        <div><small>{tr("Net invested")}</small><strong>{formatMoney(account.balance_cents, account.currency, 2, locale)}</strong></div>
        <div><small>{tr("Current estimate")}</small><strong>{formatMoney(metrics.estimatedCurrentValue, account.currency, 2, locale)}</strong></div>
      </div>
      <div className="investment-card-footer">
        <div><span className={`investment-card-movement ${movementTone(metrics.movement)}`}>{movementMoney(metrics.movement, account.currency, locale)} · {movementPercent(metrics.movementPercent)}</span><small>{metrics.latestSnapshot ? `Snapshot · ${shortDate(metrics.latestSnapshot.snapshot_date, locale)}` : tr("No snapshot yet")}</small></div>
        <button className="snapshot-action" aria-label={`Manage value snapshots for ${account.name}`} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSnapshot(account); }}>{tr("Snapshots")}</button>
      </div>
    </> : <><strong>{formatMoney(account.balance_cents, account.currency, 2, locale)}</strong><small>{account.include_spendable ? tr("Included in available money") : tr("Excluded from available money")}</small></>}</article>;
  })}<button className="add-card" onClick={onAdd}><span>＋</span><strong>{tr("Add custom account")}</strong><small>{tr("Bank, cash, savings, credit, investment, or anything else.")}</small></button></section></>;
}

export function GoalsPage({ context, onGoal, onSpare, onSweep, onEdit, onRecord }: { context: Context; onGoal: () => void; onSpare: () => void; onSweep: () => void; onEdit: (record: Goal) => void; onRecord: (record: Goal) => void }) {
 const { t: tr, locale } = useTranslation();

  const source = context.accountById[context.profile.spare_source_id ?? ""];
  const destination = context.accountById[context.profile.spare_destination_id ?? ""];
  const enabled = context.profile.spare_enabled === 1;
  const threshold = context.profile.spare_auto_sweep_threshold_cents || 0;
  return <div className="goals-page">
    <section className="spare-hero">
      <div>
        <p className="eyebrow">{tr("SPARE CHANGE ·")} {enabled ? tr("ON") : tr("OFF")}</p>
        <h2>{formatMoney(context.sparePot, context.currency, 2, locale)}  {"waiting"}</h2>
        <p>{enabled && source ? <>{tr("Expenses paid from")} {source.name}  {tr("earn a ×")}{context.profile.spare_multiplier}  {tr("round-up unless excluded.")}</> : <>{tr("No new round-ups are being collected.")}</>} {source && destination ? <>{tr("Sweep debits")} {source.name}  {tr("and records the move to")} {destination.name}.</> : <>{tr("Choose a spending account and a destination in Configure.")}</>}</p>
        {threshold > 0 && <p className="spare-sweep-status">{enabled ? <>{tr("Auto sweep at")} {formatMoney(threshold, context.currency, 2, locale)}. {context.sparePot >= threshold && source && source.balance_cents < context.sparePot ? "Waiting for the spending account to cover the full amount." : "Checked when you save activity or Remaivo syncs."}</> : "Automatic sweeps are paused while round-ups are off."}</p>}
        <div className="spare-actions"><button className="primary-button" onClick={onSpare}><span>⚙</span>{tr("Configure")}</button><button className="ghost-button" disabled={!context.sparePot || !source || !destination} onClick={onSweep}>{tr("Sweep now")}</button></div>
      </div>
      <div className="spare-orbit"><span>{enabled ? tr("ON") : tr("OFF")}</span><small>{threshold > 0 ? tr("Automatic sweeps") : tr("Sweep manually")}</small></div>
    </section>
    <div className="section-heading goal-heading"><div><p>{tr("Savings & investing")}</p><h3>{tr("Your pots and contribution targets")}</h3><small className="edit-hint">{tr("Double-click or hold a pot to edit or archive it.")}</small></div><button className="ghost-button" onClick={onGoal}>{tr("＋ New goal")}</button></div>
    <section className="goal-grid">{context.goals.map((goal) => {
      const progress = goal.progress_cents ?? (goal.account_id ? context.accountById[goal.account_id]?.balance_cents ?? goal.contributed_cents : goal.contributed_cents);
      const percent = goal.target_cents ? Math.max(0, progress / goal.target_cents * 100) : 0;
      const mode = goal.tracking_mode ?? "total";
      const period = mode === "period" && goal.start_date && goal.end_date ? `${goalDate(goal.start_date, locale)} – ${goalDate(goal.end_date, locale)}` : mode === "new_money" ? `New money since ${goal.start_date ? goalDate(goal.start_date, locale) : "goal start"}` : tr("Full value now");
      return <article className="editable-record" {...editableProps(() => onEdit(goal))} key={goal.id} style={{"--goal-color": goal.color.toLowerCase() === "#dff35f" ? "#12a16b" : goal.color} as CSSProperties}>
        <span className="goal-kind">{goal.kind === "investment" ? tr("Investing") : tr("Savings")} · {goal.account_id ? context.accountById[goal.account_id]?.name ?? "Linked account" : tr("Independent")}</span>
        <h3>{goal.name}</h3><p className="goal-period">{period}</p><strong>{formatMoney(progress, context.currency, 2, locale)}</strong>
        {goal.target_cents && <><small>{tr("of")} {formatMoney(goal.target_cents, context.currency, 2, locale)}</small><div className="wide-progress"><i style={{ width: `${Math.min(100, percent)}%` }} /></div><p>{Math.round(percent)}{tr("% complete")}</p></>}
        {!goal.account_id && <button type="button" className="goal-record-button" onClick={(event) => { event.stopPropagation(); onRecord(goal); }} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{tr("＋ Record progress")}</button>}
      </article>;
    })}{context.goals.length === 0 && <button className="add-card" onClick={onGoal}><span>＋</span><strong>{tr("Create your first goal")}</strong><small>{tr("Track savings or raw investment contributions without market prices.")}</small></button>}</section>
  </div>;
}

export function GoalEntryModal({ goal, context, busy, error, close, save }: { goal: Goal; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<boolean> }) {
 const { t: tr, locale } = useTranslation();

  const entries = context.goalEntries.filter((entry) => entry.goal_id === goal.id);
  const earliest = goal.tracking_mode === "period" || goal.tracking_mode === "new_money" ? goal.start_date ?? undefined : undefined;
  const latest = goal.tracking_mode === "period" && goal.end_date && goal.end_date < context.today ? goal.end_date : context.today;
  const canRecord = !earliest || earliest <= latest;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (await save("addGoalEntry", { ...values, goalId: goal.id })) form.reset();
  }
  async function remove(entry: GoalEntry) {
    if (!window.confirm(`Delete the ${goalDate(entry.date, locale)} progress entry?`)) return;
    await save("deleteGoalEntry", { entryId: entry.id });
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>
    <ModalTitle eyebrow={tr("INDEPENDENT GOAL")} title={`Record progress · ${goal.name}`} copy={tr("These entries track your goal only. They do not move money or change an account balance.")}/>{error && <p className="modal-error" role="alert">{tr(error)}</p>}
    {canRecord ? <form onSubmit={submit}><div className="form-grid"><Field label={tr("Change")}><select name="kind" defaultValue="add"><option value="add">{tr("Add progress")}</option><option value="remove">{tr("Remove progress")}</option></select></Field><Field label={tr("Amount")}><input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"/></Field></div><Field label={tr("Date")}><input name="date" type="date" min={earliest} max={latest} defaultValue={latest} required/></Field><Field label={tr("Note (optional)")}><input name="note" maxLength={200} placeholder={tr("Deposit, adjustment…")}/></Field><Submit busy={busy} label={tr("Record progress")}/></form> : <p className="edit-hint">{tr("This goal’s tracking period has not started yet. You can record progress once it begins.")}</p>}
    <div className="goal-entry-history"><h3>{tr("Recent progress")}</h3>{entries.length ? entries.map((entry) => <div key={entry.id}><span><strong>{entry.amount_cents >= 0 ? "+" : "−"}{formatMoney(Math.abs(entry.amount_cents), context.currency, 2, locale)}</strong><small>{goalDate(entry.date, locale)}{entry.note ? ` · ${entry.note}` : ""}</small></span><button type="button" disabled={busy} onClick={() => void remove(entry)} aria-label={`Delete progress entry from ${goalDate(entry.date, locale)}`}>{tr("Delete")}</button></div>) : <p className="edit-hint">{tr("No dated entries yet. The older opening amount, if any, is managed in Edit goal.")}</p>}</div>
  </DialogFrame></div>;
}

export function SettingsPage({ context, onCategory, onGoals, onWeek, onTimezone, onArchive, onEditCategory }: { context: Context; onCategory: () => void; onGoals: () => void; onWeek: () => void; onTimezone: () => void; onArchive: () => void; onEditCategory: (record: Category) => void }) {
 const { t: tr } = useTranslation();

  return <div className="settings-grid"><section className="page-card"><div className="section-heading"><div><p>{tr("CATEGORIES")}</p><h3>{tr("Custom income & expense labels")}</h3></div><button className="ghost-button" onClick={onCategory}>{tr("＋ Add category")}</button></div><p className="edit-hint">{tr("Double-click or hold a category to edit or archive it.")}</p><div className="category-cloud">{context.categories.filter(category => category.archived !== 1).map((category) => <span className="editable-record" {...editableProps(() => onEditCategory(category))} key={category.id} style={{ "--category-color": category.color } as CSSProperties}><i>{category.name[0]}</i>{category.name}<small>{tr(typeLabel(category.kind))}</small></span>)}</div></section><section className="page-card setting-stack"><header className="preferences-heading"><h3>{tr("Preferences")}</h3></header><div><span className="setting-icon">¤</span><span><strong>{tr("Currency")}</strong><small>{tr("Primary display and manual entry currency")}</small></span><b>{context.profile.currency}</b></div><button onClick={onTimezone}><span className="setting-icon">◷</span><span><strong>{tr("Financial timezone")}</strong><small>{tr("Controls today, due dates, resets, and automatic catch-up")}</small></span><b>{context.profile.timezone} →</b></button><button onClick={onGoals}><span className="setting-icon">◇</span><span><strong>{tr("Save & invest")}</strong><small>{tr("Goals, raw investments, and spare-change accelerator")}</small></span><b>→</b></button><button onClick={onWeek}><span className="setting-icon">7</span><span><strong>{tr("Week starts")}</strong><small>{tr("Calendar-week anchor for weekly and daily windows")}</small></span><b>{tr(weekdayLabels[context.profile.week_start])} →</b></button><button onClick={onArchive}><span className="setting-icon">▤</span><span><strong>{tr("Archive manager")}</strong><small>{tr("Search and restore archived accounts, goals, categories and plans")}</small></span><b>{tr("Open")}</b></button><div><span className="setting-icon">☁</span><span><strong>{tr("Cross-device data")}</strong><small>{tr("Stored privately on your own Remaivo server")}</small></span><b>{tr("Active")}</b></div></section></div>;
}

export function ValuationModal({ account, snapshots, currency, today, busy, close, save }: { account: Account; snapshots: InvestmentValuationSnapshot[]; currency: string; today: string; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<boolean> }) {
 const { t: tr, locale } = useTranslation();

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = snapshots.find((snapshot) => snapshot.id === editingId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const ok = await save(editing ? "updateInvestmentSnapshot" : "addInvestmentSnapshot", { ...values, accountId: account.id, snapshotId: editing?.id });
    if (ok) setEditingId(null);
  }

  async function remove(snapshot: InvestmentValuationSnapshot) {
    if (!window.confirm(`Delete the ${shortDate(snapshot.snapshot_date, locale)} valuation snapshot? This will not delete any transaction.`)) return;
    const ok = await save("deleteInvestmentSnapshot", { snapshotId: snapshot.id });
    if (ok && editingId === snapshot.id) setEditingId(null);
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card valuation-modal" currency={currency} close={close}><ModalTitle eyebrow={tr("MANUAL INVESTMENT VALUATION")} title={account.name} copy={tr("A snapshot records portfolio value only. It never creates a transaction or changes raw invested history or budgets.")}/><form key={editing?.id ?? "new"} onSubmit={submit}><div className="form-grid"><Field label={tr("Portfolio value")}><input name="value" type="number" min="0" step="0.01" defaultValue={editing ? editing.value_cents / 100 : ""} required placeholder="0.00"/></Field><Field label={tr("Snapshot date")}><input name="snapshotDate" type="date" max={today} defaultValue={editing?.snapshot_date ?? today} required/></Field></div><Field label={tr("Note (optional)")}><input name="note" maxLength={500} defaultValue={editing?.note ?? ""} placeholder={tr("Broker statement, manual check…")}/></Field><div className="valuation-form-actions">{editing && <button type="button" className="ghost-button" onClick={() => setEditingId(null)}>{tr("Cancel edit")}</button>}<Submit busy={busy} label={editing ? tr("Save snapshot changes") : tr("Add value snapshot")}/></div></form><div className="valuation-history"><div className="section-heading compact"><div><p>{tr("VALUATION HISTORY")}</p><h3>{snapshots.length ? `${snapshots.length} manual ${snapshots.length === 1 ? "snapshot" : "snapshots"}` : tr("No snapshots yet")}</h3></div></div>{snapshots.map((snapshot, index) => <article key={snapshot.id}><span><strong>{formatMoney(snapshot.value_cents, currency, 2, locale)}</strong><small>{shortDate(snapshot.snapshot_date, locale)}{index === 0 ? " · Latest" : ""}{snapshot.note ? ` · ${snapshot.note}` : ""}</small></span><span><button type="button" className="text-link" disabled={busy} onClick={() => setEditingId(snapshot.id)}>{tr("Edit")}</button><button type="button" className="delete-snapshot" disabled={busy} onClick={() => remove(snapshot)}>{tr("Delete")}</button></span></article>)}{snapshots.length === 0 && <EmptyMini text={tr("Add the value from a statement or broker screen whenever you want to refresh the estimate.")} />}</div></DialogFrame></div>;
}

export function FinanceModal({ name, context, busy, error, close, save }: { name: Exclude<ModalName, null>; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
 const { t: tr, locale } = useTranslation();

  const [planType, setPlanType] = useState<"recurring" | "installment">("recurring");
  const [accountType, setAccountType] = useState("bank");
  const [transactionType, setTransactionType] = useState("expense");
  const [recurringType, setRecurringType] = useState("expense");
  const [recurringFrequency, setRecurringFrequency] = useState("weekly");
  const [installmentCount, setInstallmentCount] = useState(3);
  const [installmentTotal, setInstallmentTotal] = useState("");
  const [spareEnabled, setSpareEnabled] = useState(context.profile.spare_enabled === 1);
  const [autoSweepEnabled, setAutoSweepEnabled] = useState(context.profile.spare_auto_sweep_threshold_cents > 0);
  const [goalAccountId, setGoalAccountId] = useState("");
  const [goalTrackingMode, setGoalTrackingMode] = useState<Goal["tracking_mode"]>("total");

  function submit(action: string, transform?: (values: Record<string, FormDataEntryValue>) => Record<string, unknown>) {
    return async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await save(action, transform ? transform(values) : values);
    };
  }

  const moving = ["transfer", "saving", "investment"].includes(transactionType);
  const activeCategories = context.categories.filter((category) => category.archived !== 1);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>{error && <p className="modal-error" role="alert">{tr(error)}</p>}
    {name === "transaction" && <><ModalTitle eyebrow={tr("MANUAL ENTRY")} title={tr("Add a transaction")} copy={tr("One entry updates every relevant balance and budget window.")}/><form onSubmit={submit("addTransaction", (values) => ({ ...values, type: transactionType, committed: values.committed === "on", excludeFromSpare: values.excludeFromSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="segmented transaction-types">{["expense", "income", "transfer", "saving", "investment"].map((type) => <button type="button" className={transactionType === type ? "active" : ""} key={type} onClick={() => setTransactionType(type)}>{tr(typeLabel(type))}</button>)}</div><div className="transaction-amount"><Field label={tr("Amount")}><input name="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"/></Field></div><Field label={tr("Description")}><input name="description" required placeholder={transactionType === "income" ? tr("Salary") : tr("What was it?")}/></Field><div className="form-grid transaction-details"><Field label={tr("Date")}><input name="date" type="date" max={context.today} defaultValue={context.today} required/></Field>{!moving && <Field label={tr("Category")}><select name="categoryId" defaultValue=""><option value="">{tr("Uncategorised")}</option>{context.categories.filter((category) => category.kind === (transactionType === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}</div><Field label={moving ? tr("From account") : tr("Account")}><select name="accountId" key={transactionType} defaultValue={transactionType === "expense" ? defaultExpenseAccountId(context.accounts, context.profile.default_expense_account_id) : undefined} required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {formatMoney(account.balance_cents, account.currency, 2, locale)}</option>)}</select></Field>{moving && <Field label={tr("To account")}><select name="destinationAccountId" required defaultValue=""><option value="" disabled>{tr("Choose destination")}</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>}{context.planning !== false && ["expense", "saving", "investment"].includes(transactionType) && <label className="single-check"><input type="checkbox" name="excludeFromBudget"/>  {tr("Exclude from budget — still updates account balances and spending history")}</label>}{transactionType === "expense" && <div className="check-stack">{context.planning !== false && !context.adaptivePlan && <label><input type="checkbox" name="committed"/>  {tr("Spread its weight over the period")}</label>}<label><input type="checkbox" name="excludeFromSpare"/>  {tr("Exclude from spare change")}</label></div>}<Submit busy={busy} label={tr("Save transaction")}/></form></>}
    {name === "account" && <><ModalTitle eyebrow={tr("CUSTOM ACCOUNT")} title={tr("Add where your money lives")} copy={tr("Opening balances create a snapshot—not fake income.")}/><form onSubmit={submit("addAccount", (values) => ({ ...values, includeSpendable: values.includeSpendable === "on" }))}><Field label={tr("Account name")}><input name="name" required placeholder={tr("Holiday cash, Revolut, Trading 212…")}/></Field><div className="form-grid"><Field label={tr("Type")}><select name="type" value={accountType} onChange={(event) => setAccountType(event.target.value)}>{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{tr(typeLabel(type))}</option>)}</select></Field><Field label={accountType === "credit" ? tr("Amount owed now") : tr("Current balance")}><input name="balance" type="number" step="0.01" required placeholder="0.00"/></Field></div><p className="v3-note">{accountType === "credit" ? tr("Enter what you owe on the card. Use a minus sign if the card is in credit.") : tr("Use a minus sign if the account is overdrawn.")}</p><Field label={tr("Credit limit (optional)")}><input name="creditLimit" type="number" min="0" step="0.01" placeholder="0.00"/></Field><Field label={tr("Account color")}><ColorPicker defaultValue="#1f5b4e"/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked/>  {tr("Include this balance in available-to-spend money")}</label><Submit busy={busy} label={tr("Add account")}/></form></>}
    {name === "category" && <><ModalTitle eyebrow={tr("CUSTOM CATEGORY")} title={tr("Create your own label")} copy={tr("Categories organise reports without forcing category budgets.")}/><form onSubmit={submit("addCategory")}><Field label={tr("Category name")}><input name="name" required placeholder={tr("Pets, Side work, Coffee…")}/></Field><ChoiceField label={tr("Type")} name="kind" defaultValue="expense" options={[{value:"expense",label:tr("Expense")},{value:"income",label:tr("Income")}]}/><Field label={tr("Color")}><ColorPicker defaultValue="#cfe9d7"/></Field><Submit busy={busy} label={tr("Add category")}/></form></>}
    {name === "week" && <><ModalTitle eyebrow={tr("CALENDAR WEEKS")} title={tr("Choose when your week starts")} copy={tr("The weekly view simply adds the daily allocations that fall inside this calendar week.")}/><form onSubmit={submit("updateWeekStart")}><Field label={tr("First day of the week")}><select name="weekStart" defaultValue={context.profile.week_start}>{weekdayLabels.map((label, value) => <option value={value} key={tr(label)}>{tr(label)}</option>)}</select></Field><div className="budget-form-note"><span>7</span><p><strong>{tr("Changing this redraws the weekly view")}</strong><small>{tr("Transactions and daily allocations stay unchanged. Month-crossing weeks take each date’s allocation from its own month.")}</small></p></div><Submit busy={busy} label={tr("Save week start")}/></form></>}
    {name === "timezone" && <><ModalTitle eyebrow={tr("FINANCIAL CALENDAR")} title={tr("Choose your financial timezone")} copy={tr("This timezone defines today for budgets, resets, scheduled payments, and automatic reconciliation on every device.")}/><form onSubmit={submit("updateTimezone")}><Field label={tr("Timezone")}><select name="timezone" defaultValue={context.profile.timezone}>{Array.from(new Set([context.profile.timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><div className="budget-form-note"><span>◷</span><p><strong>{tr("One calendar across every device")}</strong><small>{tr("After saving, Remaivo immediately catches up through today in the new timezone before recalculating balances and budgets.")}</small></p></div><Submit busy={busy} label={tr("Save timezone")}/></form></>}
    {name === "plan" && <><ModalTitle eyebrow={tr("FUTURE MONEY")} title={tr("Add a plan")} copy={tr("Schedule a repeating item, one future payment, or a purchase split into installments.")}/><div className="segmented plan-switch"><button type="button" className={planType === "recurring" ? "active" : ""} onClick={() => setPlanType("recurring")}>{tr("Recurring")}</button><button type="button" className={planType === "installment" ? "active" : ""} onClick={() => setPlanType("installment")}>{tr("Pay later / installments")}</button></div>{planType === "recurring" ? <form onSubmit={submit("addRecurring", (values) => ({ ...values, type: recurringType, excludeFromBudget: values.excludeFromBudget === "on", autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label={tr("Plan name")}><input name="title" required placeholder={tr("Rent, salary, VWCE auto-invest…")}/></Field><div className="form-grid"><Field label={tr("Type")}><select name="type" value={recurringType} onChange={(event) => setRecurringType(event.target.value)}><option value="expense">{tr("Expense")}</option><option value="income">{tr("Income")}</option><option value="saving">{tr("Savings transfer")}</option><option value="investment">{tr("Auto-invest")}</option></select></Field><Field label={tr("Amount")}><input name="amount" type="number" min="0.01" step="0.01" required/></Field></div>{["expense", "income"].includes(recurringType) ? <Field label={tr("Category")}><select name="categoryId" defaultValue="" required><option value="" disabled>{tr("Choose category")}</option>{activeCategories.filter((category) => category.kind === recurringType).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field> : <input type="hidden" name="categoryId" value=""/>}{["saving","investment"].includes(recurringType) && <Field label={tr("Destination account")}><select name="destinationAccountId" required defaultValue=""><option value="" disabled>{tr("Choose destination")}</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label={tr("Payment account")}><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label={tr("Frequency")}><select name="frequency" value={recurringFrequency} onChange={(event) => setRecurringFrequency(event.target.value)}><option value="weekly">{tr("Weekly")}</option><option value="monthly">{tr("Monthly")}</option><option value="yearly">{tr("Yearly")}</option><option value="daily">{tr("Daily")}</option><option value="once">{tr("Once")}</option></select></Field>{recurringFrequency !== "once" && <Field label={tr("Every")}><input name="intervalCount" type="number" min="1" max="365" defaultValue={1} required/></Field>}</div><Field label={recurringFrequency === "once" ? tr("Due date") : tr("Next date")}><input name="nextDate" type="date" defaultValue={context.today} required/></Field><div className="check-stack">{context.planning === false ? <input type="hidden" name="committed" value="on"/> : <label><input type="checkbox" name="committed" defaultChecked/>  {tr("Protect upcoming payments in the plan")}</label>}<label><input type="checkbox" name="autoPost"/>  {tr("Add automatically when due")}</label></div>{context.planning !== false && recurringType!=="income"&&<label className="single-check"><input type="checkbox" name="excludeFromBudget"/> {tr("Exclude from budget — still updates account balances and spending history")}</label>}<p className="v3-note">{tr("Changes apply to future unpaid occurrences. Already posted transactions keep their budget setting.")}</p><Submit busy={busy} label={tr("Create recurring plan")}/></form> : <form onSubmit={submit("addInstallment", (values) => ({ ...values, total: installmentTotal, installmentCount, autoPost: values.autoPost === "on" }))}><Field label={tr("Purchase")}><input name="title" required placeholder={tr("Laptop, flights, furniture…")}/></Field><Field label={tr("Expense category")}><select name="categoryId" defaultValue="" required><option value="" disabled>{tr("Choose category")}</option>{activeCategories.filter((category) => category.kind === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label={tr("Total purchase")}><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min="0.01" step="0.01" required/></Field><Field label={tr("Number of payments")}><input value={installmentCount} onChange={(event) => setInstallmentCount(Number(event.target.value))} type="number" min="1" max="120" required/></Field></div><div className="installment-preview"><span>{Array.from({length: Math.min(6, installmentCount)}).map((_, index) => <i key={index} />)}</span><p>{installmentTotal ? installmentCount === 1 ? `${formatMoney(Math.round(Number(installmentTotal) * 100), context.currency, 2, locale)} due in one payment` : `About ${formatMoney(Math.round(Number(installmentTotal) * 100 / Math.max(1, installmentCount)), context.currency, 2, locale)} each` : tr("Enter a total to preview payments")}</p></div><div className="form-grid"><Field label={installmentCount === 1 ? tr("Payment due date") : tr("First installment")}><input name="firstDueDate" type="date" defaultValue={context.today} required/></Field><Field label={tr("Frequency")}><select name="frequency" disabled={installmentCount === 1}><option value="monthly">{tr("Monthly")}</option><option value="weekly">{tr("Weekly")}</option></select></Field></div>{installmentCount === 1 && <input type="hidden" name="frequency" value="monthly"/>}<Field label={tr("Repayment account")}><select name="paymentAccountId" required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label={tr("Provider label (optional)")}><input name="provider" placeholder={tr("Klarna, store finance…")}/></Field><Field label={tr("Linked credit account (optional)")}><select name="linkedCreditAccountId" defaultValue=""><option value="">{tr("Standalone plan")}</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="check-stack"><label><input type="checkbox" name="autoPost"/>  {tr("Mark payments paid automatically on their due date")}</label></div><Submit busy={busy} label={tr("Create pay-later plan")}/></form>}</>}
    {name === "spare" && <><ModalTitle eyebrow={tr("SPARE CHANGE")} title={tr("Automatic round-ups")} copy={tr("Choose the account whose purchases earn round-ups and where the swept money goes.")}/><form onSubmit={submit("updateSpare", (values) => ({ ...values, enabled: values.enabled === "on", autoSweep: values.autoSweep === "on" }))}>
      <label className="spare-toggle" htmlFor="spare-enabled-switch"><input id="spare-enabled-switch" type="checkbox" role="switch" name="enabled" checked={spareEnabled} onChange={(event) => setSpareEnabled(event.target.checked)}/><span className="spare-toggle-track" aria-hidden="true"><i /></span>{tr("Automatic round-ups")}<small>{spareEnabled ? tr("On for eligible expenses") : tr("Off — waiting change is kept")}</small></label>
      <div className="form-grid"><Field label={tr("Spending account")}><select name="sourceAccountId" defaultValue={context.profile.spare_source_id ?? ""} required={spareEnabled || autoSweepEnabled}><option value="">{tr("Choose spending account")}</option>{context.accounts.filter((account) => !["investment", "credit"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>
      <Field label={tr("Destination")}><select name="destinationAccountId" defaultValue={context.profile.spare_destination_id ?? ""} required={spareEnabled || autoSweepEnabled}><option value="">{tr("Choose savings or investment account")}</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div>
      <ChoiceField label={tr("Multiplier")} name="multiplier" defaultValue={context.profile.spare_multiplier} options={[1,2,3,4,5,6,8,10].map(value=>({value,label:`×${value}`}))}/>
      <label className="spare-toggle" htmlFor="spare-auto-sweep-switch"><input id="spare-auto-sweep-switch" type="checkbox" role="switch" name="autoSweep" checked={autoSweepEnabled} onChange={(event) => setAutoSweepEnabled(event.target.checked)}/><span className="spare-toggle-track" aria-hidden="true"><i /></span>{tr("Automatic sweeps")}<small>{autoSweepEnabled ? spareEnabled ? tr("Sweep when the threshold is reached") : tr("Configured — paused while round-ups are off") : tr("Sweep manually whenever you choose")}</small></label>
      {autoSweepEnabled && <><Field label={`Sweep threshold (${context.currency})`}><input name="autoSweepThreshold" type="number" min="0.01" step="0.01" defaultValue={(context.profile.spare_auto_sweep_threshold_cents || 500) / 100} required/></Field><p className="edit-hint">{tr("Sweeps the full waiting total when you save activity or Remaivo syncs, if the spending account can cover it. Saving these settings may sweep change already waiting. Round-ups off pauses automatic sweeps.")}</p></>}
      <p className="edit-hint">{tr("Only new expenses on this account collect round-ups, unless excluded on the transaction. Sweep debits this same account and moves the waiting amount to the destination. Turning this off keeps any amount already waiting.")}</p>
      <Submit busy={busy} label={tr("Save spare-change settings")}/>
    </form></>}
    {name === "goal" && <><ModalTitle eyebrow={tr("GOAL OR POT")} title={tr("Track purposeful money")} copy={tr("Link an account for automatic progress, or record dated progress manually. Investment tracking uses recorded cash, not market value.")}/><form onSubmit={submit("addGoal")}><Field label={tr("Name")}><input name="name" required placeholder={tr("Rainy day, Home deposit, VWCE…")}/></Field><div className="form-grid"><Field label={tr("Kind")}><select name="kind"><option value="savings">{tr("Savings")}</option><option value="investment">{tr("Raw investment")}</option></select></Field><Field label={tr("Target (optional)")}><input name="target" type="number" min="0" step="0.01"/></Field></div><Field label={tr("Linked account (optional)")}><select name="accountId" value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)}><option value="">{tr("Track independently")}</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><GoalTrackingFields mode={goalTrackingMode} setMode={setGoalTrackingMode} startDate={context.today}/>{!goalAccountId && goalTrackingMode === "total" && <Field label={tr("Opening tracked amount")}><input name="contributed" type="number" min="0" step="0.01" defaultValue="0"/></Field>}<Submit busy={busy} label={tr("Create goal")}/></form></>}
  </DialogFrame></div>;
}

export function EditModal({ target, context, busy, error, close, save }: { target: EditTarget; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
 const { t: tr, locale } = useTranslation();

  const [goalAccountId, setGoalAccountId] = useState(target.kind === "goal" ? target.record.account_id ?? "" : "");
  const [goalTrackingMode, setGoalTrackingMode] = useState<Goal["tracking_mode"]>(target.kind === "goal" ? target.record.tracking_mode ?? "total" : "total");
  const editingTransaction = target.kind === "transaction" ? target.record : null;
  const [correctionType, setCorrectionType] = useState(editingTransaction?.type || "expense");
  const transactionMoving = ["transfer", "saving", "investment"].includes(correctionType);
  const transactionCorrectable = editingTransaction ? !["installment_purchase", "installment_payment"].includes(editingTransaction.type) && !isLedgerType(editingTransaction.type) : false;
  const editingLedger = editingTransaction ? isLedgerType(editingTransaction.type) : false;
  const editingAccount = target.kind === "account" ? target.record : null;
  const [actualBalance, setActualBalance] = useState("");
  const balanceDifference = editingAccount && actualBalance !== "" ? Math.round(Number(actualBalance) * 100) * (editingAccount.type === "credit" ? -1 : 1) - editingAccount.balance_cents : 0;
  const correctionAccounts = editingTransaction
    ? Object.values(context.accountById).filter((account) => account.archived !== 1 || account.id === editingTransaction.account_id || account.id === editingTransaction.destination_account_id)
    : context.accounts;
  const correctionCategories = editingTransaction
    ? Object.values(context.categoryById).filter((category) => category.archived !== 1 || category.id === editingTransaction.category_id)
    : context.categories;
  const editingInstallment = target.kind === "installment" ? target.record : null;
  const editingRecurring = target.kind === "recurring" ? target.record : null;
  const [editFrequency, setEditFrequency] = useState(editingRecurring ? (isOncePlan(editingRecurring) ? "once" : editingRecurring.frequency) : "monthly");
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

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>{error && <p className="modal-error" role="alert">{tr(error)}</p>}
    {target.kind === "transaction" && <><ModalTitle eyebrow={tr("CORRECT TRANSACTION")} title={target.record.description} copy={transactionCorrectable ? tr("Remaivo reverses the original balance and budget effects, then posts this corrected replacement with an audit link.") : editingLedger ? tr("Opening balances and adjustments only set where money sits. To fix one, use Update balance on the account; Remaivo records the difference as a new adjustment.") : tr("This entry belongs to a pay-later plan, so its accounting details must be corrected from that plan.")}/>{transactionCorrectable ? <form onSubmit={submit("correctTransaction", (values) => ({ ...values, transactionId: target.record.id, type: correctionType, committed: values.committed === "on", excludeFromSpare: values.excludeFromSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="correction-note"><span>↻</span><p><strong>{tr("The original is never erased")}</strong><small>{tr("It becomes a corrected audit entry while this replacement becomes the active transaction.")}</small></p></div><Field label={tr("Transaction type")}><select value={correctionType} onChange={event => setCorrectionType(event.target.value)}>{["expense", "income", "transfer", "saving", "investment"].map(type => <option key={type} value={type}>{tr(typeLabel(type))}</option>)}</select></Field>{correctionType !== target.record.type && <p className="v3-note">{tr("The original entry will be reversed and replaced with this type. Existing bucket assignments will be cleared. Linked plan payments and completed spare-change sweeps cannot change type.")}</p>}<Field label={tr("Description")}><input name="description" defaultValue={target.record.description} required/></Field><div className="form-grid"><Field label={tr("Correct amount")}><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field><Field label={tr("Date")}><input name="date" type="date" defaultValue={target.record.date} required/></Field></div><Field label={transactionMoving ? tr("From account") : tr("Account")}><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>{tr("Choose account")}</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>{transactionMoving && <Field label={tr("To account")}><select name="destinationAccountId" defaultValue={target.record.destination_account_id ?? ""} required><option value="" disabled>{tr("Choose destination")}</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>}{!transactionMoving && <Field label={tr("Category")}><select name="categoryId" key={correctionType} defaultValue={correctionType === target.record.type ? target.record.category_id ?? "" : ""}><option value="">{tr("Uncategorised")}</option>{correctionCategories.filter((category) => category.kind === (correctionType === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.archived ? "Archived · " : ""}{category.name}</option>)}</select></Field>}{["expense", "saving", "investment"].includes(correctionType) && (context.planning === false ? correctionType === target.record.type && target.record.counts_monthly === 0 && <input type="hidden" name="excludeFromBudget" value="on"/> : <label className="single-check"><input type="checkbox" name="excludeFromBudget" key={correctionType} defaultChecked={correctionType === target.record.type && target.record.counts_monthly === 0}/>  {tr("Exclude from budget — still updates account balances and spending history")}</label>)}{correctionType === "expense" && <div className="check-stack">{context.adaptivePlan || context.planning === false ? target.record.committed === 1 && <input type="hidden" name="committed" value="on"/> : <label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/>  {tr("Spread its weight over the period")}</label>}<label><input type="checkbox" name="excludeFromSpare" defaultChecked={target.record.spare_excluded === 1}/>  {tr("Exclude from spare change")}</label></div>}<Submit busy={busy} label={tr("Post corrected transaction")}/></form> : <div className="locked-summary"><span>{formatMoney(target.record.amount_cents, context.currency, 2, locale)}</span><small>{editingLedger ? tr("Never counted as income, spending or budget activity.") : tr("Open Plans and correct the linked purchase or remaining payment schedule there.")}</small></div>}</>}

    {target.kind === "account" && <><ModalTitle eyebrow={tr("EDIT ACCOUNT")} title={target.record.name} copy={tr("Edit how this account is described and counted. Use transactions whenever its balance changes.")}/><form onSubmit={submit("updateAccount", (values) => ({ ...values, accountId: target.record.id, includeSpendable: values.includeSpendable === "on" }))}><div className="locked-summary"><span>{formatMoney(target.record.balance_cents, target.record.currency, 2, locale)}</span><small>{tr("Current balance · changed only by transactions")}</small></div><Field label={tr("Account name")}><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label={tr("Type")}><select name="type" defaultValue={target.record.type}>{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{tr(typeLabel(type))}</option>)}</select></Field><Field label={tr("Credit limit (optional)")}><input name="creditLimit" type="number" min="0" step="0.01" defaultValue={(target.record.credit_limit_cents ?? 0) / 100}/></Field></div><Field label={tr("Account color")}><ColorPicker defaultValue={target.record.color}/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked={target.record.include_spendable === 1}/>  {tr("Include this balance in available-to-spend money")}</label><Submit busy={busy} label={tr("Save account details")}/></form>{target.record.type === "investment" ? <p className="balance-update-note">{tr("Record market value changes as value snapshots. Investment balances are not adjusted directly.")}</p> : <form className="balance-update" onSubmit={submit("adjustBalance", (values) => ({ ...values, accountId: target.record.id }))}><strong>{tr("Update balance")}</strong><small>{tr("Enter what your bank shows. Remaivo records the difference as a balance adjustment, never as income, spending or budget activity.")}</small><div className="form-grid"><Field label={target.record.type === "credit" ? tr("Amount owed now") : tr("Actual balance now")}><input name="balance" type="number" step="0.01" value={actualBalance} onChange={(event) => setActualBalance(event.target.value)} required/></Field><Field label={tr("Date")}><input name="date" type="date" max={context.today} defaultValue={context.today} required/></Field></div><div className="balance-update-action"><span>{balanceDifference ? `${tr("Adjustment")} ${balanceDifference > 0 ? "+" : "−"}${formatMoney(Math.abs(balanceDifference), target.record.currency, 2, locale)}` : tr("Matches Remaivo")}</span><button type="submit" className="ghost-button" disabled={busy || !balanceDifference}>{tr("Record adjustment")}</button></div></form>}<ArchiveAction busy={busy} label={tr("Archive account")} onClick={() => archive("archiveAccount", "accountId", target.record.id, target.record.name)} /></>}

    {target.kind === "category" && <><ModalTitle eyebrow={tr("EDIT CATEGORY")} title={target.record.name} copy={tr("Renaming keeps existing transaction links intact. Archive it when you no longer want it available for new entries.")}/><form onSubmit={submit("updateCategory", (values) => ({ ...values, categoryId: target.record.id }))}><Field label={tr("Category name")}><input name="name" defaultValue={target.record.name} required/></Field><ChoiceField label={tr("Type")} name="kind" defaultValue={target.record.kind} options={[{value:"expense",label:tr("Expense")},{value:"income",label:tr("Income")}]}/><Field label={tr("Color")}><ColorPicker defaultValue={target.record.color}/></Field><Submit busy={busy} label={tr("Save category")}/></form><ArchiveAction busy={busy} label={tr("Archive category")} onClick={() => archive("archiveCategory", "categoryId", target.record.id, target.record.name)} /></>}

    {target.kind === "recurring" && <><ModalTitle eyebrow={tr("EDIT RECURRING PLAN")} title={target.record.title} copy={`This remains a ${typeLabel(target.record.type).toLowerCase()} plan. Update its category, amount, timing, account, and automation whenever the real arrangement changes.`}/><form onSubmit={submit("updateRecurring", (values) => ({ ...values, planId: target.record.id, excludeFromBudget: values.excludeFromBudget === "on", anchorDay: values.nextDate === target.record.next_date ? target.record.anchor_day : Number(String(values.nextDate).slice(8, 10)), autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label={tr("Plan name")}><input name="title" defaultValue={target.record.title} required/></Field>{["expense", "income"].includes(target.record.type) && <Field label={tr("Category")}><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>{tr("Choose category")}</option>{context.categories.filter((category) => category.kind === target.record.type && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}<div className="form-grid"><Field label={tr("Amount")}><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field>{["saving","investment"].includes(target.record.type) && <Field label={tr("Destination account")}><select name="destinationAccountId" required defaultValue={target.record.destination_account_id||""}><option value="" disabled>{tr("Choose destination")}</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label={tr("Payment account")}><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>{tr("Choose account")}</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="form-grid"><Field label={tr("Frequency")}><select name="frequency" value={editFrequency} onChange={(event) => setEditFrequency(event.target.value)}><option value="daily">{tr("Daily")}</option><option value="weekly">{tr("Weekly")}</option><option value="monthly">{tr("Monthly")}</option><option value="yearly">{tr("Yearly")}</option><option value="once">{tr("Once")}</option></select></Field>{editFrequency !== "once" && <Field label={tr("Every")}><input name="intervalCount" type="number" min="1" max="365" defaultValue={target.record.interval_count} required/></Field>}</div><Field label={editFrequency === "once" ? tr("Due date") : tr("Next date")}><input name="nextDate" type="date" defaultValue={target.record.next_date} required/></Field>{["monthly", "yearly"].includes(editFrequency) && target.record.anchor_day >= 29 && <div className="budget-form-note"><span>31</span><p><strong>{tr("Short months use their final day")}</strong><small>{tr("The plan returns to day")} {target.record.anchor_day}  {tr("whenever that day exists again.")}</small></p></div>}<div className="check-stack">{context.planning === false ? target.record.committed === 1 && <input type="hidden" name="committed" value="on"/> : <label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/>  {tr("Reserve before calculating spendable money")}</label>}<label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/>  {tr("Add automatically when due")}</label></div>{target.record.type!=="income"&&(context.planning === false ? target.record.counts_monthly===0 && <input type="hidden" name="excludeFromBudget" value="on"/> : <label className="single-check"><input type="checkbox" name="excludeFromBudget" defaultChecked={target.record.counts_monthly===0}/> {tr("Exclude from budget — still updates account balances and spending history")}</label>)}<p className="v3-note">{tr("Changes apply to future unpaid occurrences. Already posted transactions keep their budget setting.")}</p><Submit busy={busy} label={tr("Save recurring plan")}/></form><ArchiveAction busy={busy} label={tr("Archive recurring plan")} onClick={() => archive("archiveRecurring", "planId", target.record.id, target.record.title)} /></>}


    {target.kind === "installment" && <><ModalTitle eyebrow={tr("CORRECT PAY-LATER PLAN")} title={target.record.title} copy={paidInstallments.length ? tr("Paid entries stay locked. Change the category or plan total and rebuild only the unpaid schedule.") : tr("Nothing has been paid yet, so the category, full amount, and payment schedule can be corrected safely.")}/><form onSubmit={submit("updateInstallmentPlan", (values) => ({ ...values, planId: target.record.id, total: installmentTotal, remainingCount: installmentRemainingCount, nextDueDate: installmentNextDue, frequency: installmentFrequency, autoPost: values.autoPost === "on" }))}>{paidInstallments.length > 0 && <div className="locked-summary"><span>{formatMoney(target.record.paid_cents, context.currency, 2, locale)}  {tr("already paid")}</span><small>{paidInstallments.length} {paidInstallments.length === 1 ? "payment stays" : "payments stay"}  {tr("untouched · only")} {formatMoney(installmentRemainingCents, context.currency, 2, locale)}  {tr("is rescheduled")}</small></div>}<Field label={tr("Purchase")}><input name="title" defaultValue={target.record.title} required/></Field><Field label={tr("Expense category")}><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>{tr("Choose category")}</option>{context.categories.filter((category) => category.kind === "expense" && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label={tr("Correct total")}><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min={(target.record.paid_cents + 1) / 100} step="0.01" required/></Field><Field label={paidInstallments.length ? tr("Remaining payments") : tr("Number of payments")}><input value={installmentRemainingCount} onChange={(event) => setInstallmentRemainingCount(Number(event.target.value))} type="number" min="1" max={Math.max(1, 120 - paidInstallments.length)} required/></Field></div><div className="installment-preview"><span>{Array.from({ length: Math.min(6, installmentRemainingCount) }).map((_, index) => <i key={index} />)}</span><p>{installmentRemainingCents ? `About ${formatMoney(Math.round(installmentRemainingCents / Math.max(1, installmentRemainingCount)), context.currency, 2, locale)} per remaining payment` : tr("Enter a total above the paid amount")}</p></div><div className="form-grid"><Field label={paidInstallments.length ? tr("Next unpaid date") : tr("First payment date")}><input value={installmentNextDue} onChange={(event) => setInstallmentNextDue(event.target.value)} type="date" required/></Field><Field label={tr("Frequency")}><select value={installmentFrequency} onChange={(event) => setInstallmentFrequency(event.target.value)}><option value="monthly">{tr("Monthly")}</option><option value="weekly">{tr("Weekly")}</option></select></Field></div><div className="form-grid"><Field label={tr("Provider label (optional)")}><input name="provider" defaultValue={target.record.provider ?? ""} placeholder={tr("Klarna, store finance…")}/></Field><Field label={tr("Repayment account")}><select name="paymentAccountId" defaultValue={target.record.payment_account_id} required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><Field label={tr("Linked credit account (optional)")}><select name="linkedCreditAccountId" defaultValue={target.record.linked_credit_account_id ?? ""}><option value="">{tr("Standalone plan")}</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="check-stack"><label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/>  {tr("Mark payments paid automatically on their due date")}</label></div><Submit busy={busy} label={paidInstallments.length ? tr("Rebuild unpaid schedule") : tr("Save corrected plan")}/></form><ArchiveAction busy={busy} label={tr("Archive pay-later plan")} onClick={() => archive("archiveInstallmentPlan", "planId", target.record.id, target.record.title)} /></>}

    {target.kind === "goal" && <><ModalTitle eyebrow={tr("EDIT GOAL OR POT")} title={target.record.name} copy={tr("Choose how progress is counted. Switching to New money captures a fresh starting point; later edits to the name or target keep it.")}/><form onSubmit={submit("updateGoal", (values) => ({ ...values, goalId: target.record.id }))}><Field label={tr("Name")}><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label={tr("Kind")}><select name="kind" defaultValue={target.record.kind}><option value="savings">{tr("Savings")}</option><option value="investment">{tr("Raw investment")}</option></select></Field><Field label={tr("Target (optional)")}><input name="target" type="number" min="0" step="0.01" defaultValue={(target.record.target_cents ?? 0) / 100}/></Field></div><Field label={tr("Linked account (optional)")}><select name="accountId" value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)}><option value="">{tr("Track independently")}</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><GoalTrackingFields mode={goalTrackingMode} setMode={setGoalTrackingMode} startDate={target.record.start_date ?? context.today} endDate={target.record.end_date}/>{!goalAccountId && goalTrackingMode === "total" && <Field label={tr("Opening tracked amount")}><input name="contributed" type="number" min="0" step="0.01" defaultValue={target.record.contributed_cents / 100}/></Field>}{!goalAccountId && <p className="edit-hint">{tr("Use Record progress on this goal for dated additions or removals. Manual entries never move money between accounts.")}</p>}<Field label={tr("Pot color")}><ColorPicker defaultValue={target.record.color}/></Field><Submit busy={busy} label={tr("Save goal")}/></form><ArchiveAction busy={busy} label={tr("Archive goal")} onClick={() => archive("archiveGoal", "goalId", target.record.id, target.record.name)} /></>}
  </DialogFrame></div>;
}

function ArchiveAction({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
 const { t: tr } = useTranslation();

  return <div className="archive-zone"><span><strong>{tr("Remove from active views")}</strong><small>{tr("History stays in your Remaivo data.")}</small></span><button type="button" disabled={busy} onClick={onClick}>{tr(label)}</button></div>;
}

function ModalTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
 const { t: tr } = useTranslation();
 const icon = /ACCOUNT|VALUATION/.test(eyebrow) ? "account" : /GOAL|POT/.test(eyebrow) ? "goal" : /CATEGORY/.test(eyebrow) ? "category" : /SPARE/.test(eyebrow) ? "spare" : /ENTRY|TRANSACTION/.test(eyebrow) ? "entry" : "plan"; return <DialogHeading icon={icon} title={title} copy={tr(copy)}/> }
function EmptyMini({ text }: { text: string }) {
 const { t: tr } = useTranslation();
 return <p className="empty-mini">{tr(text)}</p> }
function EmptyState({ title, copy }: { title: string; copy: string }) {
 const { t: tr } = useTranslation();
 return <div className="empty-state"><span>＋</span><strong>{title}</strong><p>{tr(copy)}</p></div> }

export function Onboarding({ displayName, busy, error, onComplete }: { displayName: string; busy: boolean; error?: string; onComplete: (payload: Record<string, unknown>) => Promise<boolean> }) {
 const { t: tr } = useTranslation();

  const { language } = useTranslation();
  const [step, setStep] = useState(0);
  const [currency, setCurrency] = useState("EUR");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [accounts, setAccounts] = useState([{ id: crypto.randomUUID(), name: defaultAccountName[nameLanguage(language)], type: "bank", balance: "", includeSpendable: true, color: "#1f5b4e" }]);
  const [weekStart, setWeekStart] = useState(1);
  const [planning, setPlanning] = useState(true);
  const [plan, setPlan] = useState({ target: "1200", period: "monthly", payday: "25", anchor: "", allocation: "adaptive", carry: "none", carryCap: "0", weights: [1, 1, 1, 1, 1, 1.4, 1.4] });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const updatePlan = (change: Partial<typeof plan>) => setPlan((current) => ({ ...current, ...change }));
  const periodLabels: Record<string, string> = { monthly: "Calendar month", payday: "Payday to payday", weekly: "Every 7 days", fortnightly: "Every 14 days" };

  // The suggested first account name follows the language chosen on the first step.
  const shownName = (name: string) => otherNames(defaultAccountName, nameLanguage(language)).includes(name) ? defaultAccountName[nameLanguage(language)] : name;
  function updateAccount(id: string, key: string, value: string | boolean) { setAccounts((items) => items.map((item) => item.id === id ? { ...item, [key]: value } : item)); }
  async function finish() { await onComplete({ language, currency, timezone, weekStart, accounts: accounts.map((account) => ({ ...account, name: shownName(account.name) })), planning, plan: { ...plan, target: planning ? plan.target : "0", anchor: plan.anchor || today } }); }
  return <main className="onboarding-screen"><aside className="onboarding-aside"><div className="brand-mark"><span className="remaivo-logo-mark" aria-hidden="true" /><strong>{tr("Remaivo")}</strong></div><div><p className="eyebrow">{tr("YOUR OPENING SNAPSHOT")}</p><h1>{tr("Start where your money is today.")}</h1><p>{tr("No fake income. No starting from zero. Add what already exists, then Remaivo takes it from here.")}</p></div><ol>{[tr("Basics"), tr("Accounts"), tr("Plan"), tr("Review")].map((label, index) => <li className={step === index ? "active" : step > index ? "done" : ""} key={tr(label)}><span>{step > index ? "✓" : index + 1}</span>{tr(label)}</li>)}</ol><small>{tr("Signed in as")} {displayName}</small></aside><section className="onboarding-main">
    {step === 0 && <div className="setup-panel"><p className="eyebrow">{tr("WELCOME,")} {displayName.split(" ")[0].toUpperCase()}</p><h2>{tr("Let’s set your financial starting line.")}</h2><p>{tr("Choose the few basics Remaivo needs to organise every amount correctly.")}</p><div className="setup-form"><LanguageSelect/><Field label={tr("Primary currency")}><select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="EUR">{tr("Euro · EUR")}</option><option value="USD">{tr("US dollar · USD")}</option><option value="GBP">{tr("British pound · GBP")}</option></select></Field><Field label={tr("Financial timezone")}><select value={timezone} onChange={(event) => { setTimezone(event.target.value); }}>{Array.from(new Set([timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><Field label={tr("First day of the week")}><select value={weekStart} onChange={(event) => setWeekStart(Number(event.target.value))}>{weekdayLabels.map((label, value) => <option value={value} key={label}>{tr(label)}</option>)}</select></Field><div className="setup-note"><span>✓</span><p><strong>{tr("This date is not income.")}</strong><small>{tr("Opening balances stay out of spending and income reports. Your timezone controls every financial calendar date.")}</small></p></div></div></div>}
    {step === 1 && <div className="setup-panel wide"><p className="eyebrow">{tr("FINANCIAL ACCOUNTS")}</p><h2>{tr("Add where your money already lives.")}</h2><p>{tr("Include spending, savings, cash, raw investments, or credit. You can add custom accounts later.")}</p><div className="setup-accounts">{accounts.map((account, index) => <article key={account.id}><span className="setup-account-number">{index + 1}</span><input aria-label={tr("Account name")} value={shownName(account.name)} onChange={(event) => updateAccount(account.id, "name", event.target.value)} placeholder={tr("Account name")}/><select aria-label={tr("Account type")} value={account.type} onChange={(event) => { const type = event.target.value; updateAccount(account.id, "type", type); updateAccount(account.id, "includeSpendable", !["savings", "investment", "credit"].includes(type)); }}><option value="bank">{tr("Bank")}</option><option value="savings">{tr("Savings")}</option><option value="cash">{tr("Cash")}</option><option value="credit">{tr("Credit")}</option><option value="investment">{tr("Investment")}</option><option value="wallet">{tr("Wallet")}</option><option value="custom">{tr("Custom")}</option></select><label><span>{account.type === "credit" ? `${tr("Owed")} ${currency}` : currency}</span><input aria-label={account.type === "credit" ? tr("Amount owed now") : tr("Opening balance")} type="number" step="0.01" value={account.balance} onChange={(event) => updateAccount(account.id, "balance", event.target.value)} placeholder="0.00"/></label>{accounts.length > 1 && <button aria-label={tr("Remove account")} onClick={() => setAccounts((items) => items.filter((item) => item.id !== account.id))}>×</button>}</article>)}<button className="add-account-line" onClick={() => setAccounts((items) => [...items, { id: crypto.randomUUID(), name: "", type: "bank", balance: "", includeSpendable: true, color: ["#d68b64", "#4c8b98", "#705f83"][items.length % 3] }])}>{tr("＋ Add another account")}</button></div><div className="setup-note"><span>i</span><p><strong>{tr("Credit cards: enter what you owe.")}</strong><small>{tr("Use a minus sign for an overdrawn account, or for a card that is in credit.")}</small></p></div></div>}
    {step === 2 && <div className="setup-panel wide"><p className="eyebrow">{tr("YOUR PLAN")}</p><h2>{tr("Set up how you plan your spending.")}</h2><div className="setup-mode" role="radiogroup" aria-label={tr("How you use Remaivo")}>{([[true, "Track and plan", "Record money in and out, and plan what you spend each period."], [false, "Track only", "Record money in and out and follow your trends, without a spending plan."]] as const).map(([value, label, note]) => <button type="button" role="radio" aria-checked={planning === value} className={planning === value ? "active" : ""} key={label} onClick={() => setPlanning(value)}><strong>{tr(label)}</strong><small>{tr(note)}</small></button>)}</div>{planning ? <><p>{tr("Choose a spending target, the period it covers and how Remaivo paces it. You can change all of this later in Configure plan.")}</p><div className="setup-form">
      <Field label={tr("Spending target")}><input type="number" min="0" step="0.01" value={plan.target} onChange={(event) => updatePlan({ target: event.target.value })}/></Field><Field label={tr("Budget period")}><select value={plan.period} onChange={(event) => updatePlan({ period: event.target.value })}>{Object.entries(periodLabels).map(([value, label]) => <option value={value} key={value}>{tr(label)}</option>)}</select></Field>
      {plan.period === "payday" && <Field label={tr("Monthly payday")}><input type="number" min="1" max="31" value={plan.payday} onChange={(event) => updatePlan({ payday: event.target.value })}/></Field>}
      {["weekly", "fortnightly"].includes(plan.period) && <Field label={tr("Cycle anchor date")}><input type="date" max={today} value={plan.anchor || today} onChange={(event) => updatePlan({ anchor: event.target.value })}/></Field>}
      <Field label={tr("Everyday pacing")}><select value={plan.allocation} onChange={(event) => updatePlan({ allocation: event.target.value, ...(event.target.value === "adaptive" ? { carry: "none" } : {}) })}><option value="adaptive">{tr("Adaptive · redistribute what remains")}</option><option value="even">{tr("Even · equal calendar slices")}</option><option value="weighted">{tr("Weighted · set your weekday rhythm")}</option></select></Field>
      {plan.allocation === "weighted" && <div className="setup-weights">{[tr("Sun"), tr("Mon"), tr("Tue"), tr("Wed"), tr("Thu"), tr("Fri"), tr("Sat")].map((day, index) => <Field key={day} label={day}><input type="number" min="0.1" max="10" step="0.1" value={plan.weights[index]} onChange={(event) => updatePlan({ weights: plan.weights.map((weight, position) => position === index ? Number(event.target.value) : weight) })}/></Field>)}</div>}
      {plan.allocation !== "adaptive" && <><Field label={tr("Carry inside this period")}><select value={plan.carry} onChange={(event) => updatePlan({ carry: event.target.value })}><option value="none">{tr("None")}</option><option value="positive">{tr("Positive only")}</option><option value="signed">{tr("Surplus and deficit")}</option><option value="capped">{tr("Capped positive")}</option></select></Field>{plan.carry === "capped" && <Field label={tr("Carry cap")}><input type="number" min="0" step="0.01" value={plan.carryCap} onChange={(event) => updatePlan({ carryCap: event.target.value })}/></Field>}</>}
    </div><div className="stack-example"><span>7</span><p><strong>{tr("Today and Week are views of this Plan")}</strong><small>{tr("They are not separate budgets. Add buckets later for money with a purpose, such as fuel or groceries.")}</small></p></div></> : <p>{tr("You can turn on a spending plan at any time in Settings.")}</p>}</div>}
    {step === 3 && <div className="setup-panel"><p className="eyebrow">{tr("READY TO BEGIN")}</p><h2>{tr("Your opening snapshot is set.")}</h2><p>{tr(planning ? "Remaivo will create your current Plan and opening balances without counting them as new activity." : "Remaivo will record your opening balances without counting them as new activity.")}</p><div className="review-list"><div><span>◫</span><p><strong>{accounts.length}  {tr("financial")} {accounts.length === 1 ? "account" : "accounts"}</strong><small>{accounts.map((account) => shownName(account.name) || typeLabel(account.type)).join(" · ")}</small></p></div>{planning ? <div><span>◔</span><p><strong>{currency} {plan.target} · {tr(periodLabels[plan.period])}{plan.period === "payday" ? ` · ${tr("day")} ${plan.payday}` : ""}</strong><small>{tr(plan.allocation === "adaptive" ? "Adaptive everyday pacing" : plan.allocation === "weighted" ? "Weighted everyday pacing" : "Even everyday pacing")}</small></p></div> : <div><span>◔</span><p><strong>{tr("Track only")}</strong><small>{tr("No spending plan. Turn one on later in Settings.")}</small></p></div>}<div><span>☁</span><p><strong>{tr("Private cross-device space")}</strong><small>{tr("Protected by your Remaivo password")}</small></p></div></div></div>}
    {error && <p className="setup-error" role="alert">{tr(error)}</p>}
    <footer className="setup-actions"><button className="ghost-button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>{tr("Back")}</button>{step < 3 ? <button className="primary-button" onClick={() => setStep((value) => value + 1)}>{tr("Continue")} <span>→</span></button> : <button className="primary-button" disabled={busy} onClick={finish}>{busy ? tr("Creating your space…") : tr("Open Remaivo")}<span>→</span></button>}</footer>
  </section></main>;
}
