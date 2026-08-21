export function adaptiveRemainingAllocation(sourceAllocation: number, countedSpent: number, planned: number, remainingDays: number, windowDays: number) {
  if (remainingDays <= 0 || windowDays <= 0) return 0;
  const remainingPool = Math.max(0, sourceAllocation - countedSpent - planned);
  return Math.round(remainingPool * Math.min(windowDays, remainingDays) / remainingDays);
}

export function fixedSplitAllocation(parentAllocation: number, divisions: number) {
  return Math.max(0, Math.round(parentAllocation / Math.max(1, divisions)));
}

export function calendarWeekSegmentsInMonth(value: string, weekStart: number) {
  const date = new Date(`${value.slice(0, 7)}-01T12:00:00Z`);
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 12));
  const offset = (date.getUTCDay() - weekStart + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  let segments = 0;
  while (date < monthEnd) {
    segments += 1;
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return segments;
}

export function stackedWindowValue(bases: number[], deductions: number[], carryMode: string, carryCap: number | null = null) {
  if (!bases.length) return { currentBase: 0, carry: 0, allocation: 0, remaining: 0 };
  let carry = 0;
  for (let index = 0; index < bases.length - 1; index += 1) {
    const remainder = bases[index] + carry - (deductions[index] ?? 0);
    if (carryMode === "stack_signed") carry = remainder;
    else if (carryMode === "stack_unused" || carryMode === "manual") carry = Math.max(0, remainder);
    else if (carryMode === "stack_capped") carry = Math.min(carryCap ?? bases[index], Math.max(0, remainder));
    else carry = 0;
  }
  const currentBase = bases.at(-1) ?? 0;
  const allocation = currentBase + carry;
  return { currentBase, carry, allocation, remaining: allocation - (deductions.at(-1) ?? 0) };
}
