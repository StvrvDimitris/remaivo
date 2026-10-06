import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinanceRefreshPolicy, FINANCE_FRESH_MS, FINANCE_IDLE_MS, snapshotChanged } from '../app/finance-refresh.ts';

const day = '2026-10-06';
test('Active use makes at most twelve automatic refreshes per hour after initial load', () => {
  const policy = new FinanceRefreshPolicy(0);
  assert.equal(policy.due(0, true, day), true);
  policy.attempted(0); policy.succeeded(0, day);
  let requests = 0;
  for (let now = 30_000; now <= 60 * 60_000; now += 30_000) {
    policy.activity(now);
    if (policy.due(now, true, day)) { requests++; policy.attempted(now); policy.succeeded(now, day); }
  }
  assert.equal(requests, 12);
});

test('Idle and hidden pages make no periodic requests; returning only refreshes stale state', () => {
  const policy = new FinanceRefreshPolicy(0); policy.attempted(0); policy.succeeded(0, day);
  assert.equal(policy.due(FINANCE_IDLE_MS + 1, true, day), false);
  assert.equal(policy.due(60 * 60_000, true, day), false);
  policy.activity(FINANCE_FRESH_MS - 1);
  assert.equal(policy.due(FINANCE_FRESH_MS - 1, true, day), false);
  assert.equal(policy.due(FINANCE_FRESH_MS, false, day), false);
  assert.equal(policy.due(FINANCE_FRESH_MS, true, day), true);
  policy.attempted(FINANCE_FRESH_MS); policy.succeeded(FINANCE_FRESH_MS, day);
  for (let now = FINANCE_FRESH_MS + 1000; now < 2 * FINANCE_FRESH_MS; now += 1000) {
    policy.activity(now); assert.equal(policy.due(now, true, day), false);
  }
});

test('The financial day reconciles once even while idle; failed requests are rate limited', () => {
  const policy = new FinanceRefreshPolicy(0); policy.attempted(0); policy.succeeded(0, day);
  const now = 24 * 60 * 60_000;
  assert.equal(policy.due(now, false, '2026-10-07'), false);
  assert.equal(policy.due(now, true, '2026-10-07'), true);
  policy.attempted(now);
  assert.equal(policy.due(now + 30_000, true, '2026-10-07'), false);
  assert.equal(policy.due(now + 60_000, true, '2026-10-07'), true);
  policy.succeeded(now + 60_000, '2026-10-07');
  assert.equal(policy.due(now + FINANCE_FRESH_MS, true, '2026-10-07'), false);
});

test('A successful save restarts freshness and unchanged snapshots are recognized without losing fields', () => {
  const policy = new FinanceRefreshPolicy(0); policy.succeeded(FINANCE_FRESH_MS - 100, day); policy.activity(FINANCE_FRESH_MS);
  assert.equal(policy.due(FINANCE_FRESH_MS, true, day), false);
  const data = { today: day, accounts: [{balance_cents:68338}], goals: [{baseline_cents:1000}] };
  const initial = snapshotChanged(null, data);
  assert.equal(initial.changed, true);
  assert.equal(snapshotChanged(initial.fingerprint, structuredClone(data)).changed, false);
  assert.equal(snapshotChanged(initial.fingerprint, {...data, today:'2026-10-07'}).changed, true);
  assert.equal(snapshotChanged(initial.fingerprint, {...data, accounts:[{balance_cents:68638}]}).changed, true);
});
