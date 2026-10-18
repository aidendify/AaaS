// v1.9.0 fixes: own-rows-only /api/kv, full delete cleanup, business profile, draft approvals, one-off routines, AI time limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from './helpers.mjs';

const MOCK = { AI_PROVIDER: 'mock', AI_MOCK: 'on', RATE_LIMIT: 'off', PLATFORM_AI_BUDGET_USD: '2' };
const PW = 'Test-pass-123!';
async function put(s, token, k, v) { const r = await fetch(s.base + '/api/kv', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ k, v: JSON.stringify(v), at: Date.now() }) }); return r.status; }
const kvFile = (s) => JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));

test('signup business profile is stored and every /api/ai prompt starts from it; POST /api/profile updates it', async () => {
  const s = await startServer(MOCK);
  try {
    const su = await s.api('/api/auth/signup', { email: 'p@example.com', name: 'P', password: PW, business: { about: 'Social media for Pune realtors', junk: 'x'.repeat(5000) } });
    assert.equal(su.status, 200); assert.deepEqual(su.d.user.profile, { about: 'Social media for Pune realtors' });
    const a = await s.api('/api/ai', { prompt: 'Write a post' }, su.d.token);
    assert.match(a.d.text, /About my business/);
    const up = await s.api('/api/profile', { name: 'Brightline', voice: 'warm' }, su.d.token);
    assert.deepEqual(up.d.profile, { name: 'Brightline', voice: 'warm' });
    const off = await s.api('/api/ai', { prompt: 'Write a post', use_profile: false }, su.d.token);
    assert.doesNotMatch(off.d.text, /About my business/);
  } finally { await s.stop(); }
});

test('a customer GET /api/kv returns only their own rows; delete removes rows outright and drops the email from the spend log', async () => {
  const s = await startServer(MOCK);
  try {
    const A = await s.api('/api/auth/signup', { email: 'a@example.com', name: 'A', password: PW });
    const B = await s.api('/api/auth/signup', { email: 'b@example.com', name: 'B', password: PW });
    assert.equal(await put(s, A.d.token, 'as_data:a@example.com', { agents: [] }), 200);
    assert.equal(await put(s, B.d.token, 'as_data:b@example.com', { agents: [] }), 200);
    const kv = await s.api('/api/kv', undefined, A.d.token);
    assert.deepEqual(kv.d.items.map((i) => i.k).sort(), ['as_data:a@example.com', 'as_users']);
    assert.equal((await s.api('/api/ai', { prompt: 'hi' }, A.d.token)).status, 200);
    assert.match(JSON.stringify(kvFile(s).as_sys_aipool), /a@example\.com/);
    assert.equal((await s.api('/api/auth/delete', { password: PW }, A.d.token)).status, 200);
    const rows = kvFile(s);
    assert.deepEqual(Object.keys(rows).filter((k) => k.includes('a@example.com')), [], 'no rows (not even empty placeholders) left for the account');
    const pool = JSON.parse(rows.as_sys_aipool.v);
    assert.doesNotMatch(JSON.stringify(pool), /a@example\.com/); assert.ok(pool.total.n >= 1, 'totals kept');
    assert.ok(Object.values(pool.days).some((d) => Object.keys(d.u).some((k) => k.startsWith('gone:'))));
  } finally { await s.stop(); }
});

