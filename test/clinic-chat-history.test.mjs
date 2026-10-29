// Regression: Chief chat (POST /api/clinic/chat) returned 500 when history held null or non-object entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1' };
test('chief chat tolerates malformed history entries', async () => {
  const s = await startServer(MOCK);
  try {
    const demo = await s.api('/api/clinic/demo', {});
    const token = demo.d.token;
    await s.api('/api/clinic/role', { role: 'dental' }, token);
    for (const history of [[null], [null, 1, 'x', { r: 'u' }, { r: 'u', t: 'hi' }], 'nope']) {
      const r = await s.api('/api/clinic/chat', { message: 'how many patients last 2 months', history }, token);
      assert.equal(r.status, 200, JSON.stringify(r.d));
      assert.match(r.d.answer, /patients in the last 2 months/);
    }
  } finally { await s.stop(); }
});
