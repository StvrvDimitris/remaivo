"use client";

import { CSSProperties, FormEvent, ReactNode, useCallback, useEffect, useState } from "react";

type Account = { id: string; name: string; type: string; currency: string; balance_cents: number; opening_balance_cents: number; credit_limit_cents: number | null; color: string; include_spendable: number };
type Category = { id: string; name: string; kind: string; color: string; icon: string };
type Transaction = { id: string; account_id: string | null; destination_account_id: string | null; category_id: string | null; type: string; description: string; amount_cents: number; date: string; committed: number; counts_daily: number; counts_weekly: number; counts_monthly: number; counts_general: number; spare_change_cents: number };
type BudgetRule = { id: string; period: string; base_cents: number; carry_mode: string; carry_cap_cents: number | null; anchor_date: string };
type RecurringPlan = { id: string; title: string; type: string; amount_cents: number; account_id: string | null; destination_account_id: string | null; frequency: string; interval_count: number; next_date: string; auto_post: number; committed: number };
type InstallmentPlan = { id: string; title: string; provider: string | null; total_cents: number; paid_cents: number; installment_count: number; payment_account_id: string; linked_credit_account_id: string | null; include_daily_weekly: number; status: string };
type InstallmentPayment = { id: string; plan_id: string; sequence: number; due_date: string; amount_cents: number; status: string };
type Goal = { id: string; name: string; kind: string; target_cents: number | null; contributed_cents: number; account_id: string | null; color: string };
type SpareEvent = { id: string; base_cents: number; multiplied_cents: number; destination_account_id: string | null };
type Profile = { currency: string; week_start: number; spare_multiplier: number; spare_destination_id: string | null; spare_sweep_mode: string; spare_threshold_cents: number };
type Snapshot = {
  needsSetup: boolean;
  today: string;
  user: { displayName: string; email: string };
  profile?: Profile;
  accounts?: Account[];
  categories?: Category[];
  transactions?: Transaction[];
  budgets?: BudgetRule[];
  recurring?: RecurringPlan[];
  installmentPlans?: InstallmentPlan[];
  installmentPayments?: InstallmentPayment[];
  goals?: Goal[];
  spareEvents?: SpareEvent[];
  error?: string;
};

type ModalName = "transaction" | "account" | "budget" | "plan" | "category" | "spare" | "goal" | null;
type PageName = "overview" | "transactions" | "accounts" | "budget" | "plans" | "goals" | "settings";

const navItems: { id: PageName; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "transactions", label: "Transactions", icon: "↕" },
  { id: "accounts", label: "Accounts", icon: "◫" },
  { id: "budget", label: "Budget", icon: "◔" },
  { id: "plans", label: "Plans", icon: "↻" },
  { id: "goals", label: "Save & invest", icon: "◇" },
];

const carryLabels: Record<string, string> = {
  reset: "Reset each period",
  stack_unused: "Stack unused allowance",
  stack_capped: "Stack up to a cap",
  stack_signed: "Stack allowance and overspend",
  manual: "Decide manually",
};

