# Self-hosting Remaivo

Run your own private Remaivo server, the same way you'd run Actual Budget: one container, one folder of data, one password. No Google sign-in, no Cloudflare account, no cloud database.

## One-click cloud hosting

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/StvrvDimitris/remaivo)

Render asks for a **password** (`REMAIVO_PASSWORD`) and, optionally, your name while it deploys. When it finishes, open the `onrender.com` URL and sign in. The database lives on a 1 GB Render disk. Disks need a paid instance, so this is the Starter plan (about $7/month plus disk).

To change the password later, edit `REMAIVO_PASSWORD` under the service's **Environment** tab. Render restarts the app, the new password takes effect, and everyone is signed out.

Any host that runs a Docker image with a persistent volume works the same way. Use image `ghcr.io/stvrvdimitris/remaivo:latest`, mount a volume at `/data`, and set `REMAIVO_PASSWORD`. Railway, Fly.io, Koyeb, Coolify, CasaOS and Unraid all fit.

## Quick start (Docker)

```sh
docker run -d --name remaivo -p 5007:5007 -v remaivo-data:/data --restart unless-stopped ghcr.io/stvrvdimitris/remaivo:latest
```

Or with Compose, from a clone of this repo:

```sh
docker compose up -d
```

Open <http://localhost:5007>. On the first visit Remaivo asks you to **choose a password**. That password protects the server from then on.

Your data is in the `remaivo-data` volume (with Compose, the `./remaivo-data` folder). Back it up, or use the JSON export inside the app.

To build the image yourself instead of pulling it: `docker build -t remaivo .`

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
| `REMAIVO_PASSWORD` | _(unset)_ | The server password, at least 8 characters. When set, it's applied on every start, there's no first-visit setup, and changing it signs everyone out. When unset, you choose the password on first visit. |
| `REMAIVO_NAME` | `Owner` | Your name in the app. Only used together with `REMAIVO_PASSWORD`. |
| `PORT` | `5007` | Port to listen on. |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the SQLite database is kept. |
| `APP_ORIGIN` | _(unset)_ | The public URL, e.g. `https://money.example.com`. Set it when a reverse proxy rewrites the `Host` header (nginx does this by default). |

## Who it's for

A self-hosted server has **one owner and one password**, like Actual Budget. Anyone with the password sees the same data, so it suits one person or a household sharing finances. The public Cloudflare deployment with per-person Google accounts is unchanged and still lives in `wrangler.cloudflare.jsonc`.

## Putting it on the internet

- **Set `REMAIVO_PASSWORD`**, or choose the password right after starting. Without it, the first visitor chooses the password (same as Actual Budget).
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

(Without Docker: `node selfhost/server.mjs reset-password`.) This clears the password and signs everyone out. Your finance data is untouched; the next visit asks for a new password. If you use `REMAIVO_PASSWORD`, just change that setting instead.

## Updating

```sh
docker compose pull && docker compose up -d
```

On Render, use **Manual Deploy → Deploy latest reference** to pull the newest image. If you built the image yourself, `git pull && docker compose up -d --build`.

Database migrations run automatically on start.

## Publishing the image (maintainers)

`.github/workflows/docker-image.yml` builds `linux/amd64` and `linux/arm64` images. Pushes to `main` publish `ghcr.io/stvrvdimitris/remaivo:latest`, and tags like `v1.2.0` publish `:1.2.0` and `:1.2`. Pull requests only build.

## How it works

The app is a Cloudflare Worker. In self-hosted mode it runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, through Miniflare. The Worker's `DB` binding is a local SQLite file under `DATA_DIR`. `selfhost/server.mjs` applies `cloudflare/migrations/` then `selfhost/migrations/` on boot, tracking what has run in a `_remaivo_migrations` table.
