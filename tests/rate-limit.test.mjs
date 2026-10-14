import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { enforceRateLimit, rateLimitGroup } from '../worker/rate-limit.ts';
const config=JSON.parse(fs.readFileSync('wrangler.cloudflare.jsonc','utf8'));
const bindings=Object.fromEntries(config.ratelimits.map(binding=>[binding.name,binding]));
function environment() {
  const counters = new Map();
  return {REMAIVO_PLATFORM:'cloudflare',...Object.fromEntries(Object.values(bindings).map(binding=>[binding.name,{limit:async({key})=>{
    const id=binding.namespace_id+':'+key;
    const count=(counters.get(id)??0)+1;
    counters.set(id,count);
    return {success:count<=binding.simple.limit};
  }}]))};
}
const request=(path,ip='192.0.2.1',extra={})=>new Request('https://remaivo.example'+path,{headers:{...(ip?{'cf-connecting-ip':ip}:{}),...extra}});
test('Repeated login attempts are rejected per visitor without consuming normal-use counters',async()=>{
  const env=environment();
  for(let i=0;i<10;i++) assert.equal(await enforceRateLimit(request('/auth/login?return_to=/'+i),env),null);
  const denied=await enforceRateLimit(request('/auth/login?return_to=/different'),env);
  assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'60');assert.equal(denied.headers.get('cache-control'),'no-store');
  assert.equal(await enforceRateLimit(request('/api/finance'),env),null);
  assert.equal(await enforceRateLimit(request('/auth/login','192.0.2.2'),env),null);
});
test('API reads and writes share a counter; query parameters and spoofed forwarded IPs cannot bypass it',async()=>{
  const env=environment();
  for(let i=0;i<120;i++) assert.equal(await enforceRateLimit(request('/api/finance?view='+i),env),null);
  const denied=await enforceRateLimit(new Request('https://remaivo.example/api/finance',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1','x-forwarded-for':'192.0.2.99'}}),env);
  assert.equal(denied.status,429);assert.match((await denied.json()).error,/wait a minute/);
  assert.equal(await enforceRateLimit(request('/api/finance','192.0.2.2'),env),null);
});
test('Page reloads are capped while static assets and sign-out remain available',async()=>{
  const env=environment();
  for(let i=0;i<60;i++) assert.equal(await enforceRateLimit(request('/?view=accounts&refresh='+i),env),null);
  assert.equal((await enforceRateLimit(request('/?view=plan'),env)).status,429);
  for(const path of ['/_next/static/chunks/app.js','/assets/logo.svg','/auth/signout']) {
    assert.equal(rateLimitGroup(path),null);assert.equal(await enforceRateLimit(request(path),env),null);
  }
});
test('Missing edge identity or unavailable limiters fail closed',async()=>{
  assert.equal((await enforceRateLimit(request('/auth/login',null),environment())).status,503);
  const env=environment();env.LOGIN_RATE_LIMIT.limit=async()=>{throw new Error('unavailable');};
  assert.equal((await enforceRateLimit(request('/auth/login'),env)).status,503);
  const namespaces=config.ratelimits.map(b=>b.namespace_id);
  assert.equal(new Set(namespaces).size,namespaces.length);
});
