// Only drafts a model wrote carry ai:true. Template drafts stay unflagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { mockLLM } from './mocks.mjs';

const PW = 'Clinic-pass-123!';

async function owner(s, email) {
  const r = await s.api('/api/auth/signup', { email, name: 'Flag Owner', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const role = await s.api('/api/clinic/role', { role: 'coach' }, r.d.token);
  assert.equal(role.status, 200, JSON.stringify(role.d));
  return r.d.token;
}

test('template social draft has no ai flag without a model', async () => {
  const s = await startServer({ AI_PROVIDER: 'none', RATE_LIMIT: 'off' });
  try {
    const token = await owner(s, 'flag-none@example.com');
    const post = await s.api('/api/clinic/social/draft', { topic: 'Flag topic' }, token);
    assert.equal(post.status, 200, JSON.stringify(post.d));
    assert.equal(post.d.post.ai, undefined);
    const st = await s.api('/api/clinic', undefined, token);
    for (const d of (st.d.drafts || st.d.clinic?.drafts || [])) assert.notEqual(d.ai, true, d.kind);
  } finally { await s.stop(); }
});

test('model-written social draft carries ai:true', async () => {
  const llm = await mockLLM(() => ({ text: 'DRAFT post the model wrote.' }));
  const s = await startServer({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-v1-' + 'f'.repeat(40), OPENROUTER_BASE_URL: llm.url, OPENROUTER_MODEL: 'mock/m', RATE_LIMIT: 'off' });
  try {
    const token = await owner(s, 'flag-ai@example.com');
    const saved = await s.api('/api/ai/key', { provider: 'openrouter', key: 'sk-or-v1-own-' + 'o'.repeat(30) }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved.d));
    const post = await s.api('/api/clinic/social/draft', { topic: 'Flag topic' }, token);
    assert.equal(post.status, 200, JSON.stringify(post.d));
    assert.equal(post.d.post.ai, true);
    const st = await s.api('/api/clinic', undefined, token);
    const drafts = st.d.drafts || st.d.clinic?.drafts || [];
    assert.equal(drafts.find((d) => d.kind === 'post').ai, true);
    assert.ok(drafts.filter((d) => d.kind !== 'post').every((d) => d.ai !== true));
  } finally { await s.stop(); await llm.close?.(); }
});