function formatMoney(cents: number, currency = "EUR", digits = 2) {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

function parseDate(value: string) {
  return new Date(`${value}T12:00:00Z`);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function periodStart(value: string, period: string, weekStart: number) {
  const date = parseDate(value);
  if (period === "weekly") {
    const offset = (date.getUTCDay() - weekStart + 7) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
  } else if (period === "monthly") {
    date.setUTCDate(1);
  }
  return dateKey(date);
}

function nextPeriod(start: string, period: string) {
  const date = parseDate(start);
  if (period === "daily") date.setUTCDate(date.getUTCDate() + 1);
  else if (period === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return dateKey(date);
}

function budgetValue(rule: BudgetRule, transactions: Transaction[], today: string, weekStart: number, reserved = 0) {
  const flag = `counts_${rule.period}` as keyof Transaction;
  const spendFor = (start: string, end: string) => transactions
    .filter((transaction) => transaction.date >= start && transaction.date < end && Number(transaction[flag]) === 1)
    .reduce((sum, transaction) => sum + transaction.amount_cents, 0);

  if (rule.period === "general") {
    return Math.max(0, rule.base_cents - spendFor(rule.anchor_date, "9999-12-31") - reserved);
  }

  const currentStart = periodStart(today, rule.period, weekStart);
  let cursor = periodStart(rule.anchor_date, rule.period, weekStart);
  let carry = 0;
  let guard = 0;
  while (cursor < currentStart && guard < 4000) {
    const following = nextPeriod(cursor, rule.period);
    const remainder = rule.base_cents + carry - spendFor(cursor, following);
    if (rule.carry_mode === "stack_signed") carry = remainder;
    else if (rule.carry_mode === "stack_unused" || rule.carry_mode === "manual") carry = Math.max(0, remainder);
    else if (rule.carry_mode === "stack_capped") carry = Math.min(rule.carry_cap_cents ?? rule.base_cents, Math.max(0, remainder));
    else carry = 0;
    cursor = following;
    guard += 1;
  }
  const remaining = rule.base_cents + carry - spendFor(currentStart, nextPeriod(currentStart, rule.period)) - reserved;
  return remaining;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(parseDate(value));
}

function typeLabel(type: string) {
  const labels: Record<string, string> = { bank: "Bank account", savings: "Savings", cash: "Cash", credit: "Credit", investment: "Investment", wallet: "Digital wallet", custom: "Custom", income: "Income", expense: "Expense", transfer: "Transfer", saving: "Saving", installment_payment: "Installment", installment_purchase: "Installment purchase" };
  return labels[type] ?? type.replaceAll("_", " ");
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function FinanceClient({ displayName, email, signOutHref }: { displayName: string; email: string; signOutHref: string }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<PageName>("overview");
  const [modal, setModal] = useState<ModalName>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/finance", { cache: "no-store" });
    const payload = await response.json() as Snapshot;
    if (!response.ok) throw new Error(payload.error || "Unable to load Pace.");
    setData(payload);
  }, []);

  useEffect(() => {
    load().catch((error) => setNotice(error instanceof Error ? error.message : "Unable to load Pace."));
  }, [load]);

  async function mutate(action: string, payload: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/finance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) });
      const next = await response.json() as Snapshot;
      if (!response.ok) throw new Error(next.error || "Unable to save that change.");
      setData(next);
      setNotice("Saved");
      window.setTimeout(() => setNotice(""), 2200);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save that change.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <main className="loading-screen"><span className="loading-logo">P</span><p>Getting your money in view…</p>{notice && <small>{notice}</small>}</main>;
  }

  if (data.needsSetup) {
    return <Onboarding displayName={displayName} busy={busy} onComplete={(payload) => mutate("setup", payload)} />;
  }

  const accounts = data.accounts ?? [];
  const categories = data.categories ?? [];
  const transactions = data.transactions ?? [];
  const budgets = data.budgets ?? [];
  const recurring = data.recurring ?? [];
  const installmentPlans = data.installmentPlans ?? [];
  const installmentPayments = data.installmentPayments ?? [];
  const goals = data.goals ?? [];
  const spareEvents = data.spareEvents ?? [];
  const profile = data.profile!;
  const currency = profile.currency;

  const accountById = Object.fromEntries(accounts.map((account) => [account.id, account]));
  const categoryById = Object.fromEntries(categories.map((category) => [category.id, category]));
  const spendable = accounts.filter((account) => account.include_spendable === 1).reduce((sum, account) => sum + account.balance_cents, 0);
  const savings = accounts.filter((account) => account.type === "savings").reduce((sum, account) => sum + account.balance_cents, 0);
  const invested = accounts.filter((account) => account.type === "investment").reduce((sum, account) => sum + account.balance_cents, 0);
  const totalBalance = accounts.reduce((sum, account) => sum + account.balance_cents, 0);
  const outstandingInstallments = installmentPlans.reduce((sum, plan) => sum + plan.total_cents - plan.paid_cents, 0);
  const monthKey = data.today.slice(0, 7);
  const reservedThisMonth = recurring.filter((plan) => plan.committed === 1 && plan.next_date.startsWith(monthKey)).reduce((sum, plan) => sum + plan.amount_cents, 0)
    + installmentPayments.filter((payment) => payment.status !== "paid" && payment.due_date.startsWith(monthKey)).reduce((sum, payment) => sum + payment.amount_cents, 0);
  const budgetResults = budgets.map((rule) => ({ ...rule, remaining: budgetValue(rule, transactions, data.today, profile.week_start, ["monthly", "general"].includes(rule.period) ? reservedThisMonth : 0) }));
  const dailyRemaining = budgetResults.find((rule) => rule.period === "daily")?.remaining ?? spendable;
  const spentToday = transactions.filter((transaction) => transaction.date === data.today && transaction.counts_daily === 1).reduce((sum, transaction) => sum + transaction.amount_cents, 0);
  const dailyBase = budgets.find((rule) => rule.period === "daily")?.base_cents ?? 0;
  const availableToday = Math.max(0, dailyRemaining);
  const totalDailyAvailable = Math.max(dailyBase, availableToday + spentToday);
  const sparePot = spareEvents.reduce((sum, event) => sum + event.multiplied_cents, 0);
  const upcomingPayments = installmentPayments.filter((payment) => payment.status !== "paid").slice(0, 5);

  const context = { accounts, categories, transactions, budgets, recurring, installmentPlans, installmentPayments, goals, profile, currency, accountById, categoryById, budgetResults, reservedThisMonth, spendable, savings, invested, totalBalance, outstandingInstallments, sparePot, upcomingPayments, today: data.today };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand-mark brand-button" onClick={() => setPage("overview")} aria-label="Pace home"><span>P</span><strong>Pace</strong></button>
        <nav aria-label="Main navigation">
          {navItems.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}><span>{item.icon}</span>{item.label}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-goal">
            <div className="mini-goal-top"><span>Spare-change pot</span><strong>{formatMoney(sparePot, currency, 0)}</strong></div>
            <div className="mini-goal-track"><span style={{ width: `${Math.min(100, profile.spare_threshold_cents ? sparePot / profile.spare_threshold_cents * 100 : 0)}%` }} /></div>
            <p>×{profile.spare_multiplier} · {profile.spare_sweep_mode}</p>
          </div>
          <button className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => setPage("settings")}><span>⚙</span>Settings</button>
          <div className="profile"><span className="avatar">{initials(displayName)}</span><span><strong>{displayName}</strong><small>{email}</small></span><a href={signOutHref} title="Sign out">↗</a></div>
        </div>
      </aside>

      <section className="workspace">
        <AppHeader page={page} displayName={displayName} onAdd={() => setModal("transaction")} />
        {page === "overview" && <Overview context={context} availableToday={availableToday} spentToday={spentToday} totalDailyAvailable={totalDailyAvailable} setPage={setPage} onAdd={() => setModal("transaction")} />}
        {page === "transactions" && <TransactionsPage context={context} search={search} setSearch={setSearch} onAdd={() => setModal("transaction")} />}
        {page === "accounts" && <AccountsPage context={context} onAdd={() => setModal("account")} onArchive={(accountId) => mutate("archiveAccount", { accountId })} />}
        {page === "budget" && <BudgetPage context={context} onEdit={() => setModal("budget")} />}
        {page === "plans" && <PlansPage context={context} onAdd={() => setModal("plan")} onPay={async (paymentId) => { if (window.confirm("Mark this installment as paid today?")) await mutate("payInstallment", { paymentId, date: data.today }); }} />}
        {page === "goals" && <GoalsPage context={context} onGoal={() => setModal("goal")} onSpare={() => setModal("spare")} onSweep={async () => { const source = accounts.find((account) => account.include_spendable === 1); if (source && profile.spare_destination_id) await mutate("sweepSpare", { sourceAccountId: source.id, destinationAccountId: profile.spare_destination_id }); }} />}
        {page === "settings" && <SettingsPage context={context} onCategory={() => setModal("category")} onSpare={() => setModal("spare")} />}
      </section>

      {notice && <div className={`toast ${notice === "Saved" ? "success" : ""}`}>{notice}</div>}
      {modal && <FinanceModal name={modal} context={context} busy={busy} close={() => setModal(null)} save={async (action, payload) => { const ok = await mutate(action, payload); if (ok) setModal(null); }} />}
    </main>
  );
}

