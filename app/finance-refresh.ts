export const FINANCE_FRESH_MS = 5 * 60_000;
export const FINANCE_IDLE_MS = 2 * 60_000;
const RETRY_MS = 60_000;

// The timer checks this locally; it does not itself make a network request.
export class FinanceRefreshPolicy {
  private lastAttempt = -Infinity;
  private lastSuccess = -Infinity;
  private lastActivity: number;
  private date: string | null = null;
  constructor(now: number) { this.lastActivity = now; }
  activity(now: number) { this.lastActivity = now; }
  attempted(now: number) { this.lastAttempt = now; }
  succeeded(now: number, date: string) { this.lastSuccess = now; this.date = date; }
  due(now: number, visible: boolean, date: string) {
    if (!visible || now - this.lastAttempt < RETRY_MS) return false;
    // Reconcile the new financial day even if the visible page is idle.
    if (this.date !== null && this.date !== date) return true;
    return now - this.lastActivity <= FINANCE_IDLE_MS && now - this.lastSuccess >= FINANCE_FRESH_MS;
  }
}

export function snapshotChanged(previous: string | null, next: unknown) {
  const fingerprint = JSON.stringify(next);
  return { changed: previous !== fingerprint, fingerprint };
}
