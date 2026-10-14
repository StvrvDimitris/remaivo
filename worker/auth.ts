// One Remaivo server belongs to one owner, who signs in with a single password.
//
// The password comes from the REMAIVO_PASSWORD secret when it is set (always on
// Cloudflare, optional for Docker). Without it, a self-hosted server asks for
// a password on first visit and stores it as a PBKDF2 hash in D1.
//
// Sessions are random tokens stored only as SHA-256 hashes. Each hash also
// covers a key derived from the current password, so changing the password
// signs every session out without any extra bookkeeping.

type AuthEnv = Pick<Env, "DB" | "REMAIVO_PLATFORM" | "APP_ORIGIN" | "REMAIVO_PASSWORD" | "REMAIVO_NAME">;
type Identity = { user_id: string; email: string; display_name: string };
type StoredPassword = { hash: string; salt: string; iterations: number };

// The owner's identity row. The column is named after the former Google login.
const OWNER_SUB = "password:owner";
const OWNER_EMAIL = "owner@remaivo.local";
const SESSION = "rmv-session";
const MIN_LENGTH = 8;
// workerd rejects PBKDF2 above 100,000 iterations.
const ITERATIONS = 100_000;
const lifetime = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function derive(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations }, key, 256)));
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function safeReturnPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    return url.origin === "https://app.local" && !url.pathname.startsWith("/auth/") ? url.pathname + url.search + url.hash : "/";
  } catch { return "/"; }
}

// Identity headers are only ever set here, after a session is verified.
export function stripIdentityHeaders(request: Request) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-remaivo-user-")) headers.delete(name);
  return headers;
}

// Secure cookies need HTTPS (or localhost). A plain-HTTP home server still
// needs a working session, so the Secure flag follows the request scheme.
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

// Browsers send Origin on cross-site POSTs. With APP_ORIGIN set it must match
// exactly; otherwise it must match the host the browser addressed.
export function sameOrigin(request: Request, env: AuthEnv) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (env.APP_ORIGIN) return origin === env.APP_ORIGIN;
  try { return new URL(origin).host === request.headers.get("host"); } catch { return false; }
}

const storedPassword = (env: AuthEnv) =>
  env.DB.prepare("SELECT hash, salt, iterations FROM auth_password WHERE id = 1").first<StoredPassword>();

// What the current password is, as a key for session hashes. Null means no
// password exists yet.
async function credentialKey(env: AuthEnv): Promise<string | null> {
  if (env.REMAIVO_PASSWORD) return "env:" + await sha256("remaivo-password:" + env.REMAIVO_PASSWORD);
  const stored = await storedPassword(env);
  return stored ? "db:" + stored.hash : null;
}
const sessionHash = (token: string, key: string) => sha256(token + "." + key);

// The owner keeps the user ID their data was created under. A server that
// already holds one person's data (for example after leaving Google sign-in)
// continues with that person's ID; a new server uses "owner".
async function ownerIdentity(env: AuthEnv, name?: string): Promise<Identity> {
  const select = () => env.DB.prepare("SELECT user_id, email, display_name FROM auth_identities WHERE google_sub = ?").bind(OWNER_SUB).first<Identity>();
  const existing = await select();
  if (existing) return existing;
  const profiles = await env.DB.prepare("SELECT user_id FROM profiles LIMIT 2").all<{ user_id: string }>();
  const userId = profiles.results.length === 1 ? profiles.results[0].user_id : "owner";
  const displayName = (name || env.REMAIVO_NAME || "").trim().slice(0, 120) || "Owner";
  // The user ID is unique: an older identity for the same person becomes the owner's.
  await env.DB.prepare("INSERT INTO auth_identities (google_sub, user_id, email, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET google_sub = excluded.google_sub").bind(OWNER_SUB, userId, OWNER_EMAIL, displayName).run();
  return (await select())!;
}

