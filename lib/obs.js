// Lightweight request observability.
//   One JSON line per API request on stdout (Vercel and the local server log capture it):
//   {"t":"req","m":"POST","route":"/api/ai","status":200,"ms":812,"ai":1,"cost":0.00004,"mock":0,"uid":"3f2a…"}
//   uid is a short one-way hash of the account email (no email, IP, prompt or answer is logged).
//   OBS_LOG=off turns the lines off. /api/admin/metrics (admins only) summarises this instance's recent requests.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const ALS = new AsyncLocalStorage();
const RING = []; const MAX = 2000; const started = Date.now();
export const obs = () => ALS.getStore() || null;
export const obsScope = (fn) => ALS.run({ ai: 0, cost: 0, mock: 0, uid: '', t0: Date.now() }, fn);
export const uidOf = (email) => (email ? crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 12) : '');
// called by lib/llm.js for every AI call (shared key, BYOK and mock)
export function obsAi(u) { const o = obs(); if (!o) return; o.ai += 1; if (typeof u.cost === 'number') o.cost += u.cost; if (u.mock) o.mock += 1; }
export function obsUser(email) { const o = obs(); if (o) o.uid = uidOf(email); }
// tokens and ids in paths are replaced so routes group together and no token is logged
export const routeOf = (p) => String(p || '').replace(/^\/p\/([a-z])\/[^/]+/, '/p/$1/:token').replace(/\/api\/browser\/shot\/[a-f0-9]+/, '/api/browser/shot/:id').slice(0, 80);
export function obsDone({ method, pathname, status, ms, store }) {
  const o = store || obs() || { ai: 0, cost: 0, mock: 0, uid: '' };
  const row = { t: 'req', at: Date.now(), m: method, route: routeOf(pathname), status, ms: Math.round(ms), ai: o.ai, cost: Number(o.cost.toFixed(6)), mock: o.mock, uid: o.uid };
  RING.push(row); if (RING.length > MAX) RING.splice(0, RING.length - MAX);
  if ((process.env.OBS_LOG || '').trim().toLowerCase() !== 'off') { const { at, ...line } = row; console.log(JSON.stringify(line)); }
  return row;
}
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
export function obsSummary({ sinceMs = 3600e3 } = {}) {
  const from = Date.now() - sinceMs, rows = RING.filter((r) => r.at >= from), by = {};
  for (const r of rows) { const k = r.m + ' ' + r.route; (by[k] ||= []).push(r); }
  const routes = Object.entries(by).map(([k, rs]) => { const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    return { route: k, n: rs.length, errors: rs.filter((r) => r.status >= 500).length, client4xx: rs.filter((r) => r.status >= 400 && r.status < 500).length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms[ms.length - 1] || 0, ai: rs.reduce((n, r) => n + r.ai, 0), cost: Number(rs.reduce((n, r) => n + r.cost, 0).toFixed(6)) }; })
    .sort((a, b) => b.n - a.n);
  return { scope: 'this server instance only (serverless hosts run several)', instanceUpMin: Math.round((Date.now() - started) / 60000), windowMin: Math.round(sinceMs / 60000), requests: rows.length, errors: rows.filter((r) => r.status >= 500).length, ai: rows.reduce((n, r) => n + r.ai, 0), cost: Number(rows.reduce((n, r) => n + r.cost, 0).toFixed(6)), routes };
}
