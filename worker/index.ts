/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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
    return response;
  },
};

export default worker;
