/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { authenticate, CHOOSE_PROFILE, handleAuth, noticePage, profilesPath, safeReturnPath, sameOrigin, themeFrom } from "./auth";
import manifest from "../public/manifest.webmanifest?raw";
import { themeCanvas } from "../app/ui-themes.ts";
import { ensureMigrated } from "./migrate";
import { enforceRateLimit } from "./rate-limit";

interface WorkerEnv extends Env {
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The web app manifest, coloured for the theme this browser last used, so an
    // installed Remaivo opens on that colour instead of a light splash.
    if (url.pathname === "/app.webmanifest") {
      const color = themeCanvas(themeFrom(request) ?? "indigo");
      return new Response(JSON.stringify({ ...JSON.parse(manifest), background_color: color, theme_color: color }), {
        headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, no-cache", "Vary": "Cookie" },
      });
    }

    // Every request is rate limited and authenticated before the app sees it.
    const limited = await enforceRateLimit(request, env);
    if (limited) return limited;
    try {
      await ensureMigrated(env.DB);
    } catch {
      console.error(JSON.stringify({ event: "migration_failed" }));
      return noticePage(request, "Remaivo is updating", "Its database is being brought up to date. Please try again in a moment.", 503, { "Retry-After": "10" });
    }
    const authResponse = await handleAuth(request, env);
    if (authResponse) return authResponse;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOrigin(request, env)) {
      return Response.json({ error: "Request origin is not allowed." }, { status: 403 });
    }
    request = await authenticate(request, env);
    // Signed in, but nobody has said who is using Remaivo yet.
    if (request.headers.has(CHOOSE_PROFILE) && request.method === "GET" && url.pathname === "/") {
      return new Response(null, { status: 303, headers: { Location: profilesPath(safeReturnPath(url.pathname + url.search)), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    if (response.status === 404 && /^\/_next\/static\/chunks\/[^/]+\.js$/.test(url.pathname)) {
      // An open tab can keep an older HTML shell across a deployment while its
      // fingerprinted JavaScript files have been replaced. This tiny module
      // refreshes that tab from a unique URL once, so it receives the new shell.
      return new Response(`(() => {
        const key = 'remaivo-stale-chunk-retry';
        const now = Date.now();
        try {
          const previous = Number(sessionStorage.getItem(key) || 0);
          if (now - previous < 60000) {
            const message = document.querySelector('.v3-loading p');
            if (message) message.textContent = 'This page did not finish updating. Please refresh to try again.';
            return;
          }
          sessionStorage.setItem(key, String(now));
        } catch {}
        const next = new URL(location.href);
        next.searchParams.set('refresh', String(now));
        location.replace(next.href);
      })();`, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (!url.pathname.startsWith("/_next/") && !url.pathname.startsWith("/assets/")) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};

export default worker;
