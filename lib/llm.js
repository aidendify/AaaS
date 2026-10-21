// One tool-calling loop for both AI providers.
//   Anthropic  (ANTHROPIC_API_KEY)  — Messages API with tool_use / tool_result blocks
//   OpenRouter (OPENROUTER_API_KEY) — OpenAI-compatible chat completions with tool_calls
// AI_PROVIDER=openrouter tries OpenRouter first; the other provider is the fallback if the first call fails.
import { AsyncLocalStorage } from 'node:async_hooks';
import { obsAi, obs } from './obs.js';
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
// Per-request AI context (lib/aikeys.js builds it): a customer's own key (BYOK) and the shared-key budget hooks.
//   { byok: { provider, key } | null, check: async () => {} (throws when over a limit), record: (usage) => {} }
// With BYOK only that provider is used (never the platform key as a silent fallback).
const ALS = new AsyncLocalStorage();
let defaultCtx = null;
export const aiScope = (ctx, fn) => ALS.run(ctx, fn);
export const aiCtx = () => ALS.getStore() || defaultCtx;
export function setDefaultAiContext(ctx) { defaultCtx = ctx; }
const byokFor = (p) => { const b = aiCtx()?.byok; return b && b.provider === p ? b.key : ''; };
const keyOf = (p, name) => (aiCtx()?.byok ? byokFor(p) : env(name));
// Providers. Every value is read at call time, so Settings changes apply live.
// OpenAI-compatible: OpenRouter, OpenAI, xAI Grok, Google Gemini (OpenAI-compatible endpoint), Ollama / any local server.
const OAI = {
  openrouter: () => ({ key: keyOf('openrouter', 'OPENROUTER_API_KEY'), base: env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1', model: env('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4.5'), name: 'OpenRouter', extra: { 'HTTP-Referer': env('APP_URL') || 'https://github.com/aidendify/AaaS', 'X-Title': 'AaaS' } }),
  openai: () => ({ key: keyOf('openai', 'OPENAI_API_KEY'), base: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1', model: env('OPENAI_MODEL', 'gpt-4o-mini'), name: 'OpenAI', extra: {} }),
  xai: () => ({ key: keyOf('xai', 'XAI_API_KEY'), base: env('XAI_BASE_URL') || 'https://api.x.ai/v1', model: env('XAI_MODEL', 'grok-4.5'), name: 'xAI Grok', extra: {} }),
  google: () => ({ key: keyOf('google', 'GOOGLE_AI_API_KEY'), base: env('GOOGLE_AI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai', model: env('GOOGLE_AI_MODEL', 'gemini-2.5-flash'), name: 'Google Gemini', extra: {} }),
  ollama: () => ({ key: env('OLLAMA_API_KEY') || 'ollama', base: (env('OLLAMA_BASE_URL') || '').replace(/\/+$/, ''), model: env('OLLAMA_MODEL', 'llama3.1'), name: 'Ollama/local', extra: {} }),
};
export const PROVIDERS = ['anthropic', 'openrouter', 'openai', 'xai', 'google', 'ollama'];
const KEY = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', google: 'GOOGLE_AI_API_KEY', ollama: 'OLLAMA_BASE_URL' };
// ---- mock provider (tests and staging only) ----
// Needs BOTH AI_PROVIDER=mock and AI_MOCK=on, so a stray AI_PROVIDER value can never switch a real server to canned answers.
// While on, it is the only provider (never falls back to a real, paid one). See mockTurn below.
export const mockOn = () => env('AI_PROVIDER').toLowerCase() === 'mock' && env('AI_MOCK').toLowerCase() === 'on';
export const providerOn = (p) => { if (p === 'mock') return mockOn(); const b = aiCtx()?.byok; return b ? b.provider === p && !!b.key : !!env(KEY[p]); };
export const llmReady = () => mockOn() || PROVIDERS.some(providerOn);
export function providerOrder() {
  if (mockOn()) return ['mock']; // AI_PROVIDER goes first; the others (with a key) are fallbacks
  const pick = env('AI_PROVIDER').toLowerCase().replace('grok', 'xai');
  return (PROVIDERS.includes(pick) ? [pick, ...PROVIDERS.filter((p) => p !== pick)] : PROVIDERS).filter(providerOn);
}
export function providerConfig(p) { return p === 'anthropic' ? { key: keyOf('anthropic', 'ANTHROPIC_API_KEY'), base: env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com', model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5'), name: 'Anthropic' } : OAI[p](); }

class LlmError extends Error { constructor(m, status, code) { super(m); this.status = status; if (code) this.code = code; } }
// Time limits. Serverless hosts stop a request at maxDuration (60 s on Vercel Hobby), so there one AI call gets at most
// 45 s and the whole request's AI work must finish 50 s after the request started (LLM_DEADLINE_MS); past that the
// call fails cleanly with 504 ai_timeout instead of the host killing the request. Local servers keep 180 s per call.
const HOSTED = !!process.env.VERCEL;
const turnCap = () => Math.max(5000, Number(env('LLM_TIMEOUT_MS', HOSTED ? '45000' : '180000')) || 180000);
const deadline = () => { const d = Number(env('LLM_DEADLINE_MS', HOSTED ? '50000' : '0')) || 0; return d > 0 ? (obs()?.t0 || Date.now()) + d : Infinity; };
const turnMs = () => { const left = deadline() - Date.now(); if (left < 3000) throw new LlmError('The AI ran out of time for this request.', 504, 'ai_timeout'); return Math.min(turnCap(), left); };
const asTimeout = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? new LlmError('The AI took too long to answer.', 504, 'ai_timeout') : e);
const maxTok = () => Math.min(32000, Math.max(256, Number(env('LLM_MAX_TOKENS', '2000')) || 2000));
const temp = () => { const t = env('LLM_TEMPERATURE'); return t === '' || !Number.isFinite(Number(t)) ? {} : { temperature: Number(t) }; };

// ---- usage, cost and the spending cap (hooks set by lib/usage.js) ----
let usageSink = null, spendGuard = null;
export function setUsageHooks({ sink, guard }) { usageSink = sink; spendGuard = guard; }
const note = (u) => {
  try { obsAi(u); } catch { /* logging never breaks a call */ }
  const c = aiCtx();
  if (c?.byok) u = { ...u, byok: true };
  if (usageSink && !u.byok) { try { usageSink(u); } catch { /* never break a call */ } } // the server's own spend only
  if (c?.record) { try { c.record(u); } catch { /* never break a call */ } }
};
const checkCtx = async () => { const c = aiCtx(); if (c?.check) await c.check(); };

async function anthropicTurn(system, msgs, tools, model, meta = {}) {
  const m = (model && /^claude/.test(model) ? model : '') || env('ANTHROPIC_MODEL', 'claude-sonnet-4-5');
  const r = await fetch((env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(turnMs()),
    headers: { 'content-type': 'application/json', 'x-api-key': keyOf('anthropic', 'ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m, max_tokens: meta.max || maxTok(), ...temp(), ...(system ? { system } : {}), messages: msgs,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}) }),
  });
  if (!r.ok) throw new LlmError('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200), r.status);
  const d = await r.json(), content = d.content || [];
  note({ provider: 'anthropic', model: d.model || m, in: d.usage?.input_tokens || 0, out: d.usage?.output_tokens || 0, cost: null, agent: meta.agent });
  return { content, text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })) };
}
async function openrouterTurn(system, msgs, tools, prov = 'openrouter', model = '', meta = {}) {
  const P = OAI[prov]();
  if (model && (prov === 'openrouter' ? model.includes('/') : (prov === 'ollama' || !model.includes('/')))) P.model = model; // per-agent model (OpenRouter ids look like vendor/model)
  if (!P.base) throw new LlmError(P.name + ': no base URL set', 400);
  const r = await fetch(P.base + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(turnMs()),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + P.key, ...P.extra },
    body: JSON.stringify({ model: P.model, max_tokens: meta.max || maxTok(), ...temp(), messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs],
      ...(prov === 'openrouter' ? { usage: { include: true } } : {}),
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}) }),
  });
  if (!r.ok) throw new LlmError(P.name + ' ' + r.status + ': ' + (await r.text()).slice(0, 200), r.status);
  const d = await r.json(), m = d.choices?.[0]?.message;
  note({ provider: prov, model: d.model || P.model, in: d.usage?.prompt_tokens || 0, out: d.usage?.completion_tokens || 0, cost: typeof d.usage?.cost === 'number' ? d.usage.cost : null, agent: meta.agent });
  if (!m) throw new LlmError(P.name + ' returned no message');
  const calls = (m.tool_calls || []).map((c) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch {} return { id: c.id, name: c.function?.name, input }; });
  return { message: m, text: typeof m.content === 'string' ? m.content : '', calls };
}
// Deterministic canned answers with fake usage. Directives in the latest user message let tests drive tools:
//   [[mock:tool_name {"json":"input"}]]   → the first turn calls that tool (several directives = several calls)
// BYOK keys containing "nocredit" answer 402, keys containing "badkey" answer 401 (to test clean BYOK errors).
export const MOCK_PRICE = { in: 0.1 / 1e6, out: 0.4 / 1e6 };
const fnv = (s) => { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b.text || b.content || '')).join(' ') : '');
export async function mockTurn(system, msgs, tools, meta = {}) {
  const b = aiCtx()?.byok;
  if (b && /nocredit/.test(b.key)) throw new LlmError('Mock 402: insufficient credits', 402);
  if (b && /badkey/.test(b.key)) throw new LlmError('Mock 401: invalid key', 401);
  const delay = Number(env('AI_MOCK_DELAY_MS', '0')) || 0;
  if (delay > 0) { const ms = turnMs(); await new Promise((r) => setTimeout(r, Math.min(delay, ms, 60000))); if (delay > ms) { const e = new Error('mock timeout'); e.name = 'TimeoutError'; throw e; } }
  const last = msgs[msgs.length - 1] || {}, afterTools = last.role === 'tool' || (Array.isArray(last.content) && last.content.some((x) => x && x.type === 'tool_result'));
  const userText = textOf([...msgs].reverse().find((m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((x) => x && x.type === 'tool_result')))?.content);
  if (!afterTools && String(system || '').includes('AIDENTIFY_WORKFLOW_JSON')) {
    const { mockWorkflowJson } = await import('./workflows.js');
    const text = mockWorkflowJson(userText);
    const inTok = Math.ceil((String(system || '').length + userText.length) / 4);
    note({ provider: 'mock', model: 'mock-1', in: inTok, out: Math.ceil(text.length / 4), cost: inTok * MOCK_PRICE.in + Math.ceil(text.length / 4) * MOCK_PRICE.out, agent: meta.agent, mock: true });
    return { message: { role: 'assistant', content: text }, text, calls: [] };
  }
  if (!afterTools && String(system || '').includes('AIDENTIFY_FRONTDESK_JSON')) {
    const { mockFrontDeskJson } = await import('./frontdesk.js');
    const text = mockFrontDeskJson(userText);
    const inTok = Math.ceil((String(system || '').length + userText.length) / 4);
    note({ provider: 'mock', model: 'mock-1', in: inTok, out: Math.ceil(text.length / 4), cost: inTok * MOCK_PRICE.in + Math.ceil(text.length / 4) * MOCK_PRICE.out, agent: meta.agent, mock: true });
    return { message: { role: 'assistant', content: text }, text, calls: [] };
  }
  const calls = [];
  if (!afterTools && tools.length) for (const m of userText.matchAll(/\[\[mock:([a-z_]+)\s*(\{[\s\S]*?\})?\]\]/g)) {
    if (!tools.some((t) => t.name === m[1])) continue;
    let input = {}; try { input = JSON.parse(m[2] || '{}'); } catch { /* bad json → empty input */ }
    calls.push({ id: 'mock_' + fnv(m[0] + calls.length), name: m[1], input });
  }
  const inTok = Math.ceil((String(system || '').length + msgs.reduce((n, m) => n + textOf(m.content).length, 0)) / 4), outTok = calls.length ? 20 : 60;
  const tail = afterTools ? ' Tool results: ' + msgs.filter((m) => m.role === 'tool').map((m) => textOf(m.content).slice(0, 160)).join(' | ') : '';
  const text = calls.length ? '' : `[mock ${fnv(userText)}] Here is a draft for: ${userText.replace(/\[\[mock:[\s\S]*?\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)}.${tail}`;
  note({ provider: 'mock', model: 'mock-1', in: inTok, out: outTok, cost: inTok * MOCK_PRICE.in + outTok * MOCK_PRICE.out, agent: meta.agent, mock: true });
  const tc = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
  return { message: { role: 'assistant', content: text, ...(tc.length ? { tool_calls: tc } : {}) }, text, calls };
}
const turnFor = async (...a) => { try { return await turnFor0(...a); } catch (e) { throw asTimeout(e); } };
const turnFor0 = async (provider, system, msgs, tools, model, meta) => { await checkCtx(); if (provider === 'mock') { if (!mockOn()) throw new LlmError('mock provider is off', 503); return mockTurn(system, msgs, tools, meta); } return provider === 'anthropic' ? anthropicTurn(system, msgs, tools, model, meta) : openrouterTurn(system, msgs, tools, provider, model, meta); };

