# Remaivo on Cloudflare

Remaivo runs as a Cloudflare Worker with a D1 database. For one person this fits comfortably in Cloudflare's free plan.

## One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/StvrvDimitris/remaivo)

Cloudflare copies this repository into your GitHub account and creates the Worker and its D1 database. It may offer the optional settings in `.dev.vars.example`; leave them empty to choose your password in the app.

When it finishes, open the `workers.dev` address it shows. Remaivo creates its database tables and shows **Welcome to Remaivo**, where you choose your password. That page also asks for a **setup code**: open your Worker in the Cloudflare dashboard, go to **Logs** and switch on **Live**, reload the Remaivo page, and copy the code from the line `Remaivo setup code: XXXX-XXXX`.

The button only works while this repository is public.

## By hand

```sh
pnpm install
pnpm exec wrangler login
pnpm run deploy
pnpm exec wrangler tail
```

`pnpm run deploy` builds with `wrangler.jsonc` and deploys; Wrangler creates the D1 database on the first deploy. Keep `wrangler tail` running, open the address, and copy the setup code it prints.

## Password

Like Actual Budget, you choose the password on your first visit. Because the address is public as soon as it is deployed, that first visit also needs the one-time setup code from your Worker's logs, so nobody who stumbles on the address can claim it first. The code is used up once your password is set.

The password is stored as a salted PBKDF2 hash. Cloudflare's free plan allows about 10 ms of CPU per request, so Workers there use 10,000 iterations (self-hosted servers use 100,000).

Prefer to configure it instead? Set the `REMAIVO_PASSWORD` secret (Worker → Settings → Variables and Secrets, or `wrangler secret put REMAIVO_PASSWORD`). It then is the password, no setup page appears, and it is never written to the database. Changing it signs everyone out.

Forgot a password chosen in the app? Delete it and choose a new one on the next visit (with a fresh setup code): `pnpm exec wrangler d1 execute <database> --remote --command "DELETE FROM auth_password"`.

## Updates

Deploy again. Database migrations in `cloudflare/migrations/` are applied automatically by the Worker before it serves the first request after an update (`worker/migrate.ts`). It records them in the same `d1_migrations` table as `wrangler d1 migrations apply`, so applying them by hand first is also fine.

## Security

- Sessions are random tokens stored only as SHA-256 hashes, expire after 30 days, and are revoked on sign-out. Each session hash includes a key derived from the current password, so changing the password ends every session.
- Cookies are HttpOnly, SameSite=Lax and Secure over HTTPS. Form posts and API writes must come from the app's own origin.
- Incoming identity headers are always discarded; only the Worker sets them after checking the session.
- The setup code is random, never shown on a page, compared in constant time, and covered by the sign-in rate limit.
- A `REMAIVO_PASSWORD` secret is compared through SHA-256 digests in constant time and is never written to the database.

## Rate limits

Cloudflare-native rate limiting runs before sign-in and database access: 10 sign-in requests, 120 finance API requests and 60 page loads per minute per visitor IP. Static assets and sign-out are exempt. Rejected requests get HTTP 429 with `Retry-After: 60`; an unavailable limiter fails closed with HTTP 503.

## Your own config file

`wrangler.jsonc` is a template without any account details, so it works for everyone. To pin your deployment to a specific account, database or domain, copy it to `wrangler.cloudflare.jsonc` (git ignores that name, so your IDs stay on your computer), fill in `account_id`, the D1 `database_id` and optionally `APP_ORIGIN`, then build and deploy with it:

```sh
REMAIVO_HOST=cloudflare pnpm build
pnpm exec wrangler deploy --config dist/server/wrangler.json
```

## Coming from Google sign-in

Earlier versions signed in with Google. Migration `0011_single_owner_password.sql` hands a server's single Google identity to the password owner with the same user ID, so all existing data carries over; the owner then chooses a password on the next visit.
