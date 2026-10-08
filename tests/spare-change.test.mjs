import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as defaultNames from '../app/default-names.ts';
globalThis.__spareNames = defaultNames;

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

test('Round-ups require an enabled expense account and a separate destination', () => {
  for (const [source, excluded, profile] of [
    ['card', false, null],
    ['card', false, { ...settings, spare_enabled: 0 }],
    ['card', true, settings],
    ['bank', false, settings],
    [null, false, settings],
    ['card', false, { ...settings, spare_destination_id: null }],
    ['card', false, { ...settings, spare_destination_id: 'card' }],
  ]) assert.equal(spareRoundUpCents(1234, source, excluded, profile), 0);
});

const sqlite = new DatabaseSync(':memory:');
for (const file of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  sqlite.exec(fs.readFileSync(path.join('drizzle', file), 'utf8'));
}
test('The current profile schema has no separate sweep debit account', () => {
  assert.equal(sqlite.prepare("PRAGMA table_info(profiles)").all().some(column => column.name === 'spare_debit_id'), false);
});
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
let batchQueue = Promise.resolve();
globalThis.__spareTestEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: statements => {
    const operation = batchQueue.then(async () => {
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
    });
    batchQueue = operation.catch(() => {});
    return operation;
  },
} };

compile(fs.readFileSync('db/spare.ts', 'utf8').replace("import { env } from 'cloudflare:workers';", 'const env = globalThis.__spareTestEnv;'), 'spare.mjs');
const { sweepSpare, autoSweepSpare } = await import(pathToFileURL(path.join(scratch, 'spare.mjs')));
globalThis.__spareTestSweep = sweepSpare;

// Run the actual sweep action with local auth, clock, and DB bindings.
const routeSource = fs.readFileSync('app/api/finance/route.ts', 'utf8')
  .replace(/^import[^\n]*\r?\n/gm, '');
compile(`const env = globalThis.__spareTestEnv;
const getUser = async () => ({ userId: globalThis.__spareTestUser, displayName: 'Test', email: 'test@example.invalid' });
const usesGoogleAuth = () => false;
const ensureFinanceSchema = async () => {};
const financialToday = () => '2026-09-17';
const spareRoundUpCents = globalThis.__spareTestRoundUp;
const sweepSpare = globalThis.__spareTestSweep;
const isLedgerType = (type) => ['opening_balance', 'balance_adjustment'].includes(type);
const { defaultAccountName, defaultCategories, defaultPlanName, nameLanguage, otherNames } = globalThis.__spareNames;
class ArchiveError extends Error { status = 409; }
${routeSource}`, 'route.mjs');
const { POST } = await import(pathToFileURL(path.join(scratch, 'route.mjs')));
const post = (action, payload = {}) => POST(new Request('https://example.invalid/api/finance', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, payload }),
}));
const sweep = () => post('sweepSpare');

function seedAuto(owner, { pending = 100, threshold = 100, enabled = 1, balance = 1000, type = 'savings' } = {}) {
  const source = `${owner}-source`, destination = `${owner}-destination`;
  sqlite.prepare('INSERT INTO profiles(user_id,spare_enabled,spare_source_id,spare_destination_id,spare_auto_sweep_threshold_cents) VALUES(?,?,?,?,?)').run(owner, enabled, source, destination, threshold);
  for (const [id, kind, amount] of [[source, 'bank', balance], [destination, type, 0]])
    sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run(id, owner, id, kind, amount);
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents) VALUES(?,?,?,?)").run(`${owner}-event`, owner, `${owner}-purchase`, pending);
  return { source, destination };
}

test('Automatic sweep settings validate and persist a positive threshold, with off as the default', async () => {
  const owner = 'threshold-settings-owner';
  globalThis.__spareTestUser = owner;
  const { source, destination } = seedAuto(owner, { threshold: 0 });
  const payload = { enabled: true, autoSweep: true, sourceAccountId: source, destinationAccountId: destination, multiplier: 2 };
  for (const autoSweepThreshold of ['', '0', '-1', 'bad', 'Infinity', '9007199254740991']) {
    assert.equal((await post('updateSpare', { ...payload, autoSweepThreshold })).status, 400);
    assert.equal(sqlite.prepare('SELECT spare_auto_sweep_threshold_cents n FROM profiles WHERE user_id=?').get(owner).n, 0);
  }
  assert.equal((await post('updateSpare', { ...payload, autoSweepThreshold: '5.25' })).status, 200);
  assert.equal(sqlite.prepare('SELECT spare_auto_sweep_threshold_cents n FROM profiles WHERE user_id=?').get(owner).n, 525);
  assert.equal((await post('updateSpare', { ...payload, autoSweep: false })).status, 200);
  assert.equal(sqlite.prepare('SELECT spare_auto_sweep_threshold_cents n FROM profiles WHERE user_id=?').get(owner).n, 0);
});

