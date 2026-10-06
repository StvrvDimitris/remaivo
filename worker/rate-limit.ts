// Counters are provided by Cloudflare; no database writes or isolate-local maps.
type Limiters = Pick<Env, "LOGIN_RATE_LIMIT" | "CALLBACK_RATE_LIMIT" | "FINANCE_RATE_LIMIT" | "PAGE_RATE_LIMIT">;
export function rateLimitGroup(pathname: string) {
  if (pathname === "/auth/callback") return "callback";
  if (pathname.startsWith("/auth/") && pathname !== "/auth/signout") return "login";
  if (pathname === "/api/finance" || pathname.startsWith("/api/finance/")) return "finance";
  if (pathname === "/") return "page";
  return null;
}
export async function enforceRateLimit(request: Request, env: Limiters): Promise<Response | null> {
  const group = rateLimitGroup(new URL(request.url).pathname);
  if (!group) return null;
  // Cloudflare overwrites this header at the public edge. Never use caller-
  // supplied Forwarded, X-Forwarded-For, cookies, query strings, or user IDs.
  const ip = request.headers.get("cf-connecting-ip");
  const headers = { "Cache-Control": "no-store", "Retry-After": "60", "Referrer-Policy": "no-referrer" };
  if (!ip) return Response.json({ error: "Request verification is temporarily unavailable. Please try again shortly." }, { status: 503, headers });
  const limiter = {
    login: env.LOGIN_RATE_LIMIT,
    callback: env.CALLBACK_RATE_LIMIT,
    finance: env.FINANCE_RATE_LIMIT,
    page: env.PAGE_RATE_LIMIT,
  }[group];
  try {
    const { success } = await limiter.limit({ key: `${group}:${ip}` });
    if (success) return null;
    if (group === "finance") return Response.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429, headers });
    return new Response("Too many requests. Please wait a minute, then return to Remaivo and try again.", {
      status: 429, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch {
    // Fail closed before touching D1 if a binding is missing or unavailable.
    console.error(JSON.stringify({ event: "rate_limiter_unavailable", group }));
    return Response.json({ error: "Request verification is temporarily unavailable. Please try again shortly." }, { status: 503, headers });
  }
}
