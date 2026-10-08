import test from "node:test";
import assert from "node:assert/strict";
import { buildStatistics, comparisonOptions, comparisonRange, effectiveComparison, shiftCalendarMonth, shiftCalendarYear } from "../app/statistics.ts";
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

test("comparisons follow the selected range and never overlap it", () => {
  // "Previous" means the same days so far in the previous day, week, month or year.
  assert.deepEqual(comparisonRange("2026-10-08", "2026-10-08", "previousEquivalent", "today"), { from: "2026-10-07", to: "2026-10-07" });
  assert.deepEqual(comparisonRange("2026-10-05", "2026-10-08", "previousEquivalent", "week"), { from: "2026-09-28", to: "2026-10-01" });
  assert.deepEqual(comparisonRange("2026-10-01", "2026-10-08", "previousEquivalent", "month"), { from: "2026-09-01", to: "2026-09-08" });
  assert.deepEqual(comparisonRange("2026-01-01", "2026-10-08", "previousEquivalent", "year"), { from: "2025-01-01", to: "2025-10-08" });
  assert.deepEqual(comparisonRange("2026-09-09", "2026-10-08", "previousEquivalent", "last30"), { from: "2026-08-10", to: "2026-09-08" });
  // A year compared with "the same dates last month" would mostly compare the year with itself.
  assert.deepEqual(comparisonOptions("year", "2026-01-01", "2026-10-08"), ["previousEquivalent"]);
  assert.equal(effectiveComparison("previousMonth", "year", "2026-01-01", "2026-10-08"), "previousEquivalent");
  assert.deepEqual(comparisonRange("2026-01-01", "2026-10-08", "previousMonth", "year"), { from: "2025-01-01", to: "2025-10-08" });
  assert.deepEqual(comparisonOptions("month", "2026-10-01", "2026-10-08"), ["previousEquivalent", "previousYear"]);
  // Custom ranges only offer shifts that land wholly before the range.
  assert.deepEqual(comparisonOptions("custom", "2026-01-01", "2026-06-30"), ["previousEquivalent", "previousYear"]);
  assert.deepEqual(comparisonOptions("custom", "2025-01-01", "2026-06-30"), ["previousEquivalent"]);
  assert.deepEqual(comparisonOptions("custom", "2026-09-01", "2026-09-20"), ["previousEquivalent", "previousMonth", "previousYear"]);
  for (const period of ["today", "week", "month", "year", "last7", "last30", "custom"]) {
    for (const mode of ["previousEquivalent", "previousMonth", "previousYear"]) {
      const range = comparisonRange("2026-01-01", "2026-10-08", mode, period);
      assert.ok(range.to < "2026-01-01", `${period}/${mode}`);
    }
  }
  assert.equal(comparisonRange("2026-10-01", "2026-10-08", "none", "month"), null);
});

test("statistics separate spending, contributions, cash flow, and market-neutral allocations", () => {
  const row = (id, type, amount_cents, date, category_name = null) => ({ id, type, amount_cents, date, description: id, category_id: category_name, category_name, category_color: null, account_id: "a", destination_account_id: null, committed: 0, recurring_plan_id: null });
  const result = buildStatistics({
    rows: [row("salary", "income", 100000, "2026-08-01", "Salary"), row("food", "expense", 25000, "2026-08-02", "Food"), row("installment", "installment_payment", 10000, "2026-08-03", "Shopping"), row("purchase marker", "installment_purchase", 60000, "2026-08-01"), row("save", "saving", 15000, "2026-08-04"), row("invest", "investment", 10000, "2026-08-05"), row("transfer", "transfer", 50000, "2026-08-06")],
    comparisonRows: [],
    filters: { from: "2026-08-01", to: "2026-08-31", comparison: "none", comparisonFrom: null, comparisonTo: null, mode: "spending", accountId: "", categoryId: "", transactionType: "", origin: "", description: "" },
    today: "2026-08-24",
    currency: "EUR",
  });
  assert.equal(result.summary.income, 100000);
  assert.equal(result.summary.spending, 35000);
  assert.equal(result.summary.netOperatingCashFlow, 65000);
  assert.equal(result.summary.saving, 15000);
  assert.equal(result.summary.investment, 10000);
  assert.equal(result.summary.cashRemaining, 40000);
  assert.equal(result.summary.savingsContributionRate, 15);
  assert.equal(result.summary.investmentContributionRate, 10);
});


test('Contribution amounts and rates stay separate when money is saved then invested or withdrawn',()=>{
 const row=(type,amount_cents)=>({id:type,type,amount_cents,date:'2026-10-07',description:type,account_id:'savings',destination_account_id:'spending',category_id:null,category_name:null,category_color:null,committed:0,recurring_plan_id:null,counts_monthly:0});
 const filters={from:'2026-10-01',to:'2026-10-31',comparison:'none',comparisonFrom:null,comparisonTo:null,mode:'cashflow',accountId:'',categoryId:'',transactionType:'',origin:'',description:''};
 const make=rows=>buildStatistics({rows,comparisonRows:[],filters,today:'2026-10-07',currency:'EUR'}).summary;
 const result=make([row('income',100000),row('saving',20000),row('investment',10000),row('transfer',7500),row('expense',7500)]);
 assert.equal(result.saving,20000);assert.equal(result.investment,10000);
 assert.equal(result.savingsContributionRate,20);assert.equal(result.investmentContributionRate,10);
 assert.equal('savedAndInvested' in result,false);assert.equal('savingsRate' in result,false);
 const noIncome=make([row('saving',20000),row('investment',10000)]);
 assert.equal(noIncome.savingsContributionRate,null);assert.equal(noIncome.investmentContributionRate,null);
 const directIncome=make([row('income',10000)]);assert.equal(directIncome.saving,0);assert.equal(directIncome.savingsContributionRate,0);
});
