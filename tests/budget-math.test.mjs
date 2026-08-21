import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveRemainingAllocation, calendarWeekSegmentsInMonth, fixedSplitAllocation, stackedWindowValue } from "../app/budget-math.ts";

test("adaptive budgets redistribute the remaining monthly pool over the days left", () => {
  const monthlyBase = 38219;
  const countedTransactions = 1188;
  const daysLeftIncludingToday = 11;

  assert.equal(adaptiveRemainingAllocation(monthlyBase, countedTransactions, 0, daysLeftIncludingToday, 1), 3366);
  assert.equal(adaptiveRemainingAllocation(monthlyBase, countedTransactions, 0, daysLeftIncludingToday, 3), 10099);
  assert.equal(adaptiveRemainingAllocation(monthlyBase, countedTransactions, 0, daysLeftIncludingToday, 7), 23565);
});

test("fixed split keeps using the original parent allocation", () => {
  const calendarWeeks = calendarWeekSegmentsInMonth("2026-08-21", 1);
  assert.equal(calendarWeeks, 6);
  assert.equal(fixedSplitAllocation(38219, calendarWeeks), 6370);
  assert.equal(fixedSplitAllocation(6370, 7), 910);
});

test("weekly stack_signed carry starts at the monthly reset boundary", () => {
  const adaptive = stackedWindowValue([2466, 8630, 8630, 8630], [0, 0, 0, 1188], "stack_signed");
  assert.deepEqual(adaptive, { currentBase: 8630, carry: 19726, allocation: 28356, remaining: 27168 });

  const fixed = stackedWindowValue([6370, 6370, 6370, 6370], [0, 0, 0, 1188], "stack_signed");
  assert.deepEqual(fixed, { currentBase: 6370, carry: 19110, allocation: 25480, remaining: 24292 });
});

test("daily modes consume the carried weekly state without double-counting transactions", () => {
  assert.equal(adaptiveRemainingAllocation(28356, 1188, 0, 3, 1), 9056);
  const fixedFromAdaptiveWeek = fixedSplitAllocation(28356, 7);
  const adaptiveWeekDaily = stackedWindowValue(Array(5).fill(fixedFromAdaptiveWeek), [0, 0, 0, 888, 300], "stack_signed");
  assert.deepEqual(adaptiveWeekDaily, { currentBase: 4051, carry: 15316, allocation: 19367, remaining: 19067 });

  assert.equal(adaptiveRemainingAllocation(25480, 1188, 0, 3, 1), 8097);
  const fixedFromFixedWeek = fixedSplitAllocation(25480, 7);
  const fixedWeekDaily = stackedWindowValue(Array(5).fill(fixedFromFixedWeek), [0, 0, 0, 888, 300], "stack_signed");
  assert.deepEqual(fixedWeekDaily, { currentBase: 3640, carry: 13672, allocation: 17312, remaining: 17012 });
});
