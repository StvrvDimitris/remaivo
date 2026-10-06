import { createRemoteJWKSet, jwtVerify } from "jose";

type AuthEnv = Pick<Env, "DB" | "AUTH_PROVIDER" | "APP_ORIGIN"> & {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LEGACY_OWNER_EMAIL?: string;
  LEGACY_OWNER_ID?: string;
};
type Identity = { user_id: string; email: string; display_name: string };
const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const SESSION = "__Host-rmv-session";
const FLOW = "__Host-rmv-oauth";
const encoder = new TextEncoder();
const lifetime = 30 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function hashToken(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
async function challenge(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function safeReturnPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    return url.origin === "https://app.local" && !url.pathname.startsWith("/auth/") ? url.pathname + url.search + url.hash : "/";
  } catch { return "/"; }
}
function cookieValue(request: Request, name: string) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function cookie(name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}
function redirect(target: string, cookies: string[] = []) {
  const headers = new Headers({ Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  cookies.forEach(c => headers.append("Set-Cookie", c));
  return new Response(null, { status: 303, headers });
}
function error(message: string, status = 400, clearFlow = false) {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (clearFlow) headers.append("Set-Cookie", cookie(FLOW, "", 0));
  return new Response(message + "\nReturn to the app and try signing in again.", { status, headers });
}
export function stripIdentityHeaders(request: Request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("oai-authenticated-") || name.startsWith("x-remaivo-user-")) headers.delete(name);
  }
  return headers;
}
export async function authenticateRequest(request: Request, env: AuthEnv): Promise<Request> {
  const headers = stripIdentityHeaders(request);
  const token = cookieValue(request, SESSION);
  if (token) {
    const identity = await env.DB.prepare("SELECT i.user_id, i.email, i.display_name FROM auth_sessions s JOIN auth_identities i ON i.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .bind(await hashToken(token), now()).first<Identity>();
    if (identity) {
      headers.set("x-remaivo-user-id", identity.user_id);
      headers.set("x-remaivo-user-email", identity.email);
      headers.set("x-remaivo-user-name", encodeURIComponent(identity.display_name));
    }
  }
  return new Request(request, { headers });
}
export async function handleGoogleAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  if (url.origin !== env.APP_ORIGIN) return redirect(env.APP_ORIGIN + url.pathname + url.search);
  if (request.method !== "GET" && !(url.pathname === "/auth/signout" && request.method === "POST")) return error("Method not allowed.", 405);
  if (url.pathname === "/auth/signout") {
    if (request.method === "GET") {
      const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign out · Remaivo</title><main style="font:16px system-ui;max-width:360px;margin:15vh auto;padding:24px"><h1>Sign out?</h1><form method="post"><button style="padding:12px 20px">Sign out of Remaivo</button></form><p><a href="/">Back to Remaivo</a></p></main>';
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
    }
    if (request.headers.get("origin") !== env.APP_ORIGIN) return error("Request origin is not allowed.", 403);
    const token = cookieValue(request, SESSION);
    if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    return redirect("/", [cookie(SESSION, "", 0)]);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return error("Google sign-in is being configured. Please try again shortly.", 503);
  if (url.pathname === "/auth/google") {
    const state = randomToken(), verifier = randomToken(), nonce = randomToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_flows WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("INSERT INTO auth_flows (state_hash, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await hashToken(state), verifier, nonce, safeReturnPath(url.searchParams.get("return_to")), now() + 600),
    ]);
    const destination = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    destination.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: env.APP_ORIGIN + "/auth/callback", response_type: "code", scope: "openid email profile", state, nonce, code_challenge: await challenge(verifier), code_challenge_method: "S256", prompt: "select_account" }).toString();
    return redirect(destination.href, [cookie(FLOW, state, 600)]);
  }
  if (url.pathname !== "/auth/callback") return error("Page not found.", 404);
  const state = url.searchParams.get("state"), browserState = cookieValue(request, FLOW);
  if (!state || !browserState || state !== browserState) return error("This sign-in request has expired or is invalid.", 400, true);
  const flow = await env.DB.prepare("DELETE FROM auth_flows WHERE state_hash = ? AND expires_at > ? RETURNING verifier, nonce, return_to")
    .bind(await hashToken(state), now()).first<{ verifier: string; nonce: string; return_to: string }>();
  if (!flow) return error("This sign-in request has already been used or expired.", 400, true);
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) return error("Google sign-in was cancelled.", 400, true);
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: flow.verifier, grant_type: "authorization_code", redirect_uri: env.APP_ORIGIN + "/auth/callback" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) return error("Google could not complete sign-in. Please try again.", 400, true);
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) return error("Google did not provide a verified identity.", 400, true);
    const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: env.GOOGLE_CLIENT_ID, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "nonce", "email", "email_verified"] });
    if (payload.nonce !== flow.nonce || payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) return error("Google identity verification failed.", 400, true);
    const email = payload.email.toLowerCase();
    const displayName = typeof payload.name === "string" ? payload.name.slice(0, 120) : email;
    let identity = await env.DB.prepare("SELECT user_id, email, display_name FROM auth_identities WHERE google_sub = ?").bind(payload.sub).first<Identity>();
    if (!identity) {
      // A single explicitly configured legacy owner can claim the copied Sites data.
      // All other people receive an independent internal ID, never an email-based merge.
      const isOwner = env.LEGACY_OWNER_EMAIL && env.LEGACY_OWNER_ID && email === env.LEGACY_OWNER_EMAIL.toLowerCase();
      const userId = isOwner ? env.LEGACY_OWNER_ID! : crypto.randomUUID();
      if (isOwner && !await env.DB.prepare("SELECT user_id FROM profiles WHERE user_id = ?").bind(userId).first()) return error("Your existing data is still being transferred. Please try again shortly.", 503, true);
      await env.DB.prepare("INSERT OR IGNORE INTO auth_identities (google_sub, user_id, email, display_name) VALUES (?, ?, ?, ?)").bind(payload.sub, userId, email, displayName).run();
      identity = await env.DB.prepare("SELECT user_id, email, display_name FROM auth_identities WHERE google_sub = ?").bind(payload.sub).first<Identity>();
      if (!identity) return error("This account could not be linked. Please contact the app owner.", 409, true);
    }
    await env.DB.prepare("UPDATE auth_identities SET email = ?, display_name = ? WHERE google_sub = ?").bind(email, displayName, payload.sub).run();
    const session = randomToken();
    const previous = cookieValue(request, SESSION);
    await env.DB.batch([
      ...(previous ? [env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await hashToken(previous))] : []),
      env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await hashToken(session), identity.user_id, now() + lifetime),
    ]);
    return redirect(safeReturnPath(flow.return_to), [cookie(SESSION, session, lifetime), cookie(FLOW, "", 0)]);
  } catch {
    // Never log tokens, authorization codes, cookies, or identity claims.
    console.error(JSON.stringify({ event: "google_signin_failed" }));
    return error("Sign-in could not be completed. Please try again.", 400, true);
  }
}