function AppHeader({ page, displayName, onAdd }: { page: PageName; displayName: string; onAdd: () => void }) {
  const title: Record<PageName, string> = { overview: `Good morning, ${displayName.split(" ")[0]}.`, transactions: "Transactions", accounts: "Your accounts", budget: "Spending pace", plans: "Plans & commitments", goals: "Save & invest", settings: "Settings" };
  const now = new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  return <header className="topbar"><div><p className="eyebrow">{page === "overview" ? now.toUpperCase() : "PACE PERSONAL FINANCE"}</p><h1>{title[page]}</h1></div><div className="top-actions"><button className="icon-button" aria-label="Notifications">●</button><button className="primary-button" onClick={onAdd}><span>＋</span>Add transaction</button></div></header>;
}

type Context = ReturnType<typeof contextShape>;
function contextShape() { return {} as { accounts: Account[]; categories: Category[]; transactions: Transaction[]; budgets: BudgetRule[]; recurring: RecurringPlan[]; installmentPlans: InstallmentPlan[]; installmentPayments: InstallmentPayment[]; goals: Goal[]; profile: Profile; currency: string; accountById: Record<string, Account>; categoryById: Record<string, Category>; budgetResults: (BudgetRule & {remaining:number})[]; reservedThisMonth: number; spendable: number; savings: number; invested: number; totalBalance: number; outstandingInstallments: number; sparePot: number; upcomingPayments: InstallmentPayment[]; today: string } }

