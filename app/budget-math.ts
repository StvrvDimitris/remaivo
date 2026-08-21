export type AllocationMode = "fixed" | "adaptive";
export type FixedCarryMode = "reset" | "stack_unused" | "stack_signed" | "stack_capped";

export function splitCents(total: number, parts: number) {
  const count = Math.max(0, Math.trunc(parts));
  if (!count) return [];
  const safeTotal = Math.max(0, Math.trunc(total));
  const base = Math.floor(safeTotal / count);
  const extra = safeTotal - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
}

export function fixedCarryValue(remainder: number, mode: FixedCarryMode, cap: number | null = null) {
  if (mode === "stack_signed") return remainder;
  if (mode === "stack_unused") return Math.max(0, remainder);
  if (mode === "stack_capped") return Math.min(Math.max(0, cap ?? 0), Math.max(0, remainder));
  return 0;
}

export type BudgetProjectionInput = {
  monthlyBudget: number;
  daysInMonth: number;
  todayIndex: number;
  remainingWeekDays: number;
  mode: AllocationMode;
  carryMode?: FixedCarryMode;
  carryCap?: number | null;
  resetStartIndex?: number;
  spentBeforeToday: number;
  spentSinceResetBeforeToday?: number;
  spentToday: number;
  reservedMonth?: number;
  reservedToday?: number;
  reservedRemainingWeek?: number;
};

export function projectBudgetPlan(input: BudgetProjectionInput) {
  const todayIndex = Math.max(0, Math.min(input.daysInMonth - 1, input.todayIndex));
  const daysRemaining = Math.max(1, input.daysInMonth - todayIndex);
  const reservedMonth = Math.max(0, input.reservedMonth ?? 0);
  const monthlyRemaining = input.monthlyBudget - input.spentBeforeToday - input.spentToday - reservedMonth;

  if (input.mode === "adaptive") {
    const poolAtStartOfToday = Math.max(0, input.monthlyBudget - input.spentBeforeToday - reservedMonth);
    const projectedDays = splitCents(poolAtStartOfToday, daysRemaining);
    const dailyBase = projectedDays[0] ?? 0;
    const weeklyBase = projectedDays.slice(0, Math.max(1, input.remainingWeekDays)).reduce((sum, value) => sum + value, 0);
    return {
      dailyBase,
      carry: 0,
      dailyRemaining: dailyBase - input.spentToday,
      weeklyBase,
      weeklyRemaining: weeklyBase - input.spentToday,
      monthlyRemaining,
      poolAtStartOfToday,
      projectedMonthRemaining: projectedDays.reduce((sum, value) => sum + value, 0) - input.spentToday,
      projectedDays,
    };
  }

  const allocations = splitCents(input.monthlyBudget, input.daysInMonth);
  const resetStart = Math.max(0, Math.min(todayIndex, input.resetStartIndex ?? todayIndex));
  const allocatedSinceReset = allocations.slice(resetStart, todayIndex).reduce((sum, value) => sum + value, 0);
  const carry = fixedCarryValue(
    allocatedSinceReset - (input.spentSinceResetBeforeToday ?? 0),
    input.carryMode ?? "reset",
    input.carryCap,
  );
  const dailyBase = allocations[todayIndex] ?? 0;
  const weeklyBase = allocations.slice(todayIndex, todayIndex + Math.max(1, input.remainingWeekDays)).reduce((sum, value) => sum + value, 0);
  return {
    dailyBase,
    carry,
    dailyRemaining: dailyBase + carry - input.spentToday - Math.max(0, input.reservedToday ?? 0),
    weeklyBase,
    weeklyRemaining: weeklyBase + carry - input.spentToday - Math.max(0, input.reservedRemainingWeek ?? 0),
    monthlyRemaining,
    poolAtStartOfToday: input.monthlyBudget - input.spentBeforeToday - reservedMonth,
    projectedMonthRemaining: allocations.slice(todayIndex).reduce((sum, value) => sum + value, 0) + carry - input.spentToday - reservedMonth,
    projectedDays: allocations.slice(todayIndex),
  };
}
