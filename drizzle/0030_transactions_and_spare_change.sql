-- Spare change no longer collects in a pot to be swept later: each purchase
-- posts its own round-up transfer. Any round-ups still waiting in a pot are
-- moved to savings now as one "Spare change" transfer, as a sweep would have.
INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly)
SELECT lower(hex(randomblob(16))), p.user_id, s.id, d.id, CASE WHEN d.type = 'investment' THEN 'investment' ELSE 'saving' END, 'Spare change', pot.amount, date('now'), 1, 1
FROM profiles p
JOIN (SELECT user_id, SUM(multiplied_cents) AS amount FROM spare_events WHERE status = 'pending' GROUP BY user_id) pot ON pot.user_id = p.user_id AND pot.amount > 0
JOIN accounts s ON s.id = p.spare_source_id AND s.user_id = p.user_id AND s.archived = 0
JOIN accounts d ON d.id = p.spare_destination_id AND d.user_id = p.user_id AND d.archived = 0 AND d.id <> s.id;--> statement-breakpoint
UPDATE accounts SET balance_cents = balance_cents - (
  SELECT SUM(e.multiplied_cents) FROM spare_events e
  JOIN profiles p ON p.user_id = e.user_id
  JOIN accounts d ON d.id = p.spare_destination_id AND d.user_id = p.user_id AND d.archived = 0
  WHERE e.status = 'pending' AND p.spare_source_id = accounts.id AND p.user_id = accounts.user_id AND d.id <> accounts.id
) WHERE archived = 0 AND EXISTS (
  SELECT 1 FROM spare_events e
  JOIN profiles p ON p.user_id = e.user_id
  JOIN accounts d ON d.id = p.spare_destination_id AND d.user_id = p.user_id AND d.archived = 0
  WHERE e.status = 'pending' AND e.multiplied_cents > 0 AND p.spare_source_id = accounts.id AND p.user_id = accounts.user_id AND d.id <> accounts.id
);--> statement-breakpoint
UPDATE accounts SET balance_cents = balance_cents + (
  SELECT SUM(e.multiplied_cents) FROM spare_events e
  JOIN profiles p ON p.user_id = e.user_id
  JOIN accounts s ON s.id = p.spare_source_id AND s.user_id = p.user_id AND s.archived = 0
  WHERE e.status = 'pending' AND p.spare_destination_id = accounts.id AND p.user_id = accounts.user_id AND s.id <> accounts.id
) WHERE archived = 0 AND EXISTS (
  SELECT 1 FROM spare_events e
  JOIN profiles p ON p.user_id = e.user_id
  JOIN accounts s ON s.id = p.spare_source_id AND s.user_id = p.user_id AND s.archived = 0
  WHERE e.status = 'pending' AND e.multiplied_cents > 0 AND p.spare_destination_id = accounts.id AND p.user_id = accounts.user_id AND s.id <> accounts.id
);--> statement-breakpoint
-- Transactions are now edited in place and deleted outright, so the hidden
-- copies that corrections used to leave behind are removed with anything still
-- pointing at them. They never counted towards balances, budgets or reports.
DELETE FROM v3_assignments WHERE transaction_id IN (SELECT id FROM transactions WHERE status <> 'posted');--> statement-breakpoint
DELETE FROM v3_payment_links WHERE transaction_id IN (SELECT id FROM transactions WHERE status <> 'posted');--> statement-breakpoint
DELETE FROM transactions WHERE status <> 'posted';--> statement-breakpoint
DROP TABLE spare_events;--> statement-breakpoint
ALTER TABLE profiles DROP COLUMN spare_auto_sweep_threshold_cents;--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN replaces_transaction_id;--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN spare_change_cents;--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN spare_excluded;
