type ExpenseAccount = { id: string; archived: number };

export function defaultExpenseAccountId(accounts: ExpenseAccount[], preferredId?: string | null): string {
  const active = accounts.filter(account => account.archived !== 1);
  return active.find(account => account.id === preferredId)?.id ?? active[0]?.id ?? '';
}
