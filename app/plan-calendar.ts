import { daysApart, plusDays, weekBeginning, type Occurrence } from './v3-engine';

// A day counts as tight when the plan has less than this many days of usual
// everyday spending left.
const TIGHT_DAYS = 2;
const OPEN = ['upcoming', 'partial'];
const HIDDEN = ['skipped', 'cancelled'];
// The same payments the end-of-plan forecast counts.
const SPENDING = ['expense', 'fee', 'installment_payment', 'saving', 'investment'];

export type PlanCalendarDay = {
  date: string;
  payments: Occurrence[];
  dueCents: number;
  // Expected to be left in the plan after this day. Null for days already past.
  left: number | null;
  state: 'past' | 'ok' | 'tight' | 'over';
};

const remainder = (o: Occurrence) => Math.max(0, o.amount_cents - o.paid_cents);
const consumesPlan = (o: Occurrence) => OPEN.includes(o.status) && o.committed === 1 && o.counts_monthly !== 0 && SPENDING.includes(o.type);

export function planCalendar(input: {
  start: string; end: string; today: string; weekStart: number;
  funding: number; spent: number;
  // Usual everyday spending per day, or null before there's enough history.
  dailyPace: number | null;
  occurrences: Occurrence[];
}) {
  const { start, end, today, weekStart } = input;
  const pace = Math.max(0, input.dailyPace ?? 0);
  const inPeriod = input.occurrences.filter(o => o.due_date >= start && o.due_date < end && !HIDDEN.includes(o.status));
  // Overdue payments still have to be paid, so they count from today onwards.
  const scheduled = input.occurrences.filter(o => consumesPlan(o) && o.due_date < end);
  const dates = Array.from({ length: Math.max(0, Math.min(370, daysApart(start, end))) }, (_, index) => plusDays(start, index));
  const days: PlanCalendarDay[] = dates.map(date => {
    const payments = inPeriod.filter(o => o.due_date === date);
    const dueCents = payments.reduce((sum, o) => sum + (o.type === 'income' ? 0 : OPEN.includes(o.status) ? remainder(o) : o.amount_cents), 0);
    if (date < today) return { date, payments, dueCents, left: null, state: 'past' };
    const due = scheduled.filter(o => o.due_date <= date).reduce((sum, o) => sum + remainder(o), 0);
    const left = input.funding - input.spent - due - pace * daysApart(today, date);
    return { date, payments, dueCents, left, state: left < 0 ? 'over' : left < pace * TIGHT_DAYS ? 'tight' : 'ok' };
  });
  const ahead = days.filter(day => day.left !== null);
  return {
    days,
    // Blank cells before the first day, so dates sit under their weekday.
    leadingBlanks: daysApart(weekBeginning(start, weekStart), start),
    endLeft: ahead.at(-1)?.left ?? null,
    overFrom: ahead.find(day => day.state === 'over')?.date ?? null,
  };
}

// The day to open on: today, or the plan's first day when it hasn't started.
export const openingDay = (start: string, end: string, today: string) => today >= start && today < end ? today : start;
