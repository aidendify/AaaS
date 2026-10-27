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
  assert.match(src, /Use your own AI key \(optional\)/);
  assert.match(src, /billed to your own key/);
  assert.match(src, /Own-key plans do not include token costs/);
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
    assert.equal(role.d.aiKey.source, 'platform');
    assert.equal(role.d.aiKey.model, 'mock/clinic-model');
    assert.equal(role.d.usage.billedTo, 'platform key');
    assert.deepEqual(role.d.aiKey.providers.map((p) => p.name), ['OpenRouter', 'OpenAI', 'xAI Grok', 'Google Gemini', 'Anthropic']);

    const before = llm.calls.length;
    const first = await s.api('/api/clinic/social/draft', { topic: 'Thursday session' }, token);
    assert.equal(first.status, 200, JSON.stringify(first.d));
    const platformCall = llm.calls.slice(before).find((c) => String(c.path).endsWith('/chat/completions'));
    assert.equal(platformCall.auth, 'Bearer ' + PLATFORM);

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
    assert.equal(clinic.d.aiKey.billedTo, 'billed to your own key');
    assert.equal(clinic.d.usage.billedTo, 'billed to your own key');
    assert.match(clinic.d.usage.note, /billed to your own key/);
    assert.equal(JSON.stringify(clinic.d).includes(MINE), false);
    assert.ok(clinic.d.plans.every((p) => (p.includes || []).includes('Own-key plans do not include token costs')));

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
    assert.equal(otherPost.status, 200, JSON.stringify(otherPost.d));
    const otherCalls = llm.calls.slice(otherMark).filter((c) => String(c.path).endsWith('/chat/completions'));
    assert.ok(otherCalls.every((c) => c.auth === 'Bearer ' + PLATFORM));

    const raw = fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8');
    assert.equal(raw.includes(MINE), false);
    assert.equal(s.log().includes(MINE), false);

    const removed = await s.api('/api/ai/key/delete', {}, token);
    assert.equal(removed.status, 200);
    const usage = await s.api('/api/clinic/usage', undefined, token);
    assert.equal(usage.d.usage.billedTo, 'platform key');
    assert.equal(usage.d.aiKey.source, 'platform');
  } finally {
    await s.stop();
    await llm.close();
  }
});