// Which model a run uses: the agent's own model, else the tier model from Settings (AI_MODEL_CHEAP / AI_MODEL_STRONG),
// else the provider default. "provider:model" pins a provider.
export function resolveModel({ agentModel = '', tier = '' } = {}) {
  if (agentModel) return agentModel;
  const t = tier || env('AGENT_TIER_DEFAULT', 'cheap');
  return (t === 'strong' && env('AI_MODEL_STRONG')) || env('AI_MODEL_CHEAP') || '';
}
const split = (m) => { const x = String(m || '').match(/^(anthropic|openrouter|openai|xai|google|ollama):(.+)$/); return x ? { provider: x[1], model: x[2] } : { provider: '', model: String(m || '') }; };
// Attempt plan: [{provider, model}] = the main model on the first provider (or its pinned provider), then Settings
// fallbacks, then every other provider with its default model (the old behaviour).
export function attemptPlan(model) {
  if (mockOn()) return [{ provider: 'mock', model: 'mock-1' }];
  const avail = providerOrder(), main = split(model), plan = [];
  const add = (p, m) => { if (providerOn(p) && !plan.some((x) => x.provider === p && x.model === m)) plan.push({ provider: p, model: m }); };
  if (main.provider) add(main.provider, main.model); else if (avail[0]) add(avail[0], main.model);
  for (const line of env('AI_FALLBACKS').split(/\n|,/).map((s) => s.trim()).filter(Boolean)) { const f = split(line); if (f.provider) add(f.provider, f.model); }
  for (const p of avail) add(p, main.provider ? '' : main.model);
  return plan;
}

