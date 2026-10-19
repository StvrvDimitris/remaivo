// One Remaivo server belongs to one owner, who signs in with a single password.
//
// The password is chosen on first visit and stored as a PBKDF2 hash in D1,
// like Actual Budget. A server's address may already be public at that point,
// so choosing it also needs a one-time setup code that only the server's logs
// show. Hosts that prefer configuration can set the REMAIVO_PASSWORD secret
// instead; it then is the password and no setup happens.
//
// Sessions are random tokens stored only as SHA-256 hashes. Each hash also
// covers a key derived from the current password, so changing the password
// signs every session out without any extra bookkeeping.
//
// The people who share the password each get a profile, like a streaming
// service: their own user ID, so accounts, plans and history never mix. A new
// sign-in first asks who is using Remaivo; the session then carries that
// profile until someone switches or signs out.

type AuthEnv = Pick<Env, "DB" | "REMAIVO_PLATFORM" | "APP_ORIGIN" | "REMAIVO_PASSWORD" | "REMAIVO_NAME">;
type Identity = { user_id: string; email: string; display_name: string };
type StoredPassword = { hash: string; salt: string; iterations: number };

// The owner's identity row. The column is named after the former Google login;
// every profile's starts with "password:".
const OWNER_SUB = "password:owner";
const OWNER_EMAIL = "owner@remaivo.local";
const PROFILE_SUB = "password:%";
const MAX_PROFILES = 5;
const SESSION = "rmv-session";
const MIN_LENGTH = 8;
// Set on a request whose session is valid but has no profile chosen yet.
export const CHOOSE_PROFILE = "x-remaivo-user-choose-profile";
// workerd rejects PBKDF2 above 100,000 iterations. Cloudflare's free plan allows
// about 10 ms of CPU per request, so a Worker there uses fewer; the count is
// stored with each hash.
const iterations = (env: AuthEnv) => env.REMAIVO_PLATFORM === "cloudflare" ? 10_000 : 100_000;
// No 0/O or 1/I/L, so a code copied from a log is read back correctly.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
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

// The one-time setup code, created on the first visit to the setup page and
// written to the server log each time that page is shown.
async function setupCode(env: AuthEnv) {
  const select = () => env.DB.prepare("SELECT code FROM auth_setup WHERE id = 1").first<{ code: string }>();
  let row = await select();
  if (!row) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("").replace(/^(.{4})/, "$1-");
    await env.DB.prepare("INSERT OR IGNORE INTO auth_setup (id, code) VALUES (1, ?)").bind(code).run();
    row = await select();
  }
  console.log(`Remaivo setup code: ${row!.code}  (enter it on the "Welcome to Remaivo" page to choose your password)`);
  return row!.code;
}
const normalCode = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, "");

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
import { themeCanvas } from "../app/ui-themes.ts";
import { localize } from "./auth-text.ts";