test('Automatic sweeps wait below the threshold and sweep the full total at or above it', async () => {
  for (const pending of [99, 100, 140]) {
    const owner = `threshold-${pending}`;
    const { source, destination } = seedAuto(owner, { pending, type: pending === 140 ? 'investment' : 'savings' });
    assert.equal(await autoSweepSpare(owner, '2026-10-01'), pending >= 100);
    assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(source).n, 1000 - (pending >= 100 ? pending : 0));
    assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(destination).n, pending >= 100 ? pending : 0);
    const recorded = sqlite.prepare("SELECT amount_cents,type,date,committed,counts_monthly FROM transactions WHERE user_id=?").all(owner);
    assert.deepEqual(recorded.map(row => ({ ...row })), pending >= 100 ? [{ amount_cents: pending, type: pending === 140 ? 'investment' : 'saving', date: '2026-10-01', committed: 1, counts_monthly: 1 }] : []);
  }
});

test('Turning collection or automatic sweeps off pauses auto while manual sweeping remains available', async () => {
  for (const settings of [{ enabled: 0 }, { threshold: 0 }, { pending: 20, threshold: 100 }]) {
    const owner = `paused-${JSON.stringify(settings)}`;
    seedAuto(owner, settings);
    assert.equal(await autoSweepSpare(owner, '2026-10-01'), false);
    assert.equal(sqlite.prepare('SELECT status FROM spare_events WHERE user_id=?').get(owner).status, 'pending');
    assert.equal(await sweepSpare(owner, '2026-10-01'), true);
  }
});

test('Insufficient funds preserve the entire pending total and a later sync retries only once', async () => {
  const owner = 'auto-retry';
  const { source, destination } = seedAuto(owner, { pending: 140, balance: 139 });
  assert.equal(await autoSweepSpare(owner, '2026-10-01'), false);
  assert.equal(sqlite.prepare('SELECT status FROM spare_events WHERE user_id=?').get(owner).status, 'pending');
  assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(destination).n, 0);
  sqlite.prepare('UPDATE accounts SET balance_cents=500 WHERE id=?').run(source);
  assert.equal(await autoSweepSpare(owner, '2026-10-02'), true);
  assert.equal(await autoSweepSpare(owner, '2026-10-02'), false);
  assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(source).n, 360);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id=?').get(owner).n, 1);
});

test('Competing automatic and manual sweeps consume the same pending change exactly once', async () => {
  const owner = 'auto-contention';
  const { source, destination } = seedAuto(owner, { pending: 140 });
  const results = await Promise.all([autoSweepSpare(owner, '2026-10-01'), autoSweepSpare(owner, '2026-10-01'), sweepSpare(owner, '2026-10-01')]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(source).n, 860);
  assert.equal(sqlite.prepare('SELECT balance_cents n FROM accounts WHERE id=?').get(destination).n, 140);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id=?').get(owner).n, 1);
});

test('Automatic sweeps respect account ownership, archived accounts and supported account types', async () => {
  for (const [field, value] of [['user_id', 'someone-else'], ['archived', 1], ['type', 'bank']]) {
    const owner = `invalid-${field}`;
    const { destination } = seedAuto(owner);
    sqlite.prepare(`UPDATE accounts SET ${field}=? WHERE id=?`).run(value, destination);
    assert.equal(await autoSweepSpare(owner, '2026-10-01'), false);
    assert.equal(sqlite.prepare('SELECT status FROM spare_events WHERE user_id=?').get(owner).status, 'pending');
  }
});

