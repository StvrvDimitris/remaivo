import assert from "node:assert/strict";
import test from "node:test";
import { accountFlow, calculateInvestmentValue, latestInvestmentSnapshot } from "../app/investment-valuations.ts";

const snapshot = (id, date, value, createdAt = `${date} 12:00:00`) => ({
  id,
  account_id: "invest-1",
  snapshot_date: date,
  value_cents: value,
  note: null,
  created_at: createdAt,
});

const transaction = (type, amount, date, accountId, destinationAccountId = null) => ({
  type,
  amount_cents: amount,
  date,
  account_id: accountId,
  destination_account_id: destinationAccountId,
});

test("without a snapshot the estimate is exactly the raw invested amount", () => {
  const result = calculateInvestmentValue({ accountId: "invest-1", rawInvested: 125000, transactions: [], snapshots: [] });
  assert.equal(result.estimatedCurrentValue, 125000);
  assert.equal(result.movement, 0);
  assert.equal(result.movementPercent, 0);
  assert.equal(result.latestSnapshot, null);
});

test("the newest dated snapshot supersedes every older valuation", () => {
  const olderCreatedLater = snapshot("older", "2026-08-01", 80000, "2026-08-20 15:00:00");
  const newer = snapshot("newer", "2026-08-15", 110000, "2026-08-15 12:00:00");
  assert.equal(latestInvestmentSnapshot([olderCreatedLater, newer], "invest-1")?.id, "newer");
});

test("same-date activity is excluded while later contributions and withdrawals move the estimate 1:1", () => {
  const transactions = [
    transaction("investment", 20000, "2026-08-15", "cash", "invest-1"),
    transaction("investment", 30000, "2026-08-16", "cash", "invest-1"),
    transaction("transfer", 5000, "2026-08-17", "invest-1", "cash"),
  ];
  const result = calculateInvestmentValue({
    accountId: "invest-1",
    rawInvested: 125000,
    transactions,
    snapshots: [snapshot("latest", "2026-08-15", 110000), snapshot("old", "2026-07-31", 70000)],
  });
  assert.equal(result.flowsAfterSnapshot, 25000);
  assert.equal(result.estimatedCurrentValue, 135000);
  assert.equal(result.movement, 10000);
  assert.equal(result.movementPercent, 8);
});

test("account flows follow the ledger sign for income, spending, contributions, and withdrawals", () => {
  assert.equal(accountFlow(transaction("income", 10000, "2026-08-20", "invest-1"), "invest-1"), 10000);
  assert.equal(accountFlow(transaction("expense", 1200, "2026-08-20", "invest-1"), "invest-1"), -1200);
  assert.equal(accountFlow(transaction("investment", 5000, "2026-08-20", "cash", "invest-1"), "invest-1"), 5000);
  assert.equal(accountFlow(transaction("transfer", 2500, "2026-08-20", "invest-1", "cash"), "invest-1"), -2500);
});

test("movement percentage is undefined when raw invested is zero", () => {
  const result = calculateInvestmentValue({ accountId: "invest-1", rawInvested: 0, transactions: [], snapshots: [snapshot("zero-base", "2026-08-15", 10000)] });
  assert.equal(result.estimatedCurrentValue, 10000);
  assert.equal(result.movement, 10000);
  assert.equal(result.movementPercent, null);
});