// Auth pages follow the theme the app last used in this browser (the
// rmv-theme cookie), or the system's light or dark mode before there is one.
const THEMES = ["indigo", "ocean", "midnight"];
const DARK = "--bg:#101621;--card:#1a2332;--text:#eef2fa;--muted:#a1aec2;--border:#354258;--soft:#232f42;--accent:#a4b7ff;--on:#142047;--err:#ffaaa8;color-scheme:dark";
// The interface language: the one the app last used here, else the browser's.
export function languageFrom(request: Request) {
  const saved = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)rmv-lang=([a-z]+)/)?.[1];
  if (saved === "el" || saved === "en") return saved;
  return /^el\b/i.test(request.headers.get("accept-language") ?? "") ? "el" : "en";
}
export function themeFrom(request: Request) {
  const value = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)rmv-theme=([a-z]+)/)?.[1];
  return value && THEMES.includes(value) ? value : null;
}
// The phone's status bar colour. Every page sets it, so an installed app never
// falls back to the colour its manifest had when it was installed.
const BAR_COLORS = `<meta name="theme-color" content="${themeCanvas("indigo")}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="${themeCanvas("midnight")}" media="(prefers-color-scheme: dark)">`;
const icons: Record<string, string> = {
  edit: "M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4",
  plus: "M12 5v14M5 12h14",
  back: "M19 12H5m6-6-6 6 6 6",
  signout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"/></svg>`;
function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${BAR_COLORS}<title>${title} · Remaivo</title>
<style>:root{--bg:#f6f7f9;--card:#fff;--text:#20242e;--muted:#697180;--border:#e5e7ec;--soft:#f5f6f8;--accent:#365bd6;--on:#fff;--err:#b42318;color-scheme:light}
html[data-theme=ocean]{--bg:#f2f7f7;--text:#17323b;--muted:#607d85;--border:#dce8e9;--soft:#edf5f5;--accent:#087c82}html[data-theme=midnight]{${DARK}}@media (prefers-color-scheme:dark){html:not([data-theme]){${DARK}}}
body{font:16px system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0}main{max-width:360px;margin:12vh auto;padding:28px;background:var(--card);border-radius:16px;box-shadow:0 1px 3px #0002}
h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);margin:0 0 18px}label{display:block;font-size:14px;margin:12px 0 4px}input{box-sizing:border-box;width:100%;padding:10px 12px;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--border);border-radius:8px}
button{margin-top:18px;width:100%;padding:12px;font:inherit;font-weight:600;color:var(--on);background:var(--accent);border:0;border-radius:8px;cursor:pointer}.error{color:var(--err)}.hint{font-size:13px;margin:6px 0 0}a{color:inherit}code{font-size:13px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
main.wide{max-width:560px;background:none;box-shadow:none;text-align:center}.wide h1{font-size:26px;margin-bottom:28px}
.tiles{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;justify-content:center;gap:22px}.tile{position:relative;width:96px}.tile form{margin:0}
.pick{margin:0;padding:0;width:96px;display:flex;flex-direction:column;align-items:center;gap:8px;background:none;color:var(--muted);font-weight:500;text-decoration:none;border-radius:16px}.pick:hover,.pick[aria-current]{color:var(--text)}
.avatar{flex:none;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:20px}.avatar.large{width:96px;height:96px;border-radius:20px;font-size:44px;box-sizing:border-box;transition:transform .12s}
.pick:hover .avatar.large{transform:scale(1.04)}.pick[aria-current] .avatar.large{box-shadow:0 0 0 3px var(--bg),0 0 0 6px var(--accent)}.avatar.add{background:var(--soft);color:var(--muted);border:2px dashed var(--border)}
.name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edit{position:absolute;top:-8px;right:-8px;width:32px;height:32px;display:grid;place-items:center;border-radius:50%;background:var(--card);color:var(--text);box-shadow:0 1px 4px #0003}.edit svg{width:16px;height:16px}
.bar{display:flex;justify-content:center;gap:12px;margin-top:36px}.bar a{width:44px;height:44px;display:grid;place-items:center;border-radius:12px;background:var(--card);color:var(--text);box-shadow:0 1px 3px #0002}
.links{margin:18px 0 0;font-size:14px;display:flex;justify-content:space-between}.preview{display:flex;justify-content:center;margin-bottom:8px}
fieldset{border:0;padding:0;margin:14px 0 0}legend{font-size:14px;padding:0;margin-bottom:6px}.choices{display:flex;flex-wrap:wrap;gap:6px}
.choices label{margin:0;position:relative;cursor:pointer}.choices input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.swatch{width:32px;height:32px;border-radius:50%}.swatch:has(:checked){box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--text)}
.icon>span:first-of-type{display:grid;place-items:center;width:36px;height:36px;border-radius:8px;border:1px solid var(--border);font-size:18px}.icon:has(:checked)>span:first-of-type{border:2px solid var(--accent);background:var(--soft)}.choices :focus-visible+span,.swatch:has(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}</style>
<main${body.startsWith("<!--wide-->") ? ' class="wide"' : ""}>${body}</main></html>`;
  return new Response(html, { status, headers: pageHeaders });
}
function form(returnTo: string, setup: boolean, message = "") {
  const error = message ? `<p class="error" role="alert">${escape(message)}</p>` : "";
  const name = setup ? '<label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="120" placeholder="Optional">' : "";
  const confirm = setup ? '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>' : "";
  const code = setup ? '<label for="code">Setup code</label><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required>'
    + '<p class="hint">You will find it in this server\'s logs. On Cloudflare: Workers &amp; Pages, your Worker, Logs, Live, then reload this page. With Docker: <code>docker logs remaivo</code>.</p>' : "";
  return `<h1>${setup ? "Welcome to Remaivo" : "Sign in"}</h1>
<p>${setup ? `Choose a password to protect this Remaivo server. Use at least ${MIN_LENGTH} characters.` : "Enter your Remaivo password."}</p>${error}
<form method="post" action="/auth/login"><input type="hidden" name="return_to" value="${escape(returnTo)}">${code}${name}
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}"${setup ? "" : " autofocus"} required>${confirm}
<button>${setup ? "Set password" : "Sign in"}</button></form>`;
}
function redirect(target: string, cookies: string[] = []) {
  const headers = new Headers({ Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  cookies.forEach(c => headers.append("Set-Cookie", c));
  return new Response(null, { status: 303, headers });
}

// Whoever just chose the first password is the owner and goes straight in;
// every later sign-in picks a profile first.
async function startSession(request: Request, env: AuthEnv, key: string, returnTo: string, name?: string) {
  const owner = await ownerIdentity(env, name);
  const chosen = name !== undefined;
  const token = randomToken();
  const previous = sessionToken(request);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now()),
    ...(previous ? [env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sessionHash(previous, key))] : []),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at, profile_chosen) VALUES (?, ?, ?, ?)").bind(await sessionHash(token, key), owner.user_id, now() + lifetime, chosen ? 1 : 0),
  ]);
  const target = safeReturnPath(returnTo);
  return redirect(chosen ? target : profilesPath(target), [cookie(request, token, lifetime)]);
}

export const profilesPath = (returnTo: string) => returnTo === "/" ? "/auth/profiles" : `/auth/profiles?return_to=${encodeURIComponent(returnTo)}`;

type Profile = { user_id: string; display_name: string; avatar_color: string; avatar_icon: string };
const profileList = (env: AuthEnv) =>
  env.DB.prepare("SELECT user_id, display_name, avatar_color, avatar_icon FROM auth_identities WHERE google_sub LIKE ? ORDER BY google_sub <> ?, created_at, rowid").bind(PROFILE_SUB, OWNER_SUB).all<Profile>().then(r => r.results);

// A profile card shows a colour and an icon, chosen from these. An empty icon
// shows the first letter of the name; an unset colour follows the card's place.
export const AVATAR_COLORS = ["#365bd6", "#0b7bc1", "#6941c6", "#c11574", "#d92d20", "#c4320a", "#b54708", "#475467"];
export const AVATAR_ICONS = ["", "🐱", "🐶", "🦊", "🐼", "🐸", "🦄", "🐙", "🌸", "🌙", "⭐", "🔥", "🍀", "🌊", "🎧", "🎮", "☕", "🍕", "⚽", "🚀"];
export function avatar(profile: Pick<Profile, "display_name" | "avatar_color" | "avatar_icon">, index = 0) {
  const color = AVATAR_COLORS.includes(profile.avatar_color) ? profile.avatar_color : AVATAR_COLORS[index % AVATAR_COLORS.length];
  const icon = AVATAR_ICONS.includes(profile.avatar_icon) && profile.avatar_icon ? profile.avatar_icon : Array.from(profile.display_name.trim())[0]?.toUpperCase() || "?";
  return { color, icon };
}

// The session behind a request, whether or not it has chosen a profile yet.
async function currentSession(request: Request, env: AuthEnv) {
  const token = sessionToken(request), key = token ? await credentialKey(env) : null;
  if (!token || !key) return null;
  const tokenHash = await sessionHash(token, key);
  const row = await env.DB.prepare("SELECT user_id, profile_chosen FROM auth_sessions WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, now()).first<{ user_id: string; profile_chosen: number }>();
  return row ? { tokenHash, userId: row.user_id, chosen: !!row.profile_chosen } : null;
}

const badge = (p: Profile, index: number, large = false) => {
  const { color, icon } = avatar(p, index);
  return `<span class="avatar${large ? " large" : ""}" style="background:${color}" aria-hidden="true">${escape(icon)}</span>`;
};
// The card editor: name, colour and icon, as plain radio buttons (no scripts).
function cardFields(p: Profile | null, index: number) {
  const current = p ? avatar(p, index) : { color: AVATAR_COLORS[index % AVATAR_COLORS.length], icon: "" };
  const icon = p && AVATAR_ICONS.includes(p.avatar_icon) ? p.avatar_icon : "";
  const colors = AVATAR_COLORS.map((c, i) => `<label class="swatch" style="background:${c}"><input type="radio" name="color" value="${c}"${c === current.color ? " checked" : ""}><span class="sr">Colour ${i + 1}</span></label>`).join("");
  const icons = AVATAR_ICONS.map(i => `<label class="icon"><input type="radio" name="icon" value="${i}"${i === icon ? " checked" : ""}><span>${i || "Aa"}</span>${i ? "" : '<span class="sr">First letter</span>'}</label>`).join("");
  return `<label for="name">Name</label><input id="name" name="name" maxlength="40" autocomplete="off" value="${escape(p?.display_name ?? "")}" required>
<fieldset><legend>Colour</legend><div class="choices">${colors}</div></fieldset><fieldset><legend>Icon</legend><div class="choices">${icons}</div></fieldset>`;
}

function profilesPage(profiles: Profile[], current: string | null, returnTo: string, options: { message?: string; status?: number; editing?: string | null; adding?: boolean } = {}) {
  const { message = "", status = 200 } = options;
  const error = message ? `<p class="error" role="alert">${escape(message)}</p>` : "";
  const hidden = `<input type="hidden" name="return_to" value="${escape(returnTo)}">`;
  const list = escape(profilesPath(returnTo));
  const withReturn = (query: string) => `/auth/profiles?${query}${returnTo === "/" ? "" : "&amp;return_to=" + encodeURIComponent(returnTo)}`;
  const editIndex = profiles.findIndex(p => p.user_id === options.editing);
  if (editIndex >= 0) {
    const p = profiles[editIndex];
    return page("Edit profile", `<div class="preview">${badge(p, editIndex, true)}</div><h1>Edit profile</h1>${error}
<form method="post" action="/auth/profiles">${hidden}<input type="hidden" name="action" value="edit"><input type="hidden" name="profile" value="${escape(p.user_id)}">${cardFields(p, editIndex)}<button>Save</button></form>
<p class="links"><a href="${list}">Cancel</a><span></span></p>`, status);
  }
  if (options.adding && profiles.length < MAX_PROFILES) {
    return page("Add profile", `<h1>Add profile</h1>${error}<form method="post" action="/auth/profiles">${hidden}<input type="hidden" name="action" value="add">
${cardFields(null, profiles.length)}<button>Create profile</button></form><p class="links"><a href="${list}">Cancel</a><span></span></p>`, status);
  }
  const tiles = profiles.map((p, i) => `<li class="tile"><form method="post" action="/auth/profiles">${hidden}<input type="hidden" name="profile" value="${escape(p.user_id)}">
<button class="pick"${p.user_id === current ? ' aria-current="true"' : ""}>${badge(p, i, true)}<span class="name">${escape(p.display_name)}</span></button></form>
<a class="edit" href="${withReturn("edit=" + encodeURIComponent(p.user_id))}" aria-label="Edit ${escape(p.display_name)}" title="Edit">${icon("edit")}</a></li>`).join("");
  const add = profiles.length >= MAX_PROFILES ? ""
    : `<li class="tile"><a class="pick" href="${withReturn("add=1")}"><span class="avatar large add" aria-hidden="true">${icon("plus")}</span><span class="name">Add profile</span></a></li>`;
  const back = current ? `<a href="${escape(returnTo)}" aria-label="Back to Remaivo" title="Back to Remaivo">${icon("back")}</a>` : "";
  return page("Profiles", `<!--wide--><h1>Who's using Remaivo?</h1>${error}<ul class="tiles">${tiles}${add}</ul>
<nav class="bar">${back}<a href="/auth/signout" aria-label="Sign out" title="Sign out">${icon("signout")}</a></nav>`, status);
}

// The name, colour and icon from a card form, or the reason they don't fit.
function cardInput(data: FormData, profiles: Profile[], self: string | null) {
  const name = String(data.get("name") ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  const color = String(data.get("color") ?? ""), icon = String(data.get("icon") ?? "");
  if (!name) return { error: "Give the profile a name." };
  if (profiles.some(p => p.user_id !== self && p.display_name.toLowerCase() === name.toLowerCase())) return { error: "A profile with that name already exists." };
  return { name, color: AVATAR_COLORS.includes(color) ? color : "", icon: AVATAR_ICONS.includes(icon) ? icon : "" };
}

async function handleProfiles(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return redirect(`/auth/login?return_to=${encodeURIComponent(safeReturnPath(url.searchParams.get("return_to")))}`);
  const current = session.chosen ? session.userId : null;
  if (request.method === "GET") return profilesPage(await profileList(env), current, safeReturnPath(url.searchParams.get("return_to")), { editing: url.searchParams.get("edit"), adding: url.searchParams.has("add") });
  if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
  if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);

  const data = await request.formData().catch(() => null);
  const returnTo = safeReturnPath(String(data?.get("return_to") ?? "/"));
  const profiles = await profileList(env);
  const action = String(data?.get("action") ?? "");
  let userId = String(data?.get("profile") ?? "");
  if (action === "add") {
    const card = cardInput(data!, profiles, null);
    if (card.error) return profilesPage(profiles, current, returnTo, { message: card.error, status: 400, adding: true });
    if (profiles.length >= MAX_PROFILES) return profilesPage(profiles, current, returnTo, { message: `This Remaivo already has ${MAX_PROFILES} profiles.`, status: 400 });
    userId = crypto.randomUUID();
    // The address column is required; profiles have none, so it stays local.
    await env.DB.prepare("INSERT INTO auth_identities (google_sub, user_id, email, display_name, avatar_color, avatar_icon) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("password:" + userId, userId, `${userId}@remaivo.local`, card.name, card.color || AVATAR_COLORS[profiles.length % AVATAR_COLORS.length], card.icon).run();
  } else if (!profiles.some(p => p.user_id === userId)) {
    return profilesPage(profiles, current, returnTo, { message: "That profile no longer exists.", status: 400 });
  } else if (action === "edit") {
    const card = cardInput(data!, profiles, userId), index = profiles.findIndex(p => p.user_id === userId);
    if (card.error) return profilesPage(profiles, current, returnTo, { message: card.error, status: 400, editing: userId });
    await env.DB.prepare("UPDATE auth_identities SET display_name = ?, avatar_color = ?, avatar_icon = ? WHERE user_id = ? AND google_sub LIKE ?").bind(card.name, card.color || avatar(profiles[index], index).color, card.icon, userId, PROFILE_SUB).run();
    // Editing a card is not choosing it: go back to the list.
    return redirect(profilesPath(returnTo));
  }
  await env.DB.prepare("UPDATE auth_sessions SET user_id = ?, profile_chosen = 1 WHERE token_hash = ?").bind(userId, session.tokenHash).run();
  // Open the app in the chosen profile's theme and language straight away, even on a new device.
  const saved = await env.DB.prepare("SELECT ui_theme, ui_language FROM profiles WHERE user_id = ?").bind(userId).first<{ ui_theme: string; ui_language: string }>();
  const theme = THEMES.includes(saved?.ui_theme ?? "") ? saved!.ui_theme : "indigo";
  const language = saved?.ui_language === "el" ? "el" : saved ? "en" : languageFrom(request);
  return redirect(returnTo, [`rmv-theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`, `rmv-lang=${language}; Path=/; Max-Age=31536000; SameSite=Lax`]);
}

export async function handleAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const response = await authPage(request, env);
  return response && themed(request, response);
}

// Applies the browser's saved theme and language to a page built by page().
async function themed(request: Request, response: Response) {
  const theme = themeFrom(request), language = languageFrom(request);
  if ((!theme && language === "en") || !response.headers.get("content-type")?.startsWith("text/html")) return response;
  let html = await response.text();
  if (theme) html = html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
    .replace(BAR_COLORS, `<meta name="theme-color" content="${themeCanvas(theme)}">`);
  return new Response(localize(html, language), { status: response.status, headers: response.headers });
}

// A short themed page for the Worker's own messages (updating, too many requests).
export function noticePage(request: Request, title: string, message: string, status: number, headers: Record<string, string> = {}) {
  const response = page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p><p><a href="/">Back to Remaivo</a></p>`, status);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return themed(request, response);
}

