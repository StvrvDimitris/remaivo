import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const scratch = path.resolve("work/setup-tests");
fs.mkdirSync(scratch, { recursive: true });
for (const [source, target] of [["app/finance-dates.ts", "dates"], ["app/spare-change.ts", "spare-change"], ["app/v3-engine.ts", "engine"], ["db/ensure.ts", "ensure"], ["db/v3.ts", "v3"], ["db/setup.ts", "setup"]]) {
  const code = fs.readFileSync(source, "utf8")
    .replaceAll('import { env } from "cloudflare:workers";', "const env = globalThis.__setupEnv;")
    .replaceAll("import { env } from 'cloudflare:workers';", "const env = globalThis.__setupEnv;")
    .replaceAll('"../app/finance-dates"', '"./dates.mjs"')
    .replaceAll("'../app/finance-dates'", "'./dates.mjs'")
    .replaceAll("'./finance-dates'", "'./dates.mjs'")
    .replaceAll('"../app/v3-engine"', '"./engine.mjs"')
    .replaceAll("'../app/v3-engine'", "'./engine.mjs'")
    .replaceAll('"../app/spare-change"', '"./spare-change.mjs"')
    .replaceAll("'../app/spare-change'", "'./spare-change.mjs'")
    .replaceAll('"./v3"', '"./v3.mjs"');
  const resolved = code.replaceAll('"./ensure"', '"./ensure.mjs"').replaceAll("'./ensure'", "'./ensure.mjs'");
  fs.writeFileSync(path.join(scratch, `${target}.mjs`), ts.transpileModule(resolved, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}

const sqlite = new DatabaseSync(":memory:");
for (const file of fs.readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) sqlite.exec(fs.readFileSync(path.join("drizzle", file), "utf8"));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) || null; }
  async run() { return { meta: sqlite.prepare(this.sql).run(...this.args) }; }
}
globalThis.__setupEnv = { DB: {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec("BEGIN");
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      sqlite.exec("COMMIT");
      return result;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
} };

const { createCurrentPlan } = await import(pathToFileURL(path.join(scratch, "setup.mjs")));
const { currentPeriod } = await import(pathToFileURL(path.join(scratch, "v3.mjs")));
const payload = {
  currency: "EUR", timezone: "Europe/Athens", weekStart: 1,
  accounts: [
    { name: "Main", type: "bank", balance: "1400", includeSpendable: true, color: "#1f5b4e" },
    { name: "Card", type: "credit", balance: "80", includeSpendable: false, color: "#4c8b98" },
  ],
  budgets: { monthly: "1100" }, budgetMode: "fixed_split", carryMode: "stack_signed",
};

test("fresh setup creates current Plan state directly", async () => {
  assert.equal(await createCurrentPlan("fresh-owner", payload), true);
  const profile = sqlite.prepare("SELECT setup_complete, timezone FROM profiles WHERE user_id='fresh-owner'").get();
  assert.deepEqual({ ...profile }, { setup_complete: 1, timezone: "Europe/Athens" });
  const accounts = sqlite.prepare("SELECT type, balance_cents FROM accounts WHERE user_id='fresh-owner' ORDER BY type").all().map(row => ({ ...row }));
  assert.deepEqual(accounts, [{ type: "bank", balance_cents: 140000 }, { type: "credit", balance_cents: -8000 }]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM categories WHERE user_id='fresh-owner'").get().n, 9);
  const config = JSON.parse(sqlite.prepare("SELECT config_json FROM v3_versions WHERE user_id='fresh-owner'").get().config_json);
  assert.equal(config.target, 110000);
  assert.equal(config.allocation, "even");
  assert.equal(config.carry, "signed");
  const { period } = await currentPeriod("fresh-owner", "2026-09-24");
  assert.equal(period.funding_cents, 110000);
});

test("retry does not duplicate accounts or replace the created Plan", async () => {
  assert.equal(await createCurrentPlan("fresh-owner", { ...payload, budgets: { monthly: "1" } }), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id='fresh-owner'").get().n, 2);
  const config = JSON.parse(sqlite.prepare("SELECT config_json FROM v3_versions WHERE user_id='fresh-owner'").get().config_json);
  assert.equal(config.target, 110000);
});

test("invalid setup leaves no partial profile", async () => {
  await assert.rejects(createCurrentPlan("invalid-owner", { ...payload, accounts: [] }));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM profiles WHERE user_id='invalid-owner'").get().n, 0);
});
