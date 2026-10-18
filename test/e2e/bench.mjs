#!/usr/bin/env node
// Latency benchmark for a running server (best on a mock-AI server): p50/p95 of common requests.
//   node test/e2e/bench.mjs --base <url> [--n 10]
// Signs up throwaway e2e-bench-* accounts and deletes them all at the end.
import crypto from 'node:crypto';
const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const BASE = String(opt('base', '')).replace(/\/+$/, ''), N = Number(opt('n', 10));
if (!BASE) { console.error('--base <url>'); process.exit(2); }
const PW = 'Bench-' + crypto.randomBytes(8).toString('hex') + '-1', TS = Date.now().toString(36);
async function call(method, p, body, token) { const t0 = performance.now(); const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const d = await r.json().catch(() => null); return { status: r.status, d, ms: performance.now() - t0 }; }
const stats = {}; const rec = (k, ms) => (stats[k] ||= []).push(ms);
const signup = async (i) => { const email = `e2e-bench-${TS}-${i}@example.com`; const r = await call('POST', '/api/auth/signup', { email, name: 'Bench', password: PW }); rec('POST /api/auth/signup', r.ms); return { email, token: r.d && r.d.token }; };
await call('GET', '/api/health');
const main = await signup('m');
await call('POST', '/api/ai', { prompt: 'warm up' }, main.token);
for (let i = 0; i < N; i++) { const r = await call('POST', '/api/ai', { prompt: 'Bench draft ' + i }, main.token); if (r.status === 200) rec('POST /api/ai', r.ms); else console.log('ai', r.status, r.d && r.d.error); }
for (let i = 0; i < N; i++) rec('GET /api/kv', (await call('GET', '/api/kv', undefined, main.token)).ms);
for (let i = 0; i < N; i++) rec('GET /api/auth/me', (await call('GET', '/api/auth/me', undefined, main.token)).ms);
const extra = []; for (let i = 0; i < Math.min(N, 6); i++) extra.push(await signup(i));
for (const u of [...extra, main]) { const r = await call('POST', '/api/auth/delete', { password: PW }, u.token); if (r.status === 200) rec('POST /api/auth/delete', r.ms); else console.log('delete', r.status, r.d && r.d.error); }
const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rows = Object.entries(stats).map(([k, v]) => ({ route: k, n: v.length, p50: Math.round(q(v, 0.5)), p95: Math.round(q(v, 0.95)) }));
console.log(JSON.stringify(rows));
