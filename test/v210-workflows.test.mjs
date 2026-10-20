// v2.1 plain-English workflows. Mock AI is deterministic. Customer B cannot see customer A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { interpret, normalizeCompiled, decideOutbound, matchTrigger } from '../lib/workflows.js';

const PW = 'Workflow-pass-123!';
// Dummy mailbox so the email tool exists for the open/click check. Nothing is approved, so nothing is sent.
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', GMAIL_USER: 'test-mailbox@example.com', GMAIL_APP_PASSWORD: 'test-app-password' };
const CRON = 'c'.repeat(32);
const EXAMPLE = 'When a new lead comes from LinkedIn, tag them, draft a welcome email, and remind me in 2 days if no reply';

async function req(s, method, p, body, token, extra = {}) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
const tick = (s, now) => req(s, 'GET', '/api/cron/tick', undefined, undefined, { headers: { authorization: 'Bearer ' + CRON, ...(now ? { 'x-test-now': String(now) } : {}) } });

test('a sentence becomes a checked workflow, and send, post or pay starts at needs approval', () => {
  const wf = normalizeCompiled(interpret(EXAMPLE));
  assert.equal(wf.trigger.type, 'lead.created');
  assert.equal(wf.trigger.source, 'LinkedIn');
  assert.deepEqual(wf.steps.map((s) => s.type), ['tag', 'draft_email', 'wait', 'remind']);
  assert.equal(wf.steps[0].autonomy, 'auto');
  assert.equal(wf.steps[0].tag, 'LinkedIn');
  assert.equal(wf.steps[1].autonomy, 'needs_approval');
  assert.equal(wf.steps[2].days, 2);
  assert.equal(wf.steps[2].until, 'no_reply');
  assert.match(wf.plain, /When a new lead comes from LinkedIn/);
  assert.match(wf.plain, /Tag them “LinkedIn”/);
  assert.match(wf.plain, /Approving the draft does not send/);
  assert.match(wf.plain, /Wait 2 days/);
  assert.match(wf.plain, /If they have not, it continues/);
  assert.match(wf.plain, /Remind you/);
  assert.match(wf.plain, /Nothing goes out until you approve/);

  const send = normalizeCompiled(interpret('When a new lead comes in, send the welcome email automatically'));
  assert.equal(send.steps[0].type, 'send_email');
  assert.equal(send.steps[0].autonomy, 'needs_approval');
  assert.equal(send.steps[0].suggested_autonomy, 'auto');
  assert.match(send.plain, /still needs your approval/);

  const post = normalizeCompiled(interpret('When a new lead comes in, post to LinkedIn automatically'));
  assert.equal(post.steps[0].type, 'social_post');
  assert.equal(post.steps[0].autonomy, 'needs_approval');
  assert.match(post.plain, /nothing is posted/i);

  const pay = normalizeCompiled(interpret('When a new lead comes in, pay the invoice'));
  assert.equal(pay.steps[0].type, 'pay');
  assert.equal(pay.steps[0].autonomy, 'needs_approval');
  assert.match(pay.plain, /Nothing is charged/);

  assert.equal(normalizeCompiled(interpret("When a lead's stage changes to Proposal sent, add a task to send the nurture plan")).trigger.stage, 'Proposal sent');
  assert.equal(normalizeCompiled(interpret('When the tag hot is added, draft a follow-up email')).trigger.tag, 'hot');
  assert.equal(normalizeCompiled(interpret('When someone opens an email, tag them interested')).trigger.type, 'email.opened');
  assert.equal(normalizeCompiled(interpret('When a contact clicks a link, tag them engaged')).trigger.type, 'email.clicked');
  assert.equal(normalizeCompiled(interpret('When a form is submitted, tag them inbound')).trigger.type, 'form.submitted');
  const morning = normalizeCompiled(interpret('Every morning, remind me to check new leads'));
  assert.equal(morning.trigger.type, 'schedule');
  assert.match(morning.plain, /Every morning/);
  assert.match(morning.plain, /Check new leads/);

  assert.equal(decideOutbound({ type: 'send_email', autonomy: 'needs_approval' }, { recipient: 'a@agency.test' }).action, 'queue');
  assert.equal(decideOutbound({ type: 'send_email', autonomy: 'auto_within_limits', limits: { daily_cap: 1, allowed_recipients: ['@agency.test'] } }, { recipient: 'a@other.test', sentToday: 0 }).reason, 'recipient');
  assert.equal(decideOutbound({ type: 'send_email', autonomy: 'auto_within_limits', limits: { daily_cap: 1, allowed_recipients: ['@agency.test'] } }, { recipient: 'a@agency.test', sentToday: 1 }).reason, 'cap');
  assert.equal(decideOutbound({ type: 'send_email', autonomy: 'auto_within_limits', limits: { daily_cap: 2, allowed_recipients: ['lead'] } }, { recipient: 'a@agency.test', sentToday: 0 }).action, 'send');
  assert.equal(decideOutbound({ type: 'pay', autonomy: 'auto' }, {}).reason, 'pay');
  assert.equal(decideOutbound({ type: 'draft_email', autonomy: 'auto' }, { optedOut: true }).action, 'skip');
  assert.equal(matchTrigger({ type: 'lead.created', source: 'LinkedIn' }, { type: 'lead.created', source: 'LinkedIn ads' }), true);
  assert.equal(matchTrigger({ type: 'lead.created', source: 'LinkedIn' }, { type: 'lead.created', source: 'Website' }), false);
  assert.equal(interpret('').error.length > 0, true);
});