const pageHeaders = {
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
button{margin-top:18px;width:100%;padding:12px;font:inherit;font-weight:600;color:#fff;background:#14171f;border:0;border-radius:8px;cursor:pointer}.error{color:#b42318}a{color:inherit}code{font-size:14px}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#eef}main{background:#181b22;box-shadow:none}p{color:#aab}input{background:#0f1115;color:#eef;border-color:#334}button{background:#eef;color:#14171f}.error{color:#f97066}}</style>
<main>${body}</main></html>`;
  return new Response(html, { status, headers: pageHeaders });
}
function form(returnTo: string, setup: boolean, message = "") {
  const error = message ? `<p class="error" role="alert">${escape(message)}</p>` : "";
  const name = setup ? '<label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="120" placeholder="Optional">' : "";
  const confirm = setup ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>' : "";
  return `<h1>${setup ? "Welcome to Remaivo" : "Sign in"}</h1>
<p>${setup ? `Choose a password to protect this Remaivo server. Use at least ${MIN_LENGTH} characters.` : "Enter your Remaivo password."}</p>${error}
<form method="post" action="/auth/login"><input type="hidden" name="return_to" value="${escape(returnTo)}">${name}
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}"${setup ? "" : " autofocus"} required>${confirm}
<button>${setup ? "Set password" : "Sign in"}</button></form>`;
}
function redirect(target: string, cookies: string[] = []) {
  const headers = new Headers({ Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  cookies.forEach(c => headers.append("Set-Cookie", c));
  return new Response(null, { status: 303, headers });
}

async function startSession(request: Request, env: AuthEnv, key: string, returnTo: string, name?: string) {
  const owner = await ownerIdentity(env, name);
  const token = randomToken();
  const previous = sessionToken(request);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now()),
    ...(previous ? [env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sessionHash(previous, key))] : []),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sessionHash(token, key), owner.user_id, now() + lifetime),
  ]);
  return redirect(safeReturnPath(returnTo), [cookie(request, token, lifetime)]);
}

export async function handleAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;

  if (url.pathname === "/auth/signout") {
    if (request.method === "GET") return page("Sign out", '<h1>Sign out?</h1><form method="post"><button>Sign out of Remaivo</button></form><p style="margin-top:16px"><a href="/">Back to Remaivo</a></p>');
    if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
    if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);
    const token = sessionToken(request), key = await credentialKey(env);
    if (token && key) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sessionHash(token, key)).run();
    return redirect("/", [cookie(request, "", 0)]);
  }

  if (url.pathname !== "/auth/login") return page("Not found", '<h1>Page not found.</h1><p><a href="/">Back to Remaivo</a></p>', 404);
  const envPassword = env.REMAIVO_PASSWORD;
  if (envPassword && envPassword.length < MIN_LENGTH) return page("Password too short", `<h1>Password too short</h1><p>The <code>REMAIVO_PASSWORD</code> setting must be at least ${MIN_LENGTH} characters.</p>`, 503);
  // On Cloudflare the URL is public from the first second, so the password
  // must come from the secret; a first-visit setup form could be claimed by anyone.
  if (!envPassword && env.REMAIVO_PLATFORM === "cloudflare") {
    return page("Set a password", `<h1>Almost ready</h1><p>This Remaivo server has no password yet. Add a secret named <code>REMAIVO_PASSWORD</code> (at least ${MIN_LENGTH} characters) to the Worker in your Cloudflare dashboard, then reload this page.</p>`, 503);
  }
  const stored = envPassword ? null : await storedPassword(env);
  const setup = !envPassword && !stored;
  if (request.method === "GET") return page(setup ? "Set up" : "Sign in", form(safeReturnPath(url.searchParams.get("return_to")), setup));
  if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
  if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);

  const data = await request.formData().catch(() => null);
  const password = String(data?.get("password") ?? "");
  const returnTo = safeReturnPath(String(data?.get("return_to") ?? "/"));

  if (setup) {
    if (password.length < MIN_LENGTH) return page("Set up", form(returnTo, true, `Use at least ${MIN_LENGTH} characters.`), 400);
    if (password !== String(data?.get("confirm") ?? "")) return page("Set up", form(returnTo, true, "The passwords do not match."), 400);
    const salt = randomToken();
    const hash = await derive(password, salt, ITERATIONS);
    // INSERT OR IGNORE: if two first-visit setups race, only the first wins.
    const created = await env.DB.prepare("INSERT OR IGNORE INTO auth_password (id, hash, salt, iterations) VALUES (1, ?, ?, ?)").bind(hash, salt, ITERATIONS).run();
    if (!created.meta.changes) return page("Sign in", form(returnTo, false, "A password was already set. Please sign in."), 409);
    return startSession(request, env, "db:" + hash, returnTo, String(data?.get("name") ?? ""));
  }

  // The secret is compared as digests so the comparison takes the same time
  // whatever the input; Cloudflare's CPU limits rule out PBKDF2 per login there.
  const correct = envPassword
    ? sameText(await sha256(password), await sha256(envPassword))
    : !!password && sameText(await derive(password, stored!.salt, stored!.iterations), stored!.hash);
  if (!correct) return page("Sign in", form(returnTo, false, "That password is not correct."), 401);
  return startSession(request, env, (await credentialKey(env))!, returnTo);
}

export async function authenticate(request: Request, env: AuthEnv): Promise<Request> {
  const headers = stripIdentityHeaders(request);
  const token = sessionToken(request);
  const key = token ? await credentialKey(env) : null;
  if (token && key) {
    const identity = await env.DB.prepare("SELECT i.user_id, i.email, i.display_name FROM auth_sessions s JOIN auth_identities i ON i.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND i.google_sub = ?")
      .bind(await sessionHash(token, key), now(), OWNER_SUB).first<Identity>();
    if (identity) {
      headers.set("x-remaivo-user-id", identity.user_id);
      headers.set("x-remaivo-user-email", identity.email);
      headers.set("x-remaivo-user-name", encodeURIComponent(identity.display_name));
    }
  }
  return new Request(request, { headers });
}
