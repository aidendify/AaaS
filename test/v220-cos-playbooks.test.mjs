// v2.2 Learning Chief of Staff and playbooks. Mock AI is deterministic. Nothing here sends mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { fakeSMTP } from './mocks.mjs';
import { decideOutbound, normalizeCompiled, interpret, lockOutbound } from '../lib/workflows.js';
import { suggestFromFacts, shapeDraft, draftFromSuggestion, autoPickDecision } from '../lib/cos.js';
import { STARTERS, prepareInstall } from '../lib/playbooks.js';

const PW = 'Cos-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };
const CRON = 'c'.repeat(32);
const DAY = 864e5;
const TUE = Date.UTC(2026, 9, 13, 15);
const THU = Date.UTC(2026, 9, 15, 15);
const FRI = Date.UTC(2026, 9, 16, 15);
const REVIEW = Date.UTC(2026, 9, 21, 15);

async function req(s, method, p, body, token, extra = {}) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
const tick = (s, now) => req(s, 'GET', '/api/cron/tick', undefined, undefined, { headers: { authorization: 'Bearer ' + CRON, ...(now ? { 'x-test-now': String(now) } : {}) } });
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; AIdentify test)' };

test('suggestions, drafts and auto-pick stay inside approval rules and send caps', () => {
  const tue = TUE, thu = THU;
  const sends = [], opens = [];
  for (let i = 0; i < 4; i++) { sends.push({ at: tue + i, lead_id: i + 1, source: 'LinkedIn' }); opens.push({ at: tue + 1000, lead_id: i + 1 }); }
  for (let i = 0; i < 8; i++) {
    sends.push({ at: thu + i, lead_id: 100 + i, source: 'Website' });
    if (i < 4) opens.push({ at: thu + 1000, lead_id: 100 + i });
  }
  const leads = [
    ...[1, 2, 3, 4].map((id) => ({ id, source: 'LinkedIn', stage: 'Won' })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, source: 'Website', stage: 'New lead' })),
  ];
  const facts = { leads, sends, opens, clicks: [], approvals: [] };
  const first = suggestFromFacts(facts);
  const again = suggestFromFacts(facts);
  assert.deepEqual(again, first);
  assert.ok(first.length >= 3 && first.length <= 5, JSON.stringify(first));
  assert.match(first.map((s) => s.text).join('\n'), /Tuesday/);
  assert.match(first.map((s) => s.text).join('\n'), /2×/);
  assert.match(first.map((s) => s.text).join('\n'), /opens/i);
  assert.match(first.map((s) => s.text).join('\n'), /Leads from LinkedIn convert best/);

  const shaped = shapeDraft('This is a very long subject line about a special offer today', 'Please buy now today', { subject_style: 'short', greeting: 'Hello there,', avoid: ['buy now'] });
  assert.ok(shaped.subject.length <= 42, shaped.subject);
  assert.ok(shaped.body.startsWith('Hello there,'), shaped.body);
  assert.doesNotMatch(shaped.subject + shaped.body, /buy now/i);

  const day = draftFromSuggestion({ action: 'workflow', kind: 'weekday_opens', weekday: 2, day: 'Tuesday', text: 'Emails sent on Tuesday get more opens.' }, {});
  assert.equal(day.status, 'draft');
  assert.equal(day.trigger.weekday, 2);
  assert.equal(day.steps.some((s) => s.type === 'send_email' || s.type === 'social_post' || s.type === 'pay'), false);
  const src = draftFromSuggestion({ action: 'workflow', kind: 'source_wins', source: 'LinkedIn', text: 'Leads from LinkedIn convert best.' }, {});
  assert.equal(src.status, 'draft');
  assert.ok(src.steps.some((s) => s.type === 'draft_email' && s.autonomy === 'needs_approval'));

  const forced = lockOutbound(normalizeCompiled({ name: 'Bad', status: 'enabled', trigger: { type: 'lead.created' }, steps: [{ type: 'send_email', autonomy: 'auto', subject: 'Hi', body: 'There' }] }));
  assert.equal(forced.status, 'draft');
  assert.equal(forced.steps[0].autonomy, 'needs_approval');

  const customer = { type: 'send_email', autonomy: 'auto', autonomy_set_by: 'customer', subject: 'Winner', body: 'Hi' };
  assert.deepEqual(autoPickDecision({ type: 'send_email', autonomy: 'needs_approval' }, { auto_pick: true }), { apply_copy: false, send: false, needs_confirmation: true });
  assert.equal(autoPickDecision(customer, { auto_pick: false }).apply_copy, false);
  assert.equal(autoPickDecision({ type: 'send_email', autonomy: 'auto' }, { auto_pick: true }).apply_copy, false);
  const picked = autoPickDecision(customer, { auto_pick: true });
  assert.equal(picked.apply_copy, true);
  assert.equal(picked.send, false);
  assert.equal(decideOutbound(customer, { recipient: 'a@x.com', leadEmail: 'a@x.com', sentToday: 0, sentTodayAll: 50 }).reason, 'cap');
  assert.equal(decideOutbound(customer, { recipient: 'other@x.com', leadEmail: 'a@x.com', sentToday: 0, sentTodayAll: 0 }).reason, 'recipient');
  assert.equal(decideOutbound({ ...customer, autonomy: 'auto_within_limits', limits: { daily_cap: 3, allowed_recipients: ['lead'] } }, { recipient: 'a@x.com', leadEmail: 'a@x.com', sentToday: 3, sentTodayAll: 0 }).reason, 'cap');

  const plan = prepareInstall({
    format: 'aidentify-playbook', name: 'Bad',
    workflows: [{ name: 'Send', status: 'enabled', trigger: { type: 'lead.created' }, steps: [{ type: 'send_email', autonomy: 'auto', subject: 'Hi', body: 'Yo' }] }],
    agents: [{ kind: 'nudge', name: 'N', prompts: [{ title: 'k', text: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz' }] }],
  });
  assert.equal(plan.workflows[0].status, 'draft');
  assert.equal(plan.workflows[0].steps[0].autonomy, 'needs_approval');
  assert.doesNotMatch(JSON.stringify(plan), /sk-or-v1/);
  assert.equal(plan.redacted > 0, true);

  assert.equal(STARTERS.length, 3);
  assert.deepEqual(STARTERS.map((p) => p.for).sort(), ['agency', 'digital', 'email']);
  assert.doesNotMatch(JSON.stringify(STARTERS), /real estate|realtor|property listing/i);
  for (const p of STARTERS) {
    assert.ok(p.workflows.length >= 1);
    for (const w of p.workflows) {
      assert.equal(w.status, 'draft');
      for (const s of w.steps) if (s.type === 'send_email' || s.type === 'draft_email' || s.type === 'social_post' || s.type === 'pay') assert.equal(s.autonomy, 'needs_approval');
    }
  }
  assert.equal(normalizeCompiled(interpret(STARTERS[0].workflows[0].prompt)).steps.length > 0, true);

  const cosSrc = fs.readFileSync(new URL('../lib/cos.js', import.meta.url), 'utf8');
  const pbSrc = fs.readFileSync(new URL('../lib/playbooks.js', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(cosSrc, /sendEmail/);
  assert.doesNotMatch(pbSrc, /sendEmail/);
  assert.match(page, /data-act="cosApply"/);
  assert.match(page, /data-act="cosConfirm"/);
  assert.match(page, /data-act="pbInstall"/);
  assert.match(page, /['"]Suggestions['"]/);
  assert.match(page, /['"]Playbooks['"]/);
});

test('a weekly review suggests from this account only, and apply saves a draft', async () => {
  const s = await startServer({ ...MOCK, CRON_SECRET: CRON });
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'cos-a@example.com', name: 'North Agency', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'cos-b@example.com', name: 'Other Agency', password: PW })).d.token;
    const made = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email' }, A);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    const wf = made.d.workflow;
    const step = wf.steps.find((x) => x.type === 'send_email');
    assert.equal((await req(s, 'POST', '/api/workflows/update', { id: wf.id, step: { id: step.id, body: '<p>Hi {{first_name}}, see https://example.com/welcome</p>' } }, A)).status, 200);
    assert.equal((await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, A)).d.workflow.status, 'enabled');

    const linkedin = [];
    for (let i = 0; i < 4; i++) linkedin.push((await req(s, 'POST', '/api/leads', { name: 'Lin ' + i, email: `lin${i}@agency.example`, source: 'LinkedIn' }, A)).d.lead);
    const first = await tick(s, TUE);
    assert.equal(first.status, 200, JSON.stringify(first.d));
    const early = await req(s, 'GET', '/api/cos', undefined, A);
    assert.equal(early.d.suggestions.length, 0);
    assert.equal(early.d.next_review_at, TUE + 7 * DAY);
    const tueRuns = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.runs;
    assert.ok(tueRuns.some((r) => (r.log || []).some((l) => l.at === TUE && l.result === 'queued_approval')), JSON.stringify(tueRuns));

    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    for (const lead of linkedin) {
      const ap = pending.find((a) => a.lead_id === lead.id && a.kind === 'email');
      assert.ok(ap, 'missing tuesday email');
      const applied = await req(s, 'POST', '/api/tracking/apply', { lead_id: lead.id, approval_id: ap.id }, A);
      assert.equal(applied.status, 200, JSON.stringify(applied.d));
      const body = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === ap.id).body;
      const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
      const click = (body.match(/\/t\/c\/[a-f0-9]{32}/) || [])[0];
      assert.ok(pixel && click, body);
      assert.equal((await fetch(s.base + pixel, { headers: UA })).status, 200);
      await fetch(s.base + click, { headers: UA, redirect: 'manual' });
    }

    const website = [];
    for (let i = 0; i < 8; i++) website.push((await req(s, 'POST', '/api/leads', { name: 'Web ' + i, email: `web${i}@studio.example`, source: 'Website' }, A)).d.lead);
    assert.equal((await tick(s, THU)).status, 200);
    const afterThu = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    for (let i = 0; i < 2; i++) {
      const lead = website[i];
      const ap = afterThu.find((a) => a.lead_id === lead.id && a.kind === 'email');
      assert.ok(ap, 'missing thursday email');
      assert.equal((await req(s, 'POST', '/api/tracking/apply', { lead_id: lead.id, approval_id: ap.id }, A)).status, 200);
      const body = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === ap.id).body;
      const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
      const click = (body.match(/\/t\/c\/[a-f0-9]{32}/) || [])[0];
      assert.equal((await fetch(s.base + pixel, { headers: UA })).status, 200);
      await fetch(s.base + click, { headers: UA, redirect: 'manual' });
    }
    for (const lead of linkedin) assert.equal((await req(s, 'PATCH', '/api/leads/' + lead.id, { stage: 'Won' }, A)).d.lead.stage, 'Won');

    const post = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, post to LinkedIn' }, A)).d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: post.id, status: 'enabled' }, A);
    const events = [];
    for (let i = 0; i < 2; i++) events.push((await req(s, 'POST', '/api/leads', { name: 'Ev ' + i, email: `ev${i}@events.example`, source: 'Event' }, A)).d.lead);
    assert.equal((await tick(s, FRI)).status, 200);
    await req(s, 'POST', '/api/workflows/update', { id: post.id, status: 'paused' }, A);
    const posts = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.filter((a) => events.some((l) => l.id === a.lead_id) && /^post/i.test(a.summary || ''));
    assert.equal(posts.length, 2, JSON.stringify(posts));
    for (const p of posts) assert.equal((await req(s, 'POST', '/api/agents/approval', { id: p.id, decision: 'reject' }, A)).d.approval.status, 'declined');

    const reviewed = await tick(s, REVIEW);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.d));
    assert.equal(reviewed.d.cos.reviewed >= 1, true);
    const sug = (await req(s, 'GET', '/api/cos', undefined, A)).d.suggestions.filter((x) => x.status === 'open');
    assert.ok(sug.length >= 3 && sug.length <= 5, JSON.stringify(sug));
    assert.ok(sug.some((x) => /Tuesday/.test(x.text) && /open/i.test(x.text)), JSON.stringify(sug));
    const win = sug.find((x) => /Leads from LinkedIn convert best/.test(x.text));
    assert.ok(win, JSON.stringify(sug));
    const applied = await req(s, 'POST', '/api/cos/suggestions/apply', { id: win.id }, A);
    assert.equal(applied.status, 200, JSON.stringify(applied.d));
    assert.equal(applied.d.sent, false);
    assert.equal(applied.d.workflow.status, 'draft');
    assert.equal(applied.d.workflow.trigger.source, 'LinkedIn');
    const email = applied.d.workflow.steps.find((x) => x.type === 'draft_email' || x.type === 'send_email');
    assert.ok(email && email.autonomy === 'needs_approval');
    assert.equal(applied.d.workflow.steps.some((x) => (x.type === 'send_email' || x.type === 'draft_email' || x.type === 'social_post' || x.type === 'pay') && x.autonomy !== 'needs_approval'), false);
    assert.equal((await req(s, 'GET', '/api/workflows/' + applied.d.workflow.id, undefined, B)).status, 404);
    const bcos = await req(s, 'GET', '/api/cos', undefined, B);
    assert.equal(bcos.d.suggestions.length, 0);
    assert.doesNotMatch(JSON.stringify(bcos.d), /LinkedIn convert best|Tuesday/);

    const ids = (await req(s, 'GET', '/api/cos', undefined, A)).d.suggestions.map((x) => x.id).sort();
    await tick(s, REVIEW);
    assert.deepEqual((await req(s, 'GET', '/api/cos', undefined, A)).d.suggestions.map((x) => x.id).sort(), ids);
    await tick(s, REVIEW + DAY);
    const draftRuns = (await req(s, 'GET', '/api/workflows/' + applied.d.workflow.id, undefined, A)).d.runs;
    assert.equal(draftRuns.length, 0);
  } finally { await s.stop(); }
});

