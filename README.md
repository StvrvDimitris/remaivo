# Remaivo Personal Finance

Remaivo is a personal finance app with accounts, transactions, a spending Plan, scheduled payments, savings, and Insights. Each Remaivo server belongs to one owner, who signs in with a password. Your data stays in your own database.

## Run your own

**On Cloudflare (free for personal use):**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/StvrvDimitris/remaivo)

Cloudflare copies the project into your account, creates the database and asks for your password. See [cloudflare/README.md](cloudflare/README.md).

**With Docker (Render, a home server, a Raspberry Pi):**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/StvrvDimitris/remaivo)

Or at home: `docker run -d -p 5007:5007 -v remaivo-data:/data ghcr.io/stvrvdimitris/remaivo` and open <http://localhost:5007>. See [selfhost/README.md](selfhost/README.md).

Both run the same code: the app is a Cloudflare Worker, and the Docker image runs it on workerd, Cloudflare's open-source runtime.

## Development

Use Node.js 22.13 or later and pnpm. Copy `.dev.vars.example` to `.dev.vars` and set a password, then:

```sh
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm build
```

The UI lives in `app/`; `app/api/finance/route.ts` handles authenticated finance requests. `worker/auth.ts` is the password sign-in and `worker/migrate.ts` brings the database up to date on startup. `db/setup.ts` creates the current Plan directly for new owners. `db/v3.ts` reconciles the Plan, buckets, and scheduled payments. `db/backup.ts` produces the JSON export.

`REMAIVO_HOST` picks the Worker config at build time: unset uses `wrangler.jsonc` (a fresh Cloudflare deployment), `cloudflare` uses `wrangler.cloudflare.jsonc` (the original owner's deployment), and `selfhost` uses `wrangler.selfhost.jsonc` (the Docker image).

The live schema is defined in `db/schema.ts` and `db/v3-schema.ts`. Every schema change needs a migration in `cloudflare/migrations/`, which every deployment applies, plus the matching `pnpm db:generate` migration in `drizzle/`, which the tests use. Keep already applied migration files unchanged.
