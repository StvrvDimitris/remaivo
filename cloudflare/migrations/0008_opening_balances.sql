-- Record each existing account's starting balance (current balance minus every posted
-- movement) as an opening-balance entry. Account balances are unchanged.
INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly)
SELECT 'opening:' || id, user_id,
  CASE WHEN opening < 0 THEN id END,
  CASE WHEN opening > 0 THEN id END,
  'opening_balance', 'Opening balance', ABS(opening), opened, 0, 0
FROM (
  SELECT a.id, a.user_id,
    a.balance_cents - COALESCE((
      SELECT SUM(
        CASE WHEN t.account_id = a.id THEN CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END ELSE 0 END
        + CASE WHEN t.destination_account_id = a.id AND t.type IN ('transfer', 'saving', 'investment') THEN t.amount_cents ELSE 0 END)
      FROM transactions t
      WHERE t.user_id = a.user_id AND t.status = 'posted' AND (t.account_id = a.id OR t.destination_account_id = a.id)
    ), 0) AS opening,
    MIN(substr(a.created_at, 1, 10), COALESCE((
      SELECT MIN(t.date) FROM transactions t
      WHERE t.user_id = a.user_id AND t.status = 'posted' AND (t.account_id = a.id OR t.destination_account_id = a.id)
    ), substr(a.created_at, 1, 10))) AS opened
  FROM accounts a
)
WHERE opening != 0;
