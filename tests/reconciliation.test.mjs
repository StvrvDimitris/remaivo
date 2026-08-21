import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarInterval, financialToday, outstandingDateInWindow, scheduledOccurrencesThrough } from "../app/finance-dates.ts";

test("financial dates follow the selected timezone, not UTC", () => {
  const instant = new Date("2026-08-21T21:30:00.000Z");
  assert.equal(financialToday("Europe/Athens", instant), "2026-08-22");
  assert.equal(financialToday("America/New_York", instant), "2026-08-21");
});

test("a ten-day absence is fully reconciled in one pass with scheduled dates", () => {
  const result = scheduledOccurrencesThrough("2026-08-12", "daily", 1, "2026-08-21");
  assert.deepEqual(result.occurrences, [
    "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
    "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
  ]);
  assert.equal(result.nextDate, "2026-08-22");
});

test("monthly schedules clamp safely at month end", () => {
  assert.equal(addCalendarInterval("2026-01-31", "monthly", 1), "2026-02-28");
});

test("monthly recurring schedules restore their intended day after short months", () => {
  const result = scheduledOccurrencesThrough("2026-08-31", "monthly", 1, "2027-03-31", null, 31);
  assert.deepEqual(result.occurrences, [
    "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30",
    "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31",
  ]);
});

test("leap-day yearly schedules restore 29 February in leap years", () => {
  const result = scheduledOccurrencesThrough("2024-02-29", "yearly", 1, "2028-02-29", null, 29);
  assert.deepEqual(result.occurrences, ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
});

test("overdue unresolved plans remain reserved in the current window", () => {
  assert.equal(outstandingDateInWindow("2026-08-10", "2026-08-21", "2026-09-01", true), true);
  assert.equal(outstandingDateInWindow("2026-08-10", "2026-08-21", "2026-09-01", false), false);
  assert.equal(outstandingDateInWindow("2026-09-01", "2026-08-21", "2026-09-01", true), false);
});
