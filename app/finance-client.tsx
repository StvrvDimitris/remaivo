"use client";

import { CSSProperties, FormEvent, HTMLAttributes, useEffect, useState } from "react";
import { DialogFrame, DialogHeading, DialogSubmit as Submit, FormField as Field, ColorPicker, ChoiceField } from "./dialog-ui";
import { defaultExpenseAccountId } from "./expense-account";
import type { v3Snapshot } from "../db/v3";
import type { InvestmentValuationSnapshot, InvestmentValueMetrics } from "./investment-valuations";
import { AnalyticsFilterBar, analyticsRange, useAnalyticsFilters } from "./statistics-page";
import { financePageCacheGeneration, readFinancePageCache, writeFinancePageCache } from "./finance-page-cache";

export type Account = { id: string; name: string; type: string; currency: string; balance_cents: number; credit_limit_cents: number | null; color: string; include_spendable: number; archived: number };
export type Category = { id: string; name: string; kind: string; color: string; archived: number };
export type Transaction = { id: string; account_id: string | null; destination_account_id: string | null; category_id: string | null; type: string; description: string; amount_cents: number; date: string; committed: number; counts_monthly: number; recurring_plan_id: string | null; installment_plan_id: string | null; replaces_transaction_id: string | null; spare_change_cents: number; spare_excluded: number };
type RecurringPlan = { id: string; title: string; type: string; amount_cents: number; account_id: string | null; destination_account_id: string | null; category_id: string | null; frequency: string; interval_count: number; next_date: string; anchor_day: number; end_date?: string | null; auto_post: number; committed: number };
type InstallmentPlan = { id: string; title: string; provider: string | null; category_id: string | null; total_cents: number; paid_cents: number; installment_count: number; first_due_date: string; frequency: string; payment_account_id: string; linked_credit_account_id: string | null; auto_post: number; status: string };
type InstallmentPayment = { id: string; plan_id: string; sequence: number; due_date: string; amount_cents: number; status: string };
export type Goal = { id: string; name: string; kind: string; target_cents: number | null; contributed_cents: number; account_id: string | null; color: string; tracking_mode: "total" | "period" | "new_money"; start_date: string | null; end_date: string | null; baseline_cents: number; progress_cents: number };
export type GoalEntry = { id: string; goal_id: string; date: string; amount_cents: number; note: string | null; created_at: string };
type SpareEvent = { id: string; multiplied_cents: number };
type Profile = { default_expense_account_id?: string | null; ui_theme?: string; currency: string; week_start: number; timezone: string; spare_multiplier: number; spare_enabled: number; spare_source_id: string | null; spare_destination_id: string | null; spare_auto_sweep_threshold_cents: number; };
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

const carryLabels: Record<string, string> = {
  reset: "Reset",
  stack_unused: "Unused only",
  stack_signed: "Signed (underspend and overspend)",
};

const weekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const commonTimezones = [
  "UTC", "Europe/Athens", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Helsinki",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function formatMoney(cents: number, currency = "EUR", digits = 2) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function movementMoney(cents: number, currency: string) {
  return `${cents > 0 ? "+" : ""}${formatMoney(cents, currency)}`;
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

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(parseDate(value));
}

function goalDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(parseDate(value));
}

function GoalTrackingFields({ mode, setMode, startDate, endDate }: { mode: Goal["tracking_mode"]; setMode: (mode: Goal["tracking_mode"]) => void; startDate?: string | null; endDate?: string | null }) {
  return <><Field label="How to track progress"><select name="trackingMode" value={mode} onChange={(event) => setMode(event.target.value as Goal["tracking_mode"])}><option value="total">Total value now</option><option value="period">Net money added in a date range</option><option value="new_money">New money since goal start</option></select></Field>
    {mode === "period" && <div className="form-grid"><Field label="From"><input name="startDate" type="date" defaultValue={startDate ?? ""} required/></Field><Field label="Through"><input name="endDate" type="date" defaultValue={endDate ?? ""} required/></Field></div>}
    <p className="edit-hint">{mode === "total" ? "Counts the full current account balance, or the full manual tally when independent." : mode === "period" ? "Counts net account money in this date range, or dated manual entries when independent. Existing balances do not count." : "Captures the current balance or manual tally the first time you select it. Later net growth counts; ordinary edits keep that starting point."}</p>
  </>;
}

function typeLabel(type: string) {
  const labels: Record<string, string> = { bank: "Bank account", savings: "Savings", cash: "Cash", credit: "Credit", investment: "Investment", wallet: "Digital wallet", custom: "Custom", income: "Income", expense: "Expense", transfer: "Transfer", saving: "Saving", installment_payment: "Installment", installment_purchase: "Installment purchase" };
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

export type Context = { accounts: Account[]; categories: Category[]; transactions: Transaction[]; recurring: RecurringPlan[]; installmentPlans: InstallmentPlan[]; installmentPayments: InstallmentPayment[]; goals: Goal[]; goalEntries: GoalEntry[]; investmentSnapshots: InvestmentValuationSnapshot[]; investmentMetrics: Record<string, InvestmentValueMetrics>; profile: Profile; currency: string; accountById: Record<string, Account>; categoryById: Record<string, Category>; spendable: number; savings: number; rawInvested: number; invested: number; investmentMovement: number; investmentMovementPercent: number | null; totalBalance: number; outstandingInstallments: number; sparePot: number; today: string };

export function TransactionRow({ transaction, accountById, categoryById, currency, onEdit }: { transaction: Transaction; accountById: Record<string, Account>; categoryById: Record<string, Category>; currency: string; onEdit: () => void }) {
  const positive = transaction.type === "income";
  const neutral = ["transfer", "saving", "investment", "installment_purchase"].includes(transaction.type);
  return <div className="editable-record" {...editableProps(onEdit)}><span className="activity-icon" style={{ background: categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description.slice(0, 1).toUpperCase()}</span><span><strong>{transaction.description}</strong><small>{categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)} · {accountById[transaction.account_id ?? ""]?.name ?? "Plan"}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? " · Excluded from budget" : ""}{transaction.replaces_transaction_id ? " · Corrected" : ""}</small></span><b className={positive ? "income" : neutral ? "neutral" : ""}>{positive ? "+" : neutral ? "" : "−"}{formatMoney(transaction.amount_cents, currency)}</b></div>;
}

