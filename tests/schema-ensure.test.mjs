import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const sqlite = new DatabaseSync(':memory:');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
  sqlite.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
}

let writes = 0;
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { writes++; return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
globalThis.__schemaTestEnv = {
  DB: {
    prepare: sql => new Statement(sql),
    batch: async statements => {
      writes += statements.length;
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => ({ meta: sqlite.prepare(statement.sql).run(...statement.args) }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  },
};

const scratch = path.resolve('work/schema-tests');
fs.mkdirSync(scratch, { recursive: true });
const source = fs.readFileSync('db/ensure.ts', 'utf8').replace('import { env } from "cloudflare:workers";', 'const env = globalThis.__schemaTestEnv;');
fs.writeFileSync(path.join(scratch, 'ensure.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const moduleUrl = pathToFileURL(path.join(scratch, 'ensure.mjs')).href;

test('migrations leave only the current finance tables and columns', () => {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  assert.deepEqual(tables, [
    'accounts', 'categories', 'goal_entries', 'goals', 'installment_payments',
    'installment_plans', 'investment_valuation_snapshots', 'profiles',
    'recurring_plans', 'spare_events', 'transactions', 'v3_assignments',
    'v3_bucket_periods', 'v3_bucket_templates', 'v3_events',
    'v3_occurrences', 'v3_payment_links', 'v3_periods', 'v3_versions',
  ]);
  for (const [table, removed] of Object.entries({
    profiles: ['spare_sweep_mode', 'spare_threshold_cents'],
    accounts: ['opening_balance_cents', 'icon'],
    categories: ['icon'],
    transactions: ['counts_daily', 'counts_weekly', 'counts_general'],
    installment_plans: ['include_daily_weekly'],
    installment_payments: ['paid_transaction_id'],
    spare_events: ['destination_account_id', 'base_cents'],
  })) {
    const columns = new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    assert.ok(removed.every(name => !columns.has(name)), table);
  }
  const goalColumns = new Set(sqlite.prepare('PRAGMA table_info(goals)').all().map(row => row.name));
  assert.ok(['tracking_mode', 'start_date', 'end_date', 'baseline_cents'].every(name => goalColumns.has(name)));
});

test('a cold Worker reads an existing schema without replaying migrations', async () => {
  await (await import(`${moduleUrl}?first`)).ensureFinanceSchema();
  writes = 0;
  await (await import(`${moduleUrl}?second`)).ensureFinanceSchema();
  assert.equal(writes, 0);
});

test('a missing current table fails closed without runtime schema writes', async () => {
  sqlite.exec('DROP TABLE v3_events');
  writes = 0;
  await assert.rejects((await import(`${moduleUrl}?missing`)).ensureFinanceSchema(), /temporarily unavailable/);
  assert.equal(writes, 0);
});
