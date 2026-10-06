import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticateRequest, handleGoogleAuth, hashToken, randomToken, safeReturnPath, stripIdentityHeaders } from '../worker/google-auth.ts';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync('cloudflare/migrations/0002_google_auth.sql', 'utf8'));
sqlite.exec('CREATE TABLE profiles(user_id TEXT PRIMARY KEY); INSERT INTO profiles VALUES (\'legacy-owner\');');
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
const env = { DB, AUTH_PROVIDER: 'google', APP_ORIGIN: 'https://remaivo.example', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', LEGACY_OWNER_EMAIL: 'owner@gmail.com', LEGACY_OWNER_ID: 'legacy-owner' };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
const originalFetch = globalThis.fetch;
let issuedClaims = {}, nonce, codeVerifier, tokenCalls = 0;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
  if (url === 'https://oauth2.googleapis.com/token') {
    tokenCalls++;
    assert.equal(options.body.get('code_verifier'), codeVerifier);
    assert.equal(options.body.get('redirect_uri'), env.APP_ORIGIN + '/auth/callback');
    const token = await new SignJWT({ sub: 'owner-sub', email: 'owner@gmail.com', email_verified: true, nonce, name: 'Owner', ...issuedClaims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience('test-client').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return Response.json({ id_token: token });
  }
  throw new Error('Unexpected fetch');
};
const request = (path, options = {}) => new Request(env.APP_ORIGIN + path, options);
function responseCookie(response, name) {
  return response.headers.getSetCookie().find(v => v.startsWith(name + '='))?.split(';')[0];
}
async function start(claims = {}) {
  issuedClaims = claims;
  const response = await handleGoogleAuth(request('/auth/google?return_to=%2F%3Fview%3Dplan'), env);
  const target = new URL(response.headers.get('location'));
  const state = target.searchParams.get('state');
  nonce = target.searchParams.get('nonce');
  codeVerifier = sqlite.prepare('SELECT verifier FROM auth_flows WHERE state_hash = ?').get(await hashToken(state)).verifier;
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('scope'), 'openid email profile');
  const flowCookie = responseCookie(response, '__Host-rmv-oauth');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  return { state, flowCookie };
}
const callback = ({ state, flowCookie }) => handleGoogleAuth(request('/auth/callback?code=test&state=' + state, { headers: { cookie: flowCookie } }), env);

test('Google login claims only the configured legacy owner and revocable sessions authorize requests', async () => {
  const flow = await start();
  const response = await callback(flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?view=plan');
  const sessionCookie = responseCookie(response, '__Host-rmv-session');
  assert.ok(sessionCookie);
  const authenticated = await authenticateRequest(request('/api/finance', { headers: { cookie: sessionCookie, 'x-remaivo-user-id': 'attacker', 'oai-authenticated-user-id': 'attacker' } }), env);
  assert.equal(authenticated.headers.get('x-remaivo-user-id'), 'legacy-owner');
  assert.equal(authenticated.headers.get('oai-authenticated-user-id'), null);
  const used = await callback(flow);
  assert.equal(used.status, 400);
  const before = tokenCalls;
  const forged = await callback({ ...flow, state: randomToken() });
  assert.equal(forged.status, 400); assert.equal(tokenCalls, before);
  const blocked = await handleGoogleAuth(request('/auth/signout', { method: 'POST', headers: { origin: 'https://evil.example', cookie: sessionCookie } }), env);
  assert.equal(blocked.status, 403);
  const logout = await handleGoogleAuth(request('/auth/signout', { method: 'POST', headers: { origin: env.APP_ORIGIN, cookie: sessionCookie } }), env);
  assert.equal(logout.status, 303);
  assert.equal((await authenticateRequest(request('/', { headers: { cookie: sessionCookie } }), env)).headers.get('x-remaivo-user-id'), null);
});
test('Friends receive independent IDs and cannot claim the owner through unverified email', async () => {
  const friend = await callback(await start({ sub: 'friend-sub', email: 'friend@gmail.com', name: 'Friend' }));
  assert.equal(friend.status, 303);
  const identity = sqlite.prepare('SELECT * FROM auth_identities WHERE google_sub = ?').get('friend-sub');
  assert.notEqual(identity.user_id, 'legacy-owner');
  const authenticated = await authenticateRequest(request('/', { headers: { cookie: responseCookie(friend, '__Host-rmv-session') } }), env);
  assert.equal(authenticated.headers.get('x-remaivo-user-id'), identity.user_id);
  const unverified = await callback(await start({ sub: 'fake-owner', email: 'owner@gmail.com', email_verified: false }));
  assert.equal(unverified.status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM auth_identities').get().count, 2);
  const nonceMismatch = await callback(await start({ nonce: 'wrong' }));
  assert.equal(nonceMismatch.status, 400);
});
test('Expired flows and sessions fail closed, supplied identity headers and unsafe returns are rejected', async () => {
  const flow = await start();
  sqlite.prepare('UPDATE auth_flows SET expires_at = 0 WHERE state_hash = ?').run(await hashToken(flow.state));
  assert.equal((await callback(flow)).status, 400);
  const token = randomToken();
  sqlite.prepare('INSERT INTO auth_sessions VALUES (?, ?, 0)').run(await hashToken(token), 'legacy-owner');
  const supplied = request('/', { headers: { cookie: '__Host-rmv-session=' + token, 'x-remaivo-user-id': 'legacy-owner', 'oai-authenticated-user-email': 'owner@gmail.com' } });
  assert.equal((await authenticateRequest(supplied, env)).headers.get('x-remaivo-user-id'), null);
  assert.equal(stripIdentityHeaders(supplied).get('oai-authenticated-user-email'), null);
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/auth/google', null]) assert.equal(safeReturnPath(value), '/');
  assert.equal(safeReturnPath('/?view=accounts'), '/?view=accounts');
  globalThis.fetch = originalFetch;
});
