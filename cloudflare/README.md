# Remaivo on Cloudflare

This deployment uses `wrangler.cloudflare.jsonc` and Google OIDC. The Sites deployment continues to use its own config and ChatGPT login.

## Build and deploy

Set `REMAIVO_HOST=cloudflare`, then run `pnpm build`. Deploy the generated config with `pnpm exec wrangler deploy --config dist/server/wrangler.json`.

The Cloudflare build must be selected **at build time**. Do not deploy a build made with the Sites configuration.

## Authentication

Google OAuth web client callback: `https://remaivo.stayrou99.workers.dev/auth/callback`.
Required Worker secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The owner's imported finance identity is configured using `LEGACY_OWNER_EMAIL` and `LEGACY_OWNER_ID` secrets. Other Google identities receive independent IDs.

Sessions use random tokens stored only as SHA-256 hashes in D1, expire after 30 days, and are revoked on sign-out. Cookies are Secure, HttpOnly and SameSite=Lax. Google authorization uses a single-use, ten-minute state with PKCE and nonce verification. Incoming identity headers are discarded; Google ID tokens are verified for signature, issuer, audience, expiration, nonce and verified email.

Friends need to be added under Google's Audience → Test users while the OAuth application is in Testing. Public Google registration requires switching the OAuth app to Production and completing any requirements Google presents.

## Database

`cloudflare/migrations/0001_current_schema.sql` creates the current finance schema directly. `0002_google_auth.sql` adds identities, login flows and sessions. Apply with `pnpm exec wrangler d1 migrations apply remaivo-production --remote --config wrangler.cloudflare.jsonc`.

The initial transfer copied all 19 finance tables, including archived records and historical plans. Migration backups and credentials are kept outside tracked source. The Sites database and Cloudflare database are separate; changes do not synchronize between the two deployments.
