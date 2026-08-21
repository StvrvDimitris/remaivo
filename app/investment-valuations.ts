export type InvestmentFlow = {
  account_id: string | null;
  destination_account_id: string | null;
  type: string;
  amount_cents: number;
  date: string;
};

export type InvestmentValuationSnapshot = {
  id: string;
  account_id: string;
  snapshot_date: string;
  value_cents: number;
  note: string | null;
  created_at: string;
};

export type InvestmentValueMetrics = {
  rawInvested: number;
  estimatedCurrentValue: number;
  movement: number;
  movementPercent: number | null;
  latestSnapshot: InvestmentValuationSnapshot | null;
  flowsAfterSnapshot: number;
};

const movementTypes = new Set(["transfer", "saving", "investment"]);

export function accountFlow(transaction: InvestmentFlow, accountId: string) {
  const amount = Number(transaction.amount_cents) || 0;
  let flow = 0;

  if (transaction.type === "income") {
    if (transaction.account_id === accountId) flow += amount;
    return flow;
  }

  if (movementTypes.has(transaction.type)) {
    if (transaction.account_id === accountId) flow -= amount;
    if (transaction.destination_account_id === accountId) flow += amount;
    return flow;
  }

  if (transaction.account_id === accountId) flow -= amount;
  return flow;
}

export function latestInvestmentSnapshot(snapshots: InvestmentValuationSnapshot[], accountId: string) {
  return snapshots
    .filter((snapshot) => snapshot.account_id === accountId)
    .sort((left, right) =>
      right.snapshot_date.localeCompare(left.snapshot_date)
      || right.created_at.localeCompare(left.created_at)
      || right.id.localeCompare(left.id)
    )[0] ?? null;
}

export function calculateInvestmentValue(input: {
  accountId: string;
  rawInvested: number;
  transactions: InvestmentFlow[];
  snapshots: InvestmentValuationSnapshot[];
}): InvestmentValueMetrics {
  const latestSnapshot = latestInvestmentSnapshot(input.snapshots, input.accountId);
  const flowsAfterSnapshot = latestSnapshot
    ? input.transactions
      .filter((transaction) => transaction.date > latestSnapshot.snapshot_date)
      .reduce((sum, transaction) => sum + accountFlow(transaction, input.accountId), 0)
    : 0;
  const estimatedCurrentValue = latestSnapshot
    ? Number(latestSnapshot.value_cents) + flowsAfterSnapshot
    : input.rawInvested;
  const movement = estimatedCurrentValue - input.rawInvested;

  return {
    rawInvested: input.rawInvested,
    estimatedCurrentValue,
    movement,
    movementPercent: input.rawInvested !== 0 ? movement / input.rawInvested * 100 : null,
    latestSnapshot,
    flowsAfterSnapshot,
  };
}
