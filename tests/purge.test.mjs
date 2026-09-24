import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const sqlite = new DatabaseSync(":memory:");
for (const file of fs.readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) sqlite.exec(fs.readFileSync(path.join("drizzle", file), "utf8"));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { return { results: sqlite.prepare(this.sql).all(...this.args), meta: { changes: 0 } }; }
}
const DB = {
  prepare: sql => new Statement(sql),
  batch: async statements => {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => {
        if (statement.sql.startsWith("SELECT")) return { results: sqlite.prepare(statement.sql).all(...statement.args) };
        return { meta: sqlite.prepare(statement.sql).run(...statement.args) };
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
globalThis.__purgeEnv = { DB, REMAIVO_PURGE_TOKEN: "x".repeat(64), REMAIVO_OWNER_USER_ID: "owner", REMAIVO_PURGE_OTHER_USER_ID: "other" };
const scratch = path.resolve("work/purge-tests");
fs.mkdirSync(scratch, { recursive: true });
const code = fs.readFileSync("app/api/maintenance/purge/route.ts", "utf8").replace('import { env } from "cloudflare:workers";', "const env = globalThis.__purgeEnv;");
fs.writeFileSync(path.join(scratch, "route.mjs"), ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { GET, POST } = await import(pathToFileURL(path.join(scratch, "route.mjs")));
const headers = { "x-remaivo-maintenance-token": "x".repeat(64) };
sqlite.prepare("INSERT INTO profiles (user_id) VALUES (?)").run("owner");
sqlite.prepare("INSERT INTO profiles (user_id) VALUES (?)").run("other");
sqlite.prepare("INSERT INTO accounts (id, user_id, name, type) VALUES (?, ?, ?, ?)").run("owner-account", "owner", "Owner", "bank");
sqlite.prepare("INSERT INTO accounts (id, user_id, name, type) VALUES (?, ?, ?, ?)").run("other-account", "other", "Other", "bank");
sqlite.prepare("INSERT INTO forecast_scenarios (id, user_id, name, events_json) VALUES (?, ?, ?, ?)").run("legacy", "other", "Old", "[]");
sqlite.prepare("INSERT INTO v3_migrations (user_id, snapshot_json, summary_json) VALUES (?, ?, ?)").run("other", "{}", "{}");

test("purge requires token and exact preflight count, then removes only other user", async () => {
  assert.equal((await GET(new Request("https://example.com/api/maintenance/purge"))).status, 404);
  const report = await (await GET(new Request("https://example.com/api/maintenance/purge", { headers }))).json();
  assert.equal(report.total, 4);
  const wrong = await POST(new Request("https://example.com/api/maintenance/purge", { method: "POST", headers, body: JSON.stringify({ expectedRows: 3 }) }));
  assert.equal(wrong.status, 409);
  const response = await POST(new Request("https://example.com/api/maintenance/purge", { method: "POST", headers, body: JSON.stringify({ expectedRows: 4 }) }));
  assert.deepEqual(await response.json(), { deletedRows: 4, remainingRows: 0 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM profiles WHERE user_id='owner'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id='owner'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM profiles WHERE user_id='other'").get().n, 0);
});
