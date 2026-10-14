# Self-hosting Remaivo

Run your own private Remaivo server, the same way you'd run Actual Budget: one container, one folder of data, one password. No Google sign-in, no Cloudflare account, no cloud database.

## Quick start (Docker)

```sh
git clone https://github.com/StvrvDimitris/remaivo.git
cd remaivo
docker compose up -d
```

Open <http://localhost:5007>. On the first visit Remaivo asks you to **choose a password**. That password protects the server from then on.

Your data is stored in `./remaivo-data` next to `docker-compose.yml`. Back up that folder (or use the JSON export inside the app).

Without Compose:

```sh
docker build -t remaivo .
docker run -d --name remaivo -p 5007:5007 -v remaivo-data:/data --restart unless-stopped remaivo
```

## Without Docker

Requires Node.js 22.13+ and pnpm.

```sh
pnpm install
REMAIVO_HOST=selfhost pnpm build
node selfhost/server.mjs
```

Data goes to `./data` unless you set `DATA_DIR`.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5007` | Port to listen on. |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the SQLite database is kept. |
| `APP_ORIGIN` | _(unset)_ | The public URL, e.g. `https://money.example.com`. Set it when a reverse proxy rewrites the `Host` header (nginx does this by default). |

## Who it's for

A self-hosted server has **one owner and one password**, like Actual Budget. Anyone with the password sees the same data, so it suits one person or a household sharing finances. The public Cloudflare deployment with per-person Google accounts is unchanged and still lives in `wrangler.cloudflare.jsonc`.

## Putting it on the internet

- **Choose the password right away.** Until it's set, the first visitor gets to choose it (same as Actual Budget).
- Use HTTPS. Put Remaivo behind Caddy, nginx, Traefik, or a Cloudflare Tunnel / Tailscale. Over HTTPS the session cookie is marked `Secure`; on plain HTTP (e.g. your home network) it isn't, so it still works.
- Login attempts are limited to 10 per minute **per server** (not per visitor), since a self-hosted server can't trust client IPs. A flood of bad attempts can lock you out for a minute but can't guess the password.

Caddy example:

```
money.example.com {
  reverse_proxy localhost:5007
}
```

## Forgot the password

```sh
docker compose exec remaivo node selfhost/server.mjs reset-password
```

(Without Docker: `node selfhost/server.mjs reset-password`.) This clears the password and signs everyone out. Your finance data is untouched; the next visit asks for a new password.

## Updating

```sh
git pull
docker compose up -d --build
```

Database migrations run automatically on start.

## How it works

The app is a Cloudflare Worker. In self-hosted mode it runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, through Miniflare. The Worker's `DB` binding is a local SQLite file under `DATA_DIR`. `selfhost/server.mjs` applies `cloudflare/migrations/` then `selfhost/migrations/` on boot, tracking what has run in a `_remaivo_migrations` table.