test('edits and rejections shape the next draft, and a held email still lets the customer choose later', async () => {
  const s = await startServer({ ...MOCK, CRON_SECRET: CRON });
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'cos-p@example.com', name: 'Prefs', password: PW })).d.token;
    const made = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email' }, A);
    const wf = made.d.workflow;
    await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, A);
    const leads = [];
    for (let i = 0; i < 3; i++) leads.push((await req(s, 'POST', '/api/leads', { name: 'P ' + i, email: `p${i}@agency.example`, source: 'Referral' }, A)).d.lead);
    assert.equal((await tick(s)).status, 200);
    const items = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.filter((a) => a.kind === 'email');
    assert.ok(items.length >= 3, JSON.stringify(items));
    for (const a of items.slice(0, 2)) {
      const edit = await req(s, 'POST', '/api/agents/approval/edit', { id: a.id, subject: 'Hi', body: 'Hello there,\n\nThanks for writing.' }, A);
      assert.equal(edit.status, 200, JSON.stringify(edit.d));
    }
    const rejected = await req(s, 'POST', '/api/agents/approval', { id: items[2].id, decision: 'reject', note: 'buy now' }, A);
    assert.equal(rejected.d.approval.status, 'declined');
    const sentence = 'When a new lead comes in, send the welcome email subject "This is a very long subject line about a special offer today" body "Please buy now and we will send the next note today"';
    const next = await req(s, 'POST', '/api/workflows/compile', { text: sentence }, A);
    assert.equal(next.status, 200, JSON.stringify(next.d));
    const email = next.d.workflow.steps.find((x) => x.type === 'send_email');
    assert.ok(email.subject.length <= 42, email.subject);
    assert.ok(email.body.startsWith('Hello there,'), email.body);
    assert.doesNotMatch(email.subject + email.body, /buy now/i);
    const twin = await req(s, 'POST', '/api/workflows/compile', { text: sentence }, A);
    assert.equal(twin.d.workflow.steps.find((x) => x.type === 'send_email').subject, email.subject);

    const later = await tick(s, Date.now() + 8 * DAY);
    assert.equal(later.status, 200, JSON.stringify(later.d));
    const hold = (await req(s, 'GET', '/api/cos', undefined, A)).d.suggestions.find((x) => x.kind === 'hold_email' && x.status === 'open');
    assert.ok(hold, JSON.stringify((await req(s, 'GET', '/api/cos', undefined, A)).d));
    const applied = await req(s, 'POST', '/api/cos/suggestions/apply', { id: hold.id }, A);
    assert.equal(applied.d.sent, false);
    assert.equal(applied.d.needs_confirmation, true);
    const confirmed = await req(s, 'POST', '/api/cos/confirm', { id: applied.d.change.id }, A);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.d));
    assert.equal(confirmed.d.sent, false);
    const auto = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email automatically' }, A);
    assert.equal(auto.d.workflow.steps[0].autonomy, 'needs_approval');
    assert.equal(auto.d.workflow.steps[0].suggested_autonomy, undefined);
    const chosen = await req(s, 'POST', '/api/workflows/update', { id: auto.d.workflow.id, step: { id: auto.d.workflow.steps[0].id, autonomy: 'auto' } }, A);
    assert.equal(chosen.d.workflow.steps[0].autonomy, 'auto');
    assert.equal(chosen.d.workflow.steps[0].autonomy_set_by, 'customer');
  } finally { await s.stop(); }
});

