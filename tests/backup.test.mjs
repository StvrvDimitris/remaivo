import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const tables = [
  'profiles', 'accounts', 'investment_valuation_snapshots', 'categories',
  'transactions', 'budget_rules', 'recurring_plans', 'expense_reserves',
  'expense_reserve_periods', 'installment_plans', 'installment_payments',
  'goals', 'spare_events', 'forecast_scenarios',
  'v3_versions', 'v3_periods', 'v3_bucket_templates', 'v3_bucket_periods',
  'v3_assignments', 'v3_occurrences', 'v3_events', 'v3_ledger_entries',
  'v3_opening_anchors', 'v3_payment_links',
];

let sqlite;
let failAfterWrite = null;
let writeCount = 0;

class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() {
    if (/^\s*(?:INSERT|DELETE|UPDATE|REPLACE)\b/i.test(this.sql) && failAfterWrite !== null && ++writeCount === failAfterWrite) {
      throw new Error('Injected database write failure');
    }
    const result = sqlite.prepare(this.sql).run(...this.args);
    return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
  }
}

globalThis.__backupTestEnv = {
  DB: {
    prepare: sql => new Statement(sql),
    batch: async statements => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(/^\s*SELECT\b/i.test(statement.sql) ? await statement.all() : await statement.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
};

const scratch = path.resolve('work/backup-tests');
fs.mkdirSync(scratch, { recursive: true });
const source = fs.readFileSync('db/backup.ts', 'utf8')
  .replace(/import \{ env \} from ["']cloudflare:workers["'];?/, 'const env=globalThis.__backupTestEnv;');
fs.writeFileSync(path.join(scratch, 'backup.mjs'), ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const { exportBackup } = await import(pathToFileURL(path.join(scratch, 'backup.mjs')));

function freshDatabase() {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  }
  failAfterWrite = null;
  writeCount = 0;
}

function seed(user, prefix) {
  const account = `${prefix}-account`;
  const category = `${prefix}-category`;
  const transaction = `${prefix}-transaction`;
  const recurring = `${prefix}-recurring`;
  const installment = `${prefix}-installment`;
  const reserve = `${prefix}-reserve`;
  const version = `${prefix}-version`;
  const period = `${prefix}-period`;
  const bucket = `${prefix}-bucket`;
  const occurrence = `${prefix}-occurrence`;
  const insert = (sql, ...args) => sqlite.prepare(sql).run(...args);
  insert('INSERT INTO profiles(user_id,currency,setup_complete) VALUES(?,?,1)', user, 'EUR');
  insert('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)', account, user, `${prefix} cash`, 'checking', 98250);
  insert('INSERT INTO investment_valuation_snapshots(id,user_id,account_id,snapshot_date,value_cents) VALUES(?,?,?,?,?)', `${prefix}-valuation`, user, account, '2026-09-20', 45000);
  insert('INSERT INTO categories(id,user_id,name,kind) VALUES(?,?,?,?)', category, user, `${prefix} food`, 'expense');
  insert('INSERT INTO transactions(id,user_id,account_id,category_id,type,description,amount_cents,date) VALUES(?,?,?,?,?,?,?,?)', transaction, user, account, category, 'expense', `${prefix}_PRIVATE_PURCHASE`, 1750, '2026-09-20');
  insert('INSERT INTO budget_rules(id,user_id,period,anchor_date,base_cents) VALUES(?,?,?,?,?)', `${prefix}-rule`, user, 'monthly', '2026-09-01', 100000);
  insert('INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,account_id,frequency,next_date) VALUES(?,?,?,?,?,?,?,?)', recurring, user, `${prefix} groceries`, 'expense', 1750, account, 'monthly', '2026-10-20');
  insert('INSERT INTO expense_reserves(id,user_id,title,category_id,target_cents) VALUES(?,?,?,?,?)', reserve, user, `${prefix} reserve`, category, 5000);
  insert('INSERT INTO expense_reserve_periods(id,user_id,reserve_id,category_id,month,target_cents) VALUES(?,?,?,?,?,?)', `${prefix}-reserve-period`, user, reserve, category, '2026-09', 5000);
  insert('INSERT INTO installment_plans(id,user_id,title,total_cents,installment_count,first_due_date,payment_account_id) VALUES(?,?,?,?,?,?,?)', installment, user, `${prefix} laptop`, 120000, 12, '2026-09-10', account);
  insert('INSERT INTO installment_payments(id,user_id,plan_id,sequence,due_date,amount_cents) VALUES(?,?,?,?,?,?)', `${prefix}-installment-payment`, user, installment, 1, '2026-09-10', 10000);
  insert('INSERT INTO goals(id,user_id,name,kind,account_id) VALUES(?,?,?,?,?)', `${prefix}-goal`, user, `${prefix} holiday`, 'savings', account);
  insert('INSERT INTO spare_events(id,user_id,transaction_id,destination_account_id,base_cents,multiplied_cents) VALUES(?,?,?,?,?,?)', `${prefix}-spare`, user, transaction, account, 50, 50);
  insert('INSERT INTO forecast_scenarios(id,user_id,name,events_json) VALUES(?,?,?,?)', `${prefix}-scenario`, user, `${prefix} car repair`, '[]');
  insert('INSERT INTO v3_migrations(user_id,snapshot_json,summary_json) VALUES(?,?,?)', user, JSON.stringify({ transactions: [{ id: transaction }] }), '{"transactions":1}');
  insert('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)', version, user, '2026-09-01', '{"target":100000,"period":"monthly"}');
  insert('INSERT INTO v3_periods(id,user_id,start_date,end_date,version_id,funding_cents) VALUES(?,?,?,?,?,?)', period, user, '2026-09-01', '2026-10-01', version, 100000);
  insert('INSERT INTO v3_bucket_templates(id,user_id,name,kind,category_id,target_cents) VALUES(?,?,?,?,?,?)', bucket, user, `${prefix} food`, 'protected', category, 20000);
  insert('INSERT INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_id,target_cents) VALUES(?,?,?,?,?,?,?,?)', `${prefix}-bucket-period`, user, period, bucket, `${prefix} food`, 'protected', category, 20000);
  insert('INSERT INTO v3_assignments(id,user_id,transaction_id,bucket_id,amount_cents) VALUES(?,?,?,?,?)', `${prefix}-assignment`, user, transaction, bucket, 1750);
  insert('INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,paid_cents,account_id,category_id,status,transaction_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', occurrence, user, 'recurring', recurring, '2026-09-20', '2026-09-20', `${prefix} groceries`, 'expense', 1750, 1750, account, category, 'paid', transaction);
  insert('INSERT INTO v3_events(id,user_id,kind,detail) VALUES(?,?,?,?)', `${prefix}-event`, user, 'allocation', `${prefix} allocation`);
  insert('INSERT INTO v3_ledger_entries(id,user_id,transaction_id,account_id,amount_cents) VALUES(?,?,?,?,?)', `${prefix}-ledger`, user, transaction, account, -1750);
  insert('INSERT INTO v3_opening_anchors(id,user_id,account_id,amount_cents) VALUES(?,?,?,?)', `${prefix}-anchor`, user, account, 100000);
  insert('INSERT INTO v3_payment_links(transaction_id,user_id,occurrence_id) VALUES(?,?,?)', transaction, user, occurrence);
}

function rowsFor(user) {
  return Object.fromEntries(tables.map(table => [table,
    sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(user)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}

test('JSON export includes current records without the migration snapshot or another owner', async () => {
  freshDatabase();
  seed('alice', 'ALICE');
  seed('bob', 'BOB');
  sqlite.prepare('INSERT INTO transactions(id,user_id,type,description,amount_cents,date) VALUES(?,?,?,?,?,?)')
    .run('alice-new', 'alice', 'expense', 'AFTER_MIGRATION_PRIVATE_PURCHASE', 999, '2026-09-21');
  sqlite.prepare('UPDATE categories SET archived=1 WHERE user_id=?').run('alice');
  const before = JSON.parse(JSON.stringify(rowsFor('alice')));
  const bobBefore = JSON.parse(JSON.stringify(rowsFor('bob')));
  const backup = JSON.parse(JSON.stringify(await exportBackup('alice')));
  assert.equal(backup.format, 'remaivo-backup');
  assert.equal(backup.version, 2);
  assert.equal(backup.ownerId, 'alice');
  assert.ok(!Number.isNaN(Date.parse(backup.exportedAt)));
  assert.deepEqual(Object.keys(backup.tables).sort(), [...tables].sort());
  assert.equal(Object.hasOwn(backup.tables, 'v3_migrations'), false);
  for (const table of tables) {
    assert.ok(backup.tables[table]?.length, `${table} must be included`);
    assert.deepEqual(backup.tables[table].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), before[table]);
  }
  const serialized = JSON.stringify(backup);
  assert.match(serialized, /AFTER_MIGRATION_PRIVATE_PURCHASE/);
  assert.doesNotMatch(serialized, /BOB_PRIVATE_PURCHASE/);
  assert.deepEqual(JSON.parse(JSON.stringify(rowsFor('alice'))), before);
  assert.deepEqual(JSON.parse(JSON.stringify(rowsFor('bob'))), bobBefore);
});
