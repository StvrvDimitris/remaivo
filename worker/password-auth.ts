import { hashToken, randomToken, safeReturnPath } from "./google-auth.ts";

// Self-hosted mode: one owner, one password, chosen on first visit.
// Sessions reuse the auth_identities/auth_sessions tables from the Google
// deployment so the rest of the Worker authenticates requests identically.
type PasswordEnv = Pick<Env, "DB"> & { APP_ORIGIN?: string };
export const OWNER_ID = "owner";
const OWNER_SUB = "password:owner";
const OWNER_EMAIL = "owner@remaivo.local";
const SESSION = "rmv-session";
const lifetime = 30 * 24 * 60 * 60;
// workerd rejects PBKDF2 above 100,000 iterations.
const ITERATIONS = 100_000;
const MIN_LENGTH = 8;
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
async function derive(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, key, 256);
  return hex(new Uint8Array(bits));
}
function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Secure cookies only work over HTTPS (or localhost). Plain-HTTP LAN installs
// still need a working session, so the Secure flag follows the request scheme.
export function isHttps(request: Request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}
function cookie(request: Request, value: string, age: number) {
  return `${SESSION}=${value}; Path=/; HttpOnly;${isHttps(request) ? " Secure;" : ""} SameSite=Lax; Max-Age=${age}`;
}
export function sessionToken(request: Request) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(SESSION + "="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(SESSION.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

// Browsers always send Origin on cross-site POSTs. Without a configured
// APP_ORIGIN, the Origin must match the Host the browser addressed.
export function sameOrigin(request: Request, env: PasswordEnv) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (env.APP_ORIGIN) return origin === env.APP_ORIGIN;
  try { return new URL(origin).host === request.headers.get("host"); } catch { return false; }
}

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // Not no-referrer: browsers then send "Origin: null" on these form posts.
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
const escape = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Remaivo</title>
<style>body{font:16px system-ui,sans-serif;background:#f6f7f9;color:#14171f;margin:0}main{max-width:360px;margin:12vh auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 1px 3px #0001}
h1{font-size:22px;margin:0 0 8px}p{color:#555;margin:0 0 18px}label{display:block;font-size:14px;margin:12px 0 4px}input{box-sizing:border-box;width:100%;padding:10px 12px;font:inherit;border:1px solid #ccd;border-radius:8px}
button{margin-top:18px;width:100%;padding:12px;font:inherit;font-weight:600;color:#fff;background:#14171f;border:0;border-radius:8px;cursor:pointer}.error{color:#b42318}a{color:inherit}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#eef}main{background:#181b22;box-shadow:none}p{color:#aab}input{background:#0f1115;color:#eef;border-color:#334}button{background:#eef;color:#14171f}.error{color:#f97066}}</style>
<main>${body}</main></html>`;
  return new Response(html, { status, headers });
}
function form(returnTo: string, setup: boolean, message = "") {
  const error = message ? `<p class="error" role="alert">${escape(message)}</p>` : "";
  const name = setup ? '<label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="120" placeholder="Optional">' : "";
  const confirm = setup ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>' : "";
  return `<h1>${setup ? "Welcome to Remaivo" : "Sign in"}</h1>
<p>${setup ? `Choose a password to protect this Remaivo server. Use at least ${MIN_LENGTH} characters.` : "Enter your Remaivo server password."}</p>${error}
<form method="post" action="/auth/login"><input type="hidden" name="return_to" value="${escape(returnTo)}">${name}
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}"${setup ? "" : " autofocus"} required>${confirm}
<button>${setup ? "Set password" : "Sign in"}</button></form>`;
}
function redirect(target: string, cookies: string[] = []) {
  const h = new Headers({ Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  cookies.forEach(c => h.append("Set-Cookie", c));
  return new Response(null, { status: 303, headers: h });
}

type Credential = { hash: string; salt: string; iterations: number };
const credential = (env: PasswordEnv) =>
  env.DB.prepare("SELECT hash, salt, iterations FROM auth_password WHERE id = 1").first<Credential>();

async function startSession(request: Request, env: PasswordEnv, returnTo: string) {
  const token = randomToken();
  const previous = sessionToken(request);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now()),
    ...(previous ? [env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await hashToken(previous))] : []),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await hashToken(token), OWNER_ID, now() + lifetime),
  ]);
  return redirect(safeReturnPath(returnTo), [cookie(request, token, lifetime)]);
}

export async function handlePasswordAuth(request: Request, env: PasswordEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;

  if (url.pathname === "/auth/signout") {
    if (request.method === "GET") {
      return page("Sign out", '<h1>Sign out?</h1><form method="post"><button>Sign out of Remaivo</button></form><p style="margin-top:16px"><a href="/">Back to Remaivo</a></p>');
    }
    if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
    if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);
    const token = sessionToken(request);
    if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    return redirect("/", [cookie(request, "", 0)]);
  }

  if (url.pathname !== "/auth/login") return page("Not found", '<h1>Page not found.</h1><p><a href="/">Back to Remaivo</a></p>', 404);
  const existing = await credential(env);
  if (request.method === "GET") return page(existing ? "Sign in" : "Set up", form(safeReturnPath(url.searchParams.get("return_to")), !existing));
  if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
  if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);

  const data = await request.formData().catch(() => null);
  const password = String(data?.get("password") ?? "");
  const returnTo = safeReturnPath(String(data?.get("return_to") ?? "/"));

  if (!existing) {
    if (password.length < MIN_LENGTH) return page("Set up", form(returnTo, true, `Use at least ${MIN_LENGTH} characters.`), 400);
    if (password !== String(data?.get("confirm") ?? "")) return page("Set up", form(returnTo, true, "The passwords do not match."), 400);
    const displayName = String(data?.get("name") ?? "").trim().slice(0, 120) || "Owner";
    const salt = randomToken();
    const hash = await derive(password, salt, ITERATIONS);
    // INSERT OR IGNORE: if two first-visit setups race, only the first wins.
    const [stored] = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO auth_password (id, hash, salt, iterations) VALUES (1, ?, ?, ?)").bind(hash, salt, ITERATIONS),
      env.DB.prepare("INSERT OR IGNORE INTO auth_identities (google_sub, user_id, email, display_name) VALUES (?, ?, ?, ?)").bind(OWNER_SUB, OWNER_ID, OWNER_EMAIL, displayName),
    ]);
    if (!stored.meta.changes) return page("Sign in", form(returnTo, false, "A password was already set. Please sign in."), 409);
    return startSession(request, env, returnTo);
  }

  if (!password || !sameHash(await derive(password, existing.salt, existing.iterations), existing.hash)) {
    return page("Sign in", form(returnTo, false, "That password is not correct."), 401);
  }
  return startSession(request, env, returnTo);
}

export async function authenticatePasswordRequest(request: Request, env: PasswordEnv, headers: Headers): Promise<Request> {
  const token = sessionToken(request);
  if (token) {
    const identity = await env.DB.prepare("SELECT i.user_id, i.email, i.display_name FROM auth_sessions s JOIN auth_identities i ON i.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
      .bind(await hashToken(token), now()).first<{ user_id: string; email: string; display_name: string }>();
    if (identity) {
      headers.set("x-remaivo-user-id", identity.user_id);
      headers.set("x-remaivo-user-email", identity.email);
      headers.set("x-remaivo-user-name", encodeURIComponent(identity.display_name));
    }
  }
  return new Request(request, { headers });
}
