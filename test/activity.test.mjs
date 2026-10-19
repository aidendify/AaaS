// Agent activity (lib/activity.js): live run progress + per-agent status, last run, steps, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { startRun, agentStatus, getRun } from '../lib/activity.js';

const mem = () => { const m = new Map(); return { get: async (k) => m.has(k) ? { v: m.get(k) } : null, put: async (k, v) => { m.set(k, v); } }; };

test('startRun records live steps, then a finished run, errors and routines per agent', async () => {
  const st = mem(); let t = 1000; const now = () => t;
  const r = startRun(st, 'a@x.co', { rid: 'abc12345', agent: { id: 7 }, now });
  t += 500; r.step({ k: 'search', t: 'Searched saved data' });
  await new Promise((z) => setTimeout(z, 5));
  assert.equal((await getRun(st, 'a@x.co', 'abc12345', t)).status, 'running');
  assert.equal(await getRun(st, 'a@x.co', '../bad', t), null);
  await r.done('ok', [{ k: 'search', t: 'Searched saved data' }], [{ status: 'pending' }]);
  const fin = await getRun(st, 'a@x.co', 'abc12345', t);
  assert.equal(fin.status, 'waiting'); assert.equal(fin.steps.length, 1);
  const e = startRun(st, 'a@x.co', { agent: null, now }); await e.done('error', null, null, { code: 'ai_timeout' });
  const s = await agentStatus(st, 'a@x.co', { agents: [{ id: 7, name: 'Nudge', kind: 'nudge' }] }, [{ id: 'r1', aid: 7, title: 'Daily', on: true, next: 5 }], t);
  const cos = s.agents.find((a) => a.id === 'assistant'), ag = s.agents.find((a) => a.id === 7);
  assert.equal(cos.status, 'error'); assert.match(cos.lastError.msg, /too long/);
  assert.equal(ag.status, 'waiting'); assert.equal(ag.routines[0].title, 'Daily'); assert.equal(ag.last.steps[0].t, 'Searched saved data');
  assert.equal(await getRun(st, 'a@x.co', 'abc12345', t + 11 * 60e3), null); // expires
});

test('/api/agents/status + /api/agents/run: sign-in required, per customer, chat run shows up', async () => {
  const s = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' });
  try {
    assert.equal((await s.api('/api/agents/status')).status, 401);
    const A = (await s.api('/api/auth/signup', { email: 'act@example.com', name: 'Act', password: 'Act-pass-123!' })).d.token;
    const B = (await s.api('/api/auth/signup', { email: 'act2@example.com', name: 'Act2', password: 'Act-pass-123!' })).d.token;
    const c = await s.api('/api/workplace/chat', { message: 'hello there', run_id: 'run-test-1' }, A);
    assert.equal(c.status, 200, JSON.stringify(c.d));
    const st = (await s.api('/api/agents/status', undefined, A)).d;
    assert.equal(st.agents[0].name, 'Chief of Staff'); assert.ok(st.agents[0].last, 'last run recorded');
    assert.ok((await s.api('/api/agents/run?id=run-test-1', undefined, A)).d.run);
    assert.equal((await s.api('/api/agents/run?id=run-test-1', undefined, B)).d.run, null); // other customer can't see it
    assert.equal((await s.api('/api/agents/status', undefined, B)).d.agents[0].last, null);
  } finally { await s.stop(); }
});
