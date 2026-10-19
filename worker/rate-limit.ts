// Counters are provided by the runtime; no database writes or isolate-local maps.
import { noticePage } from "./auth.ts";
type Limiters = Pick<Env, "LOGIN_RATE_LIMIT" | "FINANCE_RATE_LIMIT" | "PAGE_RATE_LIMIT" | "REMAIVO_PLATFORM">;
export function rateLimitGroup(pathname: string) {
  // Choosing a profile needs a signed-in session, so it counts as a page view.
  if (pathname === "/" || pathname === "/auth/profiles") return "page";
  if (pathname.startsWith("/auth/") && pathname !== "/auth/signout") return "login";
  if (pathname === "/api/finance" || pathname.startsWith("/api/finance/")) return "finance";
  return null;
}
export async function enforceRateLimit(request: Request, env: Limiters): Promise<Response | null> {
  const group = rateLimitGroup(new URL(request.url).pathname);
  if (!group) return null;
  // On Cloudflare this header is set at the public edge and can be trusted.
  // Never use caller-supplied Forwarded, X-Forwarded-For, cookies or user IDs.
  // A self-hosted server has no edge, so all its visitors share one counter.
  const ip = request.headers.get("cf-connecting-ip") ?? (env.REMAIVO_PLATFORM === "selfhost" ? "server" : null);
  const headers = { "Cache-Control": "no-store", "Retry-After": "60", "Referrer-Policy": "no-referrer" };
  if (!ip) return Response.json({ error: "Request verification is temporarily unavailable. Please try again shortly." }, { status: 503, headers });
  const limiter = { login: env.LOGIN_RATE_LIMIT, finance: env.FINANCE_RATE_LIMIT, page: env.PAGE_RATE_LIMIT }[group];
  // A self-hosted server usually sits behind a proxy, so the address it sees is
  // not the visitor's; password attempts there share one server-wide counter.
  const key = group === "login" && env.REMAIVO_PLATFORM !== "cloudflare" ? "login:server" : `${group}:${ip}`;
  try {
    const { success } = await limiter.limit({ key });
    if (success) return null;
    if (group === "finance") return Response.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429, headers });
    return noticePage(request, "Too many requests", "Please wait a minute, then try again.", 429, headers);
  } catch {
    // Fail closed before touching D1 if a binding is missing or unavailable.
    console.error(JSON.stringify({ event: "rate_limiter_unavailable", group }));
    return Response.json({ error: "Request verification is temporarily unavailable. Please try again shortly." }, { status: 503, headers });
  }
}
