import assert from "node:assert/strict";
import test from "node:test";
import { projectBudgetPlan, splitCents } from "../app/budget-math.ts";

test("fixed allocations are immutable calendar-day slices that sum to the monthly budget", () => {
  const days = splitCents(310000, 31);
  assert.equal(days.length, 31);
  assert.equal(days.reduce((sum, value) => sum + value, 0), 310000);
  assert.deepEqual(days, Array(31).fill(10000));
});

test("August 21 fixed signed carry reconciles daily, weekly, and monthly views", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "fixed", carryMode: "stack_signed", resetStartIndex: 0,
    spentBeforeToday: 195000, spentSinceResetBeforeToday: 195000, spentToday: 3000,
  });
  assert.equal(result.dailyBase, 10000);
  assert.equal(result.carry, 5000);
  assert.equal(result.dailyRemaining, 12000);
  assert.equal(result.weeklyBase, 30000);
  assert.equal(result.weeklyRemaining, 32000);
  assert.equal(result.monthlyRemaining, 112000);
  assert.equal(result.dailyRemaining + 10 * 10000, result.monthlyRemaining);
});

test("adaptive base is frozen from the start-of-day pool and today's spending is subtracted once", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "adaptive", spentBeforeToday: 200000, spentToday: 3000,
  });
  assert.equal(result.poolAtStartOfToday, 110000);
  assert.equal(result.dailyBase, 10000);
  assert.equal(result.dailyRemaining, 7000);
  assert.equal(result.weeklyBase, 30000);
  assert.equal(result.weeklyRemaining, 27000);
  assert.equal(result.monthlyRemaining, 107000);
  assert.equal(result.projectedMonthRemaining, result.monthlyRemaining);
});

test("adaptive day recalculates from corrected history but not from today's spending", () => {
  const common = {
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "adaptive",
  };
  const original = projectBudgetPlan({ ...common, spentBeforeToday: 200000, spentToday: 3000 });
  const moreToday = projectBudgetPlan({ ...common, spentBeforeToday: 200000, spentToday: 9000 });
  const correctedHistory = projectBudgetPlan({ ...common, spentBeforeToday: 190000, spentToday: 3000 });

  assert.equal(original.dailyBase, moreToday.dailyBase);
  assert.equal(moreToday.dailyRemaining, original.dailyRemaining - 6000);
  assert.notEqual(correctedHistory.dailyBase, original.dailyBase);
});

test("adaptive week uses the previous-week cutoff while current-week spending only reduces remaining", () => {
  const common = {
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "adaptive", spentBeforeToday: 195000, spentToday: 3000,
    weekStartIndex: 16, weekDaysInMonth: 7, spentBeforeWeek: 160000,
  };
  const original = projectBudgetPlan({ ...common, spentThisWeek: 38000 });
  const moreThisWeek = projectBudgetPlan({ ...common, spentThisWeek: 44000 });
  const correctedEarlierWeek = projectBudgetPlan({ ...common, spentBeforeWeek: 150000, spentThisWeek: 38000 });

  assert.equal(original.weeklyBase, 70000);
  assert.equal(original.weeklyRemaining, 32000);
  assert.equal(moreThisWeek.weeklyBase, original.weeklyBase);
  assert.equal(moreThisWeek.weeklyRemaining, original.weeklyRemaining - 6000);
  assert.notEqual(correctedEarlierWeek.weeklyBase, original.weeklyBase);
});

test("the current August 21 Remaivo figures reconcile from €382.19 and €11.88 posted", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 38219, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "adaptive", spentBeforeToday: 888, spentToday: 300,
  });
  assert.equal(result.dailyBase, 3394);
  assert.equal(result.dailyRemaining, 3094);
  assert.equal(result.weeklyBase, 10182);
  assert.equal(result.weeklyRemaining, 9882);
  assert.equal(result.monthlyRemaining, 37031);
  assert.equal(result.projectedMonthRemaining, result.monthlyRemaining);
});

test("adaptive reservations reduce the pool once and never become a second weekly deduction", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "adaptive", spentBeforeToday: 170000, spentToday: 3000, reservedMonth: 30000,
  });
  assert.equal(result.poolAtStartOfToday, 110000);
  assert.equal(result.dailyBase, 10000);
  assert.equal(result.weeklyRemaining, 27000);
  assert.equal(result.monthlyRemaining, 107000);
});

test("fixed daily reserves the month while weekly subtracts only commitments due this week", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 108077, daysInMonth: 30, todayIndex: 0, remainingWeekDays: 6,
    mode: "fixed", carryMode: "stack_signed", resetStartIndex: 0,
    spentBeforeToday: 0, spentSinceResetBeforeToday: 0, spentToday: 1980,
    reservedMonth: 18860, reservedToday: 0, reservedRemainingWeek: 0,
  });
  assert.equal(result.dailyBase, 2974);
  assert.equal(result.dailyRemaining, 994);
  assert.equal(result.weeklyBase, 21618);
  assert.equal(result.weeklyRemaining, 19638);
  assert.equal(result.monthlyRemaining, 87237);
});

test("fixed weekly view subtracts commitments due inside the week without changing daily", () => {
  const result = projectBudgetPlan({
    monthlyBudget: 108077, daysInMonth: 30, todayIndex: 0, remainingWeekDays: 6,
    mode: "fixed", carryMode: "reset", resetStartIndex: 0,
    spentBeforeToday: 0, spentSinceResetBeforeToday: 0, spentToday: 0,
    reservedMonth: 18860, reservedToday: 2100, reservedRemainingWeek: 2100,
  });
  assert.equal(result.dailyBase, 2974);
  assert.equal(result.dailyRemaining, 2974);
  assert.equal(result.weeklyRemaining, 19518);
});

test("daily and weekly reset boundaries only carry allocations earned inside that boundary", () => {
  const dailyReset = projectBudgetPlan({
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "fixed", carryMode: "stack_signed", resetStartIndex: 20,
    spentBeforeToday: 195000, spentSinceResetBeforeToday: 0, spentToday: 3000,
  });
  const weeklyReset = projectBudgetPlan({
    monthlyBudget: 310000, daysInMonth: 31, todayIndex: 20, remainingWeekDays: 3,
    mode: "fixed", carryMode: "stack_signed", resetStartIndex: 16,
    spentBeforeToday: 195000, spentSinceResetBeforeToday: 35000, spentToday: 3000,
  });
  assert.equal(dailyReset.carry, 0);
  assert.equal(weeklyReset.carry, 5000);
});
