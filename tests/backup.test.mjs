import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const tables = [
  'profiles', 'accounts', 'investment_valuation_snapshots', 'categories',
  'transactions', 'recurring_plans', 'installment_plans', 'installment_payments',
  'goals', 'goal_entries', 'tags',
  'v3_versions', 'v3_periods', 'v3_bucket_templates', 'v3_bucket_periods',
  'v3_assignments', 'v3_occurrences', 'v3_events', 'v3_payment_links',
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
const { BackupError, exportBackup, previewRestore, restoreBackup } = await import(pathToFileURL(path.join(scratch, 'backup.mjs')));

function freshDatabase() {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  }
  sqlite.exec(`CREATE TABLE auth_identities (google_sub TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, avatar_color TEXT NOT NULL DEFAULT '', avatar_icon TEXT NOT NULL DEFAULT '');
    CREATE TABLE auth_password (id INTEGER PRIMARY KEY, hash TEXT NOT NULL);
    INSERT INTO auth_password(id,hash) VALUES(1,'SECRET_PASSWORD_HASH');`);
  failAfterWrite = null;
  writeCount = 0;
}

function identity(user, name, owner = false) {
  sqlite.prepare('INSERT INTO auth_identities(google_sub,user_id,email,display_name,avatar_color,avatar_icon) VALUES(?,?,?,?,?,?)')
    .run(owner ? 'password:owner' : `password:${user}`, user, `${user}@remaivo.local`, name, '#123456', 'A');
}

function household() {
  freshDatabase();
  identity('alice', 'Alice', true);
  identity('bob', 'Bob');
  seed('alice', 'ALICE');
  seed('bob', 'BOB');
}

const copy = value => JSON.parse(JSON.stringify(value));
const count = (table, user) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(user).n;

function seed(user, prefix) {
  const account = `${prefix}-account`;
  const category = `${prefix}-category`;
  const transaction = `${prefix}-transaction`;
  const recurring = `${prefix}-recurring`;
  const installment = `${prefix}-installment`;
  const version = `${prefix}-version`;
  const period = `${prefix}-period`;
  const bucket = `${prefix}-bucket`;
  const occurrence = `${prefix}-occurrence`;
  const insert = (sql, ...args) => sqlite.prepare(sql).run(...args);
  insert('INSERT INTO profiles(user_id,currency,setup_complete) VALUES(?,?,1)', user, 'EUR');
  insert('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)', account, user, `${prefix} cash`, 'checking', 98250);
  insert('INSERT INTO investment_valuation_snapshots(id,user_id,account_id,snapshot_date,value_cents) VALUES(?,?,?,?,?)', `${prefix}-valuation`, user, account, '2026-09-20', 45000);
  insert('INSERT INTO categories(id,user_id,name,kind) VALUES(?,?,?,?)', category, user, `${prefix} food`, 'expense');
  insert('INSERT INTO tags(id,user_id,name) VALUES(?,?,?)', `${prefix}-daily`, user, `${prefix} daily`);
  insert('INSERT INTO transactions(id,user_id,account_id,category_id,tag_ids,type,description,amount_cents,date) VALUES(?,?,?,?,?,?,?,?,?)', transaction, user, account, category, JSON.stringify([`${prefix}-daily`]), 'expense', `${prefix}_PRIVATE_PURCHASE`, 1750, '2026-09-20');
  insert('INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,account_id,frequency,next_date) VALUES(?,?,?,?,?,?,?,?)', recurring, user, `${prefix} groceries`, 'expense', 1750, account, 'monthly', '2026-10-20');
  insert('INSERT INTO installment_plans(id,user_id,title,total_cents,installment_count,first_due_date,payment_account_id) VALUES(?,?,?,?,?,?,?)', installment, user, `${prefix} laptop`, 120000, 12, '2026-09-10', account);
  insert('INSERT INTO installment_payments(id,user_id,plan_id,sequence,due_date,amount_cents) VALUES(?,?,?,?,?,?)', `${prefix}-installment-payment`, user, installment, 1, '2026-09-10', 10000);
  insert('INSERT INTO goals(id,user_id,name,kind,account_id) VALUES(?,?,?,?,?)', `${prefix}-goal`, user, `${prefix} holiday`, 'savings', account);
  insert('INSERT INTO goals(id,user_id,name,kind) VALUES(?,?,?,?)', `${prefix}-manual-goal`, user, `${prefix} manual goal`, 'savings');
  insert('INSERT INTO goal_entries(id,user_id,goal_id,date,amount_cents,note) VALUES(?,?,?,?,?,?)', `${prefix}-goal-entry`, user, `${prefix}-manual-goal`, '2026-09-20', 2500, `${prefix} contribution`);
  insert('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)', version, user, '2026-09-01', '{"target":100000,"period":"monthly"}');
  insert('INSERT INTO v3_periods(id,user_id,start_date,end_date,version_id,funding_cents) VALUES(?,?,?,?,?,?)', period, user, '2026-09-01', '2026-10-01', version, 100000);
  insert('INSERT INTO v3_bucket_templates(id,user_id,name,kind,category_ids,target_cents) VALUES(?,?,?,?,?,?)', bucket, user, `${prefix} food`, 'protected', JSON.stringify([category]), 20000);
  insert('INSERT INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_ids,target_cents) VALUES(?,?,?,?,?,?,?,?)', `${prefix}-bucket-period`, user, period, bucket, `${prefix} food`, 'protected', JSON.stringify([category]), 20000);
  insert('INSERT INTO v3_assignments(id,user_id,transaction_id,bucket_id,amount_cents) VALUES(?,?,?,?,?)', `${prefix}-assignment`, user, transaction, bucket, 1750);
  insert('INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,paid_cents,account_id,category_id,status,transaction_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', occurrence, user, 'recurring', recurring, '2026-09-20', '2026-09-20', `${prefix} groceries`, 'expense', 1750, 1750, account, category, 'paid', transaction);
  insert('INSERT INTO v3_events(id,user_id,kind,detail) VALUES(?,?,?,?)', `${prefix}-event`, user, 'allocation', `${prefix} allocation`);
  insert('INSERT INTO v3_payment_links(transaction_id,user_id,occurrence_id) VALUES(?,?,?)', transaction, user, occurrence);
}

