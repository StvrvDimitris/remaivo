import { env } from 'cloudflare:workers';

// The insert claims the pending total; all balance changes and event consumption
// happen in the same atomic batch, so repeated syncs cannot sweep it twice.
export async function sweepSpare(user: string, today: string, automatic = false): Promise<boolean> {
  const transactionId = crypto.randomUUID();
  const autoGuard = automatic
    ? 'AND profile.spare_enabled = 1 AND profile.spare_auto_sweep_threshold_cents > 0 AND pending.amount >= profile.spare_auto_sweep_threshold_cents'
    : '';
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly)
      SELECT ?, ?, source.id, destination.id, CASE WHEN destination.type = 'investment' THEN 'investment' ELSE 'saving' END, 'Spare change sweep', pending.amount, ?, 1, 1
      FROM (SELECT COALESCE(SUM(multiplied_cents), 0) AS amount FROM spare_events WHERE user_id = ? AND status = 'pending') pending
      JOIN profiles profile ON profile.user_id = ?
      JOIN accounts source ON source.id = profile.spare_source_id AND source.user_id = profile.user_id AND source.archived = 0 AND source.type NOT IN ('investment', 'credit')
      JOIN accounts destination ON destination.id = profile.spare_destination_id AND destination.user_id = profile.user_id AND destination.archived = 0 AND destination.type IN ('savings', 'investment')
      WHERE pending.amount > 0 AND source.balance_cents >= pending.amount AND source.id <> destination.id ${autoGuard}`)
      .bind(transactionId, user, today, user, user),
    env.DB.prepare('UPDATE accounts SET balance_cents = balance_cents - (SELECT amount_cents FROM transactions WHERE id = ? AND user_id = ?) WHERE id = (SELECT account_id FROM transactions WHERE id = ? AND user_id = ?) AND user_id = ?')
      .bind(transactionId, user, transactionId, user, user),
    env.DB.prepare('UPDATE accounts SET balance_cents = balance_cents + (SELECT amount_cents FROM transactions WHERE id = ? AND user_id = ?) WHERE id = (SELECT destination_account_id FROM transactions WHERE id = ? AND user_id = ?) AND user_id = ?')
      .bind(transactionId, user, transactionId, user, user),
    env.DB.prepare("UPDATE spare_events SET status = 'swept' WHERE user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ?)")
      .bind(user, transactionId, user),
  ]);
  return Number(results[0].meta.changes) > 0;
}

export async function autoSweepSpare(user: string, today: string): Promise<boolean> {
  // Avoid a write batch on ordinary syncs when automatic sweeps are off or
  // the threshold has not been reached. The batch rechecks this condition.
  const eligible = await env.DB.prepare(`SELECT user_id FROM profiles
    WHERE user_id = ? AND spare_enabled = 1 AND spare_auto_sweep_threshold_cents > 0
      AND (SELECT COALESCE(SUM(multiplied_cents), 0) FROM spare_events WHERE user_id = ? AND status = 'pending') >= spare_auto_sweep_threshold_cents`)
    .bind(user, user).first();
  return eligible ? sweepSpare(user, today, true) : false;
}
