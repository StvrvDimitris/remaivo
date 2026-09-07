import test from "node:test";
import assert from "node:assert/strict";
import { budgetCountsTransaction, operatingCashEffect } from "../app/transaction-classification.ts";
import { projectBudgetPlan } from "../app/budget-math.ts";
import { buildStatistics } from "../app/statistics.ts";

const rule = { include_everyday: 1, include_committed: 1, include_savings: 1, include_investments: 1, active: 1, base_cents: 100000 };
const repair = { id: "repair", type: "expense", amount_cents: 100000, committed: 0, counts_monthly: 0, date: "2026-09-07", description: "Car repair", account_id: "bank", category_id: null };

test("excluded repair preserves fixed and adaptive budgets but still spends cash", () => {
  assert.equal(operatingCashEffect(repair), -100000);
  for (const mode of ["fixed", "adaptive"]) {
    const input = { monthlyBudget: 100000, daysInMonth: 30, todayIndex: 6, remainingWeekDays: 7, mode, spentBeforeToday: 0, spentToday: 0 };
    const countedSpend = [repair].filter(row => budgetCountsTransaction(rule, row)).reduce((sum, row) => sum + row.amount_cents, 0);
    assert.deepEqual(projectBudgetPlan({ ...input, spentToday: countedSpend }), projectBudgetPlan(input));
  }
  assert.equal(budgetCountsTransaction(rule, { ...repair, committed: 1 }), false);
  assert.equal(budgetCountsTransaction(rule, { ...repair, counts_monthly: 1 }), true);
  assert.equal(budgetCountsTransaction(rule, { type: "expense", amount_cents: 500 }), true);
  for (const type of ["saving", "investment", "installment_payment"]) {
    assert.equal(budgetCountsTransaction(rule, { ...repair, type }), false);
  }
});

test("statistics retain excluded expenses while budget pace ignores them", () => {
  const result = buildStatistics({
    rows: [repair, { ...repair, id: "food", amount_cents: 2000, counts_monthly: 1 }],
    comparisonRows: [],
    filters: { from: "2026-09-01", to: "2026-09-07", comparison: "none", comparisonFrom: null, comparisonTo: null, mode: "spending", accountId: "", categoryId: "", transactionType: "", origin: "", description: "" },
    budget: rule, budgetEligible: true, today: "2026-09-07", currency: "EUR",
  });
  assert.equal(result.summary.spending, 102000);
  assert.equal(result.summary.netOperatingCashFlow, -102000);
  assert.equal(result.budget.spent, 2000);
  assert.equal(result.budget.remaining, 98000);
});
