import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { authenticatePasswordRequest, handlePasswordAuth, sameOrigin } from '../worker/password-auth.ts';
import { stripIdentityHeaders } from '../worker/google-auth.ts';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('cloudflare/migrations/0002_google_auth.sql', 'utf8'));
sqlite.exec(fs.readFileSync('selfhost/migrations/0001_password_auth.sql', 'utf8'));
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { return { meta: { changes: sqlite.prepare(this.sql).run(...this.args).changes } }; }
}
const DB = { prepare: sql => new Statement(sql), batch: async statements => {
  sqlite.exec('BEGIN');
  try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
  catch (e) { sqlite.exec('ROLLBACK'); throw e; }
} };
const env = { DB };
const origin = 'http://192.168.1.20:5007';
const post = (fields, headers = {}) => handlePasswordAuth(new Request(origin + '/auth/login', {
  method: 'POST', body: new URLSearchParams(fields), headers: { origin, host: '192.168.1.20:5007', ...headers },
}), env);
const sessionCookie = response => response.headers.get('set-cookie')?.split(';')[0];
const whoami = async cookie => {
  const request = new Request(origin + '/', { headers: { cookie, 'x-remaivo-user-id': 'spoofed' } });
  return (await authenticatePasswordRequest(request, env, stripIdentityHeaders(request))).headers.get('x-remaivo-user-id');
};

test('First visit sets the owner password once, then the same password signs in', async () => {
  assert.match(await (await handlePasswordAuth(new Request(origin + '/auth/login'), env)).text(), /Choose a password/);
  assert.equal((await post({ password: 'short', confirm: 'short' })).status, 400);
  assert.equal((await post({ password: 'long enough', confirm: 'different!' })).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_password').get().n, 0);

  const created = await post({ name: ' Sam ', password: 'long enough', confirm: 'long enough', return_to: '/?view=plan' });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/?view=plan');
  assert.doesNotMatch(created.headers.get('set-cookie'), /Secure/, 'plain-HTTP LAN installs need a non-Secure cookie');
  assert.equal(await whoami(sessionCookie(created)), 'owner');
  assert.equal(sqlite.prepare('SELECT display_name FROM auth_identities').get().display_name, 'Sam');

  // A second setup attempt cannot replace the password.
  assert.equal((await post({ password: 'attacker pw', confirm: 'attacker pw' })).status, 401);
  assert.equal((await post({ password: 'long enough' })).status, 303);
});

test('Wrong passwords, cross-site posts and spoofed identities are rejected', async () => {
  assert.equal((await post({ password: 'not it' })).status, 401);
  assert.equal((await post({ password: 'long enough' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(await whoami('rmv-session=' + 'x'.repeat(43)), null);
  assert.equal(sameOrigin(new Request(origin + '/', { headers: { host: 'other:1' } }), env), false);
  assert.equal(sameOrigin(new Request('https://money.example/', { headers: { origin: 'https://money.example' } }), { APP_ORIGIN: 'https://money.example' }), true);
});

test('HTTPS requests get Secure cookies and sign-out revokes the session', async () => {
  const signedIn = await post({ password: 'long enough' }, { 'x-forwarded-proto': 'https' });
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = sessionCookie(signedIn);
  const out = await handlePasswordAuth(new Request(origin + '/auth/signout', { method: 'POST', headers: { origin, host: '192.168.1.20:5007', cookie } }), env);
  assert.equal(out.status, 303);
  assert.equal(await whoami(cookie), null);
});