function Overview({ context, availableToday, spentToday, totalDailyAvailable, setPage, onAdd }: { context: Context; availableToday: number; spentToday: number; totalDailyAvailable: number; setPage: (page: PageName) => void; onAdd: () => void }) {
  const { currency, totalBalance, spendable, savings, invested, budgetResults, upcomingPayments, installmentPlans, accountById, transactions, categoryById, reservedThisMonth } = context;
  const percent = totalDailyAvailable > 0 ? Math.max(0, Math.min(100, availableToday / totalDailyAvailable * 100)) : 0;
  return <div className="dashboard-grid">
    <section className="hero-card"><div className="hero-copy"><p>AVAILABLE TO SPEND TODAY</p><h2>{formatMoney(availableToday, currency, 0)}<span>.{String(Math.abs(availableToday) % 100).padStart(2, "0")}</span></h2><div className="pace-pill"><i /> {availableToday >= 0 ? "Right on pace" : "Over today’s pace"}</div><small>Your daily allowance reflects spending and the carryover rule you chose.</small><button className="hero-action" onClick={onAdd}>Add today’s spending →</button></div><div className="hero-visual"><div className="dial" style={{ background: `conic-gradient(var(--lime) 0 ${percent}%, rgba(255,255,255,.12) ${percent}% 100%)` }}><span className="dial-inner"><b>{Math.round(percent)}%</b><small>available</small></span></div><p>{formatMoney(spentToday, currency)} spent today</p></div></section>
    <section className="balance-card"><div className="card-heading"><span><p>TOTAL BALANCE</p><h3>{formatMoney(totalBalance, currency)}</h3></span><button aria-label="More balance options">•••</button></div><div className="balance-breakdown"><div><i className="dot spending"/><span><p>Spendable</p><strong>{formatMoney(spendable, currency)}</strong></span></div><div><i className="dot savings"/><span><p>Savings</p><strong>{formatMoney(savings, currency)}</strong></span></div><div><i className="dot investing"/><span><p>Raw invested</p><strong>{formatMoney(invested, currency)}</strong></span></div></div><button className="text-link" onClick={() => setPage("accounts")}>View all accounts <span>→</span></button></section>
    <section className="budget-card"><div className="section-heading"><div><p>YOUR SPENDING PACE</p><h3>Every window, in one view.</h3></div><button className="ghost-button" onClick={() => setPage("budget")}>Manage budget</button></div><div className="budget-windows">{budgetResults.filter((rule) => rule.period !== "general").map((rule, index) => <article key={rule.id} className={`budget-window ${["mint", "sky", "sand"][index]}`}><span>{rule.period === "daily" ? "Today" : rule.period === "weekly" ? "This week" : "This month"}</span><strong>{formatMoney(Math.max(0, rule.remaining), currency, 0)}</strong><small>{rule.period === "monthly" ? `${formatMoney(reservedThisMonth, currency, 0)} committed` : carryLabels[rule.carry_mode]}</small><div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, rule.remaining / Math.max(1, rule.base_cents) * 100))}%` }} /></div></article>)}</div></section>
    <section className="commitments-card"><div className="section-heading compact"><div><p>UP NEXT</p><h3>Committed money</h3></div><button className="text-link" onClick={() => setPage("plans")}>See plans</button></div><div className="commitment-list">{upcomingPayments.slice(0, 3).map((payment) => { const plan = installmentPlans.find((item) => item.id === payment.plan_id); return <div key={payment.id}><span className="date-block"><b>{parseDate(payment.due_date).getUTCDate()}</b><small>{parseDate(payment.due_date).toLocaleString("en", { month: "short", timeZone: "UTC" }).toUpperCase()}</small></span><span><strong>{plan?.title ?? "Installment"}</strong><small>Payment {payment.sequence} of {plan?.installment_count}</small></span><b>{formatMoney(payment.amount_cents, currency, 0)}</b></div>})}{upcomingPayments.length === 0 && <EmptyMini text="No installment payments coming up." />}</div><div className="reserved-note"><span>✓</span><p><strong>{formatMoney(reservedThisMonth, currency)} reserved</strong><small>Included in this month’s spending pace.</small></p></div></section>
    <section className="activity-card"><div className="section-heading compact"><div><p>LATEST ACTIVITY</p><h3>Recent transactions</h3></div><button className="text-link" onClick={() => setPage("transactions")}>View all</button></div><div className="activity-list">{transactions.slice(0, 4).map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} accountById={accountById} categoryById={categoryById} currency={currency} />)}{transactions.length === 0 && <EmptyMini text="Your first transactions will appear here." />}</div></section>
  </div>;
}

function TransactionRow({ transaction, accountById, categoryById, currency }: { transaction: Transaction; accountById: Record<string, Account>; categoryById: Record<string, Category>; currency: string }) {
  const positive = transaction.type === "income";
  const neutral = ["transfer", "saving", "investment", "installment_purchase"].includes(transaction.type);
  return <div><span className="activity-icon" style={{ background: categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description.slice(0, 1).toUpperCase()}</span><span><strong>{transaction.description}</strong><small>{categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)} · {accountById[transaction.account_id ?? ""]?.name ?? "Plan"}</small></span><b className={positive ? "income" : neutral ? "neutral" : ""}>{positive ? "+" : neutral ? "" : "−"}{formatMoney(transaction.amount_cents, currency)}</b></div>;
}

function TransactionsPage({ context, search, setSearch, onAdd }: { context: Context; search: string; setSearch: (value: string) => void; onAdd: () => void }) {
  const filtered = context.transactions.filter((transaction) => transaction.description.toLowerCase().includes(search.toLowerCase()) || (context.categoryById[transaction.category_id ?? ""]?.name ?? "").toLowerCase().includes(search.toLowerCase()));
  return <section className="page-card"><div className="page-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transactions" /></label><button className="ghost-button" onClick={onAdd}>＋ New transaction</button></div><div className="transaction-table"><div className="table-head"><span>Transaction</span><span>Date</span><span>Account</span><span>Amount</span></div>{filtered.map((transaction) => <div className="table-row" key={transaction.id}><span className="transaction-name"><i style={{ background: context.categoryById[transaction.category_id ?? ""]?.color }}>{transaction.description[0]}</i><span><strong>{transaction.description}</strong><small>{context.categoryById[transaction.category_id ?? ""]?.name ?? typeLabel(transaction.type)}{transaction.committed ? " · Committed" : ""}</small></span></span><span>{shortDate(transaction.date)}</span><span>{context.accountById[transaction.account_id ?? ""]?.name ?? "Plan"}</span><b className={transaction.type === "income" ? "income" : ""}>{transaction.type === "income" ? "+" : transaction.type === "expense" ? "−" : ""}{formatMoney(transaction.amount_cents, context.currency)}</b></div>)}{filtered.length === 0 && <EmptyState title="No transactions found" copy="Add a transaction or try a different search." />}</div></section>;
}

function AccountsPage({ context, onAdd, onArchive }: { context: Context; onAdd: () => void; onArchive: (id: string) => void }) {
  return <><section className="summary-strip"><div><p>NET BALANCE</p><strong>{formatMoney(context.totalBalance, context.currency)}</strong></div><div><p>AVAILABLE CASH</p><strong>{formatMoney(context.spendable, context.currency)}</strong></div><div><p>INSTALLMENT DEBT</p><strong>{formatMoney(context.outstandingInstallments, context.currency)}</strong></div></section><section className="accounts-grid">{context.accounts.map((account) => <article className="account-card" key={account.id} style={{ "--account-color": account.color } as CSSProperties}><div className="account-card-top"><span className="account-icon">{account.type === "cash" ? "¤" : account.type === "investment" ? "↗" : account.type === "savings" ? "◇" : account.type === "credit" ? "▰" : "◫"}</span><button onClick={() => { if (window.confirm(`Archive ${account.name}? Its history will be kept.`)) onArchive(account.id); }}>•••</button></div><p>{typeLabel(account.type)}</p><h3>{account.name}</h3><strong>{formatMoney(account.balance_cents, account.currency)}</strong><small>{account.type === "investment" ? "Raw contributions only" : account.include_spendable ? "Included in available money" : "Excluded from available money"}</small></article>)}<button className="add-card" onClick={onAdd}><span>＋</span><strong>Add custom account</strong><small>Bank, cash, savings, credit, investment, or anything else.</small></button></section></>;
}

function BudgetPage({ context, onEdit }: { context: Context; onEdit: () => void }) {
  return <div className="budget-page"><section className="budget-explainer"><div><p className="eyebrow">ONE PURCHASE, EVERY WINDOW</p><h2>Know what’s left—without counting money twice.</h2><p>Everyday spending updates the daily, weekly, monthly, and general pools together. Committed money stays out of your everyday pace by default.</p></div><button className="primary-button" onClick={onEdit}><span>⚙</span>Edit budget rules</button></section><section className="budget-rule-grid">{context.budgetResults.map((rule) => <article key={rule.id}><span className="budget-period-icon">{rule.period === "daily" ? "D" : rule.period === "weekly" ? "W" : rule.period === "monthly" ? "M" : "∞"}</span><p>{rule.period.toUpperCase()} POOL</p><h3>{formatMoney(Math.max(0, rule.remaining), context.currency, 0)}</h3><small>of {formatMoney(rule.base_cents, context.currency, 0)} base</small><div className="wide-progress"><i style={{ width: `${Math.max(0, Math.min(100, rule.remaining / Math.max(1, rule.base_cents) * 100))}%` }} /></div><div className="rule-note"><span>↻</span><p><strong>{carryLabels[rule.carry_mode]}</strong><small>{rule.carry_mode === "stack_unused" ? "Unused allowance is added to the next period." : rule.carry_mode === "stack_signed" ? "Overspending also follows into the next period." : "This pool follows its own independent rule."}</small></p></div></article>)}</section><section className="cashflow-note"><span>✓</span><div><strong>{formatMoney(context.reservedThisMonth, context.currency)} is already reserved this month</strong><p>Recurring bills and installment payments reduce the month they are due, while the original installment purchase remains visible in spending analytics.</p></div></section></div>;
}

function PlansPage({ context, onAdd, onPay }: { context: Context; onAdd: () => void; onPay: (id: string) => void }) {
  return <div className="plans-layout"><section className="page-card"><div className="section-heading"><div><p>RECURRING</p><h3>Income, bills & auto-invest</h3></div><button className="ghost-button" onClick={onAdd}>＋ Add plan</button></div><div className="plan-list">{context.recurring.map((plan) => <article key={plan.id}><span className={`plan-symbol ${plan.type}`}>{plan.type === "income" ? "+" : plan.type === "investment" ? "↗" : "↻"}</span><span><strong>{plan.title}</strong><small>Every {plan.interval_count > 1 ? `${plan.interval_count} ` : ""}{plan.frequency.replace("ly", "")} · Next {shortDate(plan.next_date)}</small></span><b>{formatMoney(plan.amount_cents, context.currency)}</b><em>{plan.auto_post ? "Auto" : "Confirm"}</em></article>)}{context.recurring.length === 0 && <EmptyState title="No recurring plans yet" copy="Add salary, bills, subscriptions, savings, or auto-invest schedules." />}</div></section><section className="page-card"><div className="section-heading"><div><p>INSTALLMENTS</p><h3>Flexible purchase plans</h3></div><button className="ghost-button" onClick={onAdd}>＋ Add purchase</button></div><div className="installment-list">{context.installmentPlans.map((plan) => { const payments = context.installmentPayments.filter((payment) => payment.plan_id === plan.id); const next = payments.find((payment) => payment.status !== "paid"); const percent = plan.total_cents ? plan.paid_cents / plan.total_cents * 100 : 0; return <article key={plan.id}><div className="installment-top"><span><strong>{plan.title}</strong><small>{plan.provider || "Installment purchase"} · {plan.installment_count} payments</small></span><b>{formatMoney(plan.total_cents - plan.paid_cents, context.currency)} left</b></div><div className="wide-progress"><i style={{ width: `${percent}%` }} /></div><div className="installment-bottom"><span>{Math.round(percent)}% paid</span>{next ? <span>Next: {formatMoney(next.amount_cents, context.currency)} on {shortDate(next.due_date)}</span> : <span>Complete</span>}</div>{next && <button className="text-link" onClick={() => onPay(next.id)}>Mark next payment paid →</button>}</article>})}{context.installmentPlans.length === 0 && <EmptyState title="No installment purchases" copy="Any purchase can have configurable payments and a chosen first due date." />}</div></section></div>;
}

function GoalsPage({ context, onGoal, onSpare, onSweep }: { context: Context; onGoal: () => void; onSpare: () => void; onSweep: () => void }) {
  const destination = context.accountById[context.profile.spare_destination_id ?? ""];
  return <div className="goals-page"><section className="spare-hero"><div><p className="eyebrow">SPARE-CHANGE ACCELERATOR</p><h2>{formatMoney(context.sparePot, context.currency)} waiting</h2><p>Round-ups are multiplied ×{context.profile.spare_multiplier} and collected before moving to {destination?.name ?? "a destination you choose"}.</p><div className="spare-actions"><button className="primary-button" onClick={onSpare}><span>⚙</span>Configure</button><button className="ghost-button" disabled={!context.sparePot || !destination} onClick={onSweep}>Sweep now</button></div></div><div className="spare-orbit"><span>×{context.profile.spare_multiplier}</span><small>{context.profile.spare_sweep_mode}</small></div></section><div className="section-heading goal-heading"><div><p>SAVINGS & RAW INVESTMENTS</p><h3>Your pots and contribution targets</h3></div><button className="ghost-button" onClick={onGoal}>＋ New goal</button></div><section className="goal-grid">{context.goals.map((goal) => { const contributed = goal.account_id ? context.accountById[goal.account_id]?.balance_cents ?? goal.contributed_cents : goal.contributed_cents; const percent = goal.target_cents ? contributed / goal.target_cents * 100 : 0; return <article key={goal.id}><span className="goal-kind">{goal.kind === "investment" ? "RAW INVESTED" : "SAVINGS"}</span><h3>{goal.name}</h3><strong>{formatMoney(contributed, context.currency)}</strong>{goal.target_cents && <><small>of {formatMoney(goal.target_cents, context.currency)}</small><div className="wide-progress"><i style={{ width: `${Math.min(100, percent)}%`, background: goal.color }} /></div><p>{Math.round(percent)}% complete</p></>}</article>})}{context.goals.length === 0 && <button className="add-card" onClick={onGoal}><span>＋</span><strong>Create your first goal</strong><small>Track savings or raw investment contributions without market prices.</small></button>}</section></div>;
}

function SettingsPage({ context, onCategory, onSpare }: { context: Context; onCategory: () => void; onSpare: () => void }) {
  return <div className="settings-grid"><section className="page-card"><div className="section-heading"><div><p>CATEGORIES</p><h3>Custom income & expense labels</h3></div><button className="ghost-button" onClick={onCategory}>＋ Add category</button></div><div className="category-cloud">{context.categories.map((category) => <span key={category.id} style={{ background: category.color }}><i>{category.name[0]}</i>{category.name}<small>{category.kind}</small></span>)}</div></section><section className="page-card setting-stack"><div><span className="setting-icon">¤</span><span><strong>Currency</strong><small>Primary display and manual entry currency</small></span><b>{context.profile.currency}</b></div><button onClick={onSpare}><span className="setting-icon">×{context.profile.spare_multiplier}</span><span><strong>Spare change</strong><small>{context.profile.spare_sweep_mode} · {formatMoney(context.profile.spare_threshold_cents, context.currency)} threshold</small></span><b>→</b></button><div><span className="setting-icon">1</span><span><strong>Week starts</strong><small>Used for weekly budget windows</small></span><b>{context.profile.week_start === 1 ? "Monday" : "Sunday"}</b></div><div><span className="setting-icon">☁</span><span><strong>Cross-device data</strong><small>Stored privately with your ChatGPT sign-in</small></span><b>Active</b></div></section></div>;
}

function FinanceModal({ name, context, busy, close, save }: { name: Exclude<ModalName, null>; context: Context; busy: boolean; close: () => void; save: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [planType, setPlanType] = useState<"recurring" | "installment">("recurring");
  const [transactionType, setTransactionType] = useState("expense");
  const [installmentCount, setInstallmentCount] = useState(3);
  const [installmentTotal, setInstallmentTotal] = useState("");
  const [budgetPeriod, setBudgetPeriod] = useState("daily");

  function submit(action: string, transform?: (values: Record<string, FormDataEntryValue>) => Record<string, unknown>) {
    return async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await save(action, transform ? transform(values) : values);
    };
  }

  const selectedBudget = context.budgets.find((rule) => rule.period === budgetPeriod);
  const moving = ["transfer", "saving", "investment"].includes(transactionType);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal-card" role="dialog" aria-modal="true"><button className="modal-close" onClick={close} aria-label="Close">×</button>
    {name === "transaction" && <><ModalTitle eyebrow="MANUAL ENTRY" title="Add a transaction" copy="One entry updates every relevant balance and budget window."/><form onSubmit={submit("addTransaction", (values) => ({ ...values, type: transactionType, committed: values.committed === "on", useSpare: values.useSpare === "on" }))}><div className="segmented">{["expense", "income", "transfer", "saving", "investment"].map((type) => <button type="button" className={transactionType === type ? "active" : ""} key={type} onClick={() => setTransactionType(type)}>{typeLabel(type)}</button>)}</div><Field label="Description"><input name="description" required placeholder={transactionType === "income" ? "Salary" : "What was it?"}/></Field><div className="form-grid"><Field label="Amount"><input name="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"/></Field><Field label="Date"><input name="date" type="date" defaultValue={context.today} required/></Field></div><Field label={moving ? "From account" : "Account"}><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} · {formatMoney(account.balance_cents, account.currency)}</option>)}</select></Field>{moving && <Field label="To account"><select name="destinationAccountId" required defaultValue=""><option value="" disabled>Choose destination</option>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field>}{!moving && <Field label="Category"><select name="categoryId" defaultValue=""><option value="">Uncategorised</option>{context.categories.filter((category) => category.kind === (transactionType === "income" ? "income" : "expense")).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></Field>}{transactionType === "expense" && <div className="check-stack"><label><input type="checkbox" name="committed"/> This is committed spending; keep it out of daily and weekly pace</label><label><input type="checkbox" name="useSpare" disabled={!context.profile.spare_destination_id}/> Apply ×{context.profile.spare_multiplier} spare change{!context.profile.spare_destination_id ? " (configure a destination first)" : ""}</label></div>}<Submit busy={busy} label="Save transaction"/></form></>}
    {name === "account" && <><ModalTitle eyebrow="CUSTOM ACCOUNT" title="Add where your money lives" copy="Opening balances create a snapshot—not fake income."/><form onSubmit={submit("addAccount", (values) => ({ ...values, includeSpendable: values.includeSpendable === "on" }))}><Field label="Account name"><input name="name" required placeholder="Holiday cash, Revolut, Trading 212…"/></Field><div className="form-grid"><Field label="Type"><select name="type" defaultValue="bank">{["bank", "savings", "cash", "credit", "investment", "wallet", "custom"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select></Field><Field label="Current balance"><input name="balance" type="number" min="0" step="0.01" required placeholder="0.00"/></Field></div><Field label="Credit limit (optional)"><input name="creditLimit" type="number" min="0" step="0.01" placeholder="0.00"/></Field><Field label="Account color"><input name="color" type="color" defaultValue="#1f5b4e"/></Field><label className="single-check"><input type="checkbox" name="includeSpendable" defaultChecked/> Include this balance in available-to-spend money</label><Submit busy={busy} label="Add account"/></form></>}
    {name === "category" && <><ModalTitle eyebrow="CUSTOM CATEGORY" title="Create your own label" copy="Categories organise reports without forcing category budgets."/><form onSubmit={submit("addCategory")}><Field label="Category name"><input name="name" required placeholder="Pets, Side work, Coffee…"/></Field><div className="form-grid"><Field label="Type"><select name="kind"><option value="expense">Expense</option><option value="income">Income</option></select></Field><Field label="Color"><input name="color" type="color" defaultValue="#cfe9d7"/></Field></div><Submit busy={busy} label="Add category"/></form></>}
    {name === "budget" && <><ModalTitle eyebrow="BUDGET RULE" title="Shape each spending window" copy="Every period keeps its own base and carryover behaviour."/><form key={budgetPeriod} onSubmit={submit("updateBudget", (values) => ({ ...values, period: budgetPeriod, anchorDate: context.today }))}><div className="segmented">{["daily", "weekly", "monthly", "general"].map((period) => <button type="button" className={budgetPeriod === period ? "active" : ""} key={period} onClick={() => setBudgetPeriod(period)}>{period}</button>)}</div><Field label="Base allowance"><input name="base" type="number" min="0" step="0.01" defaultValue={(selectedBudget?.base_cents ?? 0) / 100} required/></Field><Field label="Carryover mode"><select name="carryMode" defaultValue={selectedBudget?.carry_mode ?? "reset"}>{Object.entries(carryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="Carryover cap (only used for capped mode)"><input name="carryCap" type="number" min="0" step="0.01" defaultValue={(selectedBudget?.carry_cap_cents ?? 0) / 100}/></Field><Submit busy={busy} label="Update budget"/></form></>}
    {name === "plan" && <><ModalTitle eyebrow="FUTURE MONEY" title="Add a plan" copy="Schedule a repeating item or divide any purchase into installments."/><div className="segmented plan-switch"><button type="button" className={planType === "recurring" ? "active" : ""} onClick={() => setPlanType("recurring")}>Recurring</button><button type="button" className={planType === "installment" ? "active" : ""} onClick={() => setPlanType("installment")}>Installment purchase</button></div>{planType === "recurring" ? <form onSubmit={submit("addRecurring", (values) => ({ ...values, autoPost: values.autoPost === "on", committed: values.committed === "on" }))}><Field label="Plan name"><input name="title" required placeholder="Rent, salary, VWCE auto-invest…"/></Field><div className="form-grid"><Field label="Type"><select name="type"><option value="expense">Expense</option><option value="income">Income</option><option value="saving">Savings transfer</option><option value="investment">Auto-invest</option></select></Field><Field label="Amount"><input name="amount" type="number" min="0.01" step="0.01" required/></Field></div><Field label="Payment account"><select name="accountId" required>{context.accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Frequency"><select name="frequency"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="daily">Daily</option></select></Field><Field label="Next date"><input name="nextDate" type="date" defaultValue={context.today} required/></Field></div><div className="check-stack"><label><input type="checkbox" name="committed" defaultChecked/> Reserve this before calculating spendable money</label><label><input type="checkbox" name="autoPost"/> Add automatically when due</label></div><Submit busy={busy} label="Create recurring plan"/></form> : <form onSubmit={submit("addInstallment", (values) => ({ ...values, total: installmentTotal, installmentCount, includeDailyWeekly: values.includeDailyWeekly === "on" }))}><Field label="Purchase"><input name="title" required placeholder="Laptop, flights, furniture…"/></Field><div className="form-grid"><Field label="Total purchase"><input value={installmentTotal} onChange={(event) => setInstallmentTotal(event.target.value)} type="number" min="0.01" step="0.01" required/></Field><Field label="Number of installments"><input value={installmentCount} onChange={(event) => setInstallmentCount(Number(event.target.value))} type="number" min="2" max="120" required/></Field></div><div className="installment-preview"><span>{Array.from({length: Math.min(6, installmentCount)}).map((_, index) => <i key={index} />)}</span><p>{installmentTotal ? `About ${formatMoney(Math.round(Number(installmentTotal) * 100 / Math.max(1, installmentCount)), context.currency)} each` : "Enter a total to preview payments"}</p></div><div className="form-grid"><Field label="First installment"><input name="firstDueDate" type="date" defaultValue={context.today} required/></Field><Field label="Frequency"><select name="frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></Field></div><Field label="Repayment account"><select name="paymentAccountId" required>{context.accounts.filter((account) => account.type !== "investment").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Provider label (optional)"><input name="provider" placeholder="Klarna, store finance…"/></Field><Field label="Linked credit account (optional)"><select name="linkedCreditAccountId" defaultValue=""><option value="">Standalone plan</option>{context.accounts.filter((account) => account.type === "credit").map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field></div><label className="single-check"><input type="checkbox" name="includeDailyWeekly"/> Include payments in daily and weekly allowance</label><Submit busy={busy} label="Create installment plan"/></form>}</>}
    {name === "spare" && <><ModalTitle eyebrow="SPARE CHANGE" title="Accelerate every round-up" copy="A €3.60 purchase creates €0.40; at ×3 the pot receives €1.20."/><form onSubmit={submit("updateSpare")}><Field label="Multiplier"><select name="multiplier" defaultValue={context.profile.spare_multiplier}>{[1,2,3,4,5,6,8,10].map((value) => <option value={value} key={value}>×{value}</option>)}</select></Field><Field label="Destination"><select name="destinationAccountId" defaultValue={context.profile.spare_destination_id ?? ""} required><option value="" disabled>Choose savings or investment account</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><div className="form-grid"><Field label="Sweep method"><select name="sweepMode" defaultValue={context.profile.spare_sweep_mode}><option value="threshold">At threshold</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="manual">Manually</option></select></Field><Field label="Threshold"><input name="threshold" type="number" min="1" step="1" defaultValue={context.profile.spare_threshold_cents / 100}/></Field></div><Submit busy={busy} label="Save spare-change rule"/></form></>}
    {name === "goal" && <><ModalTitle eyebrow="GOAL OR POT" title="Track purposeful money" copy="Investment goals measure raw cash contributed, never market performance."/><form onSubmit={submit("addGoal")}><Field label="Name"><input name="name" required placeholder="Rainy day, Home deposit, VWCE…"/></Field><div className="form-grid"><Field label="Kind"><select name="kind"><option value="savings">Savings</option><option value="investment">Raw investment</option></select></Field><Field label="Target (optional)"><input name="target" type="number" min="0" step="0.01"/></Field></div><Field label="Linked account (optional)"><select name="accountId" defaultValue=""><option value="">Track independently</option>{context.accounts.filter((account) => ["savings", "investment"].includes(account.type)).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</select></Field><Field label="Already contributed"><input name="contributed" type="number" min="0" step="0.01" defaultValue="0"/></Field><Submit busy={busy} label="Create goal"/></form></>}
  </section></div>;
}

function ModalTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <div className="modal-title"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{copy}</p></div> }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="form-field"><span>{label}</span>{children}</label> }
function Submit({ busy, label }: { busy: boolean; label: string }) { return <button className="primary-button modal-submit" disabled={busy} type="submit">{busy ? "Saving…" : label}<span>→</span></button> }
function EmptyMini({ text }: { text: string }) { return <p className="empty-mini">{text}</p> }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>＋</span><strong>{title}</strong><p>{copy}</p></div> }

function Onboarding({ displayName, busy, onComplete }: { displayName: string; busy: boolean; onComplete: (payload: Record<string, unknown>) => Promise<boolean> }) {
  const [step, setStep] = useState(0);
  const [currency, setCurrency] = useState("EUR");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [accounts, setAccounts] = useState([{ id: crypto.randomUUID(), name: "Main account", type: "bank", balance: "", includeSpendable: true, color: "#1f5b4e" }]);
  const [budgets, setBudgets] = useState({ daily: "50", weekly: "300", monthly: "1200", general: "4000" });
  const [carryModes, setCarryModes] = useState({ daily: "stack_unused", weekly: "stack_unused", monthly: "reset", general: "reset" });

  function updateAccount(id: string, key: string, value: string | boolean) { setAccounts((items) => items.map((item) => item.id === id ? { ...item, [key]: value } : item)); }
  async function finish() { await onComplete({ currency, startDate, weekStart: 1, accounts, budgets, carryModes }); }
  return <main className="onboarding-screen"><aside className="onboarding-aside"><div className="brand-mark"><span>P</span><strong>Pace</strong></div><div><p className="eyebrow">YOUR OPENING SNAPSHOT</p><h1>Start where your money is today.</h1><p>No fake income. No starting from zero. Add what already exists, then Pace takes it from here.</p></div><ol>{["Basics", "Accounts", "Budgets", "Review"].map((label, index) => <li className={step === index ? "active" : step > index ? "done" : ""} key={label}><span>{step > index ? "✓" : index + 1}</span>{label}</li>)}</ol><small>Signed in as {displayName}</small></aside><section className="onboarding-main">
    {step === 0 && <div className="setup-panel"><p className="eyebrow">WELCOME, {displayName.split(" ")[0].toUpperCase()}</p><h2>Let’s set your financial starting line.</h2><p>Choose the few basics Pace needs to organise every amount correctly.</p><div className="setup-form"><Field label="Primary currency"><select value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="EUR">Euro · EUR</option><option value="USD">US dollar · USD</option><option value="GBP">British pound · GBP</option></select></Field><Field label="Opening snapshot date"><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}/></Field><div className="setup-note"><span>✓</span><p><strong>This date is not income.</strong><small>Opening balances stay out of spending and income reports.</small></p></div></div></div>}
    {step === 1 && <div className="setup-panel wide"><p className="eyebrow">FINANCIAL ACCOUNTS</p><h2>Add where your money already lives.</h2><p>Include spending, savings, cash, raw investments, or credit. You can add custom accounts later.</p><div className="setup-accounts">{accounts.map((account, index) => <article key={account.id}><span className="setup-account-number">{index + 1}</span><input aria-label="Account name" value={account.name} onChange={(event) => updateAccount(account.id, "name", event.target.value)} placeholder="Account name"/><select aria-label="Account type" value={account.type} onChange={(event) => { const type = event.target.value; updateAccount(account.id, "type", type); updateAccount(account.id, "includeSpendable", !["savings", "investment", "credit"].includes(type)); }}><option value="bank">Bank</option><option value="savings">Savings</option><option value="cash">Cash</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="wallet">Wallet</option><option value="custom">Custom</option></select><label><span>{currency}</span><input aria-label="Opening balance" type="number" min="0" step="0.01" value={account.balance} onChange={(event) => updateAccount(account.id, "balance", event.target.value)} placeholder="0.00"/></label>{accounts.length > 1 && <button aria-label="Remove account" onClick={() => setAccounts((items) => items.filter((item) => item.id !== account.id))}>×</button>}</article>)}<button className="add-account-line" onClick={() => setAccounts((items) => [...items, { id: crypto.randomUUID(), name: "", type: "bank", balance: "", includeSpendable: true, color: ["#d68b64", "#4c8b98", "#705f83"][items.length % 3] }])}>＋ Add another account</button></div></div>}
    {step === 2 && <div className="setup-panel wide"><p className="eyebrow">PARALLEL BUDGETS</p><h2>Set the pace you want to keep.</h2><p>These windows run together. One everyday purchase updates all of them once.</p><div className="setup-budget-grid">{(["daily", "weekly", "monthly", "general"] as const).map((period) => <article key={period}><span>{period === "daily" ? "D" : period === "weekly" ? "W" : period === "monthly" ? "M" : "∞"}</span><strong>{period}</strong><label><small>Base allowance</small><div><i>{currency}</i><input type="number" min="0" step="1" value={budgets[period]} onChange={(event) => setBudgets((value) => ({ ...value, [period]: event.target.value }))}/></div></label><label><small>Carryover</small><select value={carryModes[period]} onChange={(event) => setCarryModes((value) => ({ ...value, [period]: event.target.value }))}>{Object.entries(carryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></article>)}</div><div className="stack-example"><span>↻</span><p><strong>Your daily stacking example</strong><small>{currency} {budgets.daily || 0} base − {currency} 20 spent = {currency} {Math.max(0, Number(budgets.daily || 0) - 20)} carried. Tomorrow starts with {currency} {Math.max(0, Number(budgets.daily || 0) * 2 - 20)}.</small></p></div></div>}
    {step === 3 && <div className="setup-panel"><p className="eyebrow">READY TO BEGIN</p><h2>Your opening snapshot is set.</h2><p>Pace will create these balances and rules without counting any of them as new activity.</p><div className="review-list"><div><span>◫</span><p><strong>{accounts.length} financial {accounts.length === 1 ? "account" : "accounts"}</strong><small>{accounts.map((account) => account.name || typeLabel(account.type)).join(" · ")}</small></p></div><div><span>◔</span><p><strong>{currency} {budgets.daily} daily pace</strong><small>{carryLabels[carryModes.daily]}</small></p></div><div><span>☁</span><p><strong>Private cross-device space</strong><small>Connected to your ChatGPT sign-in</small></p></div></div></div>}
    <footer className="setup-actions"><button className="ghost-button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>Back</button>{step < 3 ? <button className="primary-button" onClick={() => setStep((value) => value + 1)}>Continue <span>→</span></button> : <button className="primary-button" disabled={busy} onClick={finish}>{busy ? "Creating your space…" : "Open Pace"}<span>→</span></button>}</footer>
  </section></main>;
}
