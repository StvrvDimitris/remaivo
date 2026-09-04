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

export function protectedCalendarAllocations(monthlyBudget: number, reservedMonth: number, daysInMonth: number) {
  return splitCents(Math.max(0, Math.trunc(monthlyBudget) - Math.max(0, Math.trunc(reservedMonth))), daysInMonth);
}

export function protectedCalendarWindow(monthlyBudget: number, reservedMonth: number, daysInMonth: number, startIndex: number, dayCount: number) {
  const allocations = protectedCalendarAllocations(monthlyBudget, reservedMonth, daysInMonth);
  const start = Math.max(0, Math.trunc(startIndex));
  return allocations.slice(start, start + Math.max(0, Math.trunc(dayCount))).reduce((sum, value) => sum + value, 0);
}

export function outstandingReserve(target: number, spent: number, status: "open" | "finished" = "open") {
  if (status === "finished") return 0;
  return Math.max(0, Math.trunc(target) - Math.max(0, Math.trunc(spent)));
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
  weekStartIndex?: number;
  weekDaysInMonth?: number;
  spentBeforeWeek?: number;
  spentThisWeek?: number;
  reservedMonth?: number;
  reservedFromWeekStart?: number;
  weeklySpreadReserve?: number;
  reservedRemainingWeek?: number;
};

export type AdaptivePeriodProjectionInput = {
  monthlyBudget: number;
  daysInMonth: number;
  boundaryIndex: number;
  periodDays: number;
  spentBeforeBoundary: number;
  spentInPeriod: number;
  reservedFromBoundary?: number;
};

export function projectAdaptivePeriod(input: AdaptivePeriodProjectionInput) {
  const boundaryIndex = Math.max(0, Math.min(input.daysInMonth - 1, input.boundaryIndex));
  const daysRemaining = Math.max(1, input.daysInMonth - boundaryIndex);
  const reservedFromBoundary = Math.max(0, input.reservedFromBoundary ?? 0);
  const poolAtBoundary = Math.max(0, input.monthlyBudget - input.spentBeforeBoundary - reservedFromBoundary);
  const projectedDays = splitCents(poolAtBoundary, daysRemaining);
  const base = projectedDays.slice(0, Math.max(1, input.periodDays)).reduce((sum, value) => sum + value, 0);
  return {
    base,
    remaining: base - input.spentInPeriod,
    poolAtBoundary,
    projectedDays,
  };
}

export function projectBudgetPlan(input: BudgetProjectionInput) {
  const todayIndex = Math.max(0, Math.min(input.daysInMonth - 1, input.todayIndex));
  const reservedMonth = Math.max(0, input.reservedMonth ?? 0);
  const monthlyRemaining = input.monthlyBudget - input.spentBeforeToday - input.spentToday - reservedMonth;

  if (input.mode === "adaptive") {
    const daily = projectAdaptivePeriod({
      monthlyBudget: input.monthlyBudget,
      daysInMonth: input.daysInMonth,
      boundaryIndex: todayIndex,
      periodDays: 1,
      spentBeforeBoundary: input.spentBeforeToday,
      spentInPeriod: input.spentToday,
      reservedFromBoundary: reservedMonth,
    });
    const weekly = projectAdaptivePeriod({
      monthlyBudget: input.monthlyBudget,
      daysInMonth: input.daysInMonth,
      boundaryIndex: input.weekStartIndex ?? todayIndex,
      periodDays: input.weekDaysInMonth ?? input.remainingWeekDays,
      spentBeforeBoundary: input.spentBeforeWeek ?? input.spentBeforeToday,
      spentInPeriod: input.spentThisWeek ?? input.spentToday,
      reservedFromBoundary: input.reservedFromWeekStart ?? reservedMonth,
    });
    return {
      dailyBase: daily.base,
      carry: 0,
      dailyRemaining: daily.remaining,
      weeklyBase: weekly.base,
      weeklyRemaining: weekly.remaining,
      monthlyRemaining,
      poolAtStartOfToday: daily.poolAtBoundary,
      poolAtStartOfWeek: weekly.poolAtBoundary,
      projectedMonthRemaining: daily.projectedDays.reduce((sum, value) => sum + value, 0) - input.spentToday,
      projectedDays: daily.projectedDays,
    };
  }

  // Fixed Daily protects every outstanding monthly commitment before slicing.
  // Fixed Weekly spreads only undated flexible reserves across the month, then
  // deducts dated payments and installments when they fall inside the week.
  const discretionaryAllocations = protectedCalendarAllocations(input.monthlyBudget, reservedMonth, input.daysInMonth);
  const weeklyAllocations = protectedCalendarAllocations(input.monthlyBudget, Math.max(0, input.weeklySpreadReserve ?? 0), input.daysInMonth);
  const resetStart = Math.max(0, Math.min(todayIndex, input.resetStartIndex ?? todayIndex));
  const allocatedSinceReset = discretionaryAllocations.slice(resetStart, todayIndex).reduce((sum, value) => sum + value, 0);
  const carry = fixedCarryValue(
    allocatedSinceReset - (input.spentSinceResetBeforeToday ?? 0),
    input.carryMode ?? "reset",
    input.carryCap,
  );
  const dailyBase = discretionaryAllocations[todayIndex] ?? 0;
  const weeklyBase = weeklyAllocations.slice(todayIndex, todayIndex + Math.max(1, input.remainingWeekDays)).reduce((sum, value) => sum + value, 0);
  return {
    dailyBase,
    carry,
    dailyRemaining: dailyBase + carry - input.spentToday,
    weeklyBase,
    weeklyRemaining: weeklyBase + carry - input.spentToday - Math.max(0, input.reservedRemainingWeek ?? 0),
    monthlyRemaining,
    poolAtStartOfToday: input.monthlyBudget - input.spentBeforeToday - reservedMonth,
    projectedMonthRemaining: discretionaryAllocations.slice(todayIndex).reduce((sum, value) => sum + value, 0) + carry - input.spentToday,
    projectedDays: discretionaryAllocations.slice(todayIndex),
  };
}
