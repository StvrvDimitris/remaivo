import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const sqlite = new DatabaseSync(':memory:');
for (const file of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  sqlite.exec(fs.readFileSync(path.join('drizzle', file), 'utf8'));
}

class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
globalThis.__goalsTestEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        results.push(/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(statement.sql) ? await statement.all() : await statement.run());
      }
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
} };

const scratch = path.resolve('work/goals-tests');
fs.mkdirSync(scratch, { recursive: true });
const routeSource = fs.readFileSync('app/api/finance/route.ts', 'utf8').replace(/^import[^\n]*\r?\n/gm, '');
const source = `
const env = globalThis.__goalsTestEnv;
const getUser = async () => ({ userId: globalThis.__goalsTestUser, displayName: 'Test', email: 'test@example.invalid' });
const ensureFinanceSchema = async () => {};
const financialToday = () => globalThis.__goalsTestToday ?? '2027-02-01';
const reconcileV3 = async () => {};
const v3Snapshot = async () => ({});
const isLedgerType = (type) => ['opening_balance', 'balance_adjustment'].includes(type);
class ArchiveError extends Error { status = 409; }
${routeSource}`;
fs.writeFileSync(path.join(scratch, 'route.mjs'), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { GET, POST } = await import(pathToFileURL(path.join(scratch, 'route.mjs')));

const post = (action, payload = {}) => POST(new Request('https://example.invalid/api/finance', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, payload }),
}));
const get = () => GET(new Request('https://example.invalid/api/finance'));
const expectSaved = async (response) => {
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
};
const owner = (id) => {
  globalThis.__goalsTestUser = id;
  sqlite.prepare('INSERT INTO profiles(user_id,setup_complete) VALUES(?,1)').run(id);
};
const account = (id, user, balance = 50000) => {
  sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)')
    .run(id, user, id, 'savings', balance);
};
const goal = (user, name) => sqlite.prepare('SELECT * FROM goals WHERE user_id=? AND name=?').get(user, name);
const progress = async (name) => {
  const response = await get();
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data.goals.find(item => item.name === name)?.progress_cents;
};
const transaction = (id, user, source, destination, type, amount, date, status = 'posted') => {
  sqlite.prepare('INSERT INTO transactions(id,user_id,account_id,destination_account_id,type,description,amount_cents,date,status) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, user, source, destination, type, id, amount, date, status);
};

test('migrations provide tracking fields and a dated manual-entry ledger', () => {
  const goalColumns = new Set(sqlite.prepare('PRAGMA table_info(goals)').all().map(row => row.name));
  for (const column of ['tracking_mode', 'start_date', 'end_date', 'baseline_cents']) {
    assert.ok(goalColumns.has(column), `goals.${column}`);
  }
  const entryColumns = new Set(sqlite.prepare('PRAGMA table_info(goal_entries)').all().map(row => row.name));
  for (const column of ['id', 'user_id', 'goal_id', 'date', 'amount_cents', 'note']) {
    assert.ok(entryColumns.has(column), `goal_entries.${column}`);
  }
});

test('default expense account persists per owner, rejects unavailable accounts, and clears on archive', async () => {
  const user = 'expense-default-owner'; owner(user);
  account('expense-default-first', user); account('expense-default-second', user);
  account('expense-default-foreign', 'someone-else');
  account('expense-default-archived', user);
  sqlite.prepare('UPDATE accounts SET archived=1 WHERE id=?').run('expense-default-archived');
  await expectSaved(await post('updateDefaultExpenseAccount', { accountId: 'expense-default-second' }));
  assert.equal(sqlite.prepare('SELECT default_expense_account_id FROM profiles WHERE user_id=?').get(user).default_expense_account_id, 'expense-default-second');
  const response = await get();
  assert.equal((await response.json()).profile.default_expense_account_id, 'expense-default-second');
  for (const accountId of ['expense-default-foreign', 'expense-default-archived', 'missing', '']) {
    assert.equal((await post('updateDefaultExpenseAccount', { accountId })).status, 400);
  }
  assert.equal(sqlite.prepare('SELECT default_expense_account_id FROM profiles WHERE user_id=?').get(user).default_expense_account_id, 'expense-default-second');
  await expectSaved(await post('archiveAccount', { accountId: 'expense-default-second' }));
  assert.equal(sqlite.prepare('SELECT default_expense_account_id FROM profiles WHERE user_id=?').get(user).default_expense_account_id, null);
});

test('expense preselection uses the saved active account and safely falls back', async () => {
  const code = ts.transpileModule(fs.readFileSync('app/expense-account.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  fs.writeFileSync(path.join(scratch, 'expense-account.mjs'), code);
  const { defaultExpenseAccountId } = await import(pathToFileURL(path.join(scratch, 'expense-account.mjs')));
  const accounts = [{ id: 'first', archived: 0 }, { id: 'chosen', archived: 0 }, { id: 'archived', archived: 1 }];
  assert.equal(defaultExpenseAccountId(accounts, 'chosen'), 'chosen');
  assert.equal(defaultExpenseAccountId(accounts, 'archived'), 'first');
  assert.equal(defaultExpenseAccountId(accounts, 'missing'), 'first');
  assert.equal(defaultExpenseAccountId([]), '');
});

test('linked total uses the full balance; new-money starts at the balance when created', async () => {
  const user = 'goal-linked-owner'; owner(user); account('goal-linked-savings', user, 50000);
  await expectSaved(await post('addGoal', { name: 'Whole balance', kind: 'savings', accountId: 'goal-linked-savings', target: 1500, trackingMode: 'total' }));
  await expectSaved(await post('addGoal', { name: 'New savings', kind: 'savings', accountId: 'goal-linked-savings', target: 1500, trackingMode: 'new_money' }));
  assert.equal(goal(user, 'New savings').baseline_cents, 50000);
  assert.equal(await progress('Whole balance'), 50000);
  assert.equal(await progress('New savings'), 0);

  sqlite.prepare('UPDATE accounts SET balance_cents=63500 WHERE id=?').run('goal-linked-savings');
  assert.equal(await progress('Whole balance'), 63500);
  assert.equal(await progress('New savings'), 13500);
  sqlite.prepare('UPDATE accounts SET balance_cents=45000 WHERE id=?').run('goal-linked-savings');
  assert.equal(await progress('New savings'), 0);
});

test('linked period counts posted net account flow on inclusive dates', async () => {
  const user = 'goal-period-owner'; owner(user); account('period-savings', user);
  await expectSaved(await post('addGoal', {
    name: '2026 saving', kind: 'savings', accountId: 'period-savings',
    trackingMode: 'period', target: 1500, startDate: '2026-01-01', endDate: '2026-12-31',
  }));
  transaction('before-period', user, 'other', 'period-savings', 'saving', 4000, '2025-12-31');
  transaction('start-day', user, 'other', 'period-savings', 'saving', 10000, '2026-01-01');
  transaction('period-expense', user, 'period-savings', null, 'expense', 2000, '2026-02-01');
  transaction('period-income', user, 'period-savings', null, 'income', 5000, '2026-06-15');
  transaction('end-day', user, 'period-savings', 'other', 'transfer', 3000, '2026-12-31');
  transaction('corrected', user, 'other', 'period-savings', 'saving', 7000, '2026-07-01', 'corrected');
  transaction('after-period', user, 'other', 'period-savings', 'saving', 9000, '2027-01-01');
  assert.equal(await progress('2026 saving'), 10000);
});

test('independent goals use dated add/remove entries without changing account balances', async () => {
  const user = 'goal-manual-owner'; owner(user); account('untouched-savings', user, 42000);
  await expectSaved(await post('addGoal', { name: 'Manual lifetime', kind: 'savings', target: 1500, trackingMode: 'total', contributed: 50 }));
  await expectSaved(await post('addGoal', {
    name: 'Manual 2026', kind: 'savings', target: 1500, trackingMode: 'period',
    startDate: '2026-01-01', endDate: '2026-12-31', contributed: 50,
  }));
  const lifetime = goal(user, 'Manual lifetime');
  const period = goal(user, 'Manual 2026');
  for (const goalId of [lifetime.id, period.id]) {
    await expectSaved(await post('addGoalEntry', { goalId, date: '2025-12-31', amount: 40, kind: 'add', note: 'Earlier' }));
    await expectSaved(await post('addGoalEntry', { goalId, date: '2026-01-01', amount: 20, kind: 'add', note: 'Start day' }));
    await expectSaved(await post('addGoalEntry', { goalId, date: '2026-12-31', amount: 5, kind: 'remove', note: 'Used' }));
  }
  assert.equal(await progress('Manual lifetime'), 10500);
  assert.equal(await progress('Manual 2026'), 1500);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get('untouched-savings').balance_cents, 42000);

  const used = sqlite.prepare("SELECT id,amount_cents FROM goal_entries WHERE goal_id=? AND note='Used'").get(period.id);
  assert.equal(used.amount_cents, -500);
  await expectSaved(await post('deleteGoalEntry', { entryId: used.id }));
  assert.equal(await progress('Manual 2026'), 2000);
  assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get('untouched-savings').balance_cents, 42000);
});

test('independent new-money goal starts after its entered amount and keeps its baseline on edits', async () => {
  globalThis.__goalsTestToday = '2026-12-31';
  const user = 'goal-independent-new-owner'; owner(user);
  await expectSaved(await post('addGoal', { name: 'From now', kind: 'savings', target: 1500, trackingMode: 'new_money', contributed: 50 }));
  const created = goal(user, 'From now');
  assert.equal(created.baseline_cents, 5000);
  assert.equal(await progress('From now'), 0);
  globalThis.__goalsTestToday = '2027-02-01';
  const beforeStart = await post('addGoalEntry', { goalId: created.id, date: '2026-12-30', amount: 20, kind: 'add' });
  assert.equal(beforeStart.status, 400);
  assert.equal(await progress('From now'), 0);
  await expectSaved(await post('addGoalEntry', { goalId: created.id, date: '2027-01-01', amount: 20, kind: 'add' }));
  await expectSaved(await post('addGoalEntry', { goalId: created.id, date: '2027-01-02', amount: 5, kind: 'remove' }));
  assert.equal(await progress('From now'), 1500);
  await expectSaved(await post('updateGoal', { goalId: created.id, name: 'From now', kind: 'savings', trackingMode: 'new_money', target: 2000 }));
  assert.equal(goal(user, 'From now').baseline_cents, 5000);
  assert.equal(await progress('From now'), 1500);
});

test('goal editing saves mode and dates; invalid edits and foreign entries are rejected', async () => {
  const user = 'goal-edit-owner'; owner(user); account('edit-savings', user, 25000);
  await expectSaved(await post('addGoal', { name: 'Edit me', kind: 'savings', accountId: 'edit-savings', target: 1000, trackingMode: 'total' }));
  const id = goal(user, 'Edit me').id;
  await expectSaved(await post('updateGoal', {
    goalId: id, name: 'Edited goal', kind: 'savings', accountId: 'edit-savings',
    target: 1500, trackingMode: 'period', startDate: '2026-01-01', endDate: '2026-12-31', color: '#dff35f',
  }));
  const saved = goal(user, 'Edited goal');
  assert.equal(saved.tracking_mode, 'period');
  assert.equal(saved.target_cents, 150000);
  assert.equal(saved.start_date, '2026-01-01');
  assert.equal(saved.end_date, '2026-12-31');

  const invalid = await post('updateGoal', {
    goalId: id, name: 'Broken date', kind: 'savings', accountId: 'edit-savings',
    target: 1500, trackingMode: 'period', startDate: '2026-12-31', endDate: '2026-01-01',
  });
  assert.equal(invalid.status, 400);
  assert.equal(goal(user, 'Edited goal').tracking_mode, 'period');
  assert.equal(goal(user, 'Broken date'), undefined);

  await expectSaved(await post('addGoal', { name: 'Private manual', kind: 'savings', trackingMode: 'total' }));
  const manualId = goal(user, 'Private manual').id;
  await expectSaved(await post('addGoalEntry', { goalId: manualId, date: '2026-09-01', amount: 10, kind: 'add' }));
  const entryId = sqlite.prepare('SELECT id FROM goal_entries WHERE goal_id=?').get(manualId).id;

  const foreign = 'goal-foreign-owner'; owner(foreign); account('foreign-savings', foreign);
  const foreignEntry = await post('addGoalEntry', { goalId: manualId, date: '2026-09-01', amount: 10, kind: 'add' });
  assert.notEqual(foreignEntry.status, 200);
  const foreignDelete = await post('deleteGoalEntry', { entryId });
  assert.notEqual(foreignDelete.status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM goal_entries WHERE id=?').get(entryId).n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM goal_entries WHERE user_id=?').get(foreign).n, 0);
});