function Pager({ page, totalPages, total, pageSize, label, onPage }: { page: number; totalPages: number; total: number; pageSize: number; label: string; onPage: (page: number) => void }) {
  if (totalPages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return <nav className="pager" aria-label={`${label} pages`}><span>{first}–{last} of {total}</span><div><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={`Previous ${label} page`}>←</button><b>Page {page} of {totalPages}</b><button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label={`Next ${label} page`}>→</button></div></nav>;
}

export function TransactionsPage({ context, revision, onAdd, onEdit }: { context: Context; revision: number; onAdd: () => void; onEdit: (record: Transaction) => void }) {
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
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Unable to load transactions.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, description.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [accountId, categoryId, description, direction, origin, range.from, range.to, revision, sort, transactionPage, transactionType]);

  const changeSort = (value: TransactionSort) => {
    if (sort === value) setDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(value); setDirection(value === "description" || value === "account" ? "asc" : "desc"); }
    setTransactionPage(1);
  };
  const sortLabel = (value: TransactionSort, label: string) => `${label}${sort === value ? direction === "asc" ? " ↑" : " ↓" : ""}`;
  const items = result?.items ?? [];

  return <section className="page-card transaction-page"><AnalyticsFilterBar context={context} filters={filters} setFilters={(change, replace) => { setTransactionPage(1); setFilters(change, replace); }} action={<button className="ghost-button" onClick={onAdd}>＋ New transaction</button>} /><p className="edit-hint">Double-click or hold a transaction to edit it. Filters also apply to Insights.</p><div className={`transaction-table ${loading ? "is-loading" : ""}`} aria-busy={loading}><div className="table-head"><button onClick={() => changeSort("description")}>{sortLabel("description", "Transaction")}</button><button onClick={() => changeSort("date")}>{sortLabel("date", "Date")}</button><button onClick={() => changeSort("account")}>{sortLabel("account", "Account")}</button><button onClick={() => changeSort("amount")}>{sortLabel("amount", "Amount")}</button></div>{items.map((transaction) => <div className="table-row editable-record" {...editableProps(() => onEdit(transaction))} key={transaction.id}><span className="transaction-name"><i style={{ background: context.categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description[0]}</i><span><strong>{transaction.description}</strong><small>{context.categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)}{transaction.committed ? " · Committed" : ""}{["expense", "saving", "investment", "installment_payment"].includes(transaction.type) && transaction.counts_monthly === 0 ? " · Excluded from budget" : ""}{transaction.replaces_transaction_id ? " · Corrected" : ""}</small></span></span><span>{shortDate(transaction.date)}</span><span>{context.accountById[transaction.account_id ?? ""]?.name ?? "Plan"}</span><b className={transaction.type === "income" ? "income" : ""}>{transaction.type === "income" ? "+" : transaction.type === "expense" ? "−" : ""}{formatMoney(transaction.amount_cents, context.currency)}</b></div>)}{!loading && !loadError && items.length === 0 && <EmptyState title="No transactions found" copy="Try a broader date range, clear a filter, or add a transaction." />}{loadError && <EmptyState title="Transactions could not load" copy={loadError} />}</div>{result && <Pager page={result.page} totalPages={result.totalPages} total={result.total} pageSize={result.pageSize} label="transactions" onPage={setTransactionPage} />}</section>;
}

export function AccountsPage({ context, onAdd, onEdit, onSnapshot, onDefaultExpense, busy }: { onDefaultExpense: (account: Account) => void; busy: boolean; context: Context; onAdd: () => void; onEdit: (record: Account) => void; onSnapshot: (record: Account) => void }) {
  const defaultId = defaultExpenseAccountId(context.accounts, context.profile.default_expense_account_id);
  return <><section className="summary-strip"><div><p>Net balance</p><strong>{formatMoney(context.totalBalance, context.currency)}</strong></div><div><p>Available cash</p><strong>{formatMoney(context.spendable, context.currency)}</strong></div><div><p>Installment debt</p><strong>{formatMoney(context.outstandingInstallments, context.currency)}</strong></div></section><p className="edit-hint page-edit-hint">Double-click or hold an account to edit its details. Balance changes belong in transactions.</p><section className="accounts-grid">{context.accounts.map((account) => {
    const metrics = context.investmentMetrics[account.id];
    return <article className={`account-card editable-record ${metrics ? "investment-account-card" : ""}`} {...editableProps(() => onEdit(account))} key={account.id} style={{ "--account-color": account.color } as CSSProperties}><div className="account-card-top"><div className="account-type"><span className="account-icon">{account.type === "cash" ? "¤" : account.type === "investment" ? "↗" : account.type === "savings" ? "◇" : account.type === "credit" ? "▰" : "◫"}</span><span>{typeLabel(account.type)}</span></div><button type="button" className="account-expense-default" aria-pressed={defaultId === account.id} aria-label={defaultId === account.id ? `${account.name} is the default for expenses` : `Use ${account.name} as default for expenses`} disabled={busy || defaultId === account.id} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDefaultExpense(account); }}>{defaultId === account.id ? "✓ Default" : "Set default"}</button></div><h3>{account.name}</h3><strong>{formatMoney(account.balance_cents, account.currency)}</strong><small>{metrics ? "Raw / net amount invested" : account.include_spendable ? "Included in available money" : "Excluded from available money"}</small>{metrics && <div className="valuation-summary"><span><small>Estimated / current value</small><strong>{formatMoney(metrics.estimatedCurrentValue, account.currency)}</strong><em>{metrics.latestSnapshot ? `Snapshot ${formatMoney(metrics.latestSnapshot.value_cents, account.currency)} · ${shortDate(metrics.latestSnapshot.snapshot_date)}` : "No valuation snapshot yet"}</em></span><span className={`movement-pill ${movementTone(metrics.movement)}`}><b>{movementMoney(metrics.movement, account.currency)}</b><small>{movementPercent(metrics.movementPercent)}</small></span></div>}{metrics && <button className="snapshot-action" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSnapshot(account); }}>＋ Add value snapshot</button>}</article>;
  })}<button className="add-card" onClick={onAdd}><span>＋</span><strong>Add custom account</strong><small>Bank, cash, savings, credit, investment, or anything else.</small></button></section></>;
}

