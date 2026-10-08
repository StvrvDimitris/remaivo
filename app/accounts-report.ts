import { accountFlow, type InvestmentValuationSnapshot } from "./investment-valuations";

// Balance report for whole months or years. Balances come from the account
// ledger: today's balance minus every posted entry after the date in question.

export type ReportAccount = { id: string; name: string; type: string; balance_cents: number; archived: number; created_at: string; color?: string };
export type ReportTransaction = { id: string; type: string; amount_cents: number; date: string; account_id: string | null; destination_account_id: string | null };
export type ReportGroupId = "cash" | "savings" | "investments" | "credit";
export type FlowBreakdown = { income: number; spending: number; transfers: number; adjustments: number; opening: number; total: number };
export type AccountsReportAccount = { id: string; name: string; type: string; color?: string; archived: boolean; start: number; end: number; in: FlowBreakdown; out: FlowBreakdown };
export type AccountsReportGroup = { id: ReportGroupId; start: number; end: number; in: number; out: number; accounts: AccountsReportAccount[] };
export type AccountsReport = {
  period: { kind: "month" | "year"; key: string; from: string; to: string; partial: boolean };
  firstDate: string | null;
  netWorth: { start: number; end: number; change: number };
  bridge: { income: number; spending: number; saved: number; adjustments: number; accountsAdded: number };
  rates: { savedPercent: number | null; invested: number; investedPercent: number | null };
  groups: AccountsReportGroup[];
  groupFlows: { from: ReportGroupId; to: ReportGroupId; amount: number }[];
  investments: { id: string; name: string; start: number; added: number; end: number; estimatedValue: number | null; snapshotDate: string | null }[];
};

const groupOrder: ReportGroupId[] = ["cash", "savings", "investments", "credit"];
const movementTypes = new Set(["transfer", "saving", "investment"]);
export const reportGroup = (type: string): ReportGroupId => type === "savings" ? "savings" : type === "investment" ? "investments" : type === "credit" ? "credit" : "cash";
const emptyFlow = (): FlowBreakdown => ({ income: 0, spending: 0, transfers: 0, adjustments: 0, opening: 0, total: 0 });

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// "2026-10" is a month and "2026" a year; anything else falls back to the current month.
export function reportPeriod(key: string | null, today: string) {
  const year = /^\d{4}$/.test(key ?? "") ? key! : null;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(key ?? "") ? key! : null;
  const kind: "month" | "year" = year ? "year" : "month";
  const requested = year ?? month ?? today.slice(0, 7);
  const resolved = requested > today.slice(0, kind === "year" ? 4 : 7) ? today.slice(0, kind === "year" ? 4 : 7) : requested;
  const from = kind === "year" ? `${resolved}-01-01` : `${resolved}-01`;
  const next = kind === "year" ? `${Number(resolved) + 1}-01-01` : addDays(`${resolved}-28`, 4).slice(0, 7) + "-01";
  const end = addDays(next, -1);
  return { kind, key: resolved, from, to: end < today ? end : today, partial: end >= today };
}

function classify(transaction: ReportTransaction): keyof Omit<FlowBreakdown, "total"> | null {
  if (transaction.type === "income") return "income";
  if (transaction.type === "opening_balance") return "opening";
  if (transaction.type === "balance_adjustment") return "adjustments";
  if (movementTypes.has(transaction.type)) return "transfers";
  if (transaction.type === "expense" || transaction.type === "installment_payment") return "spending";
  return null;
}

