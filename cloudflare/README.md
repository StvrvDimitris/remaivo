# Remaivo on Cloudflare

Remaivo runs as a Cloudflare Worker with a D1 database. For one person this fits comfortably in Cloudflare's free plan.

## One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/StvrvDimitris/remaivo)

Cloudflare copies this repository into your GitHub account, creates the Worker and its D1 database, and asks for the values in `.dev.vars.example`:

- `REMAIVO_PASSWORD`: your password, at least 8 characters.
- `REMAIVO_NAME`: optional, your name in the app.

When it finishes, open the `workers.dev` address it shows and sign in. The database tables are created on the first visit.

The button only works while this repository is public.

## By hand

```sh
pnpm install
pnpm exec wrangler login
pnpm run deploy
pnpm exec wrangler secret put REMAIVO_PASSWORD
```

`pnpm run deploy` builds with `wrangler.jsonc` and deploys; Wrangler creates the D1 database on the first deploy.

## Password

On Cloudflare the password is always the `REMAIVO_PASSWORD` secret. The address is public as soon as it is deployed, so there is no first-visit setup form anybody could claim; until the secret exists, the sign-in page asks you to add it.

To change the password, update the secret in the dashboard (Worker → Settings → Variables and Secrets) or with `wrangler secret put REMAIVO_PASSWORD`. Everyone signed in with the old password is signed out.

## Updates

Deploy again. Database migrations in `cloudflare/migrations/` are applied automatically by the Worker before it serves the first request after an update (`worker/migrate.ts`). It records them in the same `d1_migrations` table as `wrangler d1 migrations apply`, so applying them by hand first is also fine.

## Security

- Sessions are random tokens stored only as SHA-256 hashes, expire after 30 days, and are revoked on sign-out. Each session hash includes a key derived from the current password, so changing the password ends every session.
- Cookies are HttpOnly, SameSite=Lax and Secure over HTTPS. Form posts and API writes must come from the app's own origin.
- Incoming identity headers are always discarded; only the Worker sets them after checking the session.
- The password secret is compared through SHA-256 digests in constant time and is never written to the database.

## Rate limits

Cloudflare-native rate limiting runs before sign-in and database access: 10 sign-in requests, 120 finance API requests and 60 page loads per minute per visitor IP. Static assets and sign-out are exempt. Rejected requests get HTTP 429 with `Retry-After: 60`; an unavailable limiter fails closed with HTTP 503.

## The original deployment

`wrangler.cloudflare.jsonc` is the original owner's deployment (`remaivo-production`). Build it with `REMAIVO_HOST=cloudflare pnpm build`, then deploy with `pnpm exec wrangler deploy --config dist/server/wrangler.json`. It started with Google sign-in; migration `0011_single_owner_password.sql` handed that single Google identity to the password owner with the same user ID, so all existing data carried over.
