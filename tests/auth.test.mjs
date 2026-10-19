import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { authenticate, handleAuth, sameOrigin, stripIdentityHeaders } from '../worker/auth.ts';
import { enforceRateLimit } from '../worker/rate-limit.ts';

// A fresh database with every Cloudflare migration applied, as on a new server.
// `seed` runs just before the single-owner migration, to model an older server.
function database(seed = () => {}) {
  const sqlite = new DatabaseSync(':memory:');
  const files = fs.readdirSync('cloudflare/migrations').filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (file.startsWith('0011')) seed(sqlite);
    sqlite.exec(fs.readFileSync(`cloudflare/migrations/${file}`, 'utf8'));
  }
  class Statement {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Statement(this.sql, args); }
    async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
    async run() { return { meta: { changes: sqlite.prepare(this.sql).run(...this.args).changes } }; }
  }
  const DB = { prepare: sql => new Statement(sql), batch: async statements => {
    sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
  return { sqlite, DB };
}

const origin = 'http://192.168.1.20:5007';
const host = '192.168.1.20:5007';
const post = (env, fields, headers = {}) => handleAuth(new Request(origin + '/auth/login', {
  method: 'POST', body: new URLSearchParams(fields), headers: { origin, host, ...headers },
}), env);
const sessionCookie = response => response.headers.get('set-cookie')?.split(';')[0];
// Signing in with the password leads to the profile picker; this picks the
// first profile (the owner) and returns the session cookie.
async function enter(env, response, index = 0) {
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^\/auth\/profiles/);
  const cookie = sessionCookie(response);
  const picker = await (await handleAuth(new Request(origin + '/auth/profiles', { headers: { cookie } }), env)).text();
  const profile = [...picker.matchAll(/name="profile" value="([^"]+)"/g)][index][1];
  const picked = await handleAuth(new Request(origin + '/auth/profiles', { method: 'POST', body: new URLSearchParams({ profile }), headers: { origin, host, cookie } }), env);
  assert.equal(picked.status, 303);
  return cookie;
}
const whoami = async (env, cookie) => (await authenticate(new Request(origin + '/', { headers: { cookie, 'x-remaivo-user-id': 'spoofed' } }), env)).headers.get('x-remaivo-user-id');