export function buildAccountsReport(input: {
  period: ReturnType<typeof reportPeriod>;
  accounts: ReportAccount[];
  transactions: ReportTransaction[]; // posted entries dated on or after period.from (or an earlier snapshot)
  snapshots: InvestmentValuationSnapshot[];
  firstDate: string | null;
}): AccountsReport {
  const { period } = input;
  const byId = new Map(input.accounts.map(account => [account.id, account]));
  const rows = input.accounts.map(account => {
    let after = 0;
    const inFlow = emptyFlow(), outFlow = emptyFlow();
    for (const transaction of input.transactions) {
      if (transaction.account_id !== account.id && transaction.destination_account_id !== account.id) continue;
      const flow = accountFlow(transaction, account.id);
      if (transaction.date > period.to) { after += flow; continue; }
      if (transaction.date < period.from) continue;
      const kind = classify(transaction);
      if (!kind || !flow) continue;
      const side = flow > 0 ? inFlow : outFlow;
      side[kind] += Math.abs(flow);
      side.total += Math.abs(flow);
    }
    const end = Number(account.balance_cents) - after;
    const start = end - inFlow.total + outFlow.total;
    return { id: account.id, name: account.name, type: account.type, color: account.color, archived: account.archived === 1, start, end, in: inFlow, out: outFlow };
  }).filter(row => {
    const account = byId.get(row.id)!;
    const active = row.in.total || row.out.total || row.start || row.end;
    return active || (!row.archived && account.created_at.slice(0, 10) <= period.to);
  });

  const groups = groupOrder.map(id => {
    const accounts = rows.filter(row => reportGroup(row.type) === id);
    return {
      id, accounts,
      start: accounts.reduce((sum, row) => sum + row.start, 0),
      end: accounts.reduce((sum, row) => sum + row.end, 0),
      in: accounts.reduce((sum, row) => sum + row.in.total, 0),
      out: accounts.reduce((sum, row) => sum + row.out.total, 0),
    };
  }).filter(group => group.accounts.length);

  const sum = (pick: (row: AccountsReportAccount) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const income = sum(row => row.in.income);
  const spending = sum(row => row.out.spending);
  const adjustments = sum(row => row.in.adjustments - row.out.adjustments);
  const accountsAdded = sum(row => row.in.opening - row.out.opening);
  const start = sum(row => row.start), end = sum(row => row.end);

  // Movements between your own accounts, summarised by account group. Same-group moves cancel out.
  const flows = new Map<string, number>();
  let invested = 0;
  for (const transaction of input.transactions) {
    if (!movementTypes.has(transaction.type) || transaction.date < period.from || transaction.date > period.to) continue;
    const source = byId.get(transaction.account_id ?? ""), destination = byId.get(transaction.destination_account_id ?? "");
    if (!source || !destination) continue;
    const from = reportGroup(source.type), to = reportGroup(destination.type);
    if (from === to) continue;
    flows.set(`${from}>${to}`, (flows.get(`${from}>${to}`) ?? 0) + Number(transaction.amount_cents));
    if (to === "investments") invested += Number(transaction.amount_cents);
  }
  const groupFlows = [...flows].map(([key, amount]) => {
    const [from, to] = key.split(">") as [ReportGroupId, ReportGroupId];
    return { from, to, amount };
  }).sort((left, right) => right.amount - left.amount);

  const investments = rows.filter(row => row.type === "investment").map(row => {
    const snapshot = input.snapshots
      .filter(item => item.account_id === row.id && item.snapshot_date <= period.to)
      .sort((left, right) => right.snapshot_date.localeCompare(left.snapshot_date) || right.created_at.localeCompare(left.created_at))[0];
    const flowsAfterSnapshot = snapshot ? input.transactions
      .filter(transaction => transaction.date > snapshot.snapshot_date && transaction.date <= period.to)
      .reduce((total, transaction) => total + accountFlow(transaction, row.id), 0) : 0;
    return {
      id: row.id, name: row.name, start: row.start, end: row.end,
      added: row.in.transfers - row.out.transfers,
      estimatedValue: snapshot ? Number(snapshot.value_cents) + flowsAfterSnapshot : null,
      snapshotDate: snapshot?.snapshot_date ?? null,
    };
  });

  return {
    period, firstDate: input.firstDate,
    netWorth: { start, end, change: end - start },
    bridge: { income, spending, saved: income - spending, adjustments, accountsAdded },
    rates: { savedPercent: income > 0 ? (income - spending) / income * 100 : null, invested, investedPercent: income > 0 ? invested / income * 100 : null },
    groups, groupFlows, investments,
  };
}