test('A/B auto-pick copies words only and still queues on the account cap', async () => {
  const smtp = await fakeSMTP();
  const s = await startServer({
    ...MOCK, CRON_SECRET: CRON, WORKFLOW_SEND_DAILY_MAX: '0',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_IGNORE_TLS: 'true',
    GMAIL_USER: 'platform@example.com', GMAIL_APP_PASSWORD: 'test-app-password',
  });
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'cos-ab@example.com', name: 'AB', password: PW })).d.token;
    const made = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email' }, A);
    const wf = made.d.workflow;
    const step = wf.steps.find((x) => x.type === 'send_email');
    await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, A);
    const variants = [{ subject: 'Subject Alpha', body: 'Alpha note https://example.com/a' }, { subject: 'Subject Bravo', body: 'Bravo note https://example.com/b' }];
    const started = await req(s, 'POST', '/api/cos/ab', { workflow_id: wf.id, step_id: step.id, metric: 'opens', min_sample: 2, auto_pick: true, variants }, A);
    assert.equal(started.status, 200, JSON.stringify(started.d));
    assert.equal(started.d.sent, false);
    const used = { A: 0, B: 0 };
    const approvals = [];
    for (let i = 0; i < 24 && (used.A < 2 || used.B < 2); i++) {
      const lead = (await req(s, 'POST', '/api/leads', { name: 'AB ' + i, email: `ab${i}@agency.example`, source: 'Referral' }, A)).d.lead;
      assert.equal((await tick(s)).status, 200);
      const ap = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === lead.id);
      assert.ok(ap && ap.ab_variant, JSON.stringify(ap));
      used[ap.ab_variant]++;
      approvals.push(ap);
    }
    assert.ok(used.A >= 2 && used.B >= 2, JSON.stringify(used));
    const before = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.workflow.steps.find((x) => x.id === step.id);
    for (const ap of approvals.filter((a) => a.ab_variant === 'B')) {
      const body = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === ap.id).body;
      const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
      assert.ok(pixel, body);
      assert.equal((await fetch(s.base + pixel, { headers: UA })).status, 200);
    }
    const mid = (await req(s, 'GET', '/api/cos', undefined, A)).d.tests[0];
    assert.equal(mid.status, 'winner_pending');
    assert.equal(mid.winner, 'B');
    const unchanged = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.workflow.steps.find((x) => x.id === step.id);
    assert.equal(unchanged.subject, before.subject);
    assert.equal(unchanged.autonomy, 'needs_approval');
    const open = (await req(s, 'GET', '/api/cos', undefined, A)).d.suggestions.find((x) => x.kind === 'ab_winner' && x.status === 'open');
    assert.ok(open, 'winner suggestion missing');
    const applied = await req(s, 'POST', '/api/cos/suggestions/apply', { id: open.id }, A);
    assert.equal(applied.d.sent, false);
    assert.equal(applied.d.needs_confirmation, true);
    assert.equal((await req(s, 'GET', '/api/workflows/' + wf.id, undefined, A)).d.workflow.steps.find((x) => x.id === step.id).subject, before.subject);
    const confirmed = await req(s, 'POST', '/api/cos/confirm', { id: applied.d.change.id }, A);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.d));
    assert.equal(confirmed.d.sent, false);
    const copied = confirmed.d.workflow.steps.find((x) => x.id === step.id);
    assert.equal(copied.subject, 'Subject Bravo');
    assert.match(copied.body, /Bravo note/);
    assert.equal(copied.autonomy, 'needs_approval');
    assert.equal(copied.autonomy_set_by, undefined);
    assert.equal((await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.some((a) => a.status === 'done'), false);
    assert.equal((await req(s, 'GET', '/api/cos', undefined, A)).d.tests.find((t) => t.workflow_id === wf.id).status, 'done');

    const second = (await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email' }, A)).d.workflow;
    const step2 = second.steps.find((x) => x.type === 'send_email');
    const limited = await req(s, 'POST', '/api/workflows/update', { id: second.id, step: { id: step2.id, autonomy: 'auto_within_limits', limits: { daily_cap: 3, allowed_recipients: ['lead'] } } }, A);
    assert.equal(limited.d.workflow.steps[0].autonomy_set_by, 'customer');
    await req(s, 'POST', '/api/workflows/update', { id: second.id, status: 'enabled' }, A);
    assert.equal((await req(s, 'POST', '/api/cos/ab', { workflow_id: second.id, step_id: step2.id, metric: 'opens', min_sample: 2, auto_pick: true, variants }, A)).status, 200);
    const used2 = { A: 0, B: 0 };
    const approvals2 = [];
    for (let i = 0; i < 24 && (used2.A < 2 || used2.B < 2); i++) {
      const lead = (await req(s, 'POST', '/api/leads', { name: 'Cap ' + i, email: `cap${i}@agency.example`, source: 'Referral' }, A)).d.lead;
      assert.equal((await tick(s)).status, 200);
      const ap = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === lead.id && a.workflow_id === second.id);
      assert.ok(ap && ap.ab_variant, JSON.stringify(ap));
      const logged = (await req(s, 'GET', '/api/workflows/' + second.id, undefined, A)).d.runs.find((r) => r.lead_id === lead.id);
      assert.ok((logged.log || []).some((l) => /limit/i.test(l.detail || '') && /Nothing was sent/.test(l.detail || '')), JSON.stringify(logged && logged.log));
      used2[ap.ab_variant]++;
      approvals2.push(ap);
    }
    for (const ap of approvals2.filter((a) => a.ab_variant === 'B')) {
      const body = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === ap.id).body;
      const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
      assert.ok(pixel, body);
      assert.equal((await fetch(s.base + pixel, { headers: UA })).status, 200);
    }
    const won = (await req(s, 'GET', '/api/workflows/' + second.id, undefined, A)).d.workflow.steps.find((x) => x.id === step2.id);
    assert.equal(won.subject, 'Subject Bravo');
    assert.equal(won.autonomy, 'auto_within_limits');
    assert.equal(won.autonomy_set_by, 'customer');
    assert.equal(won.limits.daily_cap, 3);
    assert.equal((await req(s, 'GET', '/api/cos', undefined, A)).d.tests.find((t) => t.workflow_id === second.id).status, 'done');
    const extra = (await req(s, 'POST', '/api/leads', { name: 'After', email: 'after@agency.example', source: 'Referral' }, A)).d.lead;
    assert.equal((await tick(s)).status, 200);
    const queued = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.lead_id === extra.id && a.workflow_id === second.id);
    assert.ok(queued, 'capped follow-up missing');
    assert.equal(queued.status, 'pending');
    assert.equal(queued.subject, 'Subject Bravo');
    const extraRun = (await req(s, 'GET', '/api/workflows/' + second.id, undefined, A)).d.runs.find((r) => r.lead_id === extra.id);
    assert.ok((extraRun.log || []).some((l) => /limit/i.test(l.detail || '') && /Nothing was sent/.test(l.detail || '')), JSON.stringify(extraRun && extraRun.log));
    assert.equal(smtp.mails.length, 0);
  } finally { await s.stop(); await smtp.close(); }
});

