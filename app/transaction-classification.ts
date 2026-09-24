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
