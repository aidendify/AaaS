// Customer AI keys (BYOK) and the shared platform-key budget.
//
// BYOK: a customer can paste their own OpenRouter (or OpenAI / xAI / Google Gemini / Anthropic) key, at onboarding or later
// from the user menu → AI key. It is checked with the provider once, then stored AES-256-GCM encrypted (key derived from
// SESSION_SECRET, same pattern as connector credentials) under as_aikey:<email>, which never leaves the server. Only the last
// four characters are ever shown back. While a customer has a key, every AI call in their requests uses it and only it.
//
// Shared platform key: customers without their own key use the server's key. When PLATFORM_AI_BUDGET_USD is set, spend on
// it is tracked in as_sys_aipool (real cost from OpenRouter's usage.cost, else a conservative token estimate) and calls are
// refused once the total budget, the daily pool or a customer's daily allowance is used. This is the in-app soft cap; the
// hard cap is the credit limit on the OpenRouter key itself (see docs/HOSTED-AI.md).
import crypto from 'node:crypto';
import { aiScope, setDefaultAiContext, LlmError, mockOn } from './llm.js';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const num = (k, d) => { const v = Number(env(k)); return Number.isFinite(v) && env(k) !== '' ? v : d; };
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const tz = () => env('APP_TIMEZONE', 'Asia/Kolkata');
const dayOf = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const POOL = 'as_sys_aipool';
export const KEY_PREFIX = 'as_aikey:';

