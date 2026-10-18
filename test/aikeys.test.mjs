// BYOK (customer's own AI key) and the shared platform-key budget, against a real server and a mock OpenRouter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { mockLLM } from './mocks.mjs';

const PLATFORM = 'sk-or-v1-platform-' + 'p'.repeat(30), MINE = 'sk-or-v1-customer-' + 'c'.repeat(30) + 'wxyz';
let llm, srv, tok;
test.before(async () => {
  llm = await mockLLM(() => ({ text: 'Hello from the model.' }));
  srv = await startServer({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: PLATFORM, OPENROUTER_BASE_URL: llm.url, OPENROUTER_MODEL: 'mock/model',
    PLATFORM_AI_BUDGET_USD: '10', PLATFORM_AI_USER_DAILY_CALLS: '2', RATE_LIMIT: 'off' });
  const s = await srv.api('/api/auth/signup', { email: 'tester@demo.test', name: 'Tester', password: 'Correct-Horse-42!' });
  assert.equal(s.status, 200); tok = s.d.token;
});
test.after(async () => { await srv?.stop(); await llm?.close(); });
const lastChat = () => [...llm.calls].reverse().find((c) => c.path.endsWith('/chat/completions'));

test('Google sign-in is reported as not set up when GOOGLE_CLIENT_ID is missing', async () => {
  const r = await srv.api('/api/auth/providers');
  assert.equal(r.d.google, false);
});

test('new customer chats on the shared key until the daily allowance is used', async () => {
  const k = await srv.api('/api/ai/key', undefined, tok);
  assert.equal(k.d.byok, null); assert.equal(k.d.platform.on, true); assert.equal(k.d.platform.today.calls, 0);
  for (let i = 0; i < 2; i++) { const r = await srv.api('/api/ai', { prompt: 'hi ' + i }, tok); assert.equal(r.status, 200, JSON.stringify(r.d)); }
  assert.equal(lastChat().auth, 'Bearer ' + PLATFORM);
  const over = await srv.api('/api/ai', { prompt: 'third' }, tok);
  assert.equal(over.status, 429); assert.equal(over.d.error, 'platform_cap'); assert.match(over.d.message, /own OpenRouter key/);
});

test('BYOK: bad keys are refused, a good key is stored encrypted and used instead of the shared pool', async () => {
  assert.equal((await srv.api('/api/ai/key', { provider: 'openrouter', key: 'short' }, tok)).status, 400);
  const rej = await srv.api('/api/ai/key', { provider: 'openrouter', key: 'sk-or-v1-rejected-' + 'r'.repeat(30) }, tok);
  assert.equal(rej.status, 400); assert.equal(rej.d.error, 'key_rejected');
  const ok = await srv.api('/api/ai/key', { provider: 'openrouter', key: MINE }, tok);
  assert.equal(ok.status, 200); assert.equal(ok.d.byok.hint, '…wxyz');
  const g = await srv.api('/api/ai/key', undefined, tok);
  assert.equal(g.d.byok.provider, 'openrouter'); assert.ok(!JSON.stringify(g.d).includes(MINE));
  // never readable through the data API, never stored in plain text
  const kv = await srv.api('/api/kv', undefined, tok);
  assert.ok(!kv.d.items.some((it) => String(it.k).startsWith('as_aikey:')));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.readFileSync(path.join(srv.dir, 'data', 'kv.json'), 'utf8').includes(MINE));
  assert.ok(!srv.log().includes(MINE));
  // over the shared allowance, but their own key works and is the one sent
  const r = await srv.api('/api/ai', { prompt: 'with my key' }, tok);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(lastChat().auth, 'Bearer ' + MINE);
});

test('removing the key goes back to the shared key and its limits', async () => {
  assert.equal((await srv.api('/api/ai/key/delete', {}, tok)).status, 200);
  assert.equal((await srv.api('/api/ai/key', undefined, tok)).d.byok, null);
  assert.equal((await srv.api('/api/ai', { prompt: 'again' }, tok)).status, 429);
});
