import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as defaultNames from '../app/default-names.ts';
import { accountFlow } from '../app/investment-valuations.ts';
globalThis.__spareNames = defaultNames;

const scratch = path.resolve('work/spare-tests');
fs.mkdirSync(scratch, { recursive: true });
const compile = (source, target) => {
  fs.writeFileSync(path.join(scratch, target), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
compile(fs.readFileSync('app/spare-change.ts', 'utf8'), 'spare-change.mjs');
const { spareRoundUpCents, spareTransferStatements } = await import(pathToFileURL(path.join(scratch, 'spare-change.mjs')));
globalThis.__spareTestRoundUp = spareRoundUpCents;
globalThis.__spareTestTransfer = spareTransferStatements;

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
      // Like D1, reads inside a batch return their rows.
      for (const statement of statements) results.push(/^\s*(SELECT|WITH)/i.test(statement.sql) ? await statement.all() : await statement.run());
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

// Run the actual sweep action with local auth, clock, and DB bindings.
const routeSource = fs.readFileSync('app/api/finance/route.ts', 'utf8')
  .replace(/^import[^\n]*\r?\n/gm, '');
compile(`const env = globalThis.__spareTestEnv;
const getUser = async () => ({ userId: globalThis.__spareTestUser, displayName: 'Test', email: 'test@example.invalid' });
const ensureFinanceSchema = async () => {};
const reconcileV3 = async () => {};
const v3Snapshot = async () => ({});
const financialToday = () => '2026-09-17';
const spareRoundUpCents = globalThis.__spareTestRoundUp;
const spareTransferStatements = globalThis.__spareTestTransfer;
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
    const replacement = sqlite.prepare('SELECT * FROM transactions WHERE id=?').get(original);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id=?').get(owner).n, 1);
    assert.equal(replacement.type, after);
    assert.equal(replacement.counts_monthly, ['expense','saving','investment'].includes(after) ? 1 : 0);
    assert.equal(replacement.destination_account_id, ['transfer','saving','investment'].includes(after) ? destination : null);
    assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(source).balance_cents, 10000 + expected[0]);
    assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(destination).balance_cents, 10000 + expected[1]);
    assert.equal(replacement.status, 'posted');
  }
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

test('A one-off planned payment ends on its due date, and editing it to repeat removes that end',async()=>{
 const owner='recurring-once-api';globalThis.__spareTestUser=owner;
 sqlite.prepare('INSERT INTO profiles(user_id) VALUES(?)').run(owner);
 sqlite.prepare('INSERT INTO accounts(id,user_id,name,type) VALUES(?,?,?,?)').run('recurring-once-source',owner,'Bank','bank');
 const payload={type:'saving',title:'Barber',amount:'25',nextDate:'2026-10-23',frequency:'once',accountId:'recurring-once-source',destinationAccountId:'recurring-once-source-2'};
 sqlite.prepare('INSERT INTO accounts(id,user_id,name,type) VALUES(?,?,?,?)').run('recurring-once-source-2',owner,'Savings','savings');
 assert.equal((await post('addRecurring',payload)).status,200);
 let plan=sqlite.prepare('SELECT * FROM recurring_plans WHERE user_id=?').get(owner);
 assert.equal(plan.end_date,'2026-10-23');assert.equal(plan.next_date,'2026-10-23');
 assert.equal((await post('updateRecurring',{...payload,planId:plan.id,nextDate:'2026-10-30'})).status,200);
 plan=sqlite.prepare('SELECT * FROM recurring_plans WHERE id=?').get(plan.id);
 assert.equal(plan.end_date,'2026-10-30');
 assert.equal((await post('updateRecurring',{...payload,planId:plan.id,frequency:'weekly',intervalCount:2})).status,200);
 plan=sqlite.prepare('SELECT * FROM recurring_plans WHERE id=?').get(plan.id);
 assert.equal(plan.end_date,null);assert.equal(plan.frequency,'weekly');assert.equal(plan.interval_count,2);
});

test('Planning can be turned off and on, and the snapshot carries this month against the same days of last month',async()=>{
 const owner='planning-toggle';globalThis.__spareTestUser=owner;
 sqlite.prepare('INSERT INTO profiles(user_id,setup_complete) VALUES(?,1)').run(owner);
 sqlite.prepare("INSERT INTO accounts(id,user_id,name,type) VALUES('planning-bank',?,'Bank','bank')").run(owner);
 let response=await post('updatePlanning',{enabled:false});let body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 assert.equal(sqlite.prepare('SELECT planning_enabled n FROM profiles WHERE user_id=?').get(owner).n,0);
 const today=body.today;const {start,previousStart,previousThrough}=body.month;
 assert.equal(start,today.slice(0,8)+'01');assert.ok(previousStart<start&&previousThrough<start&&previousThrough>=previousStart);
 const add=(id,type,amount,date)=>sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date) VALUES(?,?,'planning-bank',?,?,?,?)").run(id,owner,type,id,amount,date);
 add('this-income','income',100000,start);add('this-spend','expense',2500,today);add('this-transfer','transfer',9999,today);
 add('last-spend','expense',4000,previousStart);add('last-income','income',50000,previousThrough);
 const lastDay=new Date(Date.UTC(Number(previousStart.slice(0,4)),Number(previousStart.slice(5,7)),0)).toISOString().slice(0,10);
 if(lastDay>previousThrough)add('last-late','expense',7000,lastDay);
 response=await post('updatePlanning',{enabled:true});body=await response.json();
 assert.equal(sqlite.prepare('SELECT planning_enabled n FROM profiles WHERE user_id=?').get(owner).n,1);
 assert.deepEqual([body.month.income,body.month.spending,body.month.previousIncome,body.month.previousSpending],[100000,2500,50000,4000]);
});

// These accounts start at zero, so their balances must equal their posted ledger entries.
const checkLedger = owner => {
  for (const account of sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=?').all(owner)) {
    const total = sqlite.prepare("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND (account_id=? OR destination_account_id=?)").all(owner, account.id, account.id)
      .reduce((sum, tx) => sum + accountFlow(tx, account.id), 0);
    assert.equal(account.balance_cents, total, account.id);
  }
};
const editPayload = (id, type, account, destination, amount = '20') => ({ transactionId: id, type, accountId: account, destinationAccountId: destination, amount, date: '2026-09-17', description: 'Edited' });
function seedEditable(owner, type = 'expense') {
  globalThis.__spareTestUser = owner;
  sqlite.prepare('INSERT INTO profiles(user_id) VALUES(?)').run(owner);
  for (const suffix of ['a', 'b', 'c']) sqlite.prepare("INSERT INTO accounts(id,user_id,name,type) VALUES(?,?,?,'bank')").run(`${owner}-${suffix}`, owner, suffix);
  const source = `${owner}-a`, destination = `${owner}-b`, id = `${owner}-tx`;
  const moving = type === 'transfer';
  sqlite.prepare("INSERT INTO transactions(id,user_id,account_id,destination_account_id,type,description,amount_cents,date) VALUES(?,?,?,?,?,'Original',1000,'2026-09-17')").run(id, owner, source, moving ? destination : null, type);
  sqlite.prepare('UPDATE accounts SET balance_cents=? WHERE id=?').run(type === 'income' ? 1000 : -1000, source);
  if (moving) sqlite.prepare('UPDATE accounts SET balance_cents=1000 WHERE id=?').run(destination);
  return { id, source, destination, other: `${owner}-c` };
}

test('Edits change amount, accounts and type in place while preserving the ledger', async () => {
  for (const type of ['expense', 'income', 'transfer']) {
    const owner = `edit-ledger-${type}`, { id, destination, other } = seedEditable(owner, type);
    const after = type === 'expense' ? 'income' : type === 'income' ? 'transfer' : 'expense';
    let response = await post('editTransaction', editPayload(id, type, other, destination));
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    checkLedger(owner);
    assert.deepEqual(sqlite.prepare('SELECT balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => row.balance_cents), type === 'expense' ? [0, 0, -2000] : type === 'income' ? [0, 0, 2000] : [0, 2000, -2000]);
    response = await post('editTransaction', editPayload(id, after, other, destination, '15'));
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const rows = sqlite.prepare('SELECT id,type,amount_cents,status FROM transactions WHERE user_id=?').all(owner).map(row => ({ ...row }));
    assert.deepEqual(rows, [{ id, type: after, amount_cents: 1500, status: 'posted' }]);
    checkLedger(owner);
    assert.deepEqual(sqlite.prepare('SELECT balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => row.balance_cents), after === 'expense' ? [0, 0, -1500] : after === 'income' ? [0, 0, 1500] : [0, 1500, -1500]);
  }
});

test('Deleting reverses balances and removes assignments', async () => {
  const owner = 'delete-ledger', { id } = seedEditable(owner, 'transfer');
  sqlite.prepare("INSERT INTO v3_assignments(id,user_id,transaction_id,bucket_id,amount_cents) VALUES('delete-assignment',?,?,'bucket',500)").run(owner, id);
  assert.equal((await post('deleteTransaction', { transactionId: id })).status, 200);
  for (const table of ['transactions', 'v3_assignments']) assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(owner).n, 0);
  checkLedger(owner);
  assert.deepEqual(sqlite.prepare('SELECT balance_cents FROM accounts WHERE user_id=? ORDER BY id').all(owner).map(row => row.balance_cents), [0, 0, 0]);
});

test('Editing scales an assignment down and changing type removes it', async () => {
  const owner = 'edit-assignment', { id, source, destination } = seedEditable(owner);
  sqlite.prepare("INSERT INTO v3_assignments(id,user_id,transaction_id,bucket_id,amount_cents) VALUES('edit-assignment-row',?,?,'bucket',600)").run(owner, id);
  assert.equal((await post('editTransaction', editPayload(id, 'expense', source, destination, '5'))).status, 200);
  assert.equal(sqlite.prepare("SELECT amount_cents FROM v3_assignments WHERE id='edit-assignment-row'").get().amount_cents, 300);
  checkLedger(owner);
  assert.equal((await post('editTransaction', editPayload(id, 'income', source, destination, '5'))).status, 200);
  assert.equal(sqlite.prepare("SELECT * FROM v3_assignments WHERE id='edit-assignment-row'").get(), undefined);
  checkLedger(owner);
});

test('Linked recurring payments update on edit and reopen on deletion', async () => {
  for (const remaining of [0, 400]) {
    const owner = `linked-${remaining}`, { id, source, destination } = seedEditable(owner);
    const plan = `${owner}-plan`, occurrence = `${owner}-occurrence`;
    sqlite.prepare("INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,account_id,frequency,next_date,active) VALUES(?,?,'Plan','expense',1000,?,'monthly','2026-10-17',1)").run(plan, owner, source);
    sqlite.prepare("INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,paid_cents,status,transaction_id) VALUES(?,?,'recurring',?,'2026-09-17','2026-09-17','Plan','expense',?,?, 'paid',?)").run(occurrence, owner, plan, 1000 + remaining, 1000 + remaining, id);
    sqlite.prepare('INSERT INTO v3_payment_links(transaction_id,user_id,occurrence_id) VALUES(?,?,?)').run(id, owner, occurrence);
    assert.equal((await post('editTransaction', editPayload(id, 'income', source, destination))).status, 409);
    assert.equal((await post('editTransaction', editPayload(id, 'expense', source, destination, '15'))).status, 200);
    let row = sqlite.prepare('SELECT paid_cents,amount_cents FROM v3_occurrences WHERE id=?').get(occurrence);
    assert.deepEqual({ ...row }, { paid_cents: 1500 + remaining, amount_cents: 1500 + remaining });
    checkLedger(owner);
    assert.equal((await post('deleteTransaction', { transactionId: id })).status, 200);
    row = sqlite.prepare('SELECT paid_cents,status,transaction_id FROM v3_occurrences WHERE id=?').get(occurrence);
    assert.deepEqual({ ...row }, { paid_cents: remaining, status: remaining ? 'partial' : 'upcoming', transaction_id: null });
    assert.equal(sqlite.prepare('SELECT next_date FROM recurring_plans WHERE id=?').get(plan).next_date, '2026-09-17');
    assert.equal(sqlite.prepare('SELECT * FROM v3_payment_links WHERE transaction_id=?').get(id), undefined);
    checkLedger(owner);
  }
});

test('Edit and delete refuse protected and missing transactions', async () => {
  const owner = 'edit-guards', { source, destination } = seedEditable(owner);
  for (const [id, type, description] of [['installment-purchase', 'installment_purchase', 'Purchase'], ['installment-payment', 'installment_payment', 'Payment'], ['opening', 'opening_balance', 'Opening'], ['adjustment', 'balance_adjustment', 'Adjustment'], ['hidden', 'expense', 'Hidden']]) {
    sqlite.prepare('INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date,status) VALUES(?,?,?,?,?,1000,?,?)').run(id, owner, source, type, description, '2026-09-17', id === 'hidden' ? 'corrected' : 'posted');
  }
  for (const id of ['installment-purchase', 'installment-payment', 'opening', 'adjustment', 'hidden', 'unknown']) {
    for (const action of ['editTransaction', 'deleteTransaction']) {
      const response = await post(action, editPayload(id, 'expense', source, destination));
      assert.equal(response.status, ['hidden', 'unknown'].includes(id) ? 404 : 409, `${action}: ${id}`);
      const { error } = await response.json();
      if (id.startsWith('installment')) assert.equal(error, 'Change installment entries from their pay-later plan.');
      if (['opening', 'adjustment'].includes(id)) assert.equal(error, 'Use Update balance on the account to change an opening balance or adjustment.');
      if (['hidden', 'unknown'].includes(id)) assert.equal(error, 'That transaction is no longer available.');
    }
  }
});



test('Eligible purchases post a separate round-up and preserve the ledger', async () => {
  for (const [scenario, destType, enabled, excluded, other, archived, multiplier, expected] of [
    ['savings','savings',1,false,false,0,1,66], ['investment','investment',1,false,false,0,3,198],
    ['excluded','savings',1,true,false,0,2,0], ['other','savings',1,false,true,0,2,0],
    ['disabled','savings',0,false,false,0,2,0], ['archived','savings',1,false,false,1,2,0],
  ]) {
    const owner=`round-${scenario}`, source=`${owner}-source`, dest=`${owner}-dest`, third=`${owner}-other`;
    globalThis.__spareTestUser=owner;
    sqlite.prepare('INSERT INTO profiles(user_id,spare_enabled,spare_source_id,spare_destination_id,spare_multiplier) VALUES(?,?,?,?,?)').run(owner,enabled,source,dest,multiplier);
    for(const [id,type,archive] of [[source,'bank',0],[dest,destType,archived],[third,'bank',0]]) sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,archived) VALUES(?,?,?,?,?)').run(id,owner,id,type,archive);
    const response=await post('addTransaction',{type:'expense',accountId:other?third:source,description:'Coffee',amount:'12.34',date:'2026-09-17',excludeFromSpare:excluded});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    const rows=sqlite.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY type').all(owner);
    assert.equal(rows.length,expected?2:1,scenario);
    if(expected) {
      const transfer=rows.find(row=>row.type!=='expense');
      assert.deepEqual([transfer.type,transfer.amount_cents,transfer.description,transfer.date,transfer.committed,transfer.counts_monthly,transfer.account_id,transfer.destination_account_id],[destType==='investment'?'investment':'saving',expected,'Spare change: Coffee','2026-09-17',1,1,source,dest]);
    }
    checkLedger(owner);
    assert.deepEqual([source,dest,third].map(id=>sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(id).balance_cents),[other?0:-1234-expected,expected,other?-1234:0]);
    if(expected && scenario==='savings') {
      const purchase=rows.find(row=>row.type==='expense');
      assert.equal((await post('editTransaction',editPayload(purchase.id,'expense',source,dest,'20'))).status,200);
      checkLedger(owner);
      assert.equal((await post('deleteTransaction',{transactionId:purchase.id})).status,200);
      checkLedger(owner);
      assert.deepEqual(sqlite.prepare('SELECT type,amount_cents FROM transactions WHERE user_id=?').all(owner).map(r=>({...r})),[{type:'saving',amount_cents:66}]);
      assert.deepEqual([source,dest,third].map(id=>sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(id).balance_cents),[-66,66,0]);
    }
  }
});

test('Spare settings validate active accounts and save the multiplier', async () => {
  const owner='spare-settings'; globalThis.__spareTestUser=owner;
  sqlite.prepare('INSERT INTO profiles(user_id) VALUES(?)').run(owner);
  for(const [id,type,archived] of [['settings-source','bank',0],['settings-dest','savings',0],['settings-archived','bank',1],['settings-invest','investment',0]]) sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,archived) VALUES(?,?,?,?,?)').run(id,owner,id,type,archived);
  const payload={enabled:true,sourceAccountId:'settings-source',destinationAccountId:'settings-dest',multiplier:3};
  for(const id of ['settings-archived','settings-invest','missing']) {
    const response=await post('updateSpare',{...payload,sourceAccountId:id});
    assert.equal(response.status,400); assert.equal((await response.json()).error,'Choose an active spending account for round-ups.');
  }
  assert.equal((await post('updateSpare',{...payload,destinationAccountId:'settings-source'})).status,400);
  assert.equal((await post('updateSpare',payload)).status,200);
  assert.deepEqual({...sqlite.prepare('SELECT spare_enabled,spare_source_id,spare_destination_id,spare_multiplier FROM profiles WHERE user_id=?').get(owner)},{spare_enabled:1,spare_source_id:'settings-source',spare_destination_id:'settings-dest',spare_multiplier:3});
});