export const BYOK_PROVIDERS = {
  openrouter: { name: 'OpenRouter', check: (k) => ({ url: (env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1') + '/key', headers: { authorization: 'Bearer ' + k } }), site: 'https://openrouter.ai/keys' },
  openai: { name: 'OpenAI', check: (k) => ({ url: (env('OPENAI_BASE_URL') || 'https://api.openai.com/v1') + '/models', headers: { authorization: 'Bearer ' + k } }), site: 'https://platform.openai.com/api-keys' },
  xai: { name: 'xAI Grok', check: (k) => ({ url: (env('XAI_BASE_URL') || 'https://api.x.ai/v1') + '/models', headers: { authorization: 'Bearer ' + k } }), site: 'https://console.x.ai' },
  google: { name: 'Google Gemini', check: (k) => ({ url: (env('GOOGLE_AI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai') + '/models', headers: { authorization: 'Bearer ' + k } }), site: 'https://aistudio.google.com/apikey' },
  anthropic: { name: 'Anthropic', check: (k) => ({ url: (env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/models', headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }), site: 'https://console.anthropic.com/settings/keys' },
};

/* ----- encryption (same scheme as lib/connectors.js, its own derived key) ----- */
async function encKey(secret) { return crypto.createHash('sha256').update(String(await secret()) + ':aikeys').digest(); }
async function seal(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
async function open(s, secret) {
  const [iv, tag, ct] = String(s || '').split('.').map((x) => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(secret), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

export async function getByok(st, email, secret) {
  const row = parse((await st.get(KEY_PREFIX + email))?.v, null);
  if (!row || !row.sealed) return null;
  try { const o = await open(row.sealed, secret); return BYOK_PROVIDERS[o.provider] && o.key ? { provider: o.provider, key: o.key, hint: row.hint, at: row.at } : null; }
  catch { console.error('AI key: could not decrypt a stored customer key (SESSION_SECRET changed?)'); return null; }
}

// Asks the provider whether the key works. Returns { ok, status, limit } (limit: OpenRouter credit limit info when present).
async function checkKey(provider, key) {
  if (env('AI_KEY_CHECK') === 'off') return { ok: true };
  if (mockOn() && /mock/.test(key)) return { ok: true }; // test keys on a mock-AI server (AI_PROVIDER=mock + AI_MOCK=on) are never sent to a provider
  const c = BYOK_PROVIDERS[provider].check(key);
  try {
    const r = await fetch(c.url, { headers: c.headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    const lim = provider === 'openrouter' && d && d.data ? { limit: d.data.limit ?? null, remaining: d.data.limit_remaining ?? null } : null;
    return { ok: true, limit: lim };
  } catch { return { ok: false, status: 0 }; }
}

/* ----- shared-key budget ----- */
export const platformBudget = () => num('PLATFORM_AI_BUDGET_USD', 0);
const limits = () => ({
  budget: platformBudget(),
  stopAt: platformBudget() * Math.min(1, Math.max(0.5, num('PLATFORM_AI_STOP_AT', 0.95))), // stop a little early: one call can overshoot
  daily: num('PLATFORM_AI_DAILY_USD', 2),
  userCalls: num('PLATFORM_AI_USER_DAILY_CALLS', 60),
  userUsd: num('PLATFORM_AI_USER_DAILY_USD', 0.5),
});
// cost of one call: OpenRouter's real charge, else a conservative estimate ($3 / $15 per million tokens in / out)
const costOf = (u) => (typeof u.cost === 'number' ? u.cost : ((u.in || 0) * 3 + (u.out || 0) * 15) / 1e6);
const emptyPool = () => ({ total: { cost: 0, n: 0 }, days: {} });
export async function poolState(st) { return parse((await st.get(POOL))?.v, null) || emptyPool(); }

const capErr = (m) => new LlmError(m, 429, 'platform_cap');
const BYOK_HINT = ' Add your own OpenRouter key (user menu → AI key) to keep going on your own credit.';
async function poolCheck(st, email, staff) {
  const L = limits(); if (!L.budget) return;
  const p = await poolState(st), d = p.days[dayOf()] || { cost: 0, n: 0, u: {} };
  if (p.total.cost >= L.stopAt) throw capErr(`The shared demo AI credit ($${L.budget}) is used up.` + BYOK_HINT);
  if (L.daily && d.cost >= L.daily) throw capErr('Today’s shared demo AI credit is used up. It resets at midnight IST.' + BYOK_HINT);
  if (staff || !email) return;
  const me = (d.u || {})[email] || { n: 0, cost: 0 };
  if ((L.userCalls && me.n >= L.userCalls) || (L.userUsd && me.cost >= L.userUsd)) throw capErr('You’ve reached today’s free AI allowance on the shared demo key. It resets at midnight IST.' + BYOK_HINT);
}
function poolRecord(st, email, u) {
  if (!platformBudget() || u.byok) return Promise.resolve();
  const c = costOf(u), day = dayOf();
  return st.update(POOL, (cur) => {
    const p = parse(cur, null) || emptyPool();
    p.total.cost += c; p.total.n += 1;
    const d = (p.days[day] ||= { cost: 0, n: 0, u: {} }); d.cost += c; d.n += 1;
    if (email) { const me = (d.u[email] ||= { n: 0, cost: 0 }); me.n += 1; me.cost += c; }
    for (const k of Object.keys(p.days).sort().slice(0, -14)) delete p.days[k]; // keep two weeks of days
    return JSON.stringify(p);
  }).catch((e) => console.error('AI pool:', e.message));
}

// Runs fn with the right AI context for this signed-in user, and waits for spend records before returning
// (serverless functions can freeze right after the response).
export async function withAiFor({ st, email, staff, secret }, fn) {
  const byok = staff ? null : await getByok(st, email, secret);
  const pending = [];
  const ctx = {
    byok: byok ? { provider: byok.provider, key: byok.key } : null,
    check: byok ? null : () => poolCheck(st, email, staff),
    record: (u) => { if (!byok) pending.push(poolRecord(st, email, u)); },
  };
  try { return await aiScope(ctx, fn); }
  finally { await Promise.allSettled(pending); }
}
// Calls outside a user request (routines, cron) still count against the shared pool.
export function initDefaultAiContext(st) {
  setDefaultAiContext({ byok: null, check: () => poolCheck(st, '', true), record: (u) => { poolRecord(st, '', u); } });
}

/* ----- routes: GET /api/ai/key, POST /api/ai/key, POST /api/ai/key/delete ----- */
export async function aiKeyRoutes({ method, pathname, json, st, who, secret, HttpError }) {
  if (pathname !== '/api/ai/key' && pathname !== '/api/ai/key/delete') return undefined;
  const k = KEY_PREFIX + who.email;
  if (pathname === '/api/ai/key' && method === 'GET') {
    const row = parse((await st.get(k))?.v, null), L = limits();
    let platform = { on: !!(env('OPENROUTER_API_KEY') || env('ANTHROPIC_API_KEY') || env('OPENAI_API_KEY') || env('XAI_API_KEY') || env('GOOGLE_AI_API_KEY')), budget: L.budget || null };
    if (L.budget) {
      const p = await poolState(st), d = p.days[dayOf()] || { u: {} }, me = (d.u || {})[who.email] || { n: 0, cost: 0 };
      platform = { ...platform, exhausted: p.total.cost >= L.stopAt, today: { calls: me.n, callLimit: L.userCalls || null } };
    }
    return { byok: row && row.sealed ? { provider: row.provider, name: (BYOK_PROVIDERS[row.provider] || {}).name || row.provider, hint: row.hint, at: row.at } : null,
      providers: Object.entries(BYOK_PROVIDERS).map(([id, p]) => ({ id, name: p.name, site: p.site })), platform };
  }
  if (method !== 'POST') return undefined;
  if (who.role && who.role !== 'customer') throw new HttpError(403, 'customers_only', 'Staff accounts use the server’s AI keys (Settings).');
  if (pathname === '/api/ai/key/delete') { await st.put(k, null, Date.now()); return { ok: true, byok: null }; }
  const b = json(), provider = String(b.provider || 'openrouter').toLowerCase(), key = String(b.key || '').trim();
  if (!BYOK_PROVIDERS[provider]) throw new HttpError(400, 'bad_provider', 'Choose OpenRouter, OpenAI, xAI, Google Gemini or Anthropic.');
  if (key.length < 20 || key.length > 400 || /\s/.test(key)) throw new HttpError(400, 'bad_key', 'That doesn’t look like an API key. Paste the whole key, with no spaces.');
  const chk = await checkKey(provider, key);
  if (!chk.ok) throw new HttpError(400, 'key_rejected', `${BYOK_PROVIDERS[provider].name} didn’t accept that key${chk.status ? ' (' + chk.status + ')' : ''}. Check it and try again.`);
  const row = { provider, hint: '…' + key.slice(-4), at: Date.now(), sealed: await seal({ provider, key }, secret) };
  await st.put(k, JSON.stringify(row), Date.now());
  return { ok: true, byok: { provider, name: BYOK_PROVIDERS[provider].name, hint: row.hint, at: row.at }, limit: chk.limit || null };
}