test('Saving spare settings and sweeping use the expense account, preserve pending accrual, and cannot repeat', async () => {
  const owner = 'sweep-owner';
  globalThis.__spareTestUser = owner;
  sqlite.prepare('INSERT INTO profiles(user_id) VALUES(?)').run(owner);
  for (const [id, type, balance] of [
    ['sweep-source', 'bank', 100],
    ['sweep-destination', 'savings', 0],
  ]) sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run(id, owner, id, type, balance);
  const saved = await post('updateSpare', {
    enabled: true, sourceAccountId: 'sweep-source', destinationAccountId: 'sweep-destination', multiplier: 2,
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  assert.deepEqual({ ...sqlite.prepare('SELECT spare_enabled,spare_source_id,spare_destination_id,spare_multiplier FROM profiles WHERE user_id=?').get(owner) }, {
    spare_enabled: 1, spare_source_id: 'sweep-source', spare_destination_id: 'sweep-destination', spare_multiplier: 2,
  });
  sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date) VALUES('sweep-purchase',?,?,'expense','Purchase',1234,'2026-09-17')")
    .run(owner, 'sweep-source');
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents) VALUES('sweep-event',?,'sweep-purchase',132)").run(owner);

  assert.equal((await sweep()).status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM spare_events WHERE id='sweep-event'").get().status, 'pending');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description='Spare change sweep' AND user_id=?").get(owner).n, 0);
  assert.deepEqual(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => ({ ...row })), [
    { id: 'sweep-destination', balance_cents: 0 },
    { id: 'sweep-source', balance_cents: 100 },
  ]);

  sqlite.prepare("UPDATE accounts SET balance_cents=500 WHERE id='sweep-source'").run();
  assert.equal((await sweep()).status, 200);
  assert.deepEqual(sqlite.prepare("SELECT type,account_id,destination_account_id,amount_cents FROM transactions WHERE description='Spare change sweep' AND user_id=?").all(owner).map(row => ({ ...row })), [
    { type: 'saving', account_id: 'sweep-source', destination_account_id: 'sweep-destination', amount_cents: 132 },
  ]);
  assert.deepEqual(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => ({ ...row })), [
    { id: 'sweep-destination', balance_cents: 132 },
    { id: 'sweep-source', balance_cents: 368 },
  ]);
  assert.equal(sqlite.prepare("SELECT status FROM spare_events WHERE id='sweep-event'").get().status, 'swept');
  assert.equal((await sweep()).status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description='Spare change sweep' AND user_id=?").get(owner).n, 1);
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='sweep-source'").get().balance_cents, 368);
});

test('Correcting a pending expense while collection is off carries its earned multiplier forward', async () => {
  const owner = 'correction-owner';
  globalThis.__spareTestUser = owner;
  sqlite.prepare('INSERT INTO profiles(user_id,spare_enabled,spare_source_id,spare_destination_id,spare_multiplier) VALUES(?,0,?,?,2)')
    .run(owner, 'correction-source', 'correction-destination');
  for (const [id, type, balance] of [
    ['correction-source', 'bank', 5000],
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
});


test('Transaction corrections support every manual type combination without duplicating balances', async () => {
  const types = ['expense', 'income', 'transfer', 'saving', 'investment'];
  const effect = type => type === 'income' ? [1234, 0] : ['transfer', 'saving', 'investment'].includes(type) ? [-1234, 1234] : [-1234, 0];
  for (const before of types) for (const after of types) {
    const owner = `type-${before}-${after}`;
    globalThis.__spareTestUser = owner;
    const source = `${owner}-source`, destination = `${owner}-dest`, original = `${owner}-tx`;
    const old = effect(before), expected = effect(after);
    for (const [id, balance] of [[source, 10000 + old[0]], [destination, 10000 + old[1]]])
      sqlite.prepare("INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,'bank',?)").run(id, owner, id, balance);
    sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,destination_account_id,type,description,amount_cents,date,counts_monthly) VALUES(?,?,?,?,?,'Mistake',1234,'2026-09-17',?)")
      .run(original, owner, source, ['transfer','saving','investment'].includes(before) ? destination : null, before, ['expense','saving','investment'].includes(before) ? 1 : 0);
    const response = await post('correctTransaction', { transactionId: original, type: after, accountId: source, destinationAccountId: destination, amount: '12.34', date: '2026-09-17', description: 'Corrected' });
    assert.equal(response.status, 200, `${before} -> ${after}: ${JSON.stringify(await response.json())}`);
    const replacement = sqlite.prepare('SELECT * FROM transactions WHERE replaces_transaction_id=?').get(original);
    assert.equal(replacement.type, after);
    assert.equal(replacement.counts_monthly, ['expense','saving','investment'].includes(after) ? 1 : 0);
    assert.equal(replacement.destination_account_id, ['transfer','saving','investment'].includes(after) ? destination : null);
    assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(source).balance_cents, 10000 + expected[0]);
    assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(destination).balance_cents, 10000 + expected[1]);
    assert.equal(sqlite.prepare('SELECT status FROM transactions WHERE id=?').get(original).status, 'corrected');
  }
});