export function GoalsPage({ context, onGoal, onSpare, onSweep, onEdit, onRecord }: { context: Context; onGoal: () => void; onSpare: () => void; onSweep: () => void; onEdit: (record: Goal) => void; onRecord: (record: Goal) => void }) {
  const source = context.accountById[context.profile.spare_source_id ?? ""];
  const destination = context.accountById[context.profile.spare_destination_id ?? ""];
  const enabled = context.profile.spare_enabled === 1;
  const threshold = context.profile.spare_auto_sweep_threshold_cents || 0;
  return <div className="goals-page">
    <section className="spare-hero">
      <div>
        <p className="eyebrow">SPARE CHANGE · {enabled ? "ON" : "OFF"}</p>
        <h2>{formatMoney(context.sparePot, context.currency)} waiting</h2>
        <p>{enabled && source ? <>Expenses paid from {source.name} earn a ×{context.profile.spare_multiplier} round-up unless excluded.</> : <>No new round-ups are being collected.</>} {source && destination ? <>Sweep debits {source.name} and records the move to {destination.name}.</> : <>Choose a spending account and a destination in Configure.</>}</p>
        {threshold > 0 && <p className="spare-sweep-status">{enabled ? <>Auto sweep at {formatMoney(threshold, context.currency)}. {context.sparePot >= threshold && source && source.balance_cents < context.sparePot ? "Waiting for the spending account to cover the full amount." : "Checked when you save activity or Remaivo syncs."}</> : "Automatic sweeps are paused while round-ups are off."}</p>}
        <div className="spare-actions"><button className="primary-button" onClick={onSpare}><span>⚙</span>Configure</button><button className="ghost-button" disabled={!context.sparePot || !source || !destination} onClick={onSweep}>Sweep now</button></div>
      </div>
      <div className="spare-orbit"><span>{enabled ? "ON" : "OFF"}</span><small>{threshold > 0 ? "Automatic sweeps" : "Sweep manually"}</small></div>
    </section>
    <div className="section-heading goal-heading"><div><p>Savings & investing</p><h3>Your pots and contribution targets</h3><small className="edit-hint">Double-click or hold a pot to edit or archive it.</small></div><button className="ghost-button" onClick={onGoal}>＋ New goal</button></div>
    <section className="goal-grid">{context.goals.map((goal) => {
      const progress = goal.progress_cents ?? (goal.account_id ? context.accountById[goal.account_id]?.balance_cents ?? goal.contributed_cents : goal.contributed_cents);
      const percent = goal.target_cents ? Math.max(0, progress / goal.target_cents * 100) : 0;
      const mode = goal.tracking_mode ?? "total";
      const period = mode === "period" && goal.start_date && goal.end_date ? `${goalDate(goal.start_date)} – ${goalDate(goal.end_date)}` : mode === "new_money" ? `New money since ${goal.start_date ? goalDate(goal.start_date) : "goal start"}` : "Full value now";
      return <article className="editable-record" {...editableProps(() => onEdit(goal))} key={goal.id} style={{"--goal-color": goal.color.toLowerCase() === "#dff35f" ? "#12a16b" : goal.color} as CSSProperties}>
        <span className="goal-kind">{goal.kind === "investment" ? "Investing" : "Savings"} · {goal.account_id ? context.accountById[goal.account_id]?.name ?? "Linked account" : "Independent"}</span>
        <h3>{goal.name}</h3><p className="goal-period">{period}</p><strong>{formatMoney(progress, context.currency)}</strong>
        {goal.target_cents && <><small>of {formatMoney(goal.target_cents, context.currency)}</small><div className="wide-progress"><i style={{ width: `${Math.min(100, percent)}%` }} /></div><p>{Math.round(percent)}% complete</p></>}
        {!goal.account_id && <button type="button" className="goal-record-button" onClick={(event) => { event.stopPropagation(); onRecord(goal); }} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>＋ Record progress</button>}
      </article>;
    })}{context.goals.length === 0 && <button className="add-card" onClick={onGoal}><span>＋</span><strong>Create your first goal</strong><small>Track savings or raw investment contributions without market prices.</small></button>}</section>
  </div>;
}