function rowsFor(user) {
  return Object.fromEntries(tables.map(table => [table,
    sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(user)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]));
}

test('A backup holds every profile and every table of user data, but no sign-in secrets', async () => {
  household();
  sqlite.prepare('UPDATE categories SET archived=1 WHERE user_id=?').run('alice');
  const before = copy(rowsFor('alice'));
  const backup = copy(await exportBackup());
  assert.equal(backup.format, 'remaivo-backup');
  assert.equal(backup.version, 7);
  assert.ok(!Number.isNaN(Date.parse(backup.exportedAt)));
  assert.deepEqual(backup.profiles, [
    { userId: 'alice', name: 'Alice', color: '#123456', icon: 'A', owner: true },
    { userId: 'bob', name: 'Bob', color: '#123456', icon: 'A', owner: false },
  ]);
  assert.deepEqual(Object.keys(backup.tables).sort(), [...tables].sort());
  const sorted = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const table of tables) assert.deepEqual(sorted(backup.tables[table].filter(row => row.user_id === 'alice')), before[table]);
  const serialized = JSON.stringify(backup);
  assert.match(serialized, /ALICE_PRIVATE_PURCHASE/);
  assert.match(serialized, /BOB_PRIVATE_PURCHASE/);
  assert.doesNotMatch(serialized, /SECRET_PASSWORD_HASH|password:/);
});

test('Every table holding user data is in the backup', async () => {
  household();
  const holding = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'auth_%'").all()
    .map(({ name }) => name)
    .filter(name => sqlite.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().some(column => column.name === 'user_id'));
  assert.deepEqual(Object.keys((await exportBackup()).tables).sort(), holding.sort());
});

