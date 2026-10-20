// Mock AI provider (AI_PROVIDER=mock + AI_MOCK=on) and request observability (lib/obs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockOn, providerOrder, attemptPlan, complete, runWithTools, aiScope, llmReady } from '../lib/llm.js';
import { obsScope, obs, obsDone, obsSummary, routeOf, uidOf } from '../lib/obs.js';

const withEnv = async (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } } };
const CLEAN = { OPENROUTER_API_KEY: null, ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, XAI_API_KEY: null, GOOGLE_AI_API_KEY: null, OLLAMA_BASE_URL: null };

test('mock needs BOTH AI_PROVIDER=mock and AI_MOCK=on', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: null }, async () => {
  assert.equal(mockOn(), false); assert.equal(llmReady(), false);
  process.env.AI_MOCK = 'yes'; assert.equal(mockOn(), false);
  process.env.AI_MOCK = 'on'; process.env.AI_PROVIDER = 'openrouter'; assert.equal(mockOn(), false);
  process.env.AI_PROVIDER = 'MOCK'; assert.equal(mockOn(), true);
}));

test('mock on: it is the only provider, even when a real key is set (never falls back to paid AI)', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: 'on', OPENROUTER_API_KEY: 'sk-or-real-looking-key-000000' }, async () => {
  assert.deepEqual(providerOrder(), ['mock']);
  assert.deepEqual(attemptPlan('openrouter:some/model'), [{ provider: 'mock', model: 'mock-1' }]);
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('network must not be used'); };
  try {
    const a = await complete('Write a reply to Ravi about the quote'), b = await complete('Write a reply to Ravi about the quote');
    assert.equal(a.provider, 'mock'); assert.equal(a.text, b.text); assert.match(a.text, /^\[mock [0-9a-f]{8}\] Here is a draft for: Write a reply/);
  } finally { globalThis.fetch = realFetch; }
}));

test('mock reports fake usage and cost through the normal hooks', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: 'on' }, async () => {
  const seen = [];
  await aiScope({ byok: null, check: async () => {}, record: (u) => seen.push(u) }, () => complete('hello there'));
  assert.equal(seen.length, 1); assert.equal(seen[0].provider, 'mock'); assert.ok(seen[0].in > 0 && seen[0].out > 0); assert.ok(seen[0].cost > 0 && seen[0].cost < 0.001); assert.equal(seen[0].mock, true);
}));

test('mock drives tools from [[mock:tool {...}]] directives, then answers with the tool results', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: 'on' }, async () => {
  const ran = [];
  const out = await runWithTools({ system: 's', history: [{ role: 'user', text: 'Please do it [[mock:remember {"fact":"likes tea"}]] [[mock:nope {}]]' }], tools: [{ name: 'remember', description: 'd', schema: { type: 'object' } }],
    exec: async (n, i) => { ran.push([n, i]); return 'saved ' + i.fact; } });
  assert.deepEqual(ran, [['remember', { fact: 'likes tea' }]]); // unknown tools are ignored
  assert.match(out.text, /Tool results: saved likes tea/);
}));

test('mock BYOK keys: "nocredit" → 402, "badkey" → 401, and nothing is recorded against the shared pool', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: 'on' }, async () => {
  const rec = [];
  const ctx = (key) => ({ byok: { provider: 'openrouter', key }, check: null, record: (u) => rec.push(u) });
  await assert.rejects(aiScope(ctx('sk-mock-nocredit-0000000000'), () => complete('x')), (e) => e.status === 402);
  await assert.rejects(aiScope(ctx('sk-mock-badkey-00000000000'), () => complete('x')), (e) => e.status === 401);
  assert.equal(rec.length, 0);
}));

test('obs: one JSON line per request with route, status, ms, AI calls and cost; tokens and emails never logged', () => withEnv({ ...CLEAN, AI_PROVIDER: 'mock', AI_MOCK: 'on', OBS_LOG: null }, async () => {
  const lines = [], orig = console.log; console.log = (s) => lines.push(s);
  try {
    await obsScope(async () => { obs().uid = uidOf('Someone@Example.com'); await complete('hi'); await complete('again'); obsDone({ method: 'POST', pathname: '/p/f/abcdef0123456789abcdef', status: 200, ms: 12.4 }); });
  } finally { console.log = orig; }
  const row = JSON.parse(lines.at(-1));
  assert.equal(row.route, '/p/f/:token'); assert.equal(row.status, 200); assert.equal(row.ai, 2); assert.equal(row.mock, 2); assert.ok(row.cost > 0); assert.equal(row.ms, 12);
  assert.equal(row.uid, uidOf('someone@example.com')); assert.doesNotMatch(lines.at(-1), /example\.com|abcdef0123/);
  const sum = obsSummary(); assert.ok(sum.requests >= 1); assert.ok(sum.routes.some((r) => r.route === 'POST /p/f/:token'));
  assert.equal(routeOf('/api/ai'), '/api/ai');
  assert.equal(routeOf('/t/o/abcdef0123456789abcdef0123456789.gif'), '/t/o/:token.gif');
  assert.equal(routeOf('/t/c/abcdef0123456789abcdef0123456789'), '/t/c/:token');
  assert.equal(routeOf('/api/leads/12/timeline'), '/api/leads/:id/timeline');
  assert.equal(routeOf('/api/channels/telegram/webhook/' + 'ab'.repeat(16)), '/api/channels/telegram/webhook/:hook');
  assert.equal(routeOf('/api/channels/slack/webhook/' + 'cd'.repeat(16)), '/api/channels/slack/webhook/:hook');
}));
