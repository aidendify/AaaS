// Clinic bring-your-own AI key. The key is the account key in lib/aikeys.js. A clinic agent call sends that key and not the platform key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { mockLLM } from './mocks.mjs';

const PW = 'Clinic-pass-123!';
const PLATFORM = 'sk-or-v1-platform-' + 'p'.repeat(30);
const MINE = 'sk-or-v1-clinic-' + 'c'.repeat(30) + 'wxyz';
const html = () => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'clinic.html'), 'utf8');

test('clinic settings, the wizard and pricing mention the owner key', () => {
  const src = html();
  assert.match(src, /data-act="ai-key"/);
  assert.match(src, /Test & save/);
  assert.match(src, /data-act="ai-key-del"/);
  assert.match(src, /Use your own AI key/);
  assert.match(src, /This step is required|Required\./);
  assert.match(src, /You pay the provider directly/);
  assert.doesNotMatch(src, /data-act="setup-key-skip"/);
  assert.doesNotMatch(src, /Choose this plan/);
  assert.doesNotMatch(src, /₹8,000|₹15,000|14-day|free trial|all-in/i);
  assert.match(src, /OpenRouter, OpenAI, xAI, Gemini or Anthropic/);
});

test('a clinic agent call uses that business key only', async () => {
  const llm = await mockLLM(() => ({ text: 'DRAFT post from the key under test.' }));
  const s = await startServer({
    AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: PLATFORM, OPENROUTER_BASE_URL: llm.url, OPENROUTER_MODEL: 'mock/clinic-model', RATE_LIMIT: 'off',
  });
  try {
    const signed = await s.api('/api/auth/signup', { email: 'byok-clinic@example.com', name: 'Byok Owner', password: PW });
    assert.equal(signed.status, 200, JSON.stringify(signed.d));
    const token = signed.d.token;
    const role = await s.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.status, 200, JSON.stringify(role.d));
    assert.equal(role.d.aiKey.source, 'none');
    assert.equal(role.d.aiKey.model, 'mock/clinic-model');
    assert.match(role.d.usage.billedTo, /Save your AI key/);
    assert.deepEqual(role.d.aiKey.providers.map((p) => p.name), ['OpenRouter', 'OpenAI', 'xAI Grok', 'Google Gemini', 'Anthropic']);

    const before = llm.calls.length;
    const first = await s.api('/api/clinic/social/draft', { topic: 'Thursday session' }, token);
    assert.equal(first.status, 403, JSON.stringify(first.d));
    assert.equal(first.d.error, 'needs_ai_key');
    assert.equal(llm.calls.slice(before).some((c) => String(c.path).endsWith('/chat/completions')), false);

    const rejected = await s.api('/api/ai/key', { provider: 'openrouter', key: 'sk-or-v1-rejected-' + 'r'.repeat(30) }, token);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.d.error, 'key_rejected');

    const saved = await s.api('/api/ai/key', { provider: 'openrouter', key: MINE }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved.d));
    assert.equal(saved.d.byok.hint, '…wxyz');
    assert.equal(JSON.stringify(saved.d).includes(MINE), false);

    const clinic = await s.api('/api/clinic', undefined, token);
    assert.equal(clinic.d.aiKey.source, 'own');
    assert.equal(clinic.d.aiKey.name, 'OpenRouter');
    assert.equal(clinic.d.aiKey.hint, '…wxyz');
    assert.equal(clinic.d.aiKey.model, 'mock/clinic-model');
    assert.equal(clinic.d.aiKey.billedTo, 'Usage on your OpenRouter key, paid to your provider');
    assert.equal(clinic.d.usage.billedTo, 'Usage on your OpenRouter key, paid to your provider');
    assert.match(clinic.d.usage.note, /Usage on your OpenRouter key, paid to your provider/);
    assert.equal(JSON.stringify(clinic.d).includes(MINE), false);
    assert.deepEqual(clinic.d.plans.map((p) => p.id), ['self', 'hosted']);

    const mark = llm.calls.length;
    const second = await s.api('/api/clinic/social/draft', { topic: 'Own key session' }, token);
    assert.equal(second.status, 200, JSON.stringify(second.d));
    const ownCalls = llm.calls.slice(mark).filter((c) => String(c.path).endsWith('/chat/completions'));
    assert.ok(ownCalls.length >= 1);
    assert.ok(ownCalls.every((c) => c.auth === 'Bearer ' + MINE));
    assert.equal(ownCalls.some((c) => c.auth === 'Bearer ' + PLATFORM), false);

    const other = await s.api('/api/auth/signup', { email: 'other-clinic@example.com', name: 'Other Owner', password: PW });
    await s.api('/api/clinic/role', { role: 'coach' }, other.d.token);
    const otherMark = llm.calls.length;
    const otherPost = await s.api('/api/clinic/social/draft', { topic: 'Other business' }, other.d.token);
    const otherPostCalls = llm.calls.slice(otherMark).filter((c) => String(c.path).endsWith('/chat/completions'));
    assert.equal(otherPost.status, 403);
    assert.equal(otherPostCalls.length, 0);

    const raw = fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8');
    assert.equal(raw.includes(MINE), false);
    assert.equal(s.log().includes(MINE), false);

    const removed = await s.api('/api/ai/key/delete', {}, token);
    assert.equal(removed.status, 200);
    const usage = await s.api('/api/clinic/usage', undefined, token);
    assert.match(usage.d.usage.billedTo, /Save your AI key/);
    assert.equal(usage.d.aiKey.source, 'none');
  } finally {
    await s.stop();
    await llm.close();
  }
});

test('the demo flag lets the sample use the server key and labels it', async () => {
  const llm = await mockLLM(() => ({ text: 'DRAFT from the demo key.' }));
  const s = await startServer({
    AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: PLATFORM, OPENROUTER_BASE_URL: llm.url, OPENROUTER_MODEL: 'mock/clinic-model',
    RATE_LIMIT: 'off', CLINIC_DEMO_PLATFORM_KEY: '1', CLINIC_DEMO: '1',
  });
  try {
    const demo = await s.api('/api/clinic/demo', {});
    assert.equal(demo.status, 200, JSON.stringify(demo.d));
    const role = await s.api('/api/clinic/role', { role: 'coach' }, demo.d.token);
    assert.equal(role.status, 200, JSON.stringify(role.d));
    const home = await s.api('/api/clinic', undefined, demo.d.token);
    assert.equal(home.d.demo, true);
    assert.equal(home.d.aiKey.source, 'demo');
    assert.equal(home.d.aiKey.label, 'Demo key, demo only');
    assert.equal(home.d.usage.billedTo, 'Demo key, demo only');
    const mark = llm.calls.length;
    const post = await s.api('/api/clinic/social/draft', { topic: 'Sample class' }, demo.d.token);
    assert.equal(post.status, 200, JSON.stringify(post.d));
    const calls = llm.calls.slice(mark).filter((c) => String(c.path).endsWith('/chat/completions'));
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.auth === 'Bearer ' + PLATFORM));
  } finally {
    await s.stop();
    await llm.close();
  }
});
