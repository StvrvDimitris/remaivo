import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const sqlite = new DatabaseSync(':memory:');
for (const file of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) sqlite.exec(fs.readFileSync(path.join('drizzle', file), 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
globalThis.__archiveEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
} };
const scratch = path.resolve('work/archive-tests'); fs.mkdirSync(scratch, { recursive: true });
for (const [source, destination] of [['app/archive-types.ts', 'types'], ['app/finance-dates.ts', 'dates'], ['app/v3-engine.ts', 'engine'], ['db/archive.ts', 'archive']]) {
  let text = fs.readFileSync(source, 'utf8').replace('import { env } from "cloudflare:workers";', 'const env = globalThis.__archiveEnv;')
    .replace('"../app/finance-dates"', '"./dates.mjs"').replace("'./finance-dates'", "'./dates.mjs'").replace('"../app/v3-engine"', '"./engine.mjs"').replace('"../app/archive-types"', '"./types.mjs"')
    .replace('import { currentPeriod } from "./v3";', 'const currentPeriod = async () => ({ period: { id: "current" } });');
  fs.writeFileSync(path.join(scratch, destination + '.mjs'), ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { listArchive, restoreArchive } = await import(pathToFileURL(path.join(scratch, 'archive.mjs')));
const today = '2026-10-05';
const insertAccount = (id, user, archived = 1) => sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents,archived) VALUES(?,?,?,\'bank\',12345,?)').run(id, user, id, archived);
const row = (table, id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);

test('Archive search and pagination are owner scoped and do not include completed or corrected history', async () => {
  for (let i = 0; i < 27; i++) insertAccount(`archive ${String(i).padStart(2, '0')}`, 'list-owner');
  insertAccount('foreign-account', 'other-owner'); insertAccount('active-account', 'list-owner', 0);
  sqlite.prepare("INSERT INTO installment_plans(id,user_id,title,total_cents,paid_cents,installment_count,first_due_date,payment_account_id,status) VALUES('complete','list-owner','Completed',100,100,1,'2026-10-01','active-account','complete')").run();
  const first = await listArchive('list-owner', new URLSearchParams());
  assert.equal(first.total, 27); assert.equal(first.items.length, 25); assert.equal(first.totalPages, 2);
  const second = await listArchive('list-owner', new URLSearchParams({page:'2'}));
  assert.equal(second.items.length, 2); assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 27);
  const searched = await listArchive('list-owner', new URLSearchParams({kind:'account',q:'ARCHIVE 26'}));
  assert.equal(searched.total, 1); assert.equal(searched.items[0].name, 'archive 26');
  assert.equal((await listArchive('other-owner', new URLSearchParams())).total, 1);
  await assert.rejects(() => restoreArchive('list-owner', today, {kind:'account',id:'foreign-account'}), /no longer archived/);
  await assert.rejects(() => listArchive('list-owner', new URLSearchParams({kind:'transactions'})), /available archive type/);
});

test('Accounts, categories and goals restore without changing balances or tracking baselines', async () => {
  insertAccount('linked', 'simple-owner');
  sqlite.prepare("INSERT INTO categories(id,user_id,name,kind,archived) VALUES('cat','simple-owner','Food','expense',1)").run();
  sqlite.prepare("INSERT INTO goals(id,user_id,name,kind,account_id,baseline_cents,tracking_mode,archived) VALUES('goal','simple-owner','Saving','savings','linked',9000,'new_money',1)").run();
  await assert.rejects(() => restoreArchive('simple-owner', today, {kind:'goal',id:'goal'}), /linked account “linked” first/);
  await restoreArchive('simple-owner', today, {kind:'account',id:'linked'});
  await restoreArchive('simple-owner', today, {kind:'category',id:'cat'});
  await restoreArchive('simple-owner', today, {kind:'goal',id:'goal'});
  assert.equal(row('accounts','linked').balance_cents,12345); assert.equal(row('goals','goal').baseline_cents,9000);
  assert.equal(row('categories','cat').archived,0); assert.equal(row('goals','goal').tracking_mode,'new_money');
  await assert.rejects(() => restoreArchive('simple-owner', today, {kind:'goal',id:'goal'}), /no longer archived/);
});

test('All six supported archive types can be searched together or filtered separately', async () => {
  const user = 'all-kinds'; insertAccount('all-account', user);
  sqlite.prepare("INSERT INTO categories(id,user_id,name,kind,archived) VALUES('all-cat',?,'Archived category','expense',1)").run(user);
  sqlite.prepare("INSERT INTO goals(id,user_id,name,kind,archived) VALUES('all-goal',?,'Archived goal','savings',1)").run(user);
  sqlite.prepare("INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,frequency,next_date,active) VALUES('all-rec',?,'Archived recurring','expense',500,'monthly','2026-10-01',0)").run(user);
  sqlite.prepare("INSERT INTO installment_plans(id,user_id,title,total_cents,installment_count,first_due_date,payment_account_id,status) VALUES('all-pay',?,'Archived purchase',10000,2,'2026-10-01','all-account','archived')").run(user);
  sqlite.prepare("INSERT INTO v3_bucket_templates(id,user_id,name,kind,target_cents,archived) VALUES('all-bucket',?,'Archived bucket','protected',5000,1)").run(user);
  const data = await listArchive(user, new URLSearchParams());
  assert.equal(data.total, 6);
  assert.deepEqual(data.items.map(item => item.kind).sort(), ['account','bucket','category','goal','installment','recurring']);
  for (const kind of data.items.map(item => item.kind)) assert.equal((await listArchive(user,new URLSearchParams({kind}))).total,1);
});

