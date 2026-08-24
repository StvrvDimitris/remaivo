import test from "node:test";
import assert from "node:assert/strict";
import { buildStatistics, comparisonRange, shiftCalendarMonth, shiftCalendarYear } from "../app/statistics.ts";
import { reportingClass } from "../app/transaction-classification.ts";

test("canonical reporting classes prevent installment and transfer double counting", () => {
  assert.equal(reportingClass("expense"), "spending");
  assert.equal(reportingClass("installment_payment"), "spending");
  assert.equal(reportingClass("installment_purchase"), "purchase_marker");
  assert.equal(reportingClass("saving"), "saving");
  assert.equal(reportingClass("investment"), "investment");
  assert.equal(reportingClass("transfer"), "transfer");
});

test("comparison ranges use inclusive equal periods and clamped calendar shifts", () => {
  assert.deepEqual(comparisonRange("2026-08-01", "2026-08-20", "previousEquivalent"), { from: "2026-07-12", to: "2026-07-31" });
  assert.deepEqual(comparisonRange("2026-07-25", "2026-08-10", "previousMonth"), { from: "2026-06-25", to: "2026-07-10" });
  assert.equal(shiftCalendarMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftCalendarYear("2028-02-29", -1), "2027-02-28");
});

test("statistics separate spending, contributions, cash flow, and market-neutral allocations", () => {
  const row = (id, type, amount_cents, date, category_name = null) => ({ id, type, amount_cents, date, description: id, category_id: category_name, category_name, category_color: null, account_id: "a", destination_account_id: null, committed: 0, recurring_plan_id: null });
  const result = buildStatistics({
    rows: [row("salary", "income", 100000, "2026-08-01", "Salary"), row("food", "expense", 25000, "2026-08-02", "Food"), row("installment", "installment_payment", 10000, "2026-08-03", "Shopping"), row("purchase marker", "installment_purchase", 60000, "2026-08-01"), row("save", "saving", 15000, "2026-08-04"), row("invest", "investment", 10000, "2026-08-05"), row("transfer", "transfer", 50000, "2026-08-06")],
    comparisonRows: [],
    filters: { from: "2026-08-01", to: "2026-08-31", comparison: "none", comparisonFrom: null, comparisonTo: null, mode: "spending", accountId: "", categoryId: "", transactionType: "", origin: "", description: "" },
    budget: null,
    budgetEligible: false,
    today: "2026-08-24",
    currency: "EUR",
  });
  assert.equal(result.summary.income, 100000);
  assert.equal(result.summary.spending, 35000);
  assert.equal(result.summary.netOperatingCashFlow, 65000);
  assert.equal(result.summary.savedAndInvested, 25000);
  assert.equal(result.summary.cashRemaining, 40000);
  assert.equal(result.summary.savingsRate, 25);
});