async function authPage(request: Request, env: AuthEnv): Promise<Response | null> {
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

  if (url.pathname === "/auth/profiles") return handleProfiles(request, env, url);
  if (url.pathname !== "/auth/login") return page("Not found", '<h1>Page not found.</h1><p><a href="/">Back to Remaivo</a></p>', 404);
  const envPassword = env.REMAIVO_PASSWORD;
  if (envPassword && envPassword.length < MIN_LENGTH) return page("Password too short", `<h1>Password too short</h1><p>The <code>REMAIVO_PASSWORD</code> setting must be at least ${MIN_LENGTH} characters.</p>`, 503);
  const stored = envPassword ? null : await storedPassword(env);
  const setup = !envPassword && !stored;
  if (request.method === "GET") {
    if (setup) await setupCode(env);
    return page(setup ? "Set up" : "Sign in", form(safeReturnPath(url.searchParams.get("return_to")), setup));
  }
  if (request.method !== "POST") return page("Error", "<h1>Method not allowed.</h1>", 405);
  if (!sameOrigin(request, env)) return page("Error", "<h1>Request origin is not allowed.</h1>", 403);

  const data = await request.formData().catch(() => null);
  const password = String(data?.get("password") ?? "");
  const returnTo = safeReturnPath(String(data?.get("return_to") ?? "/"));

  if (setup) {
    const expected = await env.DB.prepare("SELECT code FROM auth_setup WHERE id = 1").first<{ code: string }>();
    if (!expected || !sameText(normalCode(String(data?.get("code") ?? "")), normalCode(expected.code))) {
      await setupCode(env);
      return page("Set up", form(returnTo, true, "That setup code is not correct. Check the server's logs for the current code."), 400);
    }
    if (password.length < MIN_LENGTH) return page("Set up", form(returnTo, true, `Use at least ${MIN_LENGTH} characters.`), 400);
    if (password !== String(data?.get("confirm") ?? "")) return page("Set up", form(returnTo, true, "The passwords do not match."), 400);
    const salt = randomToken();
    const count = iterations(env);
    const hash = await derive(password, salt, count);
    // INSERT OR IGNORE: if two first-visit setups race, only the first wins.
    const [created] = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO auth_password (id, hash, salt, iterations) VALUES (1, ?, ?, ?)").bind(hash, salt, count),
      env.DB.prepare("DELETE FROM auth_setup"),
    ]);
    if (!created.meta.changes) return page("Sign in", form(returnTo, false, "A password was already set. Please sign in."), 409);
    return startSession(request, env, "db:" + hash, returnTo, String(data?.get("name") ?? ""));
  }

  // The secret is compared as digests so the comparison takes the same time
  // whatever the input.
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
    const identity = await env.DB.prepare("SELECT i.user_id, i.email, i.display_name, i.avatar_color, i.avatar_icon, s.profile_chosen FROM auth_sessions s JOIN auth_identities i ON i.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND i.google_sub LIKE ?")
      .bind(await sessionHash(token, key), now(), PROFILE_SUB).first<Identity & Pick<Profile, "avatar_color" | "avatar_icon"> & { profile_chosen: number }>();
    if (identity && !identity.profile_chosen) headers.set(CHOOSE_PROFILE, "1");
    else if (identity) {
      headers.set("x-remaivo-user-id", identity.user_id);
      headers.set("x-remaivo-user-email", identity.email);
      headers.set("x-remaivo-user-name", encodeURIComponent(identity.display_name));
      const { color, icon } = avatar(identity);
      headers.set("x-remaivo-user-avatar", encodeURIComponent(JSON.stringify({ color, icon })));
    }
  }
  return new Request(request, { headers });
}