test('Restoring brings back every record exactly, after loss and edits', async () => {
  household();
  const before = { alice: copy(rowsFor('alice')), bob: copy(rowsFor('bob')) };
  const backup = copy(await exportBackup());
  sqlite.exec("DELETE FROM v3_payment_links; DELETE FROM v3_assignments; DELETE FROM v3_occurrences; DELETE FROM transactions WHERE user_id='alice'");
  sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run('added-later', 'bob', 'added later', 'checking', 1);
  sqlite.prepare("UPDATE auth_identities SET display_name='Renamed' WHERE user_id='bob'").run();
  assert.deepEqual(await restoreBackup('bob', backup), { profiles: 2 });
  assert.deepEqual(copy(rowsFor('alice')), before.alice);
  assert.deepEqual(copy(rowsFor('bob')), before.bob);
  assert.equal(sqlite.prepare("SELECT display_name FROM auth_identities WHERE user_id='bob'").get().display_name, 'Bob');
  assert.equal(sqlite.prepare('SELECT hash FROM auth_password').get().hash, 'SECRET_PASSWORD_HASH');
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('The preview shows what would change and writes nothing', async () => {
  household();
  const backup = copy(await exportBackup());
  identity('carol', 'Carol');
  sqlite.prepare("UPDATE accounts SET name='edited' WHERE user_id='alice'").run();
  sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run('added-later', 'alice', 'added later', 'checking', 1);
  const before = copy(rowsFor('alice'));
  const preview = await previewRestore('alice', backup);
  assert.deepEqual(preview.profiles[0], { name: 'Alice', isNew: false, transactions: { now: 1, backup: 1 }, accounts: { now: 2, backup: 1 } });
  assert.deepEqual(preview.kept, ['Carol']);
  assert.deepEqual(copy(rowsFor('alice')), before);
});

test('Profiles that are not in the backup are left alone', async () => {
  household();
  const backup = copy(await exportBackup());
  identity('carol', 'Carol');
  seed('carol', 'CAROL');
  const carol = copy(rowsFor('carol'));
  await restoreBackup('alice', backup);
  assert.deepEqual(copy(rowsFor('carol')), carol);
});

test('A deleted profile comes back with its card', async () => {
  household();
  const backup = copy(await exportBackup());
  const bob = copy(rowsFor('bob'));
  sqlite.exec('BEGIN');
  sqlite.exec('PRAGMA defer_foreign_keys=on');
  for (const table of tables) sqlite.prepare(`DELETE FROM ${table} WHERE user_id='bob'`).run();
  sqlite.exec('COMMIT');
  sqlite.prepare("DELETE FROM auth_identities WHERE user_id='bob'").run();
  assert.equal((await previewRestore('alice', backup)).profiles[1].isNew, true);
  await restoreBackup('alice', backup);
  assert.deepEqual(copy(rowsFor('bob')), bob);
  const card = sqlite.prepare("SELECT google_sub, display_name FROM auth_identities WHERE user_id='bob'").get();
  assert.deepEqual({ ...card }, { google_sub: 'password:bob', display_name: 'Bob' });
});

test('A backup restores onto a new install under its owner', async () => {
  household();
  const backup = copy(await exportBackup());
  const alice = copy(rowsFor('alice'));
  freshDatabase();
  identity('new-owner', 'Someone', true);
  await restoreBackup('new-owner', backup);
  const moved = rowsFor('new-owner');
  for (const table of tables) assert.equal(moved[table].length, alice[table].length, table);
  assert.equal(sqlite.prepare("SELECT display_name FROM auth_identities WHERE user_id='new-owner'").get().display_name, 'Alice');
  assert.equal(count('transactions', 'bob'), 1);
});

test('An older single-profile export restores only that profile', async () => {
  household();
  const full = copy(await exportBackup());
  const only = rows => rows.filter(row => row.user_id === 'alice');
  const older = { format: 'remaivo-backup', version: 3, exportedAt: full.exportedAt, ownerId: 'alice', tables: Object.fromEntries(Object.entries(full.tables).map(([table, rows]) => [table, only(rows)])) };
  const bob = copy(rowsFor('bob'));
  const alice = copy(rowsFor('alice'));
  sqlite.prepare("UPDATE accounts SET name='changed' WHERE user_id='alice'").run();
  const preview = await previewRestore('bob', older);
  assert.deepEqual(preview.profiles.map(profile => profile.name), ['Alice']);
  await restoreBackup('bob', older);
  assert.deepEqual(copy(rowsFor('alice')), alice);
  assert.deepEqual(copy(rowsFor('bob')), bob);
});

test('A backup from before tags restores and leaves that profile without tags', async () => {
  household();
  const full = copy(await exportBackup());
  const older = copy(full);
  older.version = 4;
  delete older.tables.tag_groups;
  delete older.tables.tags;
  for (const row of older.tables.transactions) delete row.tag_ids;
  await restoreBackup('alice', older);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM tags WHERE user_id IN ('alice','bob')").get().n, 0);
  assert.deepEqual(sqlite.prepare("SELECT DISTINCT tag_ids FROM transactions WHERE user_id='alice'").all().map(row => row.tag_ids), ['[]']);
  // A current backup must hold its tag tables.
  const current = copy(full);
  delete current.tables.tags;
  await assert.rejects(restoreBackup('alice', current), BackupError);
});

test('A bad file is refused before anything changes', async () => {
  household();
  const good = copy(await exportBackup());
  const before = copy(rowsFor('alice'));
  const edited = change => { const file = copy(good); change(file); return file; };
  const refused = [
    null, [], 'text', {}, { format: 'other', version: 4 },
    edited(file => { delete file.tables.accounts; }),
    edited(file => { file.tables.other = []; }),
    edited(file => { file.tables.accounts = 'nope'; }),
    edited(file => { file.tables.accounts[0].user_id = 'stranger'; }),
    edited(file => { file.tables.accounts[0].name = { nested: true }; }),
    edited(file => { file.profiles = []; }),
    edited(file => { file.profiles[0].owner = false; }),
    edited(file => { file.profiles[1].userId = file.profiles[0].userId; }),
  ];
  for (const file of refused) {
    await assert.rejects(previewRestore('alice', file), BackupError);
    await assert.rejects(restoreBackup('alice', file), BackupError);
  }
  await assert.rejects(restoreBackup('alice', edited(file => { file.version = 8; })), /newer version/);
  await assert.rejects(restoreBackup('alice', edited(file => { file.tables.accounts[0]['name" = 1; DROP TABLE accounts; --'] = 'x'; })), /no longer uses/);
  assert.deepEqual(copy(rowsFor('alice')), before);
});

test('A failed restore changes nothing', async () => {
  household();
  const backup = copy(await exportBackup());
  const before = { alice: copy(rowsFor('alice')), bob: copy(rowsFor('bob')) };
  backup.tables.transactions.push({ ...backup.tables.transactions[0] });
  failAfterWrite = 30;
  await assert.rejects(restoreBackup('alice', copy(backup)), /Nothing was changed/);
  failAfterWrite = null;
  await assert.rejects(restoreBackup('alice', backup), /Nothing was changed/);
  assert.deepEqual(copy(rowsFor('alice')), before.alice);
  assert.deepEqual(copy(rowsFor('bob')), before.bob);
});

test('A restore over the profile limit is refused', async () => {
  household();
  const backup = copy(await exportBackup());
  freshDatabase();
  identity('owner', 'Owner', true);
  for (const user of ['p1', 'p2', 'p3', 'p4']) identity(user, user);
  await assert.rejects(restoreBackup('owner', backup), /limit of five profiles/);
});

test('A large backup restores across several statements', async () => {
  household();
  const insert = sqlite.prepare('INSERT INTO transactions(id,user_id,type,description,amount_cents,date) VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 1203; index += 1) insert.run(`bulk-${index}`, 'alice', 'expense', `Purchase "${index}" \\ 'quoted' ευρώ`, index + 1, '2026-09-21');
  const backup = copy(await exportBackup());
  const before = copy(rowsFor('alice'));
  await restoreBackup('alice', backup);
  assert.deepEqual(copy(rowsFor('alice')), before);
});

test('Version 5 grouped tags restore with unique flat names', async () => {
 household();
 const backup=copy(await exportBackup()); backup.version=5;
 backup.tables.tag_groups=[{id:'old-g1',user_id:'alice',name:'One',archived:0},{id:'old-g2',user_id:'alice',name:'Two',archived:0}];
 const tag=backup.tables.tags.find(row=>row.user_id==='alice'); tag.name='Trip'; tag.group_id='old-g1';
 backup.tables.tags.push({...tag,id:'old-tag-2',group_id:'old-g2'});
 for (const row of backup.tables.tags.filter(row=>row.user_id!=='alice')) row.group_id='other';
 await restoreBackup('alice',backup);
 const names=sqlite.prepare("SELECT name FROM tags WHERE user_id='alice'").all().map(row=>row.name);
 assert.equal(names.length,2); assert.equal(new Set(names).size,2);
});

test('Version 6 restore removes corrected transactions and their dependent rows', async () => {
  household();
  const backup = copy(await exportBackup());
  backup.version = 6;
  const posted = backup.tables.transactions.find(row => row.user_id === 'alice');
  posted.replaces_transaction_id = 'hidden';
  backup.tables.transactions.push({ ...posted, id: 'hidden', status: 'corrected', replaces_transaction_id: null });
  backup.tables.v3_assignments.push({ ...backup.tables.v3_assignments.find(row => row.user_id === 'alice'), id: 'hidden-assignment', transaction_id: 'hidden' });
  backup.tables.v3_payment_links.push({ ...backup.tables.v3_payment_links.find(row => row.user_id === 'alice'), transaction_id: 'hidden' });
  await restoreBackup('alice', backup);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE id='hidden'").get().n, 0);
  for (const table of ['v3_assignments', 'v3_payment_links'])
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE transaction_id='hidden'`).get().n, 0);
  assert.ok(sqlite.prepare('SELECT id FROM transactions WHERE id=?').get(posted.id));
  assert.equal(sqlite.prepare('PRAGMA table_info(transactions)').all().some(column => column.name === 'replaces_transaction_id'), false);
});

test('Version 6 restores without the waiting pot or retired columns', async () => {
  household();
  const backup=copy(await exportBackup()); backup.version=6;
  const profile=backup.tables.profiles.find(row=>row.user_id==='alice'); profile.spare_auto_sweep_threshold_cents=100;
  const tx=backup.tables.transactions.find(row=>row.user_id==='alice'); tx.spare_change_cents=100; tx.spare_excluded=0;
  backup.tables.spare_events=[{id:'legacy-pot',user_id:'alice',transaction_id:tx.id,multiplied_cents:100,status:'pending'}];
  await restoreBackup('alice',backup);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='spare_events'").get(),undefined);
  for(const [table,columns] of [['profiles',['spare_auto_sweep_threshold_cents']],['transactions',['spare_change_cents','spare_excluded']]]) {
    const names=sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
    for(const column of columns) assert.ok(!names.includes(column));
  }
  assert.ok(sqlite.prepare('SELECT id FROM transactions WHERE id=?').get(tx.id));
});
