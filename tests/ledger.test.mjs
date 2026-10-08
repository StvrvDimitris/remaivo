import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { reportingClass, isLedgerType } from '../app/transaction-classification.ts';
import { accountFlow } from '../app/investment-valuations.ts';

// Every account balance must equal the sum of its posted entries once opening balances exist.
function ledgerTotal(db, accountId) {
  return db.prepare("SELECT * FROM transactions WHERE status = 'posted' AND (account_id = ? OR destination_account_id = ?)").all(accountId, accountId)
    .reduce((sum, t) => sum + accountFlow(t, accountId), 0);
}
const balance = (db, id) => db.prepare('SELECT balance_cents FROM accounts WHERE id = ?').get(id).balance_cents;

function seedHistory(db) {
  const account = db.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents,created_at) VALUES(?,?,?,?,?,?)');
  account.run('bank', 'u', 'Bank', 'bank', 100000, '2026-08-20 09:00:00');
  account.run('card', 'u', 'Card', 'credit', -30000, '2026-08-20 09:00:00');
  account.run('fund', 'u', 'Fund', 'investment', 25000, '2026-08-20 09:00:00');
  account.run('empty', 'u', 'Empty', 'cash', 5000, '2026-08-20 09:00:00');
  const tx = db.prepare('INSERT INTO transactions(id,user_id,type,description,amount_cents,date,account_id,destination_account_id,status) VALUES(?,?,?,?,?,?,?,?,?)');
  tx.run('salary', 'u', 'income', 'Salary', 5000, '2026-08-25', 'bank', null, 'posted');
  tx.run('food', 'u', 'expense', 'Food', 20000, '2026-08-10', 'bank', null, 'posted');
  tx.run('old', 'u', 'expense', 'Wrong amount', 99999, '2026-08-01', 'bank', null, 'corrected');
  tx.run('shoes', 'u', 'expense', 'Shoes', 10000, '2026-08-22', 'card', null, 'posted');
  tx.run('invest', 'u', 'investment', 'Monthly', 5000, '2026-08-28', 'bank', 'fund', 'posted');
  tx.run('cash', 'u', 'transfer', 'ATM', 5000, '2026-08-21', 'bank', 'empty', 'posted');
}

for (const [directory, before] of [['drizzle', '0025'], ['cloudflare/migrations', '0008']]) {
  test(`${directory}: existing accounts receive opening balances without changing balances`, () => {
    const db = new DatabaseSync(':memory:');
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    for (const name of files.filter(name => name < before)) db.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
    seedHistory(db);
    for (const name of files.filter(name => name >= before)) db.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
    const opening = id => db.prepare("SELECT * FROM transactions WHERE id = ?").get(`opening:${id}`);
    // Bank: 1000 = opening + 50 - 200 - 50 - 50, dated at its earliest posted entry.
    assert.deepEqual({ ...opening('bank') }, { ...opening('bank'), type: 'opening_balance', amount_cents: 125000, account_id: null, destination_account_id: 'bank', date: '2026-08-10', counts_monthly: 0 });
    // A card that started in debt records money out of the account.
    assert.equal(opening('card').account_id, 'card');
    assert.equal(opening('card').destination_account_id, null);
    assert.equal(opening('card').amount_cents, 20000);
    assert.equal(opening('fund').amount_cents, 20000);
    assert.equal(opening('empty'), undefined);
    for (const id of ['bank', 'card', 'fund', 'empty']) assert.equal(ledgerTotal(db, id), balance(db, id), id);
    assert.deepEqual([balance(db, 'bank'), balance(db, 'card'), balance(db, 'fund'), balance(db, 'empty')], [100000, -30000, 25000, 5000]);
  });
}

