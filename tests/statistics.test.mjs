import test from "node:test";
import assert from "node:assert/strict";
import { buildStatistics, netSavingsEffect, comparisonRange, shiftCalendarMonth, shiftCalendarYear } from "../app/statistics.ts";
import { reportingClass, parseInvestmentFunding } from "../app/transaction-classification.ts";

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


test('New contributions count saved money once; net savings includes excluded expenses', () => {
 const row=(id,type,amount,extra={})=>({id,type,amount_cents:amount,date:'2026-10-07',description:id,account_id:'main',destination_account_id:'vwce',category_id:null,category_name:null,category_color:null,committed:0,recurring_plan_id:null,...extra});
 const make=rows=>buildStatistics({rows,comparisonRows:[],today:'2026-10-07',currency:'EUR',filters:{from:'2026-10-01',to:'2026-10-31',mode:'cashflow',comparison:'none',comparisonFrom:null,comparisonTo:null,accountId:'',categoryId:'',transactionType:'',origin:'',description:''}}).summary;
 const result=make([row('income','income',100000),row('save','saving',20000),row('invest','investment',10000,{investment_from_savings_cents:10000}),row('expense','expense',85000,{counts_monthly:0})]);
 assert.equal(result.saving,20000);assert.equal(result.investment,10000);assert.equal(result.investmentFromExistingSavings,10000);
 assert.equal(result.savedAndInvested,20000);assert.equal(result.savingsRate,20);assert.equal(result.netSavings,0);assert.equal(result.netSavingsRate,0);assert.equal(result.cashRemaining,-5000);
 const old=make([row('old savings invested','investment',10000,{investment_from_savings_cents:10000})]);
 assert.equal(old.savedAndInvested,0);assert.equal(old.investment,10000);assert.equal(old.savingsRate,null);assert.equal(old.netSavingsRate,null);
 const mixed=make([row('income','income',10000),row('mixed','investment',10000,{investment_from_savings_cents:4000}),row('expense','expense',12000)]);
 assert.equal(mixed.savedAndInvested,6000);assert.equal(mixed.savingsRate,60);assert.equal(mixed.netSavingsRate,0);
});

test('Funding choices support new, existing and mixed with strict cent validation',()=>{
 assert.equal(parseInvestmentFunding('investment',10000,{investmentFunding:'new'}),0);
 assert.equal(parseInvestmentFunding('investment',10000,{investmentFunding:'existing'}),10000);
 assert.equal(parseInvestmentFunding('investment',10000,{investmentFunding:'mixed',existingSavingsAmount:'40.25'}),4025);
 assert.equal(parseInvestmentFunding('expense',10000,{investmentFunding:'existing'}),0);
 for(const amount of ['-1','0','100','101','bad'])assert.throws(()=>parseInvestmentFunding('investment',10000,{investmentFunding:'mixed',existingSavingsAmount:amount}));
});


test('Net savings measures the savings/investment account boundary, regardless of budget or funding tags',()=>{
 const row=(type,amount,from,to=null,extra={})=>({id:type,type,amount_cents:amount,account_id:'from',destination_account_id:to?'to':null,source_account_type:from,destination_account_type:to,date:'2026-10-07',description:type,category_id:null,category_name:null,category_color:null,committed:0,recurring_plan_id:null,...extra});
 const rows=[row('income',100000,'bank'),row('saving',20000,'wallet','savings',{counts_monthly:0}),row('investment',10000,'savings','investment',{investment_from_savings_cents:0}),row('expense',3000,'savings',null,{counts_monthly:0})];
 const filters={from:'2026-10-01',to:'2026-10-31',mode:'cashflow',comparison:'none',comparisonFrom:null,comparisonTo:null,accountId:'',categoryId:'',transactionType:'',origin:'',description:''};
 const result=buildStatistics({rows,comparisonRows:[],filters,today:'2026-10-07',currency:'EUR'}).summary;
 assert.equal(result.netSavings,17000);assert.equal(result.netSavingsRate,17);assert.equal(result.netOperatingCashFlow,97000);
 assert.equal(netSavingsEffect(row('transfer',10000,'bank','savings')),10000);
 assert.equal(netSavingsEffect(row('transfer',10000,'savings','bank')),-10000);
 assert.equal(netSavingsEffect(row('transfer',10000,'savings','savings')),0);
 assert.equal(netSavingsEffect(row('transfer',10000,'investment','savings')),0);
 assert.equal(netSavingsEffect(row('investment',10000,'bank','investment',{investment_from_savings_cents:10000})),10000);
 assert.equal(netSavingsEffect(row('income',2000,'savings')),2000);
 assert.equal(netSavingsEffect(row('fee',100,'investment')),-100);
 assert.equal(netSavingsEffect(row('installment_payment',1000,'savings')),-1000);
 assert.equal(netSavingsEffect(row('installment_purchase',1000,'savings')),0);
 assert.equal(netSavingsEffect(row('expense',1000,'bank')),0);
 const negative=buildStatistics({rows:[rows[0],row('expense',5000,'savings')],comparisonRows:[],filters,today:'2026-10-07',currency:'EUR'}).summary;
 assert.equal(negative.netSavings,-5000);assert.equal(negative.netSavingsRate,-5);
 const noIncome=buildStatistics({rows:[row('expense',5000,'savings')],comparisonRows:[],filters,today:'2026-10-07',currency:'EUR'}).summary;
 assert.equal(noIncome.netSavings,-5000);assert.equal(noIncome.netSavingsRate,null);
});
