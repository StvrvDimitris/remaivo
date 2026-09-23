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

test('a cold Worker reads an existing schema without replaying migrations', async () => {
  await (await import(`${moduleUrl}?first`)).ensureFinanceSchema();
  writes = 0;
  await (await import(`${moduleUrl}?second`)).ensureFinanceSchema();
  assert.equal(writes, 0);
});

test('a missing schema object triggers repair', async () => {
  sqlite.exec('DROP INDEX idx_spare_events_user_status');
  writes = 0;
  await (await import(`${moduleUrl}?repair`)).ensureFinanceSchema();
  assert.ok(writes > 0);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_spare_events_user_status'").get());
});
