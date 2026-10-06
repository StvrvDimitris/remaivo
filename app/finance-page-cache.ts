// Keep recently visited filtered pages responsive without changing their calculations.
// Saves and changed snapshots invalidate these responses immediately. Unchanged
// refreshes retain them until expiry, including historical data not in a snapshot.
import { FINANCE_FRESH_MS } from "./finance-refresh.ts";
const MAX_AGE_MS = FINANCE_FRESH_MS;
const entries = new Map<string, { value: unknown; savedAt: number }>();
let generation = 0;

export function financePageCacheGeneration() {
  return generation;
}

export function readFinancePageCache<T>(key: string): T | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt >= MAX_AGE_MS) {
    entries.delete(key);
    return null;
  }
  return entry.value as T;
}

export function writeFinancePageCache<T>(key: string, value: T, requestGeneration: number) {
  // An older request must not repopulate the cache after a save or refresh.
  if (requestGeneration === generation) entries.set(key, { value, savedAt: Date.now() });
}

export function invalidateFinancePageCache() {
  generation += 1;
  entries.clear();
}
