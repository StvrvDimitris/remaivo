import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financePageCacheGeneration, invalidateFinancePageCache, readFinancePageCache, writeFinancePageCache } from '../app/finance-page-cache.ts';

test('filtered response cache is keyed by request and invalidated by an authoritative snapshot', () => {
  invalidateFinancePageCache();
  const previous = financePageCacheGeneration();
  const response = { total: 4, items: [{ amount_cents: 1250 }] };
  writeFinancePageCache('transactions?from=2026-09-01', response, previous);
  assert.equal(readFinancePageCache('transactions?from=2026-09-01'), response);
  assert.equal(readFinancePageCache('transactions?from=2026-08-01'), null);

  invalidateFinancePageCache();
  assert.equal(readFinancePageCache('transactions?from=2026-09-01'), null);
  writeFinancePageCache('transactions?from=2026-09-01', response, previous);
  assert.equal(readFinancePageCache('transactions?from=2026-09-01'), null);
});