test('Recurring restoration restarts in the future with automation off and paid/older history untouched', async () => {
  insertAccount('rec-cash','rec-owner',0);
  sqlite.prepare("INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,account_id,frequency,next_date,active,auto_post) VALUES('rec','rec-owner','Rent','expense',10000,'rec-cash','monthly','2026-09-06',0,1)").run();
  for (const [id,date,status,paid] of [['old','2026-09-06','cancelled',0],['future','2026-10-06','cancelled',2000],['paid','2026-11-06','paid',10000]]) {
    sqlite.prepare("INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,status,paid_cents,auto_post) VALUES(?,'rec-owner','recurring','rec',?,?,'Rent','expense',10000,?,?,1)").run(id,date,date,status,paid);
  }
  await assert.rejects(() => restoreArchive('rec-owner', today, {kind:'recurring',id:'rec',nextDate:'2026-09-06'}), /today or a future/);
  await restoreArchive('rec-owner', today, {kind:'recurring',id:'rec',nextDate:'2026-10-06'});
  assert.equal(row('recurring_plans','rec').auto_post,0); assert.equal(row('recurring_plans','rec').next_date,'2026-10-06');
  assert.equal(row('v3_occurrences','old').status,'cancelled'); assert.equal(row('v3_occurrences','future').status,'partial');
  assert.equal(row('v3_occurrences','future').paid_cents,2000); assert.equal(row('v3_occurrences','future').auto_post,0);
  assert.equal(row('v3_occurrences','paid').status,'paid'); assert.equal(row('accounts','rec-cash').balance_cents,12345);
});

test('Pay-later restoration reschedules unpaid installments while retaining paid amounts and partial progress', async () => {
  insertAccount('pay-cash','pay-owner',0);
  sqlite.prepare("INSERT INTO installment_plans(id,user_id,title,total_cents,paid_cents,installment_count,first_due_date,payment_account_id,status,auto_post) VALUES('pay','pay-owner','Purchase',30000,15000,3,'2026-08-01','pay-cash','archived',1)").run();
  for (const [id,sequence,status] of [['p1',1,'paid'],['p2',2,'cancelled'],['p3',3,'cancelled']]) {
    sqlite.prepare("INSERT INTO installment_payments(id,user_id,plan_id,sequence,due_date,amount_cents,status) VALUES(?,'pay-owner','pay',?,'2026-09-01',10000,?)").run(id,sequence,status);
  }
  sqlite.prepare("INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,paid_cents,status) VALUES('partial','pay-owner','installment','p2','2026-09-01','2026-09-01','Purchase','installment_payment',10000,5000,'cancelled')").run();
  await restoreArchive('pay-owner', today, {kind:'installment',id:'pay',nextDate:'2026-10-31'});
  assert.equal(row('installment_plans','pay').paid_cents,15000); assert.equal(row('installment_plans','pay').auto_post,0);
  assert.equal(row('installment_payments','p1').status,'paid'); assert.equal(row('installment_payments','p1').due_date,'2026-09-01');
  assert.equal(row('installment_payments','p2').due_date,'2026-10-31'); assert.equal(row('installment_payments','p3').due_date,'2026-11-30');
  assert.equal(row('v3_occurrences','partial').status,'partial'); assert.equal(row('v3_occurrences','partial').paid_cents,5000);
});

test('Bucket restore preserves the current allocation and refuses conflicting categories', async () => {
  sqlite.prepare("INSERT INTO categories(id,user_id,name,kind) VALUES('bucket-cat','bucket-owner','Fuel','expense')").run();
  sqlite.prepare("INSERT INTO v3_bucket_templates(id,user_id,name,kind,category_ids,target_cents,archived) VALUES('bucket','bucket-owner','Fuel','protected','[\"bucket-cat\"]',16000,1)").run();
  sqlite.prepare("INSERT INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_ids,target_cents,released) VALUES('current:bucket','bucket-owner','current','bucket','Fuel','protected','[\"bucket-cat\"]',18000,1)").run();
  sqlite.prepare("INSERT INTO v3_bucket_templates(id,user_id,name,kind,category_ids,target_cents) VALUES('conflict','bucket-owner','Replacement','protected','[\"other-cat\",\"bucket-cat\"]',5000)").run();
  await assert.rejects(() => restoreArchive('bucket-owner',today,{kind:'bucket',id:'bucket'}), /already uses one of this bucket’s categories/);
  assert.equal(row('v3_bucket_templates','bucket').archived,1);
  sqlite.prepare("UPDATE v3_bucket_templates SET category_ids='[\"other-cat\"]' WHERE id='conflict'").run();
  await restoreArchive('bucket-owner',today,{kind:'bucket',id:'bucket'});
  assert.equal(row('v3_bucket_templates','bucket').archived,0);
  assert.equal(row('v3_bucket_periods','current:bucket').target_cents,18000);
  assert.equal(row('v3_bucket_periods','current:bucket').released,0);
});
