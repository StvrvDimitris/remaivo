export type ReportingClass = "income" | "spending" | "saving" | "investment" | "transfer" | "purchase_marker" | "excluded";
export type StatisticsMode = "spending" | "income" | "cashflow";

export type ClassifiableTransaction = {
  type: string;
  amount_cents: number;
  committed?: number;
  counts_monthly?: number;
};

export function reportingClass(type: string): ReportingClass {
  if (type === "income") return "income";
  if (type === "expense" || type === "installment_payment") return "spending";
  if (type === "saving") return "saving";
  if (type === "investment") return "investment";
  if (type === "transfer") return "transfer";
  if (type === "installment_purchase") return "purchase_marker";
  return "excluded";
}

export function includedInMode(type: string, mode: StatisticsMode) {
  const classification = reportingClass(type);
  if (mode === "spending") return classification === "spending";
  if (mode === "income") return classification === "income";
  return classification === "income" || classification === "spending" || classification === "saving" || classification === "investment";
}

export function operatingCashEffect(transaction: ClassifiableTransaction) {
  const classification = reportingClass(transaction.type);
  if (classification === "income") return Number(transaction.amount_cents) || 0;
  if (classification === "spending") return -(Number(transaction.amount_cents) || 0);
  return 0;
}

export function budgetCountsTransaction(rule: {
  include_everyday: number;
  include_committed: number;
  include_savings: number;
  include_investments: number;
}, transaction: ClassifiableTransaction) {
  // The monthly pool also supplies the daily and weekly budget views.
  if (transaction.counts_monthly === 0) return false;
  const classification = reportingClass(transaction.type);
  if (classification === "spending") {
    if (transaction.type === "installment_payment" || Number(transaction.committed) === 1) return rule.include_committed === 1;
    return rule.include_everyday === 1;
  }
  if (classification === "saving") return rule.include_savings === 1;
  if (classification === "investment") return rule.include_investments === 1;
  return false;
}