test('draft approvals: a new account with no apps gets an approval; approving it sends nothing; key-only apps become drafts too', async () => {
  const s = await startServer(MOCK);
  try {
    const su = await s.api('/api/auth/signup', { email: 'd@example.com', name: 'D', password: PW }); const t = su.d.token;
    const c = await s.api('/api/workplace/chat', { message: 'post it [[mock:propose_action {"app":"draft","summary":"X post: audit offer","request":"Free audit this week"}]]' }, t);
    assert.equal(c.status, 200); assert.equal(c.d.approvals.length, 1); assert.equal(c.d.approvals[0].kind, 'draft'); assert.equal(c.d.approvals[0].status, 'pending');
    const ok = await s.api('/api/agents/approval', { id: c.d.approvals[0].id, decision: 'approve' }, t);
    assert.equal(ok.d.approval.status, 'done'); assert.match(ok.d.approval.result, /Nothing was sent/);
    assert.equal((await s.api('/api/connectors/key', { c: 'trello', fields: { api_key: 'k', token: 't' } }, t)).status, 200);
    const c2 = await s.api('/api/workplace/chat', { message: 'card [[mock:propose_action {"app":"trello","summary":"Card","request":"Make a card"}]]' }, t);
    assert.equal(c2.d.approvals[0].kind, 'draft'); assert.equal(c2.d.approvals[0].app, 'trello');
    const ok2 = await s.api('/api/agents/approval', { id: c2.d.approvals[0].id, decision: 'approve' }, t);
    assert.equal(ok2.d.approval.status, 'done'); assert.match(ok2.d.approval.result, /connect trello/);
  } finally { await s.stop(); }
});

test('POST /api/routines accepts a one-off run_at (the staging e2e suite checks that cron runs it)', async () => {
  const secret = crypto.randomBytes(16).toString('hex');
  const s = await startServer({ ...MOCK, CRON_SECRET: secret });
  try {
    const su = await s.api('/api/auth/signup', { email: 'r@example.com', name: 'R', password: PW }); const t = su.d.token;
    const bad = await s.api('/api/routines', { title: 'x', prompt: 'y', run_at: 'tomorrow' }, t); assert.equal(bad.status, 400);
    const r = await s.api('/api/routines', { title: 'Follow up', prompt: 'Draft a day-3 follow-up', run_at: new Date(Date.now() - 1000).toISOString() }, t);
    assert.equal(r.status, 200); assert.equal(r.d.routine.every, 0); assert.ok(r.d.routine.next > Date.now());
    const later = await s.api('/api/routines', { title: 'Day 3', prompt: 'Follow up', run_at: new Date(Date.now() + 3 * 864e5).toISOString(), repeat_every_days: 7 }, t);
    assert.equal(later.d.routine.every, 7);
    const tick = await fetch(s.base + '/api/cron/tick', { method: 'POST', headers: { authorization: 'Bearer ' + secret } });
    assert.equal(tick.status, 200);
  } finally { await s.stop(); }
});

test('AI time limit: a slow model fails cleanly with 504 ai_timeout instead of hanging', async () => {
  const s = await startServer({ ...MOCK, AI_MOCK_DELAY_MS: '8000', LLM_DEADLINE_MS: '1500', LLM_TIMEOUT_MS: '5000' });
  try {
    const su = await s.api('/api/auth/signup', { email: 't@example.com', name: 'T', password: PW });
    const t0 = Date.now(); const a = await s.api('/api/ai', { prompt: 'slow' }, su.d.token);
    assert.equal(a.status, 504); assert.equal(a.d.error, 'ai_timeout'); assert.ok(Date.now() - t0 < 5000);
    const c = await s.api('/api/workplace/chat', { message: 'slow' }, su.d.token);
    assert.equal(c.status, 504); assert.equal(c.d.error, 'ai_timeout');
  } finally { await s.stop(); }
});

test('public lead form answers fast when the AI is slow (built-in reply instead)', async () => {
  const s = await startServer({ ...MOCK, AI_MOCK_DELAY_MS: '6000', PUBLIC_AI_TIMEOUT_MS: '1000' });
  try {
    const su = await s.api('/api/auth/signup', { email: 'f@example.com', name: 'F', password: PW });
    const tok = crypto.randomBytes(16).toString('hex');
    assert.equal(await put(s, su.d.token, 'as_data:f@example.com', { agents: [{ id: 1, kind: 'formfirst', name: 'FF', forms: [{ token: tok, title: 'Quote' }], recs: [] }] }), 200);
    const t0 = Date.now();
    const r = await fetch(s.base + '/p/f/' + tok, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'f0=Ravi&f1=ravi%40example.com&f3=Need+a+quote' });
    assert.equal(r.status, 200); assert.match(await r.text(), /Thanks, Ravi/); assert.ok(Date.now() - t0 < 4000, 'answered in ' + (Date.now() - t0) + ' ms');
  } finally { await s.stop(); }
});
