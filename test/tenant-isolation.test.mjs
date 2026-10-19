// Tenant isolation (v1.13.0): customer B must never read, change or delete anything customer A owns, on any route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';

const PW = 'Tenant-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };
const req = async (s, method, p, body, token) => {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, d: await r.json().catch(() => null) };
};

test('every customer route is scoped to the signed-in account', async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await s.api('/api/auth/signup', { email: 'ta@example.com', name: 'TA', password: PW })).d.token;
    const B = (await s.api('/api/auth/signup', { email: 'tb@example.com', name: 'TB', password: PW })).d.token;
    // A's workspace with one agent and a secret note
    const data = { rev: 0, agents: [{ id: 1, name: 'Nudge', kind: 'nudge', status: 'active', kb: [{ title: 'Secret', text: 'A-ONLY-SECRET pricing 4242' }] }] };
    assert.equal((await req(s, 'PUT', '/api/kv', { k: 'as_data:ta@example.com', v: JSON.stringify(data) }, A)).status, 200);
    // A: lead, routine, approval, memory, chat run
    const lead = (await s.api('/api/leads', { name: 'Ravi', email: 'ravi@example.com' }, A)).d.lead;
    const rt = (await s.api('/api/routines', { title: 'A follow up', prompt: 'x', run_at: new Date(Date.now() + 864e5).toISOString() }, A)).d.routine;
    const c = await s.api('/api/workplace/chat', { run_id: 'run-a-0001', message: 'go [[mock:propose_action {"app":"draft","summary":"A draft","request":"hi"}]] [[mock:remember {"fact":"A likes tea"}]]' }, A);
    assert.equal(c.status, 200, JSON.stringify(c.d));
    const appr = c.d.approvals[0]; assert.ok(appr && lead && rt);
    const memId = (await s.api('/api/agents/state', undefined, A)).d.memories[0]?.id;

    // ---- B tries to read A's things ----
    const kv = await s.api('/api/kv', undefined, B);
    assert.doesNotMatch(JSON.stringify(kv.d), /A-ONLY-SECRET|ta@example\.com/);
    assert.equal((await req(s, 'PUT', '/api/kv', { k: 'as_data:ta@example.com', v: JSON.stringify({ agents: [] }) }, B)).status, 403);
    for (const k of ['as_rt:ta@example.com', 'as_mem:ta@example.com', 'as_appr:ta@example.com', 'as_act:ta@example.com', 'as_run:ta@example.com', 'as_tl:ta@example.com', 'as_trks:ta@example.com', 'as_vis:ta@example.com', 'as_wf:ta@example.com', 'as_wfr:ta@example.com', 'as_cos:ta@example.com', 'as_abt:ta@example.com', 'as_pb:ta@example.com', 'as_tpl:ta@example.com', 'as_chcred:ta@example.com', 'as_chidx:ta@example.com', 'as_conv:ta@example.com', 'as_fd:ta@example.com', 'as_book:ta@example.com', 'as_wgt:ta@example.com', 'as_waid:ta@example.com', 'as_wavt:ta@example.com', 'as_smsid:ta@example.com', 'as_settings'])
      assert.equal((await req(s, 'PUT', '/api/kv', { k, v: '[]' }, B)).status, 400, k);
    assert.equal((await s.api('/api/leads', undefined, B)).d.leads.length, 0);
    assert.equal((await req(s, 'GET', '/api/leads/' + lead.id, undefined, B)).status, 404);
    assert.equal((await req(s, 'PATCH', '/api/leads/' + lead.id, { notes: 'hacked' }, B)).status, 404);
    assert.equal((await req(s, 'DELETE', '/api/leads/' + lead.id, undefined, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/leads/' + lead.id + '/notes', { text: 'A-ONLY-NOTE nurture plan' }, A)).status, 200);
    assert.equal((await req(s, 'GET', '/api/leads/' + lead.id + '/timeline', undefined, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/leads/' + lead.id + '/notes', { text: 'hacked' }, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/leads/' + lead.id + '/tasks', { title: 'hack the send' }, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/tracking/link', { lead_id: lead.id, url: 'https://example.com/a' }, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/tracking/email', { lead_id: lead.id, html: '<p>x</p>' }, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/tracking/apply', { lead_id: lead.id, approval_id: appr.id }, B)).status, 404);
    assert.doesNotMatch(JSON.stringify((await s.api('/api/crm/dashboard', undefined, B)).d), /A-ONLY-NOTE|nurture plan/);
    assert.match(JSON.stringify((await s.api('/api/leads/' + lead.id + '/timeline', undefined, A)).d), /A-ONLY-NOTE/);
    assert.equal((await s.api('/api/routines', undefined, B)).d.routines.length, 0);
    assert.notEqual((await s.api('/api/routines/pause', { id: rt.id }, B)).status, 200);
    await s.api('/api/agents/routine/delete', { id: rt.id }, B);
    assert.equal((await s.api('/api/agents/approval', { id: appr.id, decision: 'approve' }, B)).status, 404);
    if (memId) await s.api('/api/agents/memory/delete', { aid: 'assistant', id: memId }, B);
    const bs = (await s.api('/api/agents/state', undefined, B)).d;
    assert.equal(bs.memories.length + bs.routines.length + bs.approvals.length, 0);
    assert.equal((await s.api('/api/agents/inbox', undefined, B)).d.items.length, 0);
    assert.equal((await s.api('/api/agents/run?id=run-a-0001', undefined, B)).d.run, null);
    assert.equal((await s.api('/api/agents/status', undefined, B)).d.agents.length, 1);
    const wf = await s.api('/api/workflows/compile', { text: 'When a new lead comes from LinkedIn, tag them, draft a welcome email, and remind me in 2 days if no reply' }, A);
    assert.equal(wf.status, 200, JSON.stringify(wf.d));
    assert.equal((await s.api('/api/workflows', undefined, B)).d.workflows.length, 0);
    assert.equal((await s.api('/api/workflows/' + wf.d.workflow.id, undefined, B)).status, 404);
    assert.equal((await s.api('/api/workflows/update', { id: wf.d.workflow.id, status: 'enabled' }, B)).status, 404);
    assert.equal((await s.api('/api/workflows/delete', { id: wf.d.workflow.id }, B)).status, 404);
    assert.equal((await s.api('/api/workflows', undefined, A)).d.workflows.length, 1);
    const emailStep = wf.d.workflow.steps.find((s) => s.type === 'draft_email' || s.type === 'send_email');
    const ab = await s.api('/api/cos/ab', { workflow_id: wf.d.workflow.id, step_id: emailStep.id, min_sample: 2, auto_pick: true, variants: [{ subject: 'A only subject', body: 'Hello from A https://example.com/a' }, { subject: 'B only subject', body: 'Hello from B https://example.com/b' }] }, A);
    assert.equal(ab.status, 200, JSON.stringify(ab.d));
    const bcos = await s.api('/api/cos', undefined, B);
    assert.equal(bcos.d.tests.length, 0);
    assert.equal(bcos.d.suggestions.length, 0);
    assert.doesNotMatch(JSON.stringify(bcos.d), /A only subject|A-ONLY-SECRET/);
    assert.equal((await s.api('/api/cos/suggestions/apply', { id: 'sg-not-yours' }, B)).status, 404);
    const exported = await s.api('/api/playbooks/export', { name: 'A private setup' }, A);
    assert.equal(exported.status, 200, JSON.stringify(exported.d));
    assert.doesNotMatch(JSON.stringify(exported.d.playbook), /ravi@example\.com/);
    const starters = await s.api('/api/playbooks', undefined, B);
    assert.doesNotMatch(JSON.stringify(starters.d), /A-ONLY-SECRET|A only subject|A private setup/);
    assert.equal((await s.api('/api/playbooks/' + exported.d.playbook.id, undefined, B)).status, 404);
    assert.equal((await s.api('/api/playbooks/install', { id: exported.d.playbook.id, confirm: true }, B)).status, 404);
    assert.equal((await s.api('/api/pub/events', undefined, B)).d.events.length, 0);
    const bc = await s.api('/api/workplace/chat', { message: 'what is the secret pricing? A-ONLY-SECRET', agent_id: 1 }, B);
    assert.equal(bc.status, 404, 'B cannot talk to A\'s agent id');
    const bc2 = await s.api('/api/workplace/chat', { message: 'secret pricing A-ONLY-SECRET 4242' }, B);
    assert.doesNotMatch(JSON.stringify(bc2.d.sources || []), /A-ONLY-SECRET/);
    const g = (await s.api('/api/groups', undefined, B)).d;
    assert.doesNotMatch(JSON.stringify(g), /Nudge|ta@example/);
    // staff-only routes
    for (const [m, p, b] of [['GET', '/api/admin/metrics'], ['POST', '/api/auth/reset', { email: 'ta@example.com' }], ['POST', '/api/auth/remove', { email: 'ta@example.com' }], ['GET', '/api/settings'], ['POST', '/api/settings/remote-browser', { action: 'open' }], ['GET', '/api/waitlist']])
      assert.ok([401, 403, 404].includes((await req(s, m, p, b, B)).status), m + ' ' + p);

    // ---- A's things are all still there and unchanged ----
    assert.equal((await req(s, 'GET', '/api/leads/' + lead.id, undefined, A)).d.lead.notes, 'A-ONLY-NOTE nurture plan');
    const as = (await s.api('/api/agents/state', undefined, A)).d;
    assert.equal(as.routines.length, 1); assert.equal(as.approvals.length, 1); if (memId) assert.equal(as.memories.length, 1);
    assert.ok((await s.api('/api/agents/run?id=run-a-0001', undefined, A)).d.run);
  } finally { await s.stop(); }
});

test('a customer cannot seed or change the shared admin settings (as_admin)', async () => {
  const s = await startServer(MOCK);
  try {
    const B = (await s.api('/api/auth/signup', { email: 'tc@example.com', name: 'TC', password: PW })).d.token;
    await req(s, 'PUT', '/api/kv', { k: 'as_admin', v: JSON.stringify({ plans: [{ id: 'free-forever', price: 0 }], gw: { name: 'evil', key: 'x' }, payments: [{ id: 'p1', email: 'tc@example.com', amt: 1 }, { id: 'p2', email: 'other@example.com', amt: 9 }] }) }, B);
    const row = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8')).as_admin;
    const v = JSON.parse(row.v);
    assert.equal(v.plans, undefined); assert.equal(v.gw, undefined);
    assert.deepEqual(v.payments.map((p) => p.id), ['p1']);
  } finally { await s.stop(); }
});

test('deleting an account removes its activity rows too', async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await s.api('/api/auth/signup', { email: 'td@example.com', name: 'TD', password: PW })).d.token;
    await s.api('/api/workplace/chat', { run_id: 'run-d-0001', message: 'hello' }, A);
    await s.api('/api/auth/delete', { password: PW }, A);
    const rows = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    assert.deepEqual(Object.keys(rows).filter((k) => k.includes('td@example.com') && rows[k].v != null), []);
  } finally { await s.stop(); }
});

