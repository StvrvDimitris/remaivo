import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as defaultNames from '../app/default-names.ts';

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
globalThis.__ledgerNames = defaultNames;
globalThis.__tagsTestEnv = { DB: {
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
const routeScratch = path.resolve('work/tags-tests');
fs.mkdirSync(routeScratch, { recursive: true });
fs.writeFileSync(path.join(routeScratch, 'route.mjs'), ts.transpileModule(`
const env = globalThis.__tagsTestEnv;
const getUser = async () => ({ userId: 'owner', displayName: 'Test', email: 'test@example.invalid' });
const ensureFinanceSchema = async () => {};
const financialToday = () => '2026-10-08';
const reconcileV3 = async () => {};
const spareRoundUpCents = () => 0;
const v3Snapshot = async () => ({});
const isLedgerType = (type) => ['opening_balance', 'balance_adjustment'].includes(type);
const { defaultAccountName, defaultCategories, defaultPlanName, nameLanguage, otherNames } = globalThis.__ledgerNames;
class ArchiveError extends Error { status = 409; }
class BackupError extends Error { status = 400; }
${fs.readFileSync('app/api/finance/route.ts', 'utf8').replace(/^import[^\n]*\r?\n/gm, '')}`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { POST, GET } = await import(pathToFileURL(path.join(routeScratch, 'route.mjs')));
const post = (action, payload = {}) => POST(new Request('https://example.invalid/api/finance', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }),
}));
sqlite.prepare("INSERT INTO profiles(user_id,currency,setup_complete) VALUES('owner','EUR',1)").run();

const get = tagId => GET(new Request(`https://example.invalid/api/finance?view=transactions&tagId=${encodeURIComponent(tagId)}`));
const named = (table,name) => sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? AND name=?`).get('owner',name);
const check = async (response,status,error) => { assert.equal(response.status,status,JSON.stringify(await response.clone().json())); if(error) assert.equal((await response.json()).error,error); };

test('Tag CRUD, validation, corrections, transaction filters, and recurring plans',async()=>{
 await check(await post('addTagGroup',{name:'Purpose'}),200);
 const group=named('tag_groups','Purpose');
 await check(await post('addTagGroup',{name:'Purpose'}),500,'That item already exists.');
 await check(await post('updateTagGroup',{groupId:group.id,name:'Use'}),200);
 await check(await post('addTagGroup',{name:'Person'}),200);
 const other=named('tag_groups','Person');
 await check(await post('addTag',{groupId:group.id,name:'Daily',color:'#123456'}),200);
 await check(await post('addTag',{groupId:group.id,name:'Leisure'}),200);
 await check(await post('addTag',{groupId:other.id,name:'Me'}),200);
 const daily=named('tags','Daily'),leisure=named('tags','Leisure'),me=named('tags','Me');
 await check(await post('addTag',{groupId:group.id,name:'Daily'}),500,'That item already exists.');
 await check(await post('updateTag',{tagId:leisure.id,name:'Fun',color:'#abcdef'}),200);
 assert.equal(named('tags','Fun').color,'#abcdef');
 sqlite.prepare("INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES('tags-account','owner','Cash','cash',100000)").run();
 sqlite.prepare("INSERT INTO categories(id,user_id,name,kind) VALUES('tags-category','owner','Food','expense')").run();
 const purchase={type:'expense',description:'Tagged',amount:'10',date:'2026-10-08',accountId:'tags-account',categoryId:'tags-category'};
 await check(await post('addTransaction',{...purchase,tagIds:[daily.id,leisure.id]}),400,'Choose one tag from each tag group.');
 await check(await post('archiveTag',{tagId:leisure.id}),200);
 await check(await post('addTransaction',{...purchase,tagIds:[leisure.id]}),400,'Choose active tags.');
 await check(await post('addTransaction',{...purchase,tagIds:[me.id,daily.id]}),200);
 let original=sqlite.prepare("SELECT * FROM transactions WHERE description='Tagged' AND status='posted'").get();
 assert.equal(original.tag_ids,JSON.stringify([daily.id,me.id].sort()));
 await check(await post('archiveTag',{tagId:daily.id}),200);
 await check(await post('correctTransaction',{...purchase,transactionId:original.id,description:'Corrected'}),200);
 let corrected=sqlite.prepare("SELECT * FROM transactions WHERE description='Corrected' AND status='posted'").get();
 assert.equal(corrected.tag_ids,original.tag_ids);
 await check(await post('correctTransaction',{...purchase,transactionId:corrected.id,description:'Corrected again',tagIds:[daily.id,me.id]}),200);
 corrected=sqlite.prepare("SELECT * FROM transactions WHERE description='Corrected again' AND status='posted'").get();
 assert.equal(corrected.tag_ids,original.tag_ids);
 await check(await post('addTransaction',{...purchase,description:'Untagged',tagIds:[]}),200);
 const tagged=await (await get(daily.id)).json(), none=await (await get('none:'+group.id)).json();
 assert.deepEqual(tagged.items.map(t=>t.id),[corrected.id]);
 assert.deepEqual(none.items.map(t=>t.description),['Untagged']);
 await check(await post('addRecurring',{title:'Monthly',type:'expense',amount:'5',accountId:'tags-account',categoryId:'tags-category',frequency:'monthly',nextDate:'2026-10-09',tagIds:[me.id]}),200);
 assert.equal(sqlite.prepare("SELECT tag_ids FROM recurring_plans WHERE title='Monthly'").get().tag_ids,JSON.stringify([me.id]));
 await check(await post('archiveTagGroup',{groupId:other.id}),200);
 assert.equal(sqlite.prepare('SELECT archived FROM tag_groups WHERE id=?').get(other.id).archived,1);
});