for (const platform of ['selfhost', 'cloudflare']) test(`On ${platform}, the first visit chooses the password, but only with the setup code from the logs`, async () => {
  const { sqlite, DB } = database();
  const env = { DB, REMAIVO_PLATFORM: platform };
  const logged = [];
  const log = console.log;
  console.log = line => logged.push(String(line));
  const form = await (await handleAuth(new Request(origin + '/auth/login'), env)).text();
  console.log = log;
  assert.match(form, /Choose a password/);
  assert.match(form, /Setup code/);
  const code = sqlite.prepare('SELECT code FROM auth_setup').get().code;
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(logged.some(line => line.includes(code)), 'the code is written to the server log');
  assert.doesNotMatch(form, new RegExp(code), 'the page never shows the code');

  // A stranger who found the address cannot claim it.
  assert.equal((await post(env, { password: 'claim it now', confirm: 'claim it now' })).status, 400);
  assert.equal((await post(env, { code: 'AAAA-AAAA', password: 'claim it now', confirm: 'claim it now' })).status, 400);
  assert.equal((await post(env, { code, password: 'short', confirm: 'short' })).status, 400);
  assert.equal((await post(env, { code, password: 'long enough', confirm: 'different!' })).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_password').get().n, 0);

  // Codes are read back case- and dash-insensitively.
  const created = await post(env, { code: code.toLowerCase().replace('-', ' '), name: ' Sam ', password: 'long enough', confirm: 'long enough', return_to: '/?view=plan' });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/?view=plan');
  assert.doesNotMatch(created.headers.get('set-cookie'), /Secure/, 'plain-HTTP home servers need a non-Secure cookie');
  assert.equal(await whoami(env, sessionCookie(created)), 'owner');
  assert.equal(sqlite.prepare('SELECT display_name FROM auth_identities').get().display_name, 'Sam');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_setup').get().n, 0, 'the code is used up');
  assert.equal(sqlite.prepare('SELECT iterations FROM auth_password').get().iterations, platform === 'cloudflare' ? 10000 : 100000);

  // The setup form is gone; a second "setup" is just a wrong password.
  assert.equal((await post(env, { code, password: 'attacker pw', confirm: 'attacker pw' })).status, 401);
  assert.equal(await whoami(env, await enter(env, await post(env, { password: 'long enough' }))), 'owner');
});

test('Wrong passwords, cross-site posts and spoofed identities are rejected', async () => {
  const { DB } = database();
  const env = { DB, REMAIVO_PLATFORM: 'selfhost', REMAIVO_PASSWORD: 'long enough' };
  assert.equal((await post(env, { password: 'not it' })).status, 401);
  assert.equal((await post(env, { password: 'long enough' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(await whoami(env, 'rmv-session=' + 'x'.repeat(43)), null);
  assert.equal(stripIdentityHeaders(new Request(origin, { headers: { 'x-remaivo-user-id': 'spoofed' } })).has('x-remaivo-user-id'), false);
  assert.equal(sameOrigin(new Request(origin + '/', { headers: { host: 'other:1' } }), env), false);
  assert.equal(sameOrigin(new Request('https://money.example/', { headers: { origin: 'https://money.example' } }), { APP_ORIGIN: 'https://money.example' }), true);
});

test('HTTPS gets Secure cookies and sign-out revokes the session', async () => {
  const { DB } = database();
  const env = { DB, REMAIVO_PLATFORM: 'selfhost', REMAIVO_PASSWORD: 'long enough' };
  const signedIn = await post(env, { password: 'long enough' }, { 'x-forwarded-proto': 'https' });
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = await enter(env, signedIn);
  assert.equal(await whoami(env, cookie), 'owner');
  const out = await handleAuth(new Request(origin + '/auth/signout', { method: 'POST', headers: { origin, host, cookie } }), env);
  assert.equal(out.status, 303);
  assert.equal(await whoami(env, cookie), null);
});

test('A REMAIVO_PASSWORD secret replaces setup, is never stored, and changing it signs everyone out', async () => {
  const { sqlite, DB } = database();
  assert.equal((await handleAuth(new Request(origin + '/auth/login'), { DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'short' })).status, 503);

  const env = { DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'first password' };
  assert.doesNotMatch(await (await handleAuth(new Request(origin + '/auth/login'), env)).text(), /Choose a password/);
  const cookie = await enter(env, await post(env, { password: 'first password' }));
  assert.equal(await whoami(env, cookie), 'owner');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_password').get().n, 0, 'the secret is never stored');

  const changed = { ...env, REMAIVO_PASSWORD: 'second password' };
  assert.equal(await whoami(changed, cookie), null);
  assert.equal((await post(changed, { password: 'first password' })).status, 401);
  assert.equal(await whoami(changed, await enter(changed, await post(changed, { password: 'second password' }))), 'owner');
});

test('Leaving Google sign-in keeps the owner on the user ID that holds their data', async () => {
  const { sqlite, DB } = database(db => {
    db.exec("INSERT INTO profiles(user_id) VALUES('google-user-1')");
    db.exec("INSERT INTO auth_identities(google_sub,user_id,email,display_name) VALUES('1234','google-user-1','me@example.com','Me')");
    db.exec("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('old','google-user-1',9999999999)");
  });
  assert.deepEqual({ ...sqlite.prepare('SELECT google_sub, user_id FROM auth_identities').get() }, { google_sub: 'password:owner', user_id: 'google-user-1' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
  const env = { DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'long enough' };
  assert.equal(await whoami(env, await enter(env, await post(env, { password: 'long enough' }))), 'google-user-1');

  // Without an identity row, a server holding one person's data still signs in as them.
  const single = database(db => db.exec("INSERT INTO profiles(user_id) VALUES('only-user')"));
  const singleEnv = { DB: single.DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'long enough' };
  assert.equal(await whoami(singleEnv, await enter(singleEnv, await post(singleEnv, { password: 'long enough' }))), 'only-user');
});

test('People sharing the password each get their own profile, with a customisable card', async () => {
  const { sqlite, DB } = database();
  const env = { DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'shared secret' };
  const profiles = (cookie, init = {}) => handleAuth(new Request(origin + '/auth/profiles', { ...init, headers: { origin, host, cookie, ...init.headers } }), env);
  const send = (cookie, fields) => profiles(cookie, { method: 'POST', body: new URLSearchParams(fields) });
  const avatarOf = async cookie => JSON.parse(decodeURIComponent((await authenticate(new Request(origin + '/', { headers: { cookie } }), env)).headers.get('x-remaivo-user-avatar')));

  // Before a profile is chosen the session is signed in but holds nobody's data.
  const signedIn = await post(env, { password: 'shared secret', return_to: '/?view=plan' });
  assert.equal(signedIn.headers.get('location'), '/auth/profiles?return_to=%2F%3Fview%3Dplan');
  const mine = sessionCookie(signedIn);
  assert.equal(await whoami(env, mine), null);
  const waiting = await authenticate(new Request(origin + '/', { headers: { cookie: mine } }), env);
  assert.equal(waiting.headers.get('x-remaivo-user-choose-profile'), '1');
  assert.equal((await profiles('rmv-session=' + 'x'.repeat(43))).status, 303, 'the picker needs the password first');
  assert.match(await (await profiles(mine)).text(), /Who's using Remaivo\?/);

  const ownerId = [...(await (await profiles(mine)).text()).matchAll(/name="profile" value="([^"]+)"/g)][0][1];
  assert.equal((await send(mine, { profile: ownerId, return_to: '/?view=plan' })).headers.get('location'), '/?view=plan');
  assert.equal(await whoami(env, mine), 'owner');

  // Someone else signs in with the same password and adds their own profile.
  const theirs = sessionCookie(await post(env, { password: 'shared secret' }));
  const created = await send(theirs, { action: 'add', name: '  Alex  ', color: '#c11574', icon: '🦊' });
  assert.equal(created.status, 303);
  const alex = sqlite.prepare("SELECT user_id, display_name, avatar_color, avatar_icon FROM auth_identities WHERE display_name = 'Alex'").get();
  assert.deepEqual([alex.avatar_color, alex.avatar_icon], ['#c11574', '🦊']);
  assert.equal(await whoami(env, theirs), alex.user_id, 'a new profile is chosen straight away and starts empty');
  assert.notEqual(alex.user_id, 'owner');
  assert.deepEqual(await avatarOf(theirs), { color: '#c11574', icon: '🦊' });
  assert.equal(await whoami(env, mine), 'owner', 'switching on one device leaves the other alone');

  // Names are unique, and unknown colours or icons fall back to the defaults.
  assert.equal((await send(theirs, { action: 'add', name: 'alex' })).status, 400);
  assert.equal((await send(theirs, { action: 'add', name: '   ' })).status, 400);
  await send(theirs, { action: 'add', name: 'Kim', color: 'red; background:url(x)', icon: '<b>' });
  const kim = sqlite.prepare("SELECT avatar_color, avatar_icon FROM auth_identities WHERE display_name = 'Kim'").get();
  assert.match(kim.avatar_color, /^#[0-9a-f]{6}$/);
  assert.equal(kim.avatar_icon, '');
  assert.notEqual(await whoami(env, theirs), alex.user_id, 'adding a profile switches to it');
  await send(theirs, { profile: alex.user_id });

  // Editing a card changes its look, not who is signed in.
  const edited = await send(mine, { action: 'edit', profile: alex.user_id, name: 'Alexandra', color: '#0b7bc1', icon: '' });
  assert.equal(edited.headers.get('location'), '/auth/profiles');
  assert.equal(await whoami(env, mine), 'owner');
  assert.deepEqual(await avatarOf(theirs), { color: '#0b7bc1', icon: 'A' });
  assert.equal((await send(mine, { action: 'edit', profile: alex.user_id, name: 'Kim' })).status, 400);
  assert.match(await (await handleAuth(new Request(origin + '/auth/profiles?edit=' + alex.user_id, { headers: { cookie: mine } }), env)).text(), /value="Alexandra"/);

  // Only real profiles can be chosen, cross-site posts are refused, and there is a cap.
  assert.equal((await send(mine, { profile: 'someone-else' })).status, 400);
  assert.equal((await profiles(mine, { method: 'POST', body: new URLSearchParams({ profile: alex.user_id }), headers: { origin: 'https://evil.example' } })).status, 403);
  await send(mine, { action: 'add', name: 'Four' });
  await send(mine, { action: 'add', name: 'Five' });
  assert.equal((await send(mine, { action: 'add', name: 'Six' })).status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM auth_identities").get().n, 5);

  // Picking a card opens the app in that profile's theme, even on a new device.
  sqlite.exec(`INSERT INTO profiles (user_id, ui_theme) VALUES ('${alex.user_id}', 'midnight')`);
  assert.match((await send(mine, { profile: alex.user_id })).headers.get('set-cookie'), /^rmv-theme=midnight;/);
  assert.match(await (await profiles(mine + '; rmv-theme=midnight')).text(), /<html lang="en" data-theme="midnight">/);

  // Switching back is just picking another card.
  await send(mine, { profile: alex.user_id });
  assert.equal(await whoami(env, mine), alex.user_id);
});

test('Sessions from before profiles keep the owner signed in', async () => {
  const { sqlite, DB } = database();
  const env = { DB, REMAIVO_PLATFORM: 'cloudflare', REMAIVO_PASSWORD: 'long enough' };
  const cookie = await enter(env, await post(env, { password: 'long enough' }));
  // Rows written before the migration take the column's default.
  sqlite.exec("UPDATE auth_sessions SET profile_chosen = (SELECT dflt_value FROM pragma_table_info('auth_sessions') WHERE name = 'profile_chosen')");
  assert.equal(sqlite.prepare('SELECT profile_chosen FROM auth_sessions').get().profile_chosen, 1);
  assert.equal(await whoami(env, cookie), 'owner');
});

test('Login limits are per visitor on Cloudflare and shared on a self-hosted server', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  const limits = platform => ({ LOGIN_RATE_LIMIT: limiter, FINANCE_RATE_LIMIT: limiter, PAGE_RATE_LIMIT: limiter, REMAIVO_PLATFORM: platform });
  const request = path => new Request(origin + path, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  await enforceRateLimit(request('/auth/login'), limits('cloudflare'));
  await enforceRateLimit(request('/auth/login'), limits('selfhost'));
  await enforceRateLimit(request('/api/finance'), limits('selfhost'));
  // Without Cloudflare's edge there is no visitor address at all.
  await enforceRateLimit(new Request(origin + '/api/finance'), limits('selfhost'));
  assert.equal((await enforceRateLimit(new Request(origin + '/api/finance'), limits('cloudflare'))).status, 503);
  assert.deepEqual(keys, ['login:203.0.113.9', 'login:server', 'finance:203.0.113.9', 'finance:server']);
});
