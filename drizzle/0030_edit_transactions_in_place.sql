-- Transactions are now edited in place and deleted outright, so the hidden
-- copies that corrections used to leave behind are removed with anything still
-- pointing at them. They never counted towards balances, budgets or reports.
DELETE FROM spare_events WHERE transaction_id IN (SELECT id FROM transactions WHERE status <> 'posted');--> statement-breakpoint
DELETE FROM v3_assignments WHERE transaction_id IN (SELECT id FROM transactions WHERE status <> 'posted');--> statement-breakpoint
DELETE FROM v3_payment_links WHERE transaction_id IN (SELECT id FROM transactions WHERE status <> 'posted');--> statement-breakpoint
DELETE FROM transactions WHERE status <> 'posted';--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN replaces_transaction_id;
