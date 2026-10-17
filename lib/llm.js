// One tool-calling loop for both AI providers.
//   Anthropic  (ANTHROPIC_API_KEY)  — Messages API with tool_use / tool_result blocks
//   OpenRouter (OPENROUTER_API_KEY) — OpenAI-compatible chat completions with tool_calls
// AI_PROVIDER=openrouter tries OpenRouter first; the other provider is the fallback if the first call fails.
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
// Providers. Every value is read at call time, so Settings changes apply live.
// OpenAI-compatible: OpenRouter, OpenAI, xAI Grok, Google Gemini (OpenAI-compatible endpoint), Ollama / any local server.
const OAI = {
  openrouter: () => ({ key: env('OPENROUTER_API_KEY'), base: env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1', model: env('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4.5'), name: 'OpenRouter', extra: { 'HTTP-Referer': env('APP_URL') || 'https://agentsphere.app', 'X-Title': 'AIdentify' } }),
  openai: () => ({ key: env('OPENAI_API_KEY'), base: env('OPENAI_BASE_URL') || 'https://api.openai.com/v1', model: env('OPENAI_MODEL', 'gpt-4o-mini'), name: 'OpenAI', extra: {} }),
  xai: () => ({ key: env('XAI_API_KEY'), base: env('XAI_BASE_URL') || 'https://api.x.ai/v1', model: env('XAI_MODEL', 'grok-4.5'), name: 'xAI Grok', extra: {} }),
  google: () => ({ key: env('GOOGLE_AI_API_KEY'), base: env('GOOGLE_AI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai', model: env('GOOGLE_AI_MODEL', 'gemini-2.5-flash'), name: 'Google Gemini', extra: {} }),
  ollama: () => ({ key: env('OLLAMA_API_KEY') || 'ollama', base: (env('OLLAMA_BASE_URL') || '').replace(/\/+$/, ''), model: env('OLLAMA_MODEL', 'llama3.1'), name: 'Ollama/local', extra: {} }),
};
export const PROVIDERS = ['anthropic', 'openrouter', 'openai', 'xai', 'google', 'ollama'];
const KEY = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', google: 'GOOGLE_AI_API_KEY', ollama: 'OLLAMA_BASE_URL' };
export const providerOn = (p) => !!env(KEY[p]);
export const llmReady = () => PROVIDERS.some(providerOn);
export function providerOrder() { // AI_PROVIDER goes first; the others (with a key) are fallbacks
  const pick = env('AI_PROVIDER').toLowerCase().replace('grok', 'xai');
  return (PROVIDERS.includes(pick) ? [pick, ...PROVIDERS.filter((p) => p !== pick)] : PROVIDERS).filter(providerOn);
}
export function providerConfig(p) { return p === 'anthropic' ? { key: env('ANTHROPIC_API_KEY'), base: env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com', model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5'), name: 'Anthropic' } : OAI[p](); }

class LlmError extends Error { constructor(m, status) { super(m); this.status = status; } }
const turnMs = () => Math.max(30000, Number(env('LLM_TIMEOUT_MS', '180000')) || 180000);
const maxTok = () => Math.min(32000, Math.max(256, Number(env('LLM_MAX_TOKENS', '2000')) || 2000));
const temp = () => { const t = env('LLM_TEMPERATURE'); return t === '' || !Number.isFinite(Number(t)) ? {} : { temperature: Number(t) }; };

// ---- usage, cost and the spending cap (hooks set by lib/usage.js) ----
let usageSink = null, spendGuard = null;
export function setUsageHooks({ sink, guard }) { usageSink = sink; spendGuard = guard; }
const note = (u) => { if (usageSink) { try { usageSink(u); } catch { /* never break a call */ } } };

async function anthropicTurn(system, msgs, tools, model, meta = {}) {
  const m = (model && /^claude/.test(model) ? model : '') || env('ANTHROPIC_MODEL', 'claude-sonnet-4-5');
  const r = await fetch((env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(turnMs()),
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
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
const turnFor = (provider, system, msgs, tools, model, meta) => (provider === 'anthropic' ? anthropicTurn(system, msgs, tools, model, meta) : openrouterTurn(system, msgs, tools, provider, model, meta));

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
  if (spendGuard) spendGuard(); // throws when the monthly cap is reached and the action is block
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
      if (msgs.length > seed(provider, history).length) throw e; // tools already ran: don't replay them on the other provider
    }
  }
  throw lastErr || new LlmError('upstream', 502);
}

// One plain completion (no tools) with the same providers, fallbacks, usage tracking and cap. Used by /api/ai.
export async function complete(prompt, { max = 1500, model = '', meta = {} } = {}) {
  const plan = attemptPlan(model || resolveModel({}));
  if (!plan.length) throw new LlmError('no_key', 503);
  if (spendGuard) spendGuard();
  let last; const failed = [];
  for (const { provider, model: m } of plan) {
    try { const t = await turnFor(provider, '', [{ role: 'user', content: prompt }], [], m, { ...meta, max }); return { text: stripToolText(t.text), provider, model: m, failed }; }
    catch (e) { last = e; failed.push(`${provider}${m ? ':' + m : ''}`); console.error('LLM', provider, e.message); }
  }
  throw last || new LlmError('upstream', 502);
}
export { LlmError };
