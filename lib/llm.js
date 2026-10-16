// One tool-calling loop for both AI providers.
//   Anthropic  (ANTHROPIC_API_KEY)  — Messages API with tool_use / tool_result blocks
//   OpenRouter (OPENROUTER_API_KEY) — OpenAI-compatible chat completions with tool_calls
// AI_PROVIDER=openrouter tries OpenRouter first; the other provider is the fallback if the first call fails.
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
// OpenAI-compatible providers: OpenRouter and xAI Grok (XAI_API_KEY, api.x.ai)
const OAI = {
  openrouter: () => ({ key: env('OPENROUTER_API_KEY'), base: env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1', model: env('OPENROUTER_MODEL', 'anthropic/claude-sonnet-4.5'), name: 'OpenRouter', extra: { 'HTTP-Referer': env('APP_URL') || 'https://agentsphere.app', 'X-Title': 'AgentSphere' } }),
  xai: () => ({ key: env('XAI_API_KEY'), base: env('XAI_BASE_URL') || 'https://api.x.ai/v1', model: env('XAI_MODEL', 'grok-4.5'), name: 'xAI Grok', extra: {} }),
};
const KEY = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', xai: 'XAI_API_KEY' };
export const llmReady = () => Object.values(KEY).some((k) => env(k));
export function providerOrder() { // AI_PROVIDER (anthropic | openrouter | xai) goes first; the others are fallbacks
  const all = ['anthropic', 'openrouter', 'xai'], pick = env('AI_PROVIDER').toLowerCase().replace('grok', 'xai');
  return (all.includes(pick) ? [pick, ...all.filter((p) => p !== pick)] : all).filter((p) => env(KEY[p]));
}

class LlmError extends Error { constructor(m, status) { super(m); this.status = status; } }

async function anthropicTurn(system, msgs, tools, model) {
  const r = await fetch((env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: (model && /^claude/.test(model) ? model : '') || env('ANTHROPIC_MODEL', 'claude-sonnet-4-5'), max_tokens: 2000, system, messages: msgs,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) }),
  });
  if (!r.ok) throw new LlmError('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200), r.status);
  const d = await r.json(), content = d.content || [];
  return { content, text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })) };
}
async function openrouterTurn(system, msgs, tools, prov = 'openrouter', model = '') {
  const P = OAI[prov]();
  if (model && (prov === 'openrouter' ? model.includes('/') : !model.includes('/'))) P.model = model; // per-agent model (OpenRouter ids look like vendor/model)
  const r = await fetch(P.base + '/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + P.key, ...P.extra },
    body: JSON.stringify({ model: P.model, max_tokens: 2000, messages: [{ role: 'system', content: system }, ...msgs],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) }),
  });
  if (!r.ok) throw new LlmError(P.name + ' ' + r.status + ': ' + (await r.text()).slice(0, 200), r.status);
  const d = await r.json(), m = d.choices?.[0]?.message;
  if (!m) throw new LlmError(P.name + ' returned no message');
  const calls = (m.tool_calls || []).map((c) => { let input = {}; try { input = JSON.parse(c.function?.arguments || '{}'); } catch {} return { id: c.id, name: c.function?.name, input }; });
  return { message: m, text: typeof m.content === 'string' ? m.content : '', calls };
}

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
export async function runWithTools({ system, history, tools, exec, maxSteps = 6, stop = () => false, model = '' }) {
  const avail = providerOrder();
  if (!avail.length) throw new LlmError('no_key', 503);
  let lastErr;
  for (const provider of avail) {
    const msgs = seed(provider, history);
    let text = '';
    try {
      for (let step = 0; step < maxSteps; step++) {
        const last = step === maxSteps - 1;
        const turn = provider === 'anthropic' ? await anthropicTurn(system, msgs, last ? [] : tools, model) : await openrouterTurn(system, msgs, last ? [] : tools, provider, model);
        text = turn.text || text;
        if (!turn.calls.length) return { text: turn.text, provider };
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
        if (stop()) return { text: turn.text || text, provider, stopped: true };
      }
      return { text, provider };
    } catch (e) {
      lastErr = e; console.error('LLM', provider, e.message);
      if (msgs.length > seed(provider, history).length) throw e; // tools already ran: don't replay them on the other provider
    }
  }
  throw lastErr || new LlmError('upstream', 502);
}
