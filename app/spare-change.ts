export type SpareSettings = {
  spare_enabled: number;
  spare_source_id: string | null;
  spare_debit_id: string | null;
  spare_destination_id: string | null;
  spare_multiplier: number;
};

// Round-ups are earned only by posted expenses on the configured source.
// Recording an amount does not move cash; the later sweep does that.
export function spareRoundUpCents(
  amountCents: number,
  sourceAccountId: string | null,
  excluded: boolean,
  settings: SpareSettings | null,
): number {
  if (!settings || settings.spare_enabled !== 1 || excluded ||
      !sourceAccountId || sourceAccountId !== settings.spare_source_id ||
      !settings.spare_debit_id || settings.spare_debit_id === sourceAccountId ||
      !settings.spare_destination_id || settings.spare_destination_id === sourceAccountId ||
      settings.spare_destination_id === settings.spare_debit_id) return 0;
  const base = (100 - (amountCents % 100)) % 100;
  return base * Math.max(1, Math.min(20, Math.trunc(settings.spare_multiplier || 1)));
}