test('Opening balances and adjustments are never income, spending, contributions or budget activity', async () => {
  for (const type of ['opening_balance', 'balance_adjustment']) {
    assert.equal(isLedgerType(type), true);
    assert.equal(reportingClass(type), 'excluded');
  }
  const scratch = path.resolve('work/ledger-tests');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'dates.mjs'), ts.transpileModule(fs.readFileSync('app/finance-dates.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  fs.writeFileSync(path.join(scratch, 'engine.mjs'), ts.transpileModule(fs.readFileSync('app/v3-engine.ts', 'utf8').replace("'./finance-dates'", "'./dates.mjs'"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  const { consumesBudget } = await import(pathToFileURL(path.join(scratch, 'engine.mjs')));
  assert.equal(consumesBudget({ type: 'opening_balance', counts_monthly: 0, status: 'posted' }), false);
  assert.equal(consumesBudget({ type: 'balance_adjustment', counts_monthly: 1, status: 'posted' }), false);
});

// Route harness: the real POST handler with local auth, clock and database.
const sqlite = new DatabaseSync(':memory:');
for (const file of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync(path.join('drizzle', file), 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
globalThis.__ledgerTestEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(statement.sql) ? await statement.all() : await statement.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
} };
const routeScratch = path.resolve('work/ledger-tests');
fs.mkdirSync(routeScratch, { recursive: true });
fs.writeFileSync(path.join(routeScratch, 'route.mjs'), ts.transpileModule(`
const env = globalThis.__ledgerTestEnv;
const getUser = async () => ({ userId: 'owner', displayName: 'Test', email: 'test@example.invalid' });
const usesGoogleAuth = () => false;
const ensureFinanceSchema = async () => {};
const financialToday = () => '2026-10-08';
const reconcileV3 = async () => {};
const v3Snapshot = async () => ({});
const isLedgerType = (type) => ['opening_balance', 'balance_adjustment'].includes(type);
class ArchiveError extends Error { status = 409; }
${fs.readFileSync('app/api/finance/route.ts', 'utf8').replace(/^import[^\n]*\r?\n/gm, '')}`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { POST } = await import(pathToFileURL(path.join(routeScratch, 'route.mjs')));
const post = (action, payload = {}) => POST(new Request('https://example.invalid/api/finance', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }),
}));
sqlite.prepare("INSERT INTO profiles(user_id,currency,setup_complete) VALUES('owner','EUR',1)").run();
const accountNamed = name => sqlite.prepare('SELECT * FROM accounts WHERE user_id = ? AND name = ?').get('owner', name);
const entries = (id, type) => sqlite.prepare("SELECT * FROM transactions WHERE status = 'posted' AND type = ? AND (account_id = ? OR destination_account_id = ?) ORDER BY created_at, rowid").all(type, id, id);

test('New accounts record their starting balance as an opening entry', async () => {
  assert.equal((await post('addAccount', { name: 'Main', type: 'bank', balance: '1234.56' })).status, 200);
  assert.equal((await post('addAccount', { name: 'Visa', type: 'credit', balance: '300' })).status, 200);
  assert.equal((await post('addAccount', { name: 'Jar', type: 'cash', balance: '0' })).status, 200);
  const main = accountNamed('Main'), visa = accountNamed('Visa'), jar = accountNamed('Jar');
  assert.deepEqual(entries(main.id, 'opening_balance').map(t => [t.destination_account_id, t.account_id, t.amount_cents, t.date]), [[main.id, null, 123456, '2026-10-08']]);
  assert.deepEqual(entries(visa.id, 'opening_balance').map(t => [t.destination_account_id, t.account_id, t.amount_cents]), [[null, visa.id, 30000]]);
  assert.equal(entries(jar.id, 'opening_balance').length, 0);
  for (const account of [main, visa, jar]) assert.equal(ledgerTotal(sqlite, account.id), account.balance_cents, account.name);
});

test('Update balance records the difference once and refuses investments, no-ops and future dates', async () => {
  const main = accountNamed('Main'), visa = accountNamed('Visa');
  assert.equal((await post('adjustBalance', { accountId: main.id, balance: '1238.00', date: '2026-10-07' })).status, 200);
  assert.equal(balance(sqlite, main.id), 123800);
  assert.deepEqual(entries(main.id, 'balance_adjustment').map(t => [t.destination_account_id, t.amount_cents, t.date, t.counts_monthly]), [[main.id, 344, '2026-10-07', 0]]);
  assert.equal((await post('adjustBalance', { accountId: visa.id, balance: '250' })).status, 200);
  assert.equal(balance(sqlite, visa.id), -25000);
  assert.deepEqual(entries(visa.id, 'balance_adjustment').map(t => [t.destination_account_id, t.amount_cents]), [[visa.id, 5000]]);
  assert.equal((await post('adjustBalance', { accountId: main.id, balance: '1238.00' })).status, 400);
  assert.equal((await post('adjustBalance', { accountId: main.id, balance: '10', date: '2026-10-09' })).status, 400);
  sqlite.prepare("INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES('fund','owner','Fund','investment',1000)").run();
  assert.equal((await post('adjustBalance', { accountId: 'fund', balance: '20' })).status, 409);
  assert.equal(balance(sqlite, 'fund'), 1000);
  for (const account of [main, visa]) assert.equal(ledgerTotal(sqlite, account.id), balance(sqlite, account.id), account.name);
});

test('Opening balances and adjustments cannot be rewritten through transaction corrections', async () => {
  const main = accountNamed('Main');
  const [opening] = entries(main.id, 'opening_balance');
  const response = await post('correctTransaction', { transactionId: opening.id, type: 'income', amount: '1', date: '2026-10-08', accountId: main.id, description: 'x' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Update balance/);
  assert.equal(sqlite.prepare('SELECT status FROM transactions WHERE id = ?').get(opening.id).status, 'posted');
  assert.equal(ledgerTotal(sqlite, main.id), balance(sqlite, main.id));
});