export function GoalEntryModal({ goal, context, busy, error, close, save }: { goal: Goal; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<boolean> }) {
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
    if (!window.confirm(`Delete the ${goalDate(entry.date)} progress entry?`)) return;
    await save("deleteGoalEntry", { entryId: entry.id });
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>
    <ModalTitle eyebrow="INDEPENDENT GOAL" title={`Record progress · ${goal.name}`} copy="These entries track your goal only. They do not move money or change an account balance."/>{error && <p className="modal-error" role="alert">{error}</p>}
    {canRecord ? <form onSubmit={submit}><div className="form-grid"><Field label="Change"><select name="kind" defaultValue="add"><option value="add">Add progress</option><option value="remove">Remove progress</option></select></Field><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"/></Field></div><Field label="Date"><input name="date" type="date" min={earliest} max={latest} defaultValue={latest} required/></Field><Field label="Note (optional)"><input name="note" maxLength={200} placeholder="Deposit, adjustment…"/></Field><Submit busy={busy} label="Record progress"/></form> : <p className="edit-hint">This goal’s tracking period has not started yet. You can record progress once it begins.</p>}
    <div className="goal-entry-history"><h3>Recent progress</h3>{entries.length ? entries.map((entry) => <div key={entry.id}><span><strong>{entry.amount_cents >= 0 ? "+" : "−"}{formatMoney(Math.abs(entry.amount_cents), context.currency)}</strong><small>{goalDate(entry.date)}{entry.note ? ` · ${entry.note}` : ""}</small></span><button type="button" disabled={busy} onClick={() => void remove(entry)} aria-label={`Delete progress entry from ${goalDate(entry.date)}`}>Delete</button></div>) : <p className="edit-hint">No dated entries yet. The older opening amount, if any, is managed in Edit goal.</p>}</div>
  </DialogFrame></div>;
}

export function SettingsPage({ context, onCategory, onGoals, onWeek, onTimezone, onArchive, onEditCategory }: { context: Context; onCategory: () => void; onGoals: () => void; onWeek: () => void; onTimezone: () => void; onArchive: () => void; onEditCategory: (record: Category) => void }) {
  return <div className="settings-grid"><section className="page-card"><div className="section-heading"><div><p>CATEGORIES</p><h3>Custom income & expense labels</h3></div><button className="ghost-button" onClick={onCategory}>＋ Add category</button></div><p className="edit-hint">Double-click or hold a category to edit or archive it.</p><div className="category-cloud">{context.categories.filter(category => category.archived !== 1).map((category) => <span className="editable-record" {...editableProps(() => onEditCategory(category))} key={category.id} style={{ "--category-color": category.color } as CSSProperties}><i>{category.name[0]}</i>{category.name}<small>{category.kind}</small></span>)}</div></section><section className="page-card setting-stack"><header className="preferences-heading"><h3>Preferences</h3></header><div><span className="setting-icon">¤</span><span><strong>Currency</strong><small>Primary display and manual entry currency</small></span><b>{context.profile.currency}</b></div><button onClick={onTimezone}><span className="setting-icon">◷</span><span><strong>Financial timezone</strong><small>Controls today, due dates, resets, and automatic catch-up</small></span><b>{context.profile.timezone} →</b></button><button onClick={onGoals}><span className="setting-icon">◇</span><span><strong>Save & invest</strong><small>Goals, raw investments, and spare-change accelerator</small></span><b>→</b></button><button onClick={onWeek}><span className="setting-icon">7</span><span><strong>Week starts</strong><small>Calendar-week anchor for weekly and daily windows</small></span><b>{weekdayLabels[context.profile.week_start]} →</b></button><button onClick={onArchive}><span className="setting-icon">▤</span><span><strong>Archive manager</strong><small>Search and restore archived accounts, goals, categories and plans</small></span><b>Open</b></button><div><span className="setting-icon">☁</span><span><strong>Cross-device data</strong><small>Stored privately with your ChatGPT sign-in</small></span><b>Active</b></div></section></div>;
}

export function ValuationModal({ account, snapshots, currency, today, busy, close, save }: { account: Account; snapshots: InvestmentValuationSnapshot[]; currency: string; today: string; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<boolean> }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = snapshots.find((snapshot) => snapshot.id === editingId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const ok = await save(editing ? "updateInvestmentSnapshot" : "addInvestmentSnapshot", { ...values, accountId: account.id, snapshotId: editing?.id });
    if (ok) setEditingId(null);
  }

  async function remove(snapshot: InvestmentValuationSnapshot) {
    if (!window.confirm(`Delete the ${shortDate(snapshot.snapshot_date)} valuation snapshot? This will not delete any transaction.`)) return;
    const ok = await save("deleteInvestmentSnapshot", { snapshotId: snapshot.id });
    if (ok && editingId === snapshot.id) setEditingId(null);
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card valuation-modal" currency={currency} close={close}><ModalTitle eyebrow="MANUAL INVESTMENT VALUATION" title={account.name} copy="A snapshot records portfolio value only. It never creates a transaction or changes raw invested history or budgets."/><form key={editing?.id ?? "new"} onSubmit={submit}><div className="form-grid"><Field label="Portfolio value"><input name="value" type="number" min="0" step="0.01" defaultValue={editing ? editing.value_cents / 100 : ""} required placeholder="0.00"/></Field><Field label="Snapshot date"><input name="snapshotDate" type="date" max={today} defaultValue={editing?.snapshot_date ?? today} required/></Field></div><Field label="Note (optional)"><input name="note" maxLength={500} defaultValue={editing?.note ?? ""} placeholder="Broker statement, manual check…"/></Field><div className="valuation-form-actions">{editing && <button type="button" className="ghost-button" onClick={() => setEditingId(null)}>Cancel edit</button>}<Submit busy={busy} label={editing ? "Save snapshot changes" : "Add value snapshot"}/></div></form><div className="valuation-history"><div className="section-heading compact"><div><p>VALUATION HISTORY</p><h3>{snapshots.length ? `${snapshots.length} manual ${snapshots.length === 1 ? "snapshot" : "snapshots"}` : "No snapshots yet"}</h3></div></div>{snapshots.map((snapshot, index) => <article key={snapshot.id}><span><strong>{formatMoney(snapshot.value_cents, currency)}</strong><small>{shortDate(snapshot.snapshot_date)}{index === 0 ? " · Latest" : ""}{snapshot.note ? ` · ${snapshot.note}` : ""}</small></span><span><button type="button" className="text-link" disabled={busy} onClick={() => setEditingId(snapshot.id)}>Edit</button><button type="button" className="delete-snapshot" disabled={busy} onClick={() => remove(snapshot)}>Delete</button></span></article>)}{snapshots.length === 0 && <EmptyMini text="Add the value from a statement or broker screen whenever you want to refresh the estimate." />}</div></DialogFrame></div>;
}

export function FinanceModal({ name, context, busy, error, close, save }: { name: Exclude<ModalName, null>; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [planType, setPlanType] = useState<"recurring" | "installment">("recurring");
  const [transactionType, setTransactionType] = useState("expense");
  const [recurringType, setRecurringType] = useState("expense");
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>{error && <p className="modal-error" role="alert">{error}</p>}
    {name === "transaction" && <><ModalTitle eyebrow="MANUAL ENTRY" title="Add a transaction" copy="One entry updates every relevant balance and budget window."/><form onSubmit={submit("addTransaction", (values) => ({ ...values, type: transactionType, committed: values.committed === "on", excludeFromSpare: values.excludeFromSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="segmented transaction-types">{["expense", "income", "transfer", "saving", "investment"].map((type) => <button type="button" className={transactionType === type ? "active" : ""} key={type} onClick={() => setTransactionType(type)}>{typeLabel(type)}</button>)}</div><div className="transaction-amount"><Field label="Amount"><input name="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"/></Field></div><Field label="Description"><input name="description" required placeholder={transactionType === "income" ? "Salary" : "What was it?"}/></Field><div className="form-grid transaction-details"><Field label="Date"><input name="date" type="date" max={context.today} defaultValue={context.today} required/></Field>{!moving && <Field label="Category"><select name="categoryId" defaultValue=""><option value="">Uncategorised</option>{context.categories.filter((category) => category.kind === (transactionType === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}</div><Field label={moving ? "From account" : "Account"}><select name="accountId" key={transactionType} defaultValue={transactionType === "expense" ? defaultExpenseAccountId(context.accounts, context.profile.default_expense_account_id) : undefined} required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {formatMoney(account.balance_cents, account.currency)}</option>)}</select></Field>{moving && <Field label="To account"><select name="destinationAccountId" required defaultValue=""><option value="" disabled>Choose destination</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>}{["expense", "saving", "investment"].includes(transactionType) && <label className="single-check"><input type="checkbox" name="excludeFromBudget"/> Exclude from budget — still updates account balances and spending history</label>}{transactionType === "expense" && <div className="check-stack"><label><input type="checkbox" name="committed"/> Cover this from committed money, outside everyday guidance</label><label><input type="checkbox" name="excludeFromSpare"/> Exclude from spare change</label></div>}<Submit busy={busy} label="Save transaction"/></form></>}
    {name === "account" && <><ModalTitle eyebrow="CUSTOM ACCOUNT" title="Add where your money lives" copy="Opening balances create a snapshot—not fake income."/><form onSubmit={submit("addAccount", (values) => ({ ...values, includeSpendable: values.includeSpendable === "on" }))}><Field label="Account name"><input name="name" required placeholder="Holiday cash, Revolut, Trading 212…"/></Field><div className="form-grid"><Field label="Type"><select name="type" defaultValue="bank">{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select></Field><Field label="Current balance"><input name="balance" type="number" min="0" step="0.01" required placeholder="0.00"/></Field></div><Field label="Credit limit (optional)"><input name="creditLimit" type="number" min="0" step="0.01" placeholder="0.00"/></Field><Field label="Account color"><ColorPicker defaultValue="#1f5b4e"/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked/> Include this balance in available-to-spend money</label><Submit busy={busy} label="Add account"/></form></>}
    {name === "category" && <><ModalTitle eyebrow="CUSTOM CATEGORY" title="Create your own label" copy="Categories organise reports without forcing category budgets."/><form onSubmit={submit("addCategory")}><Field label="Category name"><input name="name" required placeholder="Pets, Side work, Coffee…"/></Field><ChoiceField label="Type" name="kind" defaultValue="expense" options={[{value:"expense",label:"Expense"},{value:"income",label:"Income"}]}/><Field label="Color"><ColorPicker defaultValue="#cfe9d7"/></Field><Submit busy={busy} label="Add category"/></form></>}
    {name === "week" && <><ModalTitle eyebrow="CALENDAR WEEKS" title="Choose when your week starts" copy="The weekly view simply adds the daily allocations that fall inside this calendar week."/><form onSubmit={submit("updateWeekStart")}><Field label="First day of the week"><select name="weekStart" defaultValue={context.profile.week_start}>{weekdayLabels.map((label, value) => <option value={value} key={label}>{label}</option>)}</select></Field><div className="budget-form-note"><span>7</span><p><strong>Changing this redraws the weekly view</strong><small>Transactions and daily allocations stay unchanged. Month-crossing weeks take each date’s allocation from its own month.</small></p></div><Submit busy={busy} label="Save week start"/></form></>}
    {name === "timezone" && <><ModalTitle eyebrow="FINANCIAL CALENDAR" title="Choose your financial timezone" copy="This timezone defines today for budgets, resets, scheduled payments, and automatic reconciliation on every device."/><form onSubmit={submit("updateTimezone")}><Field label="Timezone"><select name="timezone" defaultValue={context.profile.timezone}>{Array.from(new Set([context.profile.timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><div className="budget-form-note"><span>◷</span><p><strong>One calendar across every device</strong><small>After saving, Remaivo immediately catches up through today in the new timezone before recalculating balances and budgets.</small></p></div><Submit busy={busy} label="Save timezone"/></form></>}
    {name === "plan" && <><ModalTitle eyebrow="FUTURE MONEY" title="Add a plan" copy="Schedule a repeating item, one future payment, or a purchase split into installments."/><div className="segmented plan-switch"><button type="button" className={planType === "recurring" ? "active" : ""} onClick={() => setPlanType("recurring")}>Recurring</button><button type="button" className={planType === "installment" ? "active" : ""} onClick={() => setPlanType("installment")}>Pay later / installments</button></div>{planType === "recurring" ? <form onSubmit={submit("addRecurring", (values) => ({ ...values, type: recurringType, autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label="Plan name"><input name="title" required placeholder="Rent, salary, VWCE auto-invest…"/></Field><div className="form-grid"><Field label="Type"><select name="type" value={recurringType} onChange={(event) => setRecurringType(event.target.value)}><option value="expense">Expense</option><option value="income">Income</option><option value="saving">Savings transfer</option><option value="investment">Auto-invest</option></select></Field><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required/></Field></div>{["expense", "income"].includes(recurringType) ? <Field label="Category"><select name="categoryId" defaultValue="" required><option value="" disabled>Choose category</option>{activeCategories.filter((category) => category.kind === recurringType).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field> : <input type="hidden" name="categoryId" value=""/>}{["saving","investment"].includes(recurringType) && <Field label="Destination account"><select name="destinationAccountId" required defaultValue=""><option value="" disabled>Choose destination</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label="Payment account"><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Frequency"><select name="frequency"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="daily">Daily</option></select></Field><Field label="Next date"><input name="nextDate" type="date" defaultValue={context.today} required/></Field></div><div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked/> Protect upcoming payments in the plan</label><label><input type="checkbox" name="autoPost"/> Add automatically when due</label></div><Submit busy={busy} label="Create recurring plan"/></form> : <form onSubmit={submit("addInstallment", (values) => ({ ...values, total: installmentTotal, installmentCount, autoPost: values.autoPost === "on" }))}><Field label="Purchase"><input name="title" required placeholder="Laptop, flights, furniture…"/></Field><Field label="Expense category"><select name="categoryId" defaultValue="" required><option value="" disabled>Choose category</option>{activeCategories.filter((category) => category.kind === "expense").map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label="Total purchase"><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min="0.01" step="0.01" required/></Field><Field label="Number of payments"><input value={installmentCount} onChange={(event) => setInstallmentCount(Number(event.target.value))} type="number" min="1" max="120" required/></Field></div><div className="installment-preview"><span>{Array.from({length: Math.min(6, installmentCount)}).map((_, index) => <i key={index} />)}</span><p>{installmentTotal ? installmentCount === 1 ? `${formatMoney(Math.round(Number(installmentTotal) * 100), context.currency)} due in one payment` : `About ${formatMoney(Math.round(Number(installmentTotal) * 100 / Math.max(1, installmentCount)), context.currency)} each` : "Enter a total to preview payments"}</p></div><div className="form-grid"><Field label={installmentCount === 1 ? "Payment due date" : "First installment"}><input name="firstDueDate" type="date" defaultValue={context.today} required/></Field><Field label="Frequency"><select name="frequency" disabled={installmentCount === 1}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field></div>{installmentCount === 1 && <input type="hidden" name="frequency" value="monthly"/>}<Field label="Repayment account"><select name="paymentAccountId" required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Provider label (optional)"><input name="provider" placeholder="Klarna, store finance…"/></Field><Field label="Linked credit account (optional)"><select name="linkedCreditAccountId" defaultValue=""><option value="">Standalone plan</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="check-stack"><label><input type="checkbox" name="autoPost"/> Mark payments paid automatically on their due date</label></div><Submit busy={busy} label="Create pay-later plan"/></form>}</>}
    {name === "spare" && <><ModalTitle eyebrow="SPARE CHANGE" title="Automatic round-ups" copy="Choose the account whose purchases earn round-ups and where the swept money goes."/><form onSubmit={submit("updateSpare", (values) => ({ ...values, enabled: values.enabled === "on", autoSweep: values.autoSweep === "on" }))}>
      <label className="spare-toggle" htmlFor="spare-enabled-switch"><input id="spare-enabled-switch" type="checkbox" role="switch" name="enabled" checked={spareEnabled} onChange={(event) => setSpareEnabled(event.target.checked)}/><span className="spare-toggle-track" aria-hidden="true"><i /></span>Automatic round-ups<small>{spareEnabled ? "On for eligible expenses" : "Off — waiting change is kept"}</small></label>
      <div className="form-grid"><Field label="Spending account"><select name="sourceAccountId" defaultValue={context.profile.spare_source_id ?? ""} required={spareEnabled || autoSweepEnabled}><option value="">Choose spending account</option>{context.accounts.filter((account) => !["investment", "credit"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>
      <Field label="Destination"><select name="destinationAccountId" defaultValue={context.profile.spare_destination_id ?? ""} required={spareEnabled || autoSweepEnabled}><option value="">Choose savings or investment account</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div>
      <ChoiceField label="Multiplier" name="multiplier" defaultValue={context.profile.spare_multiplier} options={[1,2,3,4,5,6,8,10].map(value=>({value,label:`×${value}`}))}/>
      <label className="spare-toggle" htmlFor="spare-auto-sweep-switch"><input id="spare-auto-sweep-switch" type="checkbox" role="switch" name="autoSweep" checked={autoSweepEnabled} onChange={(event) => setAutoSweepEnabled(event.target.checked)}/><span className="spare-toggle-track" aria-hidden="true"><i /></span>Automatic sweeps<small>{autoSweepEnabled ? spareEnabled ? "Sweep when the threshold is reached" : "Configured — paused while round-ups are off" : "Sweep manually whenever you choose"}</small></label>
      {autoSweepEnabled && <><Field label={`Sweep threshold (${context.currency})`}><input name="autoSweepThreshold" type="number" min="0.01" step="0.01" defaultValue={(context.profile.spare_auto_sweep_threshold_cents || 500) / 100} required/></Field><p className="edit-hint">Sweeps the full waiting total when you save activity or Remaivo syncs, if the spending account can cover it. Saving these settings may sweep change already waiting. Round-ups off pauses automatic sweeps.</p></>}
      <p className="edit-hint">Only new expenses on this account collect round-ups, unless excluded on the transaction. Sweep debits this same account and moves the waiting amount to the destination. Turning this off keeps any amount already waiting.</p>
      <Submit busy={busy} label="Save spare-change settings"/>
    </form></>}
    {name === "goal" && <><ModalTitle eyebrow="GOAL OR POT" title="Track purposeful money" copy="Link an account for automatic progress, or record dated progress manually. Investment tracking uses recorded cash, not market value."/><form onSubmit={submit("addGoal")}><Field label="Name"><input name="name" required placeholder="Rainy day, Home deposit, VWCE…"/></Field><div className="form-grid"><Field label="Kind"><select name="kind"><option value="savings">Savings</option><option value="investment">Raw investment</option></select></Field><Field label="Target (optional)"><input name="target" type="number" min="0" step="0.01"/></Field></div><Field label="Linked account (optional)"><select name="accountId" value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)}><option value="">Track independently</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><GoalTrackingFields mode={goalTrackingMode} setMode={setGoalTrackingMode} startDate={context.today}/>{!goalAccountId && goalTrackingMode === "total" && <Field label="Opening tracked amount"><input name="contributed" type="number" min="0" step="0.01" defaultValue="0"/></Field>}<Submit busy={busy} label="Create goal"/></form></>}
  </DialogFrame></div>;
}

export function EditModal({ target, context, busy, error, close, save }: { target: EditTarget; context: Context; busy: boolean; error: string; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [goalAccountId, setGoalAccountId] = useState(target.kind === "goal" ? target.record.account_id ?? "" : "");
  const [goalTrackingMode, setGoalTrackingMode] = useState<Goal["tracking_mode"]>(target.kind === "goal" ? target.record.tracking_mode ?? "total" : "total");
  const editingTransaction = target.kind === "transaction" ? target.record : null;
  const transactionMoving = editingTransaction ? ["transfer", "saving", "investment"].includes(editingTransaction.type) : false;
  const transactionCorrectable = editingTransaction ? !["installment_purchase", "installment_payment"].includes(editingTransaction.type) : false;
  const correctionAccounts = editingTransaction
    ? Object.values(context.accountById).filter((account) => account.archived !== 1 || account.id === editingTransaction.account_id || account.id === editingTransaction.destination_account_id)
    : context.accounts;
  const correctionCategories = editingTransaction
    ? Object.values(context.categoryById).filter((category) => category.archived !== 1 || category.id === editingTransaction.category_id)
    : context.categories;
  const editingInstallment = target.kind === "installment" ? target.record : null;
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

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><DialogFrame className="modal-card" currency={context.currency} close={close}>{error && <p className="modal-error" role="alert">{error}</p>}
    {target.kind === "transaction" && <><ModalTitle eyebrow="CORRECT TRANSACTION" title={target.record.description} copy={transactionCorrectable ? "Remaivo reverses the original balance and budget effects, then posts this corrected replacement with an audit link." : "This entry belongs to a pay-later plan, so its accounting details must be corrected from that plan."}/>{transactionCorrectable ? <form onSubmit={submit("correctTransaction", (values) => ({ ...values, transactionId: target.record.id, committed: values.committed === "on", excludeFromSpare: values.excludeFromSpare === "on", excludeFromBudget: values.excludeFromBudget === "on" }))}><div className="correction-note"><span>↻</span><p><strong>The original is never erased</strong><small>It becomes a corrected audit entry while this replacement becomes the active transaction.</small></p></div><Field label="Description"><input name="description" defaultValue={target.record.description} required/></Field><div className="form-grid"><Field label="Correct amount"><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field><Field label="Date"><input name="date" type="date" defaultValue={target.record.date} required/></Field></div><Field label={transactionMoving ? "From account" : "Account"}><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>Choose account</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>{transactionMoving && <Field label="To account"><select name="destinationAccountId" defaultValue={target.record.destination_account_id ?? ""} required><option value="" disabled>Choose destination</option>{correctionAccounts.map((account) => <option value={account.id} key={account.id}>{account.archived ? "Archived · " : ""}{account.name}</option>)}</select></Field>}{!transactionMoving && <Field label="Category"><select name="categoryId" defaultValue={target.record.category_id ?? ""}><option value="">Uncategorised</option>{correctionCategories.filter((category) => category.kind === (target.record.type === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.archived ? "Archived · " : ""}{category.name}</option>)}</select></Field>}{["expense", "saving", "investment"].includes(target.record.type) && <label className="single-check"><input type="checkbox" name="excludeFromBudget" defaultChecked={target.record.counts_monthly === 0}/> Exclude from budget — still updates account balances and spending history</label>}{target.record.type === "expense" && <div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/> Treat as committed spending</label><label><input type="checkbox" name="excludeFromSpare" defaultChecked={target.record.spare_excluded === 1}/> Exclude from spare change</label></div>}<Submit busy={busy} label="Post corrected transaction"/></form> : <div className="locked-summary"><span>{formatMoney(target.record.amount_cents, context.currency)}</span><small>Open Plans and correct the linked purchase or remaining payment schedule there.</small></div>}</>}

    {target.kind === "account" && <><ModalTitle eyebrow="EDIT ACCOUNT" title={target.record.name} copy="Edit how this account is described and counted. Use transactions whenever its balance changes."/><form onSubmit={submit("updateAccount", (values) => ({ ...values, accountId: target.record.id, includeSpendable: values.includeSpendable === "on" }))}><div className="locked-summary"><span>{formatMoney(target.record.balance_cents, target.record.currency)}</span><small>Current balance · changed only by transactions</small></div><Field label="Account name"><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label="Type"><select name="type" defaultValue={target.record.type}>{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select></Field><Field label="Credit limit (optional)"><input name="creditLimit" type="number" min="0" step="0.01" defaultValue={(target.record.credit_limit_cents ?? 0) / 100}/></Field></div><Field label="Account color"><ColorPicker defaultValue={target.record.color}/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked={target.record.include_spendable === 1}/> Include this balance in available-to-spend money</label><Submit busy={busy} label="Save account details"/></form><ArchiveAction busy={busy} label="Archive account" onClick={() => archive("archiveAccount", "accountId", target.record.id, target.record.name)} /></>}

    {target.kind === "category" && <><ModalTitle eyebrow="EDIT CATEGORY" title={target.record.name} copy="Renaming keeps existing transaction links intact. Archive it when you no longer want it available for new entries."/><form onSubmit={submit("updateCategory", (values) => ({ ...values, categoryId: target.record.id }))}><Field label="Category name"><input name="name" defaultValue={target.record.name} required/></Field><ChoiceField label="Type" name="kind" defaultValue={target.record.kind} options={[{value:"expense",label:"Expense"},{value:"income",label:"Income"}]}/><Field label="Color"><ColorPicker defaultValue={target.record.color}/></Field><Submit busy={busy} label="Save category"/></form><ArchiveAction busy={busy} label="Archive category" onClick={() => archive("archiveCategory", "categoryId", target.record.id, target.record.name)} /></>}

    {target.kind === "recurring" && <><ModalTitle eyebrow="EDIT RECURRING PLAN" title={target.record.title} copy={`This remains a ${typeLabel(target.record.type).toLowerCase()} plan. Update its category, amount, timing, account, and automation whenever the real arrangement changes.`}/><form onSubmit={submit("updateRecurring", (values) => ({ ...values, planId: target.record.id, anchorDay: values.nextDate === target.record.next_date ? target.record.anchor_day : Number(String(values.nextDate).slice(8, 10)), autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label="Plan name"><input name="title" defaultValue={target.record.title} required/></Field>{["expense", "income"].includes(target.record.type) && <Field label="Category"><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>Choose category</option>{context.categories.filter((category) => category.kind === target.record.type && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}<div className="form-grid"><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" defaultValue={target.record.amount_cents / 100} required/></Field>{["saving","investment"].includes(target.record.type) && <Field label="Destination account"><select name="destinationAccountId" required defaultValue={target.record.destination_account_id||""}><option value="" disabled>Choose destination</option>{context.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}<Field label="Payment account"><select name="accountId" defaultValue={target.record.account_id ?? ""} required><option value="" disabled>Choose account</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><div className="form-grid"><Field label="Frequency"><select name="frequency" defaultValue={target.record.frequency}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every"><input name="intervalCount" type="number" min="1" max="365" defaultValue={target.record.interval_count} required/></Field></div><Field label="Next date"><input name="nextDate" type="date" defaultValue={target.record.next_date} required/></Field>{["monthly", "yearly"].includes(target.record.frequency) && target.record.anchor_day >= 29 && <div className="budget-form-note"><span>31</span><p><strong>Short months use their final day</strong><small>The plan returns to day {target.record.anchor_day} whenever that day exists again.</small></p></div>}<div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked={target.record.committed === 1}/> Reserve before calculating spendable money</label><label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/> Add automatically when due</label></div><Submit busy={busy} label="Save recurring plan"/></form><ArchiveAction busy={busy} label="Archive recurring plan" onClick={() => archive("archiveRecurring", "planId", target.record.id, target.record.title)} /></>}


    {target.kind === "installment" && <><ModalTitle eyebrow="CORRECT PAY-LATER PLAN" title={target.record.title} copy={paidInstallments.length ? "Paid entries stay locked. Change the category or plan total and rebuild only the unpaid schedule." : "Nothing has been paid yet, so the category, full amount, and payment schedule can be corrected safely."}/><form onSubmit={submit("updateInstallmentPlan", (values) => ({ ...values, planId: target.record.id, total: installmentTotal, remainingCount: installmentRemainingCount, nextDueDate: installmentNextDue, frequency: installmentFrequency, autoPost: values.autoPost === "on" }))}>{paidInstallments.length > 0 && <div className="locked-summary"><span>{formatMoney(target.record.paid_cents, context.currency)} already paid</span><small>{paidInstallments.length} {paidInstallments.length === 1 ? "payment stays" : "payments stay"} untouched · only {formatMoney(installmentRemainingCents, context.currency)} is rescheduled</small></div>}<Field label="Purchase"><input name="title" defaultValue={target.record.title} required/></Field><Field label="Expense category"><select name="categoryId" defaultValue={target.record.category_id ?? ""} required><option value="" disabled>Choose category</option>{context.categories.filter((category) => category.kind === "expense" && category.archived !== 1).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field><div className="form-grid"><Field label="Correct total"><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min={(target.record.paid_cents + 1) / 100} step="0.01" required/></Field><Field label={paidInstallments.length ? "Remaining payments" : "Number of payments"}><input value={installmentRemainingCount} onChange={(event) => setInstallmentRemainingCount(Number(event.target.value))} type="number" min="1" max={Math.max(1, 120 - paidInstallments.length)} required/></Field></div><div className="installment-preview"><span>{Array.from({ length: Math.min(6, installmentRemainingCount) }).map((_, index) => <i key={index} />)}</span><p>{installmentRemainingCents ? `About ${formatMoney(Math.round(installmentRemainingCents / Math.max(1, installmentRemainingCount)), context.currency)} per remaining payment` : "Enter a total above the paid amount"}</p></div><div className="form-grid"><Field label={paidInstallments.length ? "Next unpaid date" : "First payment date"}><input value={installmentNextDue} onChange={(event) => setInstallmentNextDue(event.target.value)} type="date" required/></Field><Field label="Frequency"><select value={installmentFrequency} onChange={(event) => setInstallmentFrequency(event.target.value)}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field></div><div className="form-grid"><Field label="Provider label (optional)"><input name="provider" defaultValue={target.record.provider ?? ""} placeholder="Klarna, store finance…"/></Field><Field label="Repayment account"><select name="paymentAccountId" defaultValue={target.record.payment_account_id} required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><Field label="Linked credit account (optional)"><select name="linkedCreditAccountId" defaultValue={target.record.linked_credit_account_id ?? ""}><option value="">Standalone plan</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="check-stack"><label><input type="checkbox" name="autoPost" defaultChecked={target.record.auto_post === 1}/> Mark payments paid automatically on their due date</label></div><Submit busy={busy} label={paidInstallments.length ? "Rebuild unpaid schedule" : "Save corrected plan"}/></form><ArchiveAction busy={busy} label="Archive pay-later plan" onClick={() => archive("archiveInstallmentPlan", "planId", target.record.id, target.record.title)} /></>}

    {target.kind === "goal" && <><ModalTitle eyebrow="EDIT GOAL OR POT" title={target.record.name} copy="Choose how progress is counted. Switching to New money captures a fresh starting point; later edits to the name or target keep it."/><form onSubmit={submit("updateGoal", (values) => ({ ...values, goalId: target.record.id }))}><Field label="Name"><input name="name" defaultValue={target.record.name} required/></Field><div className="form-grid"><Field label="Kind"><select name="kind" defaultValue={target.record.kind}><option value="savings">Savings</option><option value="investment">Raw investment</option></select></Field><Field label="Target (optional)"><input name="target" type="number" min="0" step="0.01" defaultValue={(target.record.target_cents ?? 0) / 100}/></Field></div><Field label="Linked account (optional)"><select name="accountId" value={goalAccountId} onChange={(event) => setGoalAccountId(event.target.value)}><option value="">Track independently</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><GoalTrackingFields mode={goalTrackingMode} setMode={setGoalTrackingMode} startDate={target.record.start_date ?? context.today} endDate={target.record.end_date}/>{!goalAccountId && goalTrackingMode === "total" && <Field label="Opening tracked amount"><input name="contributed" type="number" min="0" step="0.01" defaultValue={target.record.contributed_cents / 100}/></Field>}{!goalAccountId && <p className="edit-hint">Use Record progress on this goal for dated additions or removals. Manual entries never move money between accounts.</p>}<Field label="Pot color"><ColorPicker defaultValue={target.record.color}/></Field><Submit busy={busy} label="Save goal"/></form><ArchiveAction busy={busy} label="Archive goal" onClick={() => archive("archiveGoal", "goalId", target.record.id, target.record.name)} /></>}
  </DialogFrame></div>;
}

function ArchiveAction({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return <div className="archive-zone"><span><strong>Remove from active views</strong><small>History stays in your Remaivo data.</small></span><button type="button" disabled={busy} onClick={onClick}>{label}</button></div>;
}

function ModalTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { const icon = /ACCOUNT|VALUATION/.test(eyebrow) ? "account" : /GOAL|POT/.test(eyebrow) ? "goal" : /CATEGORY/.test(eyebrow) ? "category" : /SPARE/.test(eyebrow) ? "spare" : /ENTRY|TRANSACTION/.test(eyebrow) ? "entry" : "plan"; return <DialogHeading icon={icon} title={title} copy={copy}/> }
function EmptyMini({ text }: { text: string }) { return <p className="empty-mini">{text}</p> }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>＋</span><strong>{title}</strong><p>{copy}</p></div> }

export function Onboarding({ displayName, busy, error, onComplete }: { displayName: string; busy: boolean; error?: string; onComplete: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const [step, setStep] = useState(0);
  const [currency, setCurrency] = useState("EUR");
  const [timezone, setTimezone] = useState(browserTimezone);
  const [accounts, setAccounts] = useState([{ id: crypto.randomUUID(), name: "Main account", type: "bank", balance: "", includeSpendable: true, color: "#1f5b4e" }]);
  const [budgets, setBudgets] = useState({ monthly: "1200" });
  const [budgetMode, setBudgetMode] = useState("adaptive");
  const [carryMode, setCarryMode] = useState("stack_signed");

  function updateAccount(id: string, key: string, value: string | boolean) { setAccounts((items) => items.map((item) => item.id === id ? { ...item, [key]: value } : item)); }
  async function finish() { await onComplete({ currency, timezone, weekStart: 1, accounts, budgets, budgetMode, carryMode }); }
  return <main className="onboarding-screen"><aside className="onboarding-aside"><div className="brand-mark"><span className="remaivo-logo-mark" aria-hidden="true" /><strong>Remaivo</strong></div><div><p className="eyebrow">YOUR OPENING SNAPSHOT</p><h1>Start where your money is today.</h1><p>No fake income. No starting from zero. Add what already exists, then Remaivo takes it from here.</p></div><ol>{["Basics", "Accounts", "Budgets", "Review"].map((label, index) => <li className={step === index ? "active" : step > index ? "done" : ""} key={label}><span>{step > index ? "✓" : index + 1}</span>{label}</li>)}</ol><small>Signed in as {displayName}</small></aside><section className="onboarding-main">
    {step === 0 && <div className="setup-panel"><p className="eyebrow">WELCOME, {displayName.split(" ")[0].toUpperCase()}</p><h2>Let’s set your financial starting line.</h2><p>Choose the few basics Remaivo needs to organise every amount correctly.</p><div className="setup-form"><Field label="Primary currency"><select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="EUR">Euro · EUR</option><option value="USD">US dollar · USD</option><option value="GBP">British pound · GBP</option></select></Field><Field label="Financial timezone"><select value={timezone} onChange={(event) => { setTimezone(event.target.value); }}>{Array.from(new Set([timezone, ...commonTimezones])).map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</select></Field><div className="setup-note"><span>✓</span><p><strong>This date is not income.</strong><small>Opening balances stay out of spending and income reports. Your timezone controls every financial calendar date.</small></p></div></div></div>}
    {step === 1 && <div className="setup-panel wide"><p className="eyebrow">FINANCIAL ACCOUNTS</p><h2>Add where your money already lives.</h2><p>Include spending, savings, cash, raw investments, or credit. You can add custom accounts later.</p><div className="setup-accounts">{accounts.map((account, index) => <article key={account.id}><span className="setup-account-number">{index + 1}</span><input aria-label="Account name" value={account.name} onChange={(event) => updateAccount(account.id, "name", event.target.value)} placeholder="Account name"/><select aria-label="Account type" value={account.type} onChange={(event) => { const type = event.target.value; updateAccount(account.id, "type", type); updateAccount(account.id, "includeSpendable", !["savings", "investment", "credit"].includes(type)); }}><option value="bank">Bank</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="custom">Custom</option></select><label><span>{currency}</span><input aria-label="Opening balance" type="number" min="0" step="0.01" value={account.balance} onChange={(event) => updateAccount(account.id, "balance", event.target.value)} placeholder="0.00"/></label>{accounts.length > 1 && <button aria-label="Remove account" onClick={() => setAccounts((items) => items.filter((item) => item.id !== account.id))}>×</button>}</article>)}<button className="add-account-line" onClick={() => setAccounts((items) => [...items, { id: crypto.randomUUID(), name: "", type: "bank", balance: "", includeSpendable: true, color: ["#d68b64", "#4c8b98", "#705f83"][items.length % 3] }])}>＋ Add another account</button></div></div>}
    {step === 2 && <div className="setup-panel wide"><p className="eyebrow">ONE BUDGET PLAN</p><h2>Start with one monthly pool.</h2><p>Remaivo allocates that pool by calendar day. Today and Week are always derived views of the same plan.</p><div className="setup-budget-grid"><article><span>M</span><strong>Monthly budget</strong><label><small>Spending pool</small><div><i>{currency}</i><input type="number" min="0" step="1" value={budgets.monthly} onChange={(event) => setBudgets({ monthly: event.target.value })}/></div></label></article><article><span>↻</span><strong>Allocation</strong><label><small>Mode</small><select value={budgetMode} onChange={(event) => setBudgetMode(event.target.value)}><option value="adaptive">Adaptive</option><option value="fixed_split">Fixed</option></select></label><div className="setup-derived"><b>{budgetMode === "adaptive" ? "Redistributes each morning" : "Same calendar-day base"}</b><small>{budgetMode === "adaptive" ? "Today stays frozen after it starts" : "Transactions never change the base"}</small></div></article>{budgetMode === "fixed_split" && <article><span>＋</span><strong>Fixed carry</strong><label><small>Mode</small><select value={carryMode} onChange={(event) => setCarryMode(event.target.value)}>{["reset", "stack_unused", "stack_signed"].map((value) => <option value={value} key={value}>{carryLabels[value]}</option>)}</select></label></article>}</div><div className="stack-example"><span>7</span><p><strong>Weeks are views, not separate budgets</strong><small>Remaivo adds the daily allocations inside each calendar week, including weeks that cross into a new month.</small></p></div></div>}
    {step === 3 && <div className="setup-panel"><p className="eyebrow">READY TO BEGIN</p><h2>Your opening snapshot is set.</h2><p>Remaivo will create your current Plan and opening balances without counting them as new activity.</p><div className="review-list"><div><span>◫</span><p><strong>{accounts.length} financial {accounts.length === 1 ? "account" : "accounts"}</strong><small>{accounts.map((account) => account.name || typeLabel(account.type)).join(" · ")}</small></p></div><div><span>◔</span><p><strong>{currency} {budgets.monthly} monthly spending pool</strong><small>Daily and weekly guidance comes from this Plan</small></p></div><div><span>☁</span><p><strong>Private cross-device space</strong><small>Connected to your ChatGPT sign-in</small></p></div></div></div>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    <footer className="setup-actions"><button className="ghost-button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>Back</button>{step < 3 ? <button className="primary-button" onClick={() => setStep((value) => value + 1)}>Continue <span>→</span></button> : <button className="primary-button" disabled={busy} onClick={finish}>{busy ? "Creating your space…" : "Open Remaivo"}<span>→</span></button>}</footer>
  </section></main>;
}
