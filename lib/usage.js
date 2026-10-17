// Token usage and estimated cost per day, provider, model and agent, plus the monthly spending cap.
// Stored per month in "as_usage:YYYY-MM": { days: { 'YYYY-MM-DD': { '<provider>|<model>|<agent>': {n,in,out,cost,unknown} } }, alerts: [50,80] }
// Cost: OpenRouter returns the real charge per call (usage.cost); otherwise we estimate it from OpenRouter's public price
// list (GET https://openrouter.ai/api/v1/models, prices per token). Calls we cannot price count tokens only ("unknown").
import { setUsageHooks, LlmError } from './llm.js';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const tz = () => env('APP_TIMEZONE', 'Asia/Kolkata');
const dayOf = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const monthOf = (t = Date.now()) => dayOf(t).slice(0, 7);

let ST = null, cur = null, dirty = false, notify = null;
let prices = { at: 0, map: {} };
export async function orModels(force = false) {
  if (!force && Date.now() - prices.at < 6 * 3600 * 1000 && prices.list) return prices.list;
  const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('OpenRouter models ' + r.status);
  const d = await r.json();
  const list = (d.data || []).map((m) => ({ id: m.id, name: m.name, context: m.context_length, prompt: Number(m.pricing?.prompt) || 0, completion: Number(m.pricing?.completion) || 0, tools: (m.supported_parameters || []).includes('tools') }));
  prices = { at: Date.now(), list, map: Object.fromEntries(list.map((m) => [m.id, m])) };
  return list;
}
function priceFor(provider, model) {
  const m = String(model || ''), cands = [m, provider + '/' + m, provider + '/' + m.replace(/-(\d)-(\d)/, '-$1.$2'), (provider === 'google' ? 'google/' : '') + m, (provider === 'xai' ? 'x-ai/' : '') + m];
  for (const c of cands) if (prices.map[c]) return prices.map[c];
  // OpenRouter answers with dated ids (e.g. vendor/model-20250101); try the prefix
  const hit = Object.keys(prices.map).find((id) => m.startsWith(id + '-') || id === m.replace(/-\d{8}$/, ''));
  return hit ? prices.map[hit] : null;
}
async function load(month) {
  if (cur && cur.month === month) return cur;
  if (cur && dirty) await flush();
  cur = { month, data: parse((await ST.get('as_usage:' + month))?.v, null) || { days: {}, alerts: [] } };
  return cur;
}
async function flush() { if (!cur || !dirty || !ST) return; dirty = false; await ST.put('as_usage:' + cur.month, JSON.stringify(cur.data), Date.now()); }
export function monthCost(data) { let c = 0; for (const d of Object.values(data.days || {})) for (const r of Object.values(d)) c += r.cost || 0; return c; }

export async function initUsage(st, { onAlert } = {}) {
  ST = st; notify = onAlert || null;
  await load(monthOf());
  orModels().catch(() => {}); // warm the price list
  setInterval(() => { flush().catch((e) => console.error('Usage flush:', e.message)); }, 5000).unref();
  setUsageHooks({
    sink: (u) => { record(u).catch((e) => console.error('Usage:', e.message)); },
    guard: () => {
      const cap = Number(env('SPEND_CAP_MONTH_USD'));
      if (!cap || !cur || cur.month !== monthOf()) return;
      if (env('SPEND_CAP_ACTION', 'block') === 'block' && monthCost(cur.data) >= cap) throw new LlmError(`Monthly spending cap reached ($${cap}, estimated). Raise it in Settings → Usage & spending.`, 402);
    },
  });
}
async function record(u) {
  if (!ST) return;
  if (!prices.list) await orModels().catch(() => {});
  const c = await load(monthOf()), day = dayOf();
  let cost = u.cost, unknown = false;
  if (cost == null) { const p = priceFor(u.provider, u.model); if (p) cost = (u.in || 0) * p.prompt + (u.out || 0) * p.completion; else { cost = 0; unknown = true; } }
  const k = [u.provider, u.model, u.agent || '-'].join('|'), d = (c.data.days[day] ||= {}), r = (d[k] ||= { n: 0, in: 0, out: 0, cost: 0, unknown: 0 });
  r.n++; r.in += u.in || 0; r.out += u.out || 0; r.cost += cost || 0; if (unknown) r.unknown++;
  dirty = true;
  const cap = Number(env('SPEND_CAP_MONTH_USD'));
  if (cap) {
    const pct = (monthCost(c.data) / cap) * 100;
    for (const step of [50, 80, 100]) if (pct >= step && !c.data.alerts.includes(step)) {
      c.data.alerts.push(step);
      if (notify && env('NOTIFY_SPEND', 'on') !== 'off') notify(`:money_with_wings: Estimated AI spend is at ${step}% of your $${cap} monthly cap (about $${monthCost(c.data).toFixed(2)}).${step >= 100 && env('SPEND_CAP_ACTION', 'block') === 'block' ? ' Agents are paused from calling models until you raise the cap.' : ''}`);
    }
  }
}
export async function usageSummary(st, month = monthOf()) {
  await flush();
  const data = parse((await st.get('as_usage:' + month))?.v, null) || { days: {}, alerts: [] };
  const rows = [], today = dayOf();
  for (const [day, d] of Object.entries(data.days)) for (const [k, r] of Object.entries(d)) { const [provider, model, agent] = k.split('|'); rows.push({ day, provider, model, agent, ...r }); }
  const sum = (f) => rows.filter(f).reduce((a, r) => ({ n: a.n + r.n, in: a.in + r.in, out: a.out + r.out, cost: a.cost + r.cost, unknown: a.unknown + r.unknown }), { n: 0, in: 0, out: 0, cost: 0, unknown: 0 });
  const week = dayOf(Date.now() - 6 * 864e5);
  return { month, today: sum((r) => r.day === today), week: sum((r) => r.day >= week), total: sum(() => true), rows, cap: Number(env('SPEND_CAP_MONTH_USD')) || 0, action: env('SPEND_CAP_ACTION', 'block'), alerts: data.alerts };
}
export const _flush = flush;
