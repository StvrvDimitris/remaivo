import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const scratch = path.resolve('work/plan-calendar-tests');
fs.mkdirSync(scratch, { recursive: true });
for (const [source, name] of [['finance-dates', 'finance-dates'], ['v3-engine', 'v3-engine'], ['plan-calendar', 'plan-calendar']]) {
  const text = fs.readFileSync(`app/${source}.ts`, 'utf8').replace(/from '\.\/(finance-dates|v3-engine)'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(scratch, `${name}.mjs`), ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { planCalendar, openingDay } = await import(pathToFileURL(path.join(scratch, 'plan-calendar.mjs')));

const payment = (due_date, amount_cents, extra = {}) => ({ id: `${due_date}-${amount_cents}`, due_date, amount_cents, paid_cents: 0, type: 'expense', status: 'upcoming', committed: 1, counts_monthly: 1, ...extra });
const plan = (extra = {}) => planCalendar({ start: '2026-11-01', end: '2026-12-01', today: '2026-11-04', weekStart: 1, funding: 100000, spent: 20000, dailyPace: 1000, occurrences: [], ...extra });
const day = (calendar, date) => calendar.days.find(entry => entry.date === date);

test('Each day shows what the plan expects to have left', () => {
  const calendar = plan({ occurrences: [payment('2026-11-05', 30000), payment('2026-11-10', 10000)] });
  assert.equal(day(calendar, '2026-11-04').left, 80000);
  assert.equal(day(calendar, '2026-11-05').left, 80000 - 30000 - 1000);
  assert.equal(day(calendar, '2026-11-09').left, 80000 - 30000 - 5000);
  assert.equal(day(calendar, '2026-11-10').left, 80000 - 40000 - 6000);
  assert.equal(calendar.endLeft, 80000 - 40000 - 26000);
});

test('Past days have no forecast and today has no extra everyday spending', () => {
  const calendar = plan();
  assert.equal(day(calendar, '2026-11-03').left, null);
  assert.equal(day(calendar, '2026-11-03').state, 'past');
  assert.equal(day(calendar, '2026-11-04').left, 80000);
});

test('Only the unpaid part of a partly paid payment comes off the plan', () => {
  const calendar = plan({ dailyPace: 0, occurrences: [payment('2026-11-05', 30000, { paid_cents: 10000, status: 'partial' })] });
  assert.equal(day(calendar, '2026-11-05').left, 60000);
  assert.equal(day(calendar, '2026-11-05').dueCents, 20000);
});

test('Overdue payments count against the plan from today', () => {
  const calendar = plan({ dailyPace: 0, occurrences: [payment('2026-11-02', 5000)] });
  assert.equal(day(calendar, '2026-11-04').left, 75000);
  assert.equal(day(calendar, '2026-11-02').payments.length, 1);
});

test('Money the plan does not budget is shown but never deducted', () => {
  const occurrences = [
    payment('2026-11-05', 180000, { type: 'income', id: 'salary' }),
    payment('2026-11-06', 1000, { counts_monthly: 0, id: 'outside' }),
    payment('2026-11-07', 1000, { committed: 0, id: 'uncommitted' }),
    payment('2026-11-08', 1000, { status: 'paid', id: 'paid' }),
    payment('2026-11-09', 1000, { status: 'skipped', id: 'skipped' }),
    payment('2026-11-10', 1000, { status: 'cancelled', id: 'cancelled' }),
  ];
  const calendar = plan({ dailyPace: 0, occurrences });
  assert.equal(calendar.endLeft, 80000);
  assert.equal(day(calendar, '2026-11-05').payments[0].id, 'salary');
  assert.equal(day(calendar, '2026-11-05').dueCents, 0);
  assert.equal(day(calendar, '2026-11-08').payments[0].id, 'paid');
  assert.equal(day(calendar, '2026-11-09').payments.length, 0);
  assert.equal(day(calendar, '2026-11-10').payments.length, 0);
  assert.equal(day(calendar, '2026-11-10').dueCents, 0);
});

test('Payments after the plan ends stay out of it', () => {
  const calendar = plan({ dailyPace: 0, occurrences: [payment('2026-12-01', 50000)] });
  assert.equal(calendar.endLeft, 80000);
  assert.equal(calendar.days.length, 30);
});

test('Days turn tight, then over, and the first day over is reported', () => {
  const calendar = plan({ spent: 50000, dailyPace: 2000 });
  assert.equal(day(calendar, '2026-11-04').state, 'ok');
  assert.equal(day(calendar, '2026-11-17').left, 50000 - 26000);
  assert.equal(day(calendar, '2026-11-27').state, 'ok');
  assert.equal(day(calendar, '2026-11-28').left, 2000);
  assert.equal(day(calendar, '2026-11-28').state, 'tight');
  assert.equal(day(calendar, '2026-11-29').left, 0);
  assert.equal(day(calendar, '2026-11-30').state, 'over');
  assert.equal(calendar.overFrom, '2026-11-30');
});

test('Without spending history only scheduled payments are counted, with no false alarm', () => {
  const calendar = plan({ dailyPace: null });
  assert.equal(calendar.endLeft, 80000);
  assert.equal(calendar.days.filter(entry => ['tight', 'over'].includes(entry.state)).length, 0);
});

test('A plan period that does not start on a Monday lines up under its weekday', () => {
  assert.equal(plan().leadingBlanks, 6);
  assert.equal(plan({ weekStart: 0 }).leadingBlanks, 0);
  assert.equal(plan({ start: '2026-11-25', end: '2026-12-25', today: '2026-11-25' }).days.length, 30);
});

test('The calendar opens on today, or on the first day of another period', () => {
  assert.equal(openingDay('2026-11-01', '2026-12-01', '2026-11-04'), '2026-11-04');
  assert.equal(openingDay('2026-12-01', '2027-01-01', '2026-11-04'), '2026-12-01');
});
