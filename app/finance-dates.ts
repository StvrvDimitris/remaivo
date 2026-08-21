export type ScheduleFrequency = "daily" | "weekly" | "monthly" | "yearly";

function dateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isoDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function financialToday(timeZone: string, now = new Date()) {
  const safeZone = validTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function addCalendarInterval(dateValue: string, frequency: string, interval = 1, anchorDay?: number | null) {
  const { year, month, day } = dateParts(dateValue);
  const count = Math.max(1, Math.trunc(interval) || 1);
  if (frequency === "daily") return isoDate(year, month, day + count);
  if (frequency === "weekly") return isoDate(year, month, day + (7 * count));

  const monthOffset = frequency === "yearly" ? 12 * count : count;
  const targetIndex = (year * 12) + (month - 1) + monthOffset;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = (targetIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const intendedDay = Math.max(1, Math.min(31, Math.trunc(anchorDay ?? day) || day));
  return isoDate(targetYear, targetMonth, Math.min(intendedDay, lastDay));
}

export function scheduledOccurrencesThrough(
  nextDate: string,
  frequency: string,
  interval: number,
  throughDate: string,
  endDate?: string | null,
  anchorDay?: number | null,
  maximum = 50_000,
) {
  const occurrences: string[] = [];
  let cursor = nextDate;
  while (cursor <= throughDate && (!endDate || cursor <= endDate)) {
    if (occurrences.length >= maximum) throw new Error("Automatic reconciliation exceeded its safety limit.");
    occurrences.push(cursor);
    const following = addCalendarInterval(cursor, frequency, interval, anchorDay);
    if (following <= cursor) throw new Error("Automatic reconciliation could not advance the schedule.");
    cursor = following;
  }
  return { occurrences, nextDate: cursor, ended: Boolean(endDate && cursor > endDate) };
}

export function outstandingDateInWindow(date: string, start: string, end: string, includeOverdue = false) {
  return date < end && (date >= start || includeOverdue);
}