test('Reclassifying an expense cancels pending spare change; invalid types cannot mutate it', async () => {
  const owner = 'reclassify-spare'; globalThis.__spareTestUser = owner;
  sqlite.prepare("INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES('reclassify-card',?,'Card','bank',8766)").run(owner);
  sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date) VALUES('reclassify-tx',?,'reclassify-card','expense','Mistake',1234,'2026-09-17')").run(owner);
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents) VALUES('reclassify-event',?,'reclassify-tx',66)").run(owner);
  const payload = { transactionId:'reclassify-tx', accountId:'reclassify-card', amount:'12.34', date:'2026-09-17' };
  assert.equal((await post('correctTransaction', {...payload,type:'bogus'})).status,400);
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='reclassify-card'").get().balance_cents,8766);
  assert.equal((await post('correctTransaction', {...payload,type:'income'})).status,200);
  assert.equal(sqlite.prepare("SELECT status FROM spare_events WHERE id='reclassify-event'").get().status,'cancelled');
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='reclassify-card'").get().balance_cents,11234);
});


test('Type corrections keep linked payments and completed round-ups protected', async () => {
  const owner = 'type-guards'; globalThis.__spareTestUser = owner;
  sqlite.prepare("INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES('type-guards-card',?,'Card','bank',9000)").run(owner);
  for (const [id, recurring] of [['type-guards-linked','some-plan'],['type-guards-swept',null]])
    sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date,recurring_plan_id) VALUES(?,?,'type-guards-card','expense','Protected',1000,'2026-09-17',?)").run(id,owner,recurring);
  sqlite.prepare("INSERT INTO spare_events(id,user_id,transaction_id,multiplied_cents,status) VALUES('type-guards-event',?,'type-guards-swept',66,'swept')").run(owner);
  for (const transactionId of ['type-guards-linked','type-guards-swept']) {
    const response = await post('correctTransaction',{transactionId,type:'income',accountId:'type-guards-card',amount:'10',date:'2026-09-17'});
    assert.equal(response.status,409);
    assert.equal(sqlite.prepare('SELECT status FROM transactions WHERE id=?').get(transactionId).status,'posted');
  }
  assert.equal(sqlite.prepare("SELECT balance_cents FROM accounts WHERE id='type-guards-card'").get().balance_cents,9000);
});


test('Language settings persist per owner and reject unsupported values', async () => {
  sqlite.prepare("INSERT INTO profiles(user_id) VALUES('language-a'),('language-b')").run();
  globalThis.__spareTestUser='language-a';
  assert.equal((await post('updateLanguage',{language:'el'})).status,200);
  assert.equal(sqlite.prepare("SELECT ui_language FROM profiles WHERE user_id='language-a'").get().ui_language,'el');
  assert.equal(sqlite.prepare("SELECT ui_language FROM profiles WHERE user_id='language-b'").get().ui_language,'en');
  assert.equal((await post('updateLanguage',{language:'xx'})).status,400);
  assert.equal((await post('updateLanguage',{language:'en'})).status,200);
});


test('Recurring budget exclusion saves independently of protection and automation, and can be changed',async()=>{
 const owner='recurring-budget-api';globalThis.__spareTestUser=owner;
 sqlite.prepare('INSERT INTO profiles(user_id) VALUES(?)').run(owner);
 for(const [id,type] of [['recurring-budget-source','bank'],['recurring-budget-destination','savings']])sqlite.prepare('INSERT INTO accounts(id,user_id,name,type) VALUES(?,?,?,?)').run(id,owner,id,type);
 const payload={type:'saving',title:'Savings',amount:'100',nextDate:'2026-09-18',frequency:'monthly',accountId:'recurring-budget-source',destinationAccountId:'recurring-budget-destination',autoPost:true,committed:true,excludeFromBudget:true};
 let response=await post('addRecurring',payload);assert.equal(response.status,200,JSON.stringify(await response.json()));
 const plan=sqlite.prepare('SELECT * FROM recurring_plans WHERE user_id=?').get(owner);assert.equal(plan.counts_monthly,0);assert.equal(plan.committed,1);assert.equal(plan.auto_post,1);
 response=await post('updateRecurring',{...payload,planId:plan.id,excludeFromBudget:false});assert.equal(response.status,200,JSON.stringify(await response.json()));
 assert.equal(sqlite.prepare('SELECT counts_monthly n FROM recurring_plans WHERE id=?').get(plan.id).n,1);
 const legacy={...payload,title:'Included by default'};delete legacy.excludeFromBudget;
 assert.equal((await post('addRecurring',legacy)).status,200);
 assert.equal(sqlite.prepare("SELECT counts_monthly n FROM recurring_plans WHERE user_id=? AND title='Included by default'").get(owner).n,1);
});