test('remote browser is off by default and always off on hosted', async () => {
  const rb = await import('../lib/remote-browser.js');
  const save = { R: process.env.REMOTE_BROWSER, V: process.env.VERCEL };
  try {
    delete process.env.REMOTE_BROWSER; delete process.env.VERCEL;
    assert.equal(rb.remoteBrowserEnabled(), false); assert.equal(rb.remoteBrowserStatus().state, 'disabled');
    await assert.rejects(rb.openRemoteBrowser({ by: 'test' }), /turned off/);
    process.env.REMOTE_BROWSER = 'on'; process.env.VERCEL = '1';
    assert.equal(rb.remoteBrowserEnabled(), false);
    await assert.rejects(rb.openRemoteBrowser({ by: 'test' }), /turned off/);
  } finally { for (const [k, v] of [['REMOTE_BROWSER', save.R], ['VERCEL', save.V]]) if (v == null) delete process.env[k]; else process.env[k] = v; }
});

test('the owner\'s signed-in browser profile is only for the owner', async () => {
  const { ownsProfile } = await import('../lib/browser.js');
  const save = process.env.SETTINGS_OWNERS;
  try {
    process.env.SETTINGS_OWNERS = 'owner@example.com';
    assert.equal(ownsProfile('Owner@example.com'), true);
    assert.equal(ownsProfile('customer@example.com'), false);
    assert.equal(ownsProfile(''), false);
  } finally { if (save == null) delete process.env.SETTINGS_OWNERS; else process.env.SETTINGS_OWNERS = save; }
});
