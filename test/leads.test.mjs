// Single-lead API (lib/leads.js): POST/GET/PATCH/DELETE /api/leads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { cleanLead } from '../lib/leads.js';

const PW = 'Lead-pass-123!';
async function req(s, method, p, body, token) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, d: await r.json().catch(() => null) };
}

test('cleanLead validates and normalises', () => {
  assert.deepEqual(cleanLead({ name: 'Ravi Kumar Rao', email: 'RAVI@Example.com', source: 'linkedin', score: 'hot', tags: 'a, b' }), { first_name: 'Ravi', last_name: 'Kumar Rao', email: 'ravi@example.com', source: 'LinkedIn', score: 'Hot', tags: ['a', 'b'] });
  assert.throws(() => cleanLead({ email: 'x@example.com' }), /name/);
  assert.throws(() => cleanLead({ name: 'X' }), /email or a phone/);
  assert.throws(() => cleanLead({ name: 'X', email: 'nope' }), /email/);
  assert.throws(() => cleanLead({ name: 'X', phone: 'call me' }), /phone/);
  assert.throws(() => cleanLead({ name: 'X', email: 'x@y.co', status: 'Won' }), /status must be/);
  assert.throws(() => cleanLead('str'), /JSON object/);
});

test('POST/GET/PATCH/DELETE /api/leads: per-customer, deduped, visible in the workspace, follow-up routine, nothing sent', async () => {
  const s = await startServer({ RATE_LIMIT: 'off' });
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'la@example.com', name: 'LA', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'lb@example.com', name: 'LB', password: PW })).d.token;
    assert.equal((await req(s, 'POST', '/api/leads', { name: 'Ravi', email: 'ravi@example.com' })).status, 401);
    assert.equal((await req(s, 'POST', '/api/leads', { email: 'ravi@example.com' }, A)).status, 400);
    const c = await req(s, 'POST', '/api/leads', { name: 'Ravi Kumar', email: 'ravi@example.com', phone: '+91 90000 00000', source: 'Website', notes: 'Wants 3 listings promoted', followUp: { in_days: 3, message: 'Check if Ravi saw the proposal' } }, A);
    assert.equal(c.status, 200); assert.equal(c.d.created, true); assert.equal(c.d.lead.id, 1); assert.equal(c.d.lead.status, 'New'); assert.equal(c.d.lead.name, 'Ravi Kumar');
    assert.ok(c.d.followUp.routine_id); assert.ok(c.d.followUp.next > Date.now() + 2.9 * 864e5);
    const rts = await req(s, 'GET', '/api/routines', undefined, A); assert.equal(rts.d.routines[0].every, 0); assert.match(rts.d.routines[0].prompt, /do not send/i);
    // dedupe on email (case-insensitive) and on phone digits
    const d1 = await req(s, 'POST', '/api/leads', { name: 'R', email: 'RAVI@example.com' }, A); assert.equal(d1.status, 409); assert.equal(d1.d.error, 'duplicate'); assert.equal(d1.d.lead.id, 1);
    const d2 = await req(s, 'POST', '/api/leads', { name: 'R', phone: '+919000000000' }, A); assert.equal(d2.status, 409);
    const up = await req(s, 'POST', '/api/leads', { name: 'Ravi Kumar', email: 'ravi@example.com', score: 'Hot', upsert: true }, A); assert.equal(up.d.created, false); assert.equal(up.d.lead.score, 'Hot'); assert.equal(up.d.lead.notes, 'Wants 3 listings promoted');
    await req(s, 'POST', '/api/leads', { name: 'Asha', email: 'asha@example.com', source: 'Referral' }, A);
    // the lead lives where the web app's CRM keeps it
    const kv = await req(s, 'GET', '/api/kv', undefined, A); const ws = JSON.parse(kv.d.items.find((i) => i.k === 'as_data:la@example.com').v);
    const crm = ws.agents.find((a) => a.kind === 'crm'); assert.equal(crm.db.lead.length, 2); assert.ok(ws.rev >= 3);
    // list + filters, other customer sees nothing
    assert.equal((await req(s, 'GET', '/api/leads', undefined, A)).d.total, 2);
    assert.equal((await req(s, 'GET', '/api/leads?source=referral', undefined, A)).d.leads[0].first_name, 'Asha');
    assert.equal((await req(s, 'GET', '/api/leads?q=ravi&limit=1', undefined, A)).d.leads.length, 1);
    assert.equal((await req(s, 'GET', '/api/leads', undefined, B)).d.total, 0);
    assert.equal((await req(s, 'GET', '/api/leads/1', undefined, B)).status, 404);
    // patch
    const p = await req(s, 'PATCH', '/api/leads/1', { status: 'contacted' }, A); assert.equal(p.d.lead.status, 'Contacted'); assert.match(p.d.lead.hist.at(-1).t, /New → Contacted/);
    assert.equal((await req(s, 'PATCH', '/api/leads/1', { status: 'Won' }, A)).status, 400);
    assert.equal((await req(s, 'PATCH', '/api/leads/1', { email: 'asha@example.com' }, A)).status, 409);
    assert.equal((await req(s, 'PATCH', '/api/leads/99', { notes: 'x' }, A)).status, 404);
    // an open browser tab with the old rev gets a conflict instead of overwriting the API's lead
    const stale = await req(s, 'PUT', '/api/kv', { k: 'as_data:la@example.com', v: JSON.stringify({ ...ws, rev: 1, agents: [] }), at: Date.now() }, A); assert.equal(stale.status, 409);
    // delete
    assert.equal((await req(s, 'DELETE', '/api/leads/2', undefined, A)).d.deleted, 2);
    assert.equal((await req(s, 'GET', '/api/leads/2', undefined, A)).status, 404);
    assert.equal((await req(s, 'GET', '/api/leads', undefined, A)).d.total, 1);
    // writing leads queued no approvals and sent nothing
    const state = await req(s, 'GET', '/api/agents/state?aid=' + crm.id, undefined, A); assert.equal(state.d.approvals.length, 0);
  } finally { await s.stop(); }
});

test('concurrent POST /api/leads never lose a lead', async () => {
  const s = await startServer({ RATE_LIMIT: 'off' });
  try {
    const t = (await req(s, 'POST', '/api/auth/signup', { email: 'lc@example.com', name: 'LC', password: PW })).d.token;
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => req(s, 'POST', '/api/leads', { name: 'Lead ' + i, email: `l${i}@example.com` }, t)));
    assert.ok(rs.every((r) => r.status === 200));
    const ids = new Set(rs.map((r) => r.d.lead.id)); assert.equal(ids.size, 12);
    assert.equal((await req(s, 'GET', '/api/leads?limit=200', undefined, t)).d.total, 12);
  } finally { await s.stop(); }
});
