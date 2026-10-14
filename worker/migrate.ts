/// <reference types="vite/client" />
// Brings the database up to date before the first request is served, so a
// fresh deployment (Deploy to Cloudflare, Docker) needs no migration command.
//
// It records progress in the same `d1_migrations` table that
// `wrangler d1 migrations apply` uses, so the two can be mixed freely: files
// already applied by Wrangler are skipped here, and the other way round.

const files = import.meta.glob<string>("../cloudflare/migrations/*.sql", { query: "?raw", import: "default", eager: true });
const migrations = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The migrations hold plain statements (no triggers), one per `;` at a line end.
export function statements(sql: string) {
  return sql.split("\n").map(line => line.replace(/^\s*--.*$/, "")).join("\n")
    .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
}

async function migrate(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map(row => row.name));
  for (const { name, sql } of migrations) {
    if (applied.has(name)) continue;
    // One batch per file runs as a single transaction. If two isolates race,
    // the loser's batch fails and rolls back; the next request sees it applied.
    await db.batch([...statements(sql).map(s => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    console.log(JSON.stringify({ event: "migration_applied", name }));
  }
}

let ready: Promise<void> | null = null;
export function ensureMigrated(db: D1Database) {
  ready ??= migrate(db).catch(error => { ready = null; throw error; });
  return ready;
}