test('workflows compile through mock AI, run on the cron tick, and stay inside one account', async () => {
  const s = await startServer({ ...MOCK, CRON_SECRET: CRON });
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'wf-a@example.com', name: 'North Agency', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'wf-b@example.com', name: 'Other Agency', password: PW })).d.token;
    assert.equal((await req(s, 'GET', '/api/workflows')).status, 401);
    const made = await req(s, 'POST', '/api/workflows/compile', { text: EXAMPLE }, A);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    const wf = made.d.workflow;
    assert.equal(wf.compiled_by, 'mock');
    assert.equal(wf.status, 'draft');
    assert.equal(wf.trigger.source, 'LinkedIn');
    assert.match(wf.plain, /LinkedIn/);
    assert.match(wf.plain, /needs your approval/i);
    const again = await req(s, 'POST', '/api/workflows/compile', { text: EXAMPLE }, A);
    assert.deepEqual(again.d.workflow.steps.map((x) => x.type), wf.steps.map((x) => x.type));

    assert.equal((await req(s, 'GET', '/api/workflows', undefined, B)).d.workflows.length, 0);
    assert.equal((await req(s, 'GET', '/api/workflows/' + wf.id, undefined, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/workflows/delete', { id: wf.id }, B)).status, 404);
    assert.equal((await req(s, 'PUT', '/api/kv', { k: 'as_wf:wf-a@example.com', v: '[]' }, B)).status, 400);
    assert.equal((await req(s, 'PUT', '/api/kv', { k: 'as_wfr:wf-a@example.com', v: '[]' }, B)).status, 400);

    assert.equal((await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, A)).d.workflow.status, 'enabled');
    const l1 = (await req(s, 'POST', '/api/leads', { name: 'Asha Rao', email: 'asha@agency.example', source: 'LinkedIn', company: 'Northwind' }, A)).d.lead;
    const l2 = (await req(s, 'POST', '/api/leads', { name: 'Meera Shah', email: 'meera@studio.example', source: 'LinkedIn' }, A)).d.lead;
    const l3 = (await req(s, 'POST', '/api/leads', { name: 'Website Lead', email: 'web@other.example', source: 'Website' }, A)).d.lead;
    const first = await tick(s);
    assert.equal(first.status, 200, JSON.stringify(first.d));
    assert.ok(first.d.workflows.ran >= 1);

    const asha = (await req(s, 'GET', '/api/leads/' + l1.id, undefined, A)).d.lead;
    assert.ok((asha.tags || []).includes('LinkedIn'), JSON.stringify(asha.tags));
    const web = (await req(s, 'GET', '/api/leads/' + l3.id, undefined, A)).d.lead;
    assert.equal((web.tags || []).includes('LinkedIn'), false);
    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    const draft = pending.find((a) => a.kind === 'draft' && a.lead_id === l1.id);
    assert.ok(draft, JSON.stringify(pending));
    assert.equal(draft.status, 'pending');
    assert.match(draft.subject || draft.summary, /Welcome/);
    const tl = (await req(s, 'GET', '/api/leads/' + l1.id + '/timeline', undefined, A)).d;
    assert.ok(tl.events.some((e) => e.kind === 'workflow'));
    const runs = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.runs;
    assert.ok(runs.some((r) => r.lead_id === l1.id && r.status === 'waiting'), JSON.stringify(runs));
    const act = (await req(s, 'GET', '/api/agents/status', undefined, A)).d.agents.find((a) => a.id === 'workflows');
    assert.ok(act && act.runs >= 1);
    assert.equal((await req(s, 'GET', '/api/agents/status', undefined, B)).d.agents.some((a) => a.id === 'workflows'), false);
    assert.equal((await req(s, 'GET', '/api/leads/' + l1.id + '/timeline', undefined, B)).status, 404);

    await req(s, 'POST', '/api/leads/' + l2.id + '/notes', { text: 'They replied on the thread' }, A);
    const later = await tick(s, Date.now() + 3 * 864e5);
    assert.equal(later.status, 200, JSON.stringify(later.d));
    const inbox = (await req(s, 'GET', '/api/agents/inbox', undefined, A)).d.items.map((i) => i.t).join('\n');
    assert.match(inbox, /asha@agency\.example/);
    assert.doesNotMatch(inbox, /meera@studio\.example/);
    const done = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.runs;
    assert.ok(done.some((r) => r.lead_id === l2.id && r.status === 'done' && (r.log || []).some((l) => l.result === 'skipped_replied')), JSON.stringify(done));
    assert.equal((await req(s, 'GET', '/api/agents/inbox', undefined, B)).d.items.length, 0);

    await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'paused' }, A);
    const l4 = (await req(s, 'POST', '/api/leads', { name: 'Paused', email: 'paused@agency.example', source: 'LinkedIn' }, A)).d.lead;
    await tick(s, Date.now() + 4 * 864e5);
    assert.equal(((await req(s, 'GET', '/api/leads/' + l4.id, undefined, A)).d.lead.tags || []).includes('LinkedIn'), false);

    const stage = (await req(s, 'POST', '/api/workflows/compile', { text: "When a lead's stage changes to Proposal sent, add a task to send the nurture plan" }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: stage.id, status: 'enabled' }, A);
    await req(s, 'PATCH', '/api/leads/' + l3.id, { stage: 'Contacted' }, A);
    await tick(s, Date.now() + 4 * 864e5);
    let tasks = (await req(s, 'GET', '/api/leads/' + l3.id + '/timeline', undefined, A)).d.events.filter((e) => e.kind === 'task');
    assert.equal(tasks.length, 0);
    await req(s, 'PATCH', '/api/leads/' + l3.id, { stage: 'Proposal sent' }, A);
    await tick(s, Date.now() + 4 * 864e5);
    tasks = (await req(s, 'GET', '/api/leads/' + l3.id + '/timeline', undefined, A)).d.events.filter((e) => e.kind === 'task');
    assert.ok(tasks.some((t) => /nurture plan/i.test(t.title)), JSON.stringify(tasks));

    const tagged = (await req(s, 'POST', '/api/workflows/compile', { text: 'When the tag hot is added, draft a follow-up email' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: tagged.id, status: 'enabled' }, A);
    await req(s, 'POST', '/api/leads/tags', { ids: [l3.id], add: ['hot'] }, A);
    await tick(s, Date.now() + 4 * 864e5);
    const follow = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === l3.id && /Follow/.test(a.subject || a.summary || ''));
    assert.ok(follow, 'follow-up draft missing');
    assert.equal(follow.status, 'pending');

    const opened = (await req(s, 'POST', '/api/workflows/compile', { text: 'When someone opens an email, tag them interested' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: opened.id, status: 'enabled' }, A);
    const chat = await req(s, 'POST', '/api/workplace/chat', { message: 'Email asha@agency.example [[mock:send_email {"to":"asha@agency.example","subject":"Nurture","body":"<p>Hi <a href=\'https://example.com/plan\'>plan</a></p>"}]]' }, A);
    const emailAppr = (chat.d.approvals || []).find((a) => a.kind === 'email');
    assert.ok(emailAppr, JSON.stringify(chat.d));
    const applied = await req(s, 'POST', '/api/tracking/apply', { lead_id: l1.id, approval_id: emailAppr.id }, A);
    assert.equal(applied.status, 200, JSON.stringify(applied.d));
    assert.equal(applied.d.sent, false);
    await req(s, 'GET', applied.d.pixel, undefined, undefined);
    await tick(s, Date.now() + 4 * 864e5);
    assert.ok(((await req(s, 'GET', '/api/leads/' + l1.id, undefined, A)).d.lead.tags || []).includes('interested'));

    const clicked = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a contact clicks a link, tag them engaged' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: clicked.id, status: 'enabled' }, A);
    const body = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === emailAppr.id).body;
    const clickPath = (body.match(/\/t\/c\/[a-f0-9]{32}/) || [])[0];
    await fetch(s.base + clickPath, { redirect: 'manual' });
    await tick(s, Date.now() + 4 * 864e5);
    assert.ok(((await req(s, 'GET', '/api/leads/' + l1.id, undefined, A)).d.lead.tags || []).includes('engaged'));

    const formWf = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a form is submitted, tag them inbound' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: formWf.id, status: 'enabled' }, A);
    const kv = await req(s, 'GET', '/api/kv', undefined, A);
    const item = kv.d.items.find((i) => i.k === 'as_data:wf-a@example.com');
    const ws = JSON.parse(item.v);
    const form = crypto.randomBytes(16).toString('hex');
    ws.agents.push({ id: 99, kind: 'formfirst', name: 'Forms', biz: 'North Agency', forms: [{ token: form, title: 'Audit request', fields: ['Name', 'Email', 'How can we help?'] }], recs: [] });
    assert.equal((await req(s, 'PUT', '/api/kv', { k: item.k, v: JSON.stringify(ws), at: Date.now() }, A)).status, 200);
    const posted = await fetch(s.base + '/p/f/' + form, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'f0=Ravi+Menon&f1=ravi%40client.example&f2=Need+a+welcome+sequence' });
    assert.match(await posted.text(), /Thanks, Ravi/);
    await tick(s, Date.now() + 4 * 864e5);
    const ravi = (await req(s, 'GET', '/api/leads?q=ravi', undefined, A)).d.leads[0];
    assert.ok(ravi && (ravi.tags || []).includes('inbound'), JSON.stringify(ravi));
    assert.equal((await req(s, 'GET', '/api/leads?q=ravi', undefined, B)).d.total, 0);

    const morning = (await req(s, 'POST', '/api/workflows/compile', { text: 'Every morning, remind me to check new leads' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: morning.id, status: 'enabled' }, A);
    await tick(s, Date.now() + 6 * 864e5);
    const inbox2 = (await req(s, 'GET', '/api/agents/inbox', undefined, A)).d.items.map((i) => i.t).join('\n');
    assert.match(inbox2, /Check new leads/);

    const limits = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email automatically' }, A)).d.workflow;
    assert.equal(limits.steps[0].autonomy, 'needs_approval');
    await req(s, 'POST', '/api/workflows/update', { id: limits.id, step: { id: limits.steps[0].id, autonomy: 'auto_within_limits', limits: { daily_cap: 1, allowed_recipients: ['@agency.test'] } } }, A);
    await req(s, 'POST', '/api/workflows/update', { id: limits.id, status: 'enabled' }, A);
    const outside = (await req(s, 'POST', '/api/leads', { name: 'Outside', email: 'buyer@other.test', source: 'Referral' }, A)).d.lead;
    await tick(s, Date.now() + 6 * 864e5);
    const outsideRun = (await req(s, 'GET', '/api/workflows/' + limits.id, undefined, A)).d.runs.find((r) => r.lead_id === outside.id);
    assert.ok(outsideRun, 'limits run missing');
    assert.ok((outsideRun.log || []).some((l) => /allowed recipients/i.test(l.detail || '') && /Nothing was sent/.test(l.detail || '')), JSON.stringify(outsideRun.log));
    const outsideAppr = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === outside.id && a.kind === 'email');
    assert.ok(outsideAppr && outsideAppr.status === 'pending');

    const pay = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, pay the invoice' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: limits.id, status: 'paused' }, A);
    await req(s, 'POST', '/api/workflows/update', { id: pay.id, status: 'enabled' }, A);
    const payer = (await req(s, 'POST', '/api/leads', { name: 'Payer', email: 'payer@agency.example', source: 'Referral' }, A)).d.lead;
    await tick(s, Date.now() + 6 * 864e5);
    const payAppr = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === payer.id);
    assert.ok(payAppr, 'payment approval missing');
    assert.equal(payAppr.status, 'pending');
    assert.match(JSON.stringify(payAppr), /Nothing is charged|Payment/);
    assert.equal((await req(s, 'GET', '/api/leads/' + payer.id, undefined, A)).d.lead.paid, undefined);

    assert.equal((await req(s, 'POST', '/api/auth/delete', { password: PW }, A)).status, 200);
    const rows = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    assert.deepEqual(Object.keys(rows).filter((k) => k.includes('wf-a@example.com') && rows[k].v != null), []);
  } finally { await s.stop(); }
});