test('playbooks preview, then install only after confirm, and stay inside one account', async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'pb-a@example.com', name: 'Agency A', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'pb-b@example.com', name: 'Agency B', password: PW })).d.token;
    const lead = (await req(s, 'POST', '/api/leads', { name: 'Kept Client', email: 'kept@client.example', source: 'Website' }, A)).d.lead;
    assert.equal(lead.stage, 'New lead');
    const kv = await req(s, 'GET', '/api/kv', undefined, A);
    const item = kv.d.items.find((i) => i.k === 'as_data:pb-a@example.com');
    const data = JSON.parse(item.v);
    const crm = data.agents.find((a) => a.kind === 'crm');
    crm.kb = [{ title: 'Secret', text: 'token sk-or-v1-abcdefghijklmnopqrstuvwxyz' }];
    assert.equal((await req(s, 'PUT', '/api/kv', { k: item.k, v: JSON.stringify(data), at: Date.now() }, A)).status, 200);
    const before = (await req(s, 'GET', '/api/workflows', undefined, A)).d.workflows.length;
    const stagesBefore = (await req(s, 'GET', '/api/leads/stages', undefined, A)).d.stages;
    const preview = await req(s, 'POST', '/api/playbooks/preview', { id: 'pb_agency' }, A);
    assert.equal(preview.status, 200, JSON.stringify(preview.d));
    assert.equal(preview.d.installed, false);
    assert.equal(preview.d.sent, false);
    assert.equal((await req(s, 'GET', '/api/workflows', undefined, A)).d.workflows.length, before);
    assert.deepEqual((await req(s, 'GET', '/api/leads/stages', undefined, A)).d.stages, stagesBefore);
    const dry = await req(s, 'POST', '/api/playbooks/install', { id: 'pb_agency' }, A);
    assert.equal(dry.d.installed, false);
    assert.equal((await req(s, 'GET', '/api/workflows', undefined, A)).d.workflows.length, before);
    const installed = await req(s, 'POST', '/api/playbooks/install', { id: 'pb_agency', confirm: true }, A);
    assert.equal(installed.status, 200, JSON.stringify(installed.d));
    assert.equal(installed.d.installed, true);
    assert.equal(installed.d.sent, false);
    for (const w of installed.d.result.workflows) assert.equal(w.status, 'draft');
    const workflows = (await req(s, 'GET', '/api/workflows', undefined, A)).d.workflows;
    assert.ok(workflows.length > before);
    for (const w of workflows) {
      assert.equal(w.status, 'draft');
      for (const st of w.steps || []) if (['send_email', 'draft_email', 'social_post', 'pay'].includes(st.type)) assert.equal(st.autonomy, 'needs_approval');
    }
    assert.deepEqual((await req(s, 'GET', '/api/leads/stages', undefined, A)).d.stages, ['New enquiry', 'Discovery booked', 'Proposal sent', 'Won', 'Lost']);
    const moved = (await req(s, 'GET', '/api/leads/' + lead.id, undefined, A)).d.lead;
    assert.equal(moved.email, 'kept@client.example');
    assert.equal(moved.stage, 'New enquiry');
    assert.match(JSON.stringify(moved.hist), /\(playbook\)/);
    const exported = await req(s, 'POST', '/api/playbooks/export', { name: 'A setup' }, A);
    assert.equal(exported.status, 200, JSON.stringify(exported.d));
    assert.doesNotMatch(JSON.stringify(exported.d.playbook), /kept@client\.example|sk-or-v1/);
    assert.match(JSON.stringify(exported.d.playbook), /\[removed\]/);
    assert.equal((await req(s, 'GET', '/api/playbooks/' + exported.d.playbook.id, undefined, B)).status, 404);
    assert.equal((await req(s, 'POST', '/api/playbooks/install', { id: exported.d.playbook.id, confirm: true }, B)).status, 404);
    assert.equal((await req(s, 'GET', '/api/leads/stages', undefined, B)).d.stages[0], 'New lead');
    assert.doesNotMatch(JSON.stringify((await req(s, 'GET', '/api/playbooks', undefined, B)).d), /kept@client|sk-or-v1|A setup/);
    assert.equal((await req(s, 'POST', '/api/auth/delete', { password: PW }, A)).status, 200);
    const rows = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    assert.deepEqual(Object.keys(rows).filter((k) => k.includes('pb-a@example.com') && rows[k].v != null), []);
  } finally { await s.stop(); }
});
