export type SpareSettings = {
  spare_enabled: number;
  spare_source_id: string | null;
  spare_destination_id: string | null;
  spare_multiplier: number;
};

// Round-ups are earned only by expenses on the configured spending account.
export function spareRoundUpCents(
  amountCents: number,
  sourceAccountId: string | null,
  excluded: boolean,
  settings: SpareSettings | null,
): number {
  if (!settings || settings.spare_enabled !== 1 || excluded ||
      !sourceAccountId || sourceAccountId !== settings.spare_source_id ||
      !settings.spare_destination_id || settings.spare_destination_id === sourceAccountId ||
      !Number.isSafeInteger(amountCents) || amountCents <= 0) return 0;
  const base = (100 - (amountCents % 100)) % 100;
  return base * Math.max(1, Math.min(20, Math.trunc(settings.spare_multiplier || 1)));
}

type Prepared<T> = { bind: (...values: unknown[]) => T };

// Each round-up is posted at once as its own transfer from the spending account
// to the savings or investment destination, next to the purchase that earned
// it. The two are not linked: editing or deleting the purchase leaves the
// round-up alone. Every statement runs only if the purchase row exists, so the
// round-up shares the purchase's batch and its fate.
export function spareTransferStatements<T>(prepare: (sql: string) => Prepared<T>, input: {
  userId: string; purchaseId: string; amount: number; date: string; description: string;
  sourceId: string; destinationId: string; destinationType: string;
}): T[] {
  const purchase = "EXISTS (SELECT 1 FROM transactions WHERE id = ? AND user_id = ?)";
  const type = input.destinationType === "investment" ? "investment" : "saving";
  return [
    prepare(`INSERT INTO transactions (id, user_id, account_id, destination_account_id, type, description, amount_cents, date, committed, counts_monthly) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, 1 WHERE ${purchase}`)
      .bind(crypto.randomUUID(), input.userId, input.sourceId, input.destinationId, type, `Spare change: ${input.description}`.slice(0, 160), input.amount, input.date, input.purchaseId, input.userId),
    prepare(`UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ? AND user_id = ? AND ${purchase}`).bind(input.amount, input.sourceId, input.userId, input.purchaseId, input.userId),
    prepare(`UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND user_id = ? AND ${purchase}`).bind(input.amount, input.destinationId, input.userId, input.purchaseId, input.userId),
  ];
}
