# Self-hosting Remaivo

Run your own private Remaivo server, the same way you'd run Actual Budget: one container, one folder of data, one password. No Cloudflare account needed.

Prefer not to run a server at all? Remaivo also deploys to Cloudflare's free plan in one click; see [cloudflare/README.md](../cloudflare/README.md).

## One-click cloud hosting

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/StvrvDimitris/remaivo)

Render asks for a **password** (`REMAIVO_PASSWORD`) and, optionally, your name while it deploys. When it finishes, open the `onrender.com` URL and sign in. The database lives on a 1 GB Render disk. Disks need a paid instance, so this is the Starter plan (about $7/month plus disk).

To change the password later, edit `REMAIVO_PASSWORD` under the service's **Environment** tab. Render restarts the app, the new password takes effect, and everyone is signed out.

Render builds the image from this repo's Dockerfile; no published image is needed. Any host that builds from a Dockerfile (or runs an image you built) with a persistent volume works the same way: mount a volume at `/data` and set `REMAIVO_PASSWORD`. Railway, Fly.io, Koyeb, Coolify, CasaOS and Unraid all fit.

## Quick start (Docker)

```sh
docker build -t remaivo https://github.com/StvrvDimitris/remaivo.git#main
docker run -d --name remaivo -p 5007:5007 -v remaivo-data:/data --restart unless-stopped remaivo
```

Or with Compose, from a clone of this repo (it builds the image the same way):

```sh
docker compose up -d
```

Open <http://localhost:5007>. On the first visit Remaivo asks you to **choose a password**, together with a one-time **setup code** that only the server's log shows (`docker logs remaivo`, or the terminal you started it from). That password protects the server from then on.

Your data is in the `remaivo-data` volume (with Compose, the `./remaivo-data` folder). Back it up, or use the JSON export inside the app.

To build from a local clone instead: `docker build -t remaivo .`

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
| `REMAIVO_PASSWORD` | _(unset)_ | The server password, at least 8 characters. When set, there's no first-visit setup, it's never stored, and changing it signs everyone out. When unset, you choose the password on first visit with the setup code from the log. |
| `REMAIVO_NAME` | `Owner` | Your name in the app, used when you first sign in. |
| `PORT` | `5007` | Port to listen on. |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the SQLite database is kept. |
| `APP_ORIGIN` | _(unset)_ | The public URL, e.g. `https://money.example.com`. Set it when a reverse proxy rewrites the `Host` header (nginx does this by default). |

## Who it's for

Every Remaivo server has **one owner and one password**, like Actual Budget. Anyone with the password sees the same data, so it suits one person or a household sharing finances. For separate finances, run a separate server.

## Putting it on the internet

- Choosing the password on first visit needs the setup code from the server's log, so a stranger who finds the address can't claim it. Or set `REMAIVO_PASSWORD` and skip setup entirely.
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

(Without Docker: `node selfhost/server.mjs reset-password`.) This clears the password and signs everyone out. Your finance data is untouched; the next visit asks for a new password and a fresh setup code from the log. If you use `REMAIVO_PASSWORD`, just change that setting instead.

## Updating

```sh
git pull && docker compose up -d --build
```

Without Compose, run the `docker build` line from the quick start again, then `docker rm -f remaivo` and the `docker run` line. On Render, use **Manual Deploy → Deploy latest commit**.

Database migrations run automatically after each update.

## Publishing the image (maintainers)

Nothing above depends on a published image: every install builds from the Dockerfile. `.github/workflows/docker-image.yml` can still publish `linux/amd64` and `linux/arm64` images to `ghcr.io/stvrvdimitris/remaivo` when run by hand (Actions → Docker image → Run workflow) or for a `v*` tag, if GitHub Actions is available on the account.

## How it works

The app is a Cloudflare Worker. In self-hosted mode it runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, through Miniflare. The Worker's `DB` binding is a local SQLite file under `DATA_DIR`. The Worker applies the migrations in `cloudflare/migrations/` itself before its first request, exactly as it does on Cloudflare.