// Some models write tool calls as text (e.g. <｜DSML｜tool_calls>…, <tool_call>…). Strip that so it never reaches a user.
export function stripToolText(t) {
  return String(t || '')
    .replace(/<[｜|]DSML[｜|]tool_calls>[\s\S]*?(<\/[｜|]DSML[｜|]tool_calls>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/<[｜|]tool[▁_]calls[▁_]begin[｜|]>[\s\S]*?(<[｜|]tool[▁_]calls[▁_]end[｜|]>|$)/g, '')
    .trim();
}
const WRAP_UP = 'Step limit reached. Do not call any tools. Using only what you already found above, write your final answer now: the finished deliverable, clearly marking anything unknown or not checked.';

// history: [{role:'user'|'assistant', text}]  →  provider transcript
function seed(provider, history) {
  const h = history.filter((m) => m.text && m.text.trim());
  // both APIs want the conversation to start with the user
  while (h.length && h[0].role !== 'user') h.shift();
  return h.map((m) => ({ role: m.role, content: m.text }));
}

// Runs the model with tools until it answers or hits maxSteps.
// exec(name, input) → string (tool result shown to the model). stop() → true ends the loop after the current step.
// model: optional per-agent model id; providers that can't serve it use their default from .env
export async function runWithTools({ system, history, tools, exec, maxSteps = 6, stop = () => false, model = '', meta = {} }) {
  const plan = attemptPlan(model);
  if (!plan.length) throw new LlmError('no_key', 503);
  if (spendGuard && !aiCtx()?.byok) spendGuard(); // throws when the monthly cap is reached and the action is block
  let lastErr;
  for (const { provider, model: pm } of plan) {
    const model = pm;
    const msgs = seed(provider, history);
    let text = '';
    try {
      for (let step = 0; step < maxSteps; step++) {
        const turn = await turnFor(provider, system, msgs, tools, model, meta);
        const clean = stripToolText(turn.text);
        text = clean || text;
        if (!turn.calls.length && clean) return { text: clean, provider, model };
        if (!turn.calls.length) break; // only tool-call text, nothing usable: wrap up below
        // several tool calls in one turn (e.g. ask two agents) run at the same time
        const results = await Promise.all(turn.calls.map(async (c) => {
          let out;
          try { out = await exec(c.name, c.input || {}); } catch (e) { out = 'Tool error: ' + e.message; }
          return { id: c.id, out: typeof out === 'string' ? out : JSON.stringify(out) };
        }));
        if (provider === 'anthropic') {
          msgs.push({ role: 'assistant', content: turn.content });
          msgs.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.out.slice(0, 12000) })) });
        } else {
          msgs.push({ role: 'assistant', content: turn.message.content || '', tool_calls: turn.message.tool_calls });
          for (const r of results) msgs.push({ role: 'tool', tool_call_id: r.id, content: r.out.slice(0, 12000) });
        }
        if (stop()) return { text: clean || text, provider, stopped: true };
      }
      // Step limit hit (or the model only wrote tool-call text): one last call with no tools, asking for the final answer.
      if (provider === 'anthropic') {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) lastMsg.content.push({ type: 'text', text: WRAP_UP });
        else msgs.push({ role: 'user', content: WRAP_UP });
      } else msgs.push({ role: 'user', content: WRAP_UP });
      const fin = await turnFor(provider, system, msgs, [], model, meta);
      return { text: stripToolText(fin.text) || text || 'I ran out of steps before finishing. Please run this again or narrow it down.', provider, wrapped: true };
    } catch (e) {
      lastErr = e; console.error('LLM', provider, e.message);
      if (e.code === 'ai_timeout') throw e; // out of time: another provider can't finish either
      if (msgs.length > seed(provider, history).length) throw e; // tools already ran: don't replay them on the other provider
    }
  }
  throw lastErr || new LlmError('upstream', 502);
}

// One plain completion (no tools) with the same providers, fallbacks, usage tracking and cap. Used by /api/ai.
export async function complete(prompt, { max = 1500, model = '', meta = {} } = {}) {
  const plan = attemptPlan(model || resolveModel({}));
  if (!plan.length) throw new LlmError('no_key', 503);
  if (spendGuard && !aiCtx()?.byok) spendGuard();
  let last; const failed = [];
  for (const { provider, model: m } of plan) {
    try { const t = await turnFor(provider, '', [{ role: 'user', content: prompt }], [], m, { ...meta, max }); return { text: stripToolText(t.text), provider, model: m, failed }; }
    catch (e) { last = e; failed.push(`${provider}${m ? ':' + m : ''}`); console.error('LLM', provider, e.message); if (e.code === 'ai_timeout') break; }
  }
  throw last || new LlmError('upstream', 502);
}
export { LlmError };
