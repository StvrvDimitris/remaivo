#!/usr/bin/env node
// Runs the self-hosted Remaivo build (REMAIVO_HOST=selfhost pnpm build) on
// workerd via Miniflare. All data lives under DATA_DIR as SQLite files.
//
//   node selfhost/server.mjs                 start the server
//   node selfhost/server.mjs reset-password  forget the password; the next
//                                            visit asks for a new one
//
// REMAIVO_PASSWORD, when set, is the password: it is applied on every start
// and the first-visit setup form never appears. One-click hosts use this so
// a freshly deployed public URL is never left waiting for a password.
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, "data"));
const port = Number(process.env.PORT ?? 5007);
const host = process.env.HOST ?? "0.0.0.0";
const appOrigin = process.env.APP_ORIGIN?.replace(/\/+$/, "");

const config = JSON.parse(fs.readFileSync(path.join(dist, "server", "wrangler.json"), "utf8"));
if (config.vars?.AUTH_PROVIDER !== "password") {
  console.error("dist/ is not a self-hosted build. Run: REMAIVO_HOST=selfhost pnpm build");
  process.exit(1);
}

function jsModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsModules(file);
    return /\.m?js$/.test(entry.name) ? [{ type: "ESModule", path: file }] : [];
  });
}
const serverDir = path.join(dist, "server");
const entry = path.join(serverDir, config.main);
const modules = jsModules(serverDir).sort((a, b) => (a.path === entry ? -1 : b.path === entry ? 1 : 0));

const command = process.argv[2];
fs.mkdirSync(dataDir, { recursive: true });
const mf = new Miniflare({
  modules,
  modulesRoot: serverDir,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  assets: {
    directory: path.join(dist, "client"),
    binding: "ASSETS",
    routerConfig: { has_user_worker: true },
    assetConfig: { not_found_handling: "none" },
  },
  d1Databases: { DB: "remaivo" },
  d1Persist: path.join(dataDir, "d1"),
  ratelimits: Object.fromEntries(config.ratelimits.map((r) => [r.name, { simple: r.simple }])),
  bindings: { ...config.vars, ...(appOrigin ? { APP_ORIGIN: appOrigin } : {}) },
  ...(command ? {} : { host, port }),
});

// Apply the Cloudflare schema, then the self-host additions, once each.
const migrationDirs = [path.join(root, "cloudflare", "migrations"), path.join(root, "selfhost", "migrations")];
function statements(sql) {
  return sql.split("\n").map((line) => line.replace(/^\s*--.*$/, "")).join("\n")
    .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}
async function migrate(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS _remaivo_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  const applied = new Set((await db.prepare("SELECT name FROM _remaivo_migrations").all()).results.map((r) => r.name));
  for (const dir of migrationDirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const name = `${path.basename(path.dirname(dir))}/${file}`;
      if (applied.has(name)) continue;
      const sql = statements(fs.readFileSync(path.join(dir, file), "utf8"));
      // One batch per file runs as a single transaction.
      await db.batch([...sql.map((s) => db.prepare(s)), db.prepare("INSERT INTO _remaivo_migrations (name) VALUES (?)").bind(name)]);
      console.log(`Applied migration ${name}`);
    }
  }
}

// Matches worker/password-auth.ts: PBKDF2-SHA256, 100k iterations, hex hash,
// salt used as its UTF-8 string.
const ITERATIONS = 100_000;
const derive = (password, salt, iterations) => pbkdf2Sync(password, salt, iterations, 32, "sha256");
async function applyEnvPassword(db) {
  const password = process.env.REMAIVO_PASSWORD;
  if (!password) return;
  if (password.length < 8) throw new Error("REMAIVO_PASSWORD must be at least 8 characters.");
  const stored = await db.prepare("SELECT hash, salt, iterations FROM auth_password WHERE id = 1").first();
  if (stored && timingSafeEqual(derive(password, stored.salt, stored.iterations), Buffer.from(stored.hash, "hex"))) return;
  const salt = randomBytes(32).toString("base64url");
  const name = process.env.REMAIVO_NAME?.trim().slice(0, 120) || "Owner";
  // A changed password signs out every existing session.
  await db.batch([
    db.prepare("DELETE FROM auth_sessions"),
    db.prepare("INSERT OR REPLACE INTO auth_password (id, hash, salt, iterations) VALUES (1, ?, ?, ?)").bind(derive(password, salt, ITERATIONS).toString("hex"), salt, ITERATIONS),
    db.prepare("INSERT OR IGNORE INTO auth_identities (google_sub, user_id, email, display_name) VALUES ('password:owner', 'owner', 'owner@remaivo.local', ?)").bind(name),
  ]);
  console.log(stored ? "Password updated from REMAIVO_PASSWORD; existing sessions were signed out." : "Password set from REMAIVO_PASSWORD.");
}

try {
  const db = await mf.getD1Database("DB");
  await migrate(db);
  if (!command) await applyEnvPassword(db);
  if (command === "reset-password") {
    await db.batch([db.prepare("DELETE FROM auth_password"), db.prepare("DELETE FROM auth_sessions")]);
    console.log(process.env.REMAIVO_PASSWORD
      ? "All sessions signed out. REMAIVO_PASSWORD is set, so it will be the password again on the next start; change that setting instead."
      : "Password cleared and all sessions signed out. Open Remaivo to choose a new password.");
    await mf.dispose();
  } else if (command) {
    console.error(`Unknown command: ${command}`);
    await mf.dispose();
    process.exit(1);
  } else {
    const url = await mf.ready;
    console.log(`Remaivo is running on port ${url.port}. Data directory: ${dataDir}`);
  }
} catch (error) {
  console.error(error);
  await mf.dispose();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await mf.dispose(); process.exit(0); });
}
