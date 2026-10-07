export type ReportingClass = "income" | "spending" | "saving" | "investment" | "transfer" | "purchase_marker" | "excluded";
export type StatisticsMode = "spending" | "income" | "cashflow";

export type ClassifiableTransaction = {
  type: string;
  amount_cents: number;
  committed?: number;
  counts_monthly?: number;
  investment_from_savings_cents?: number;
};

export function investmentFromSavings(transaction: ClassifiableTransaction) {
  return transaction.type === "investment" ? Math.max(0, Math.min(transaction.amount_cents, Number(transaction.investment_from_savings_cents) || 0)) : 0;
}

// Funding is explicit and persisted; account labels never rewrite history.
export function parseInvestmentFunding(type: string, amount: number, payload: Record<string, unknown>, fallback = 0) {
  const invalid = (message: string): never => { const error = new Error(message); error.name = "InvestmentFundingError"; throw error; };
  if (type !== "investment") return 0;
  if (payload.investmentFunding === undefined) return Math.max(0, Math.min(amount, fallback));
  if (payload.investmentFunding === "new") return 0;
  if (payload.investmentFunding === "existing") return amount;
  if (payload.investmentFunding !== "mixed") return invalid("Choose how this investment is funded.");
  const value = Math.round(Number(payload.existingSavingsAmount) * 100);
  if (!Number.isSafeInteger(value) || value <= 0 || value >= amount) return invalid("Existing savings must be greater than zero and less than the investment amount.");
  return value;
}

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
