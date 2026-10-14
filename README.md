# Remaivo Personal Finance

Remaivo is a personal finance Site with accounts, transactions, a current Plan, scheduled payments, savings, and Insights. It stores signed-in users' records in the Sites D1 database declared as `DB` in `.openai/hosting.json`.

## Self-hosting

Want your own private copy?

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/StvrvDimitris/remaivo)

Or run it at home: `docker run -d -p 5007:5007 -v remaivo-data:/data ghcr.io/stvrvdimitris/remaivo` and open <http://localhost:5007>. See [selfhost/README.md](selfhost/README.md).

## Development

Use Node.js 22.13 or later and pnpm:

```sh
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm build
```

The UI lives in `app/`; `app/api/finance/route.ts` handles authenticated finance requests. `db/setup.ts` creates the current Plan directly for new users. `db/v3.ts` reconciles the Plan, buckets, and scheduled payments. `db/backup.ts` produces the user-scoped JSON export.

The live schema is defined in `db/schema.ts` and `db/v3-schema.ts`. Generate a new migration with `pnpm db:generate` after changing either model. Keep already applied files in `drizzle/` immutable: Sites applies new migrations before publishing the next Worker. Runtime code checks schema availability but does not create or alter tables.
