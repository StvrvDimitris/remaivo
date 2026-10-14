#!/usr/bin/env node
// Runs the self-hosted Remaivo build (REMAIVO_HOST=selfhost pnpm build) on
// workerd via Miniflare. All data lives under DATA_DIR as SQLite files.
//
//   node selfhost/server.mjs                 start the server
//   node selfhost/server.mjs reset-password  forget the password; the next
//                                            visit asks for a new one
//
// REMAIVO_PASSWORD, when set, is the password and the first-visit setup form
// never appears. One-click hosts use this so a freshly deployed public URL is
// never left waiting for a password. Changing it signs everyone out. The
// Worker itself checks it (worker/auth.ts), exactly as it does on Cloudflare.
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
if (config.vars?.REMAIVO_PLATFORM !== "selfhost") {
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

if (process.env.REMAIVO_PASSWORD && process.env.REMAIVO_PASSWORD.length < 8) {
  console.error("REMAIVO_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

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
  bindings: {
    ...config.vars,
    ...(appOrigin ? { APP_ORIGIN: appOrigin } : {}),
    ...(process.env.REMAIVO_PASSWORD ? { REMAIVO_PASSWORD: process.env.REMAIVO_PASSWORD } : {}),
    ...(process.env.REMAIVO_NAME ? { REMAIVO_NAME: process.env.REMAIVO_NAME } : {}),
  },
  ...(command ? {} : { host, port }),
});

// The Worker applies database migrations itself on its first request
// (worker/migrate.ts), the same way it does on Cloudflare.

try {
  const db = await mf.getD1Database("DB");
  if (command === "reset-password") {
    if (!await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_password'").first()) {
      console.log("This server has not been started yet, so there is no password to reset.");
      await mf.dispose();
      process.exit(0);
    }
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
