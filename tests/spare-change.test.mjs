import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const scratch = path.resolve('work/spare-tests');
fs.mkdirSync(scratch, { recursive: true });
const compile = (source, target) => {
  fs.writeFileSync(path.join(scratch, target), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
compile(fs.readFileSync('app/spare-change.ts', 'utf8'), 'spare-change.mjs');
const { spareRoundUpCents } = await import(pathToFileURL(path.join(scratch, 'spare-change.mjs')));
globalThis.__spareTestRoundUp = spareRoundUpCents;

const settings = {
  spare_enabled: 1,
  spare_source_id: 'card',
  spare_debit_id: 'bank',
  spare_destination_id: 'savings',
  spare_multiplier: 3,
};

test('Round-ups use the next whole currency unit and the configured multiplier', () => {
  assert.equal(spareRoundUpCents(1234, 'card', false, settings), 198);
  assert.equal(spareRoundUpCents(1200, 'card', false, settings), 0);
  assert.equal(spareRoundUpCents(1, 'card', false, settings), 297);
  assert.equal(spareRoundUpCents(1234, 'card', false, { ...settings, spare_multiplier: 2.9 }), 132);
  assert.equal(spareRoundUpCents(1234, 'card', false, { ...settings, spare_multiplier: 30 }), 1320);
  assert.equal(spareRoundUpCents(1234, 'card', false, { ...settings, spare_multiplier: 0 }), 66);
});

test('Round-ups require an enabled source, no exclusion, and distinct sweep accounts', () => {
  for (const [source, excluded, profile] of [
    ['card', false, null],
    ['card', false, { ...settings, spare_enabled: 0 }],
    ['card', true, settings],
    ['bank', false, settings],
    [null, false, settings],
    ['card', false, { ...settings, spare_debit_id: null }],
    ['card', false, { ...settings, spare_debit_id: 'card' }],
    ['card', false, { ...settings, spare_destination_id: null }],
    ['card', false, { ...settings, spare_destination_id: 'card' }],
    ['card', false, { ...settings, spare_destination_id: 'bank' }],
  ]) assert.equal(spareRoundUpCents(1234, source, excluded, profile), 0);
});

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
globalThis.__spareTestEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
} };

// Run the actual sweep action with local auth, clock, and DB bindings.
const routeSource = fs.readFileSync('app/api/finance/route.ts', 'utf8')
  .replace(/^import[^\n]*\r?\n/gm, '');
compile(`const env = globalThis.__spareTestEnv;
const getChatGPTUser = async () => ({ userId: globalThis.__spareTestUser, displayName: 'Test', email: 'test@example.invalid' });
const ensureFinanceSchema = async () => {};
const financialToday = () => '2026-09-17';
const spareRoundUpCents = globalThis.__spareTestRoundUp;
${routeSource}`, 'route.mjs');
const { POST } = await import(pathToFileURL(path.join(scratch, 'route.mjs')));
const post = (action, payload = {}) => POST(new Request('https://example.invalid/api/finance', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, payload }),
}));
const sweep = () => post('sweepSpare');

test('Sweep uses debit cash, preserves pending accrual on insufficient funds, and cannot repeat', async () => {
  const owner = 'sweep-owner';
  globalThis.__spareTestUser = owner;
  sqlite.prepare('INSERT INTO profiles(user_id,spare_enabled,spare_source_id,spare_debit_id,spare_destination_id) VALUES(?,1,?,?,?)')
    .run(owner, 'sweep-source', 'sweep-debit', 'sweep-destination');
  for (const [id, type, balance] of [
    ['sweep-source', 'bank', 1000],
    ['sweep-debit', 'cash', 100],
    ['sweep-destination', 'savings', 0],
  ]) sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run(id, owner, id, type, balance);
  sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date) VALUES('sweep-purchase',?,?,'expense','Purchase',1234,'2026-09-17')")
    .run(owner, 'sweep-source');
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents) VALUES('sweep-event',?,'sweep-purchase',132)").run(owner);

  assert.equal((await sweep()).status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM spare_events WHERE id='sweep-event'").get().status, 'pending');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description='Spare change sweep' AND user_id=?").get(owner).n, 0);
  assert.deepEqual(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => ({ ...row })), [
    { id: 'sweep-debit', balance_cents: 100 },
    { id: 'sweep-destination', balance_cents: 0 },
    { id: 'sweep-source', balance_cents: 1000 },
  ]);

  sqlite.prepare("UPDATE accounts SET balance_cents=500 WHERE id='sweep-debit'").run();
  assert.equal((await sweep()).status, 200);
  assert.deepEqual(sqlite.prepare("SELECT type,account_id,destination_account_id,amount_cents FROM transactions WHERE description='Spare change sweep' AND user_id=?").all(owner).map(row => ({ ...row })), [
    { type: 'saving', account_id: 'sweep-debit', destination_account_id: 'sweep-destination', amount_cents: 132 },
  ]);
  assert.deepEqual(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => ({ ...row })), [
    { id: 'sweep-debit', balance_cents: 368 },
    { id: 'sweep-destination', balance_cents: 132 },
    { id: 'sweep-source', balance_cents: 1000 },
  ]);
  assert.equal(sqlite.prepare("SELECT status FROM spare_events WHERE id='sweep-event'").get().status, 'swept');
  assert.equal((await sweep()).status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description='Spare change sweep' AND user_id=?").get(owner).n, 1);
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='sweep-debit'").get().balance_cents, 368);
});

test('Correcting a pending expense while collection is off carries its earned multiplier forward', async () => {
  const owner = 'correction-owner';
  globalThis.__spareTestUser = owner;
  sqlite.prepare('INSERT INTO profiles(user_id,spare_enabled,spare_source_id,spare_debit_id,spare_destination_id,spare_multiplier) VALUES(?,0,?,?,?,2)')
    .run(owner, 'correction-source', 'correction-debit', 'correction-destination');
  for (const [id, type, balance] of [
    ['correction-source', 'bank', 5000],
    ['correction-debit', 'cash', 500],
    ['correction-destination', 'savings', 0],
  ]) sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run(id, owner, id, type, balance);
  sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date,spare_change_cents) VALUES('correction-original',?,?,'expense','Original',1234,'2026-09-17',132)")
    .run(owner, 'correction-source');
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents) VALUES('correction-event',?,'correction-original',132)").run(owner);

  const response = await post('correctTransaction', {
    transactionId: 'correction-original', accountId: 'correction-source', amount: '12.50',
    date: '2026-09-17', description: 'Corrected purchase', excludeFromSpare: false,
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const replacement = sqlite.prepare("SELECT id,amount_cents,spare_change_cents,status FROM transactions WHERE user_id=? AND replaces_transaction_id='correction-original'").get(owner);
  assert.deepEqual({ amount_cents: replacement.amount_cents, spare_change_cents: replacement.spare_change_cents, status: replacement.status },
    { amount_cents: 1250, spare_change_cents: 100, status: 'posted' });
  assert.equal(sqlite.prepare("SELECT status FROM transactions WHERE id='correction-original'").get().status, 'corrected');
  assert.deepEqual(sqlite.prepare('SELECT transaction_id,multiplied_cents,status FROM spare_events WHERE user_id=? ORDER BY status').all(owner).map(row => ({ ...row })), [
    { transaction_id: 'correction-original', multiplied_cents: 132, status: 'cancelled' },
    { transaction_id: replacement.id, multiplied_cents: 100, status: 'pending' },
  ]);
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='correction-source'").get().balance_cents, 4984);
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='correction-debit'").get().balance_cents, 500);
});
