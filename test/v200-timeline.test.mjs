// v2.0: one timeline per contact, and tracking that feeds it. Each check is per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { assembleTimeline, classifyHist, summarizeDashboard } from '../lib/timeline.js';
import { utmOf, mergeUtm, safeHttpUrl } from '../lib/tracking.js';

const PW = 'Timeline-pass-123!';
// Dummy mailbox so the email tool exists. Nothing is approved, so nothing is sent.
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', GMAIL_USER: 'test-mailbox@example.com', GMAIL_APP_PASSWORD: 'test-app-password' };
async function req(s, method, p, body, token, extra = {}) {
  const r = await fetch(s.base + p, { method, redirect: extra.redirect || 'follow', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const buf = Buffer.from(await r.arrayBuffer());
  let d = null; try { d = JSON.parse(buf.toString('utf8')); } catch { /* html or gif */ }
  return { status: r.status, d, text: buf.toString('utf8'), buf, headers: r.headers };
}

test('timeline join, UTM and link checks', () => {
  assert.equal(classifyHist('Note: called the agency'), 'note');
  assert.equal(classifyHist('New lead → Contacted'), 'stage');
  assert.equal(classifyHist('Visited from linkedin / email / spring-nurture'), 'visit');
  assert.equal(classifyHist('Form submitted: Newsletter signup'), 'form');
  const lead = { id: 7, email: 'asha@agency.example', first_name: 'Asha', hist: [{ at: 1, t: 'Created' }, { at: 3, t: 'Note: likes the Tuesday send' }] };
  const events = assembleTimeline(lead, {
    tasks: [{ id: 1, lead_id: 7, title: 'Send the nurture plan', status: 'Open', at: 4 }],
    approvals: [{ id: 'a1', kind: 'email', to: 'Asha@agency.example', subject: 'Your plan', status: 'pending', at: 5 }],
    tracked: [{ id: 'e1', lead_id: 7, kind: 'open', title: 'Email opened', at: 6 }, { id: 'e2', lead_id: 8, kind: 'click', title: 'other', at: 9 }],
    order: 'asc',
  });
  assert.deepEqual(events.map((e) => e.kind), ['history', 'note', 'task', 'email', 'open']);
  const dash = summarizeDashboard([
    { source: 'LinkedIn', stage: 'Won', status: 'New' },
    { source: 'Website', stage: 'New lead', status: 'New', consent: 'Opted out' },
    { first_touch: { utm: { utm_source: 'newsletter' } }, stage: 'New lead', status: 'New' },
  ], ['New lead', 'Won'], { tracked: [{ kind: 'open' }, { kind: 'click' }], pageViews: 4 });
  assert.equal(dash.leads, 3); assert.equal(dash.opted_out, 1); assert.equal(dash.conversion.won, 1); assert.equal(dash.conversion.rate, 0.333);
  assert.deepEqual(Object.fromEntries(dash.by_source.map((s) => [s.source, s.count])), { LinkedIn: 1, Website: 1, newsletter: 1 });
  assert.equal(dash.tracking.page_views, 4); assert.equal(dash.tracking.opens, 1);
  assert.deepEqual(utmOf(new URLSearchParams('utm_source=linkedin&utm_campaign=spring-nurture&gclid=abc')), { utm_source: 'linkedin', utm_campaign: 'spring-nurture', gclid: 'abc' });
  assert.equal(mergeUtm({ utm_source: 'linkedin' }, { utm_campaign: 'spring-nurture' }).utm_campaign, 'spring-nurture');
  assert.equal(safeHttpUrl('https://example.com/nurture'), 'https://example.com/nurture');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('https://user:pass@example.com/x'), '');
});

test('contact timeline, tracking, opt-out and tenant isolation', async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'tl-a@example.com', name: 'Northwind', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'tl-b@example.com', name: 'Other Agency', password: PW })).d.token;
    assert.equal((await req(s, 'GET', '/api/crm/dashboard')).status, 401);
    const made = await req(s, 'POST', '/api/leads', { name: 'Asha Rao', email: 'asha@agency.example', company: 'Northwind Digital', source: 'LinkedIn' }, A);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    const id = made.d.lead.id;
    assert.equal((await req(s, 'POST', '/api/leads/' + id + '/notes', { text: 'Likes the Tuesday nurture send' }, A)).status, 200);
    assert.equal((await req(s, 'POST', '/api/leads/' + id + '/tasks', { title: 'Send the nurture plan', due: '2026-11-02', priority: 'High' }, A)).d.task.lead_id, id);
    assert.match((await req(s, 'PATCH', '/api/leads/' + id, { stage: 'Contacted' }, A)).d.lead.hist.at(-1).t, /New lead → Contacted/);

    // Two chats: tool calls in one turn run together and can overwrite each other's approval row.
    const emailMsg = 'Email asha@agency.example [[mock:send_email {"to":"asha@agency.example","subject":"Nurture sequence","body":"<p>Hi Asha <a href=\'https://example.com/nurture\'>the plan</a></p>"}]]';
    const draftMsg = 'Draft for asha@agency.example [[mock:propose_action {"app":"draft","summary":"Draft for asha@agency.example","request":"Nurture draft for the agency"}]]';
    const chat = await req(s, 'POST', '/api/workplace/chat', { run_id: 'run-tl-0001', message: emailMsg }, A);
    assert.equal(chat.status, 200, JSON.stringify(chat.d));
    const chat2 = await req(s, 'POST', '/api/workplace/chat', { run_id: 'run-tl-0002', message: draftMsg }, A);
    assert.equal(chat2.status, 200, JSON.stringify(chat2.d));
    const emailAppr = (chat.d.approvals || []).find((a) => a.kind === 'email');
    const draft = (chat2.d.approvals || []).find((a) => a.kind === 'draft');
    assert.ok(emailAppr && draft, JSON.stringify({ email: chat.d.approvals, draft: chat2.d.approvals }));
    const applied = await req(s, 'POST', '/api/tracking/apply', { lead_id: id, approval_id: emailAppr.id }, A);
    assert.equal(applied.status, 200, JSON.stringify(applied.d));
    assert.equal(applied.d.sent, false); assert.equal(applied.d.approval.status, 'pending');
    assert.match(applied.d.pixel, /\/t\/o\/[a-f0-9]{32}\.gif/);
    const still = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === emailAppr.id);
    assert.equal(still.status, 'pending'); assert.match(still.body, /\/t\/c\/[a-f0-9]{32}/); assert.match(still.body, /\/t\/o\//);

    const pix = await req(s, 'GET', applied.d.pixel, undefined, undefined);
    assert.equal(pix.status, 200); assert.match(pix.headers.get('content-type'), /image\/gif/); assert.ok(pix.buf.length > 20);
    const clickPath = (still.body.match(/\/t\/c\/[a-f0-9]{32}/) || [])[0];
    const clk = await req(s, 'GET', clickPath + '?url=https://evil.example', undefined, undefined, { redirect: 'manual' });
    assert.equal(clk.status, 302); assert.equal(clk.headers.get('location'), 'https://example.com/nurture');
    const bogus = await req(s, 'GET', '/t/c/' + 'ab'.repeat(16) + '?url=https://evil.example', undefined, undefined, { redirect: 'manual' });
    assert.notEqual(bogus.status, 302); assert.equal(bogus.headers.get('location'), null); assert.match(bogus.text, /isn’t active/);

    const tl = await req(s, 'GET', '/api/leads/' + id + '/timeline', undefined, A);
    const kinds = new Set(tl.d.events.map((e) => e.kind));
    for (const k of ['history', 'note', 'stage', 'task', 'email', 'draft', 'agent', 'open', 'click']) assert.ok(kinds.has(k), 'missing ' + k + ' in ' + [...kinds].join(','));
    assert.equal(tl.d.tracking.opted_out, false); assert.match(tl.d.tracking.visit_path, /^\/t\/v\/[a-f0-9]{32}$/);
    const vis = await req(s, 'GET', tl.d.tracking.visit_path + '?utm_source=linkedin&utm_campaign=spring-nurture', undefined, undefined);
    assert.match(vis.text, /Visit noted/);
    assert.ok((await req(s, 'GET', '/api/leads/' + id + '/timeline', undefined, A)).d.events.some((e) => e.kind === 'visit' && /linkedin/.test(e.title)));

    const bot = await req(s, 'GET', tl.d.tracking.visit_path + '?utm_source=bot', undefined, undefined, { headers: { 'user-agent': 'WhatsApp/2.1' } });
    assert.match(bot.text, /Visit noted/);
    const afterBot = await req(s, 'GET', '/api/leads/' + id + '/timeline', undefined, A);
    assert.equal(afterBot.d.events.filter((e) => e.kind === 'visit' && /bot/.test(e.title + e.detail)).length, 0);

    assert.equal((await req(s, 'POST', '/api/tracking/link', { lead_id: id, url: 'javascript:alert(1)' }, A)).status, 400);
    await req(s, 'PATCH', '/api/leads/' + id, { consent: 'Opted out' }, A);
    const again = await req(s, 'GET', applied.d.pixel, undefined, undefined);
    assert.equal(again.status, 200);
    const linkNo = await req(s, 'POST', '/api/tracking/link', { lead_id: id, url: 'https://example.com/more' }, A);
    assert.equal(linkNo.status, 400); assert.equal(linkNo.d.error, 'opted_out');
    const applyNo = await req(s, 'POST', '/api/tracking/apply', { lead_id: id, approval_id: emailAppr.id }, A);
    assert.equal(applyNo.status, 400); assert.equal(applyNo.d.error, 'opted_out');
    const quiet = await req(s, 'GET', '/api/leads/' + id + '/timeline', undefined, A);
    assert.equal(quiet.d.events.filter((e) => e.kind === 'open').length, 1);
    assert.equal(quiet.d.events.filter((e) => e.kind === 'click').length, 1);
    assert.equal((await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items.find((a) => a.id === emailAppr.id).status, 'pending');

    // B has the same numeric id and must not see or change A's contact
    const bLead = (await req(s, 'POST', '/api/leads', { name: 'Other', email: 'other@agency.example', source: 'Referral' }, B)).d.lead;
    assert.equal(bLead.id, id);
    const btl = await req(s, 'GET', '/api/leads/' + id + '/timeline', undefined, B);
    assert.doesNotMatch(JSON.stringify(btl.d), /Asha|nurture|Tuesday|example.com\/nurture/);
    assert.equal((await req(s, 'POST', '/api/leads/' + id + '/notes', { text: 'B note only' }, B)).status, 200);
    assert.match((await req(s, 'GET', '/api/leads/' + id, undefined, A)).d.lead.notes, /Tuesday/);
    assert.doesNotMatch((await req(s, 'GET', '/api/leads/' + id, undefined, A)).d.lead.notes, /B note only/);
    const bDash = (await req(s, 'GET', '/api/crm/dashboard', undefined, B)).d;
    assert.equal(bDash.leads, 1); assert.deepEqual(bDash.by_source, [{ source: 'Referral', count: 1 }]);
    const aDash = (await req(s, 'GET', '/api/crm/dashboard', undefined, A)).d;
    assert.ok(aDash.by_source.some((s) => s.source === 'LinkedIn' && s.count === 1));
    assert.ok(aDash.tracking.opens >= 1 && aDash.tracking.clicks >= 1 && aDash.tracking.page_views >= 1);

    // public form visit + UTM lands on the contact timeline
    const kv = await req(s, 'GET', '/api/kv', undefined, A);
    const item = kv.d.items.find((i) => i.k === 'as_data:tl-a@example.com');
    const ws = JSON.parse(item.v);
    const form = crypto.randomBytes(16).toString('hex');
    ws.agents.push({ id: 99, kind: 'formfirst', name: 'Forms', biz: 'Northwind Digital', forms: [{ token: form, title: 'Newsletter signup', fields: ['Name', 'Email', 'Phone', 'How can we help?'] }], recs: [] });
    assert.equal((await req(s, 'PUT', '/api/kv', { k: item.k, v: JSON.stringify(ws), at: Date.now() }, A)).status, 200);
    const page = await req(s, 'GET', '/p/f/' + form + '?utm_source=newsletter&utm_medium=email&utm_campaign=spring-nurture', undefined, undefined);
    assert.match(page.text, /<form/);
    const posted = await req(s, 'POST', '/p/f/' + form + '?utm_source=newsletter&utm_campaign=spring-nurture', 'f0=Meera+Shah&f1=meera%40studio.example&f2=%2B91+90000+22222&f3=Want+a+welcome+sequence', undefined, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.match(posted.text, /Thanks, Meera/);
    const meera = (await req(s, 'GET', '/api/leads?q=meera', undefined, A)).d.leads[0];
    assert.ok(meera, 'form did not create a CRM lead');
    assert.equal(meera.first_touch.utm.utm_source, 'newsletter'); assert.equal(meera.first_touch.utm.utm_campaign, 'spring-nurture');
    const mtl = (await req(s, 'GET', '/api/leads/' + meera.id + '/timeline', undefined, A)).d;
    assert.ok(mtl.events.some((e) => e.kind === 'visit' && /newsletter/.test(e.title)));
    assert.ok(mtl.events.some((e) => e.kind === 'form' && /Newsletter signup/.test(e.title)));
    assert.equal((await req(s, 'GET', '/api/leads?q=meera', undefined, B)).d.total, 0);
    const src = (await req(s, 'GET', '/api/crm/dashboard', undefined, A)).d.by_source;
    assert.ok(src.some((x) => x.source === 'newsletter'));
    assert.equal((await req(s, 'POST', '/api/tracking/apply', { lead_id: meera.id, approval_id: emailAppr.id }, B)).status, 404);
  } finally { await s.stop(); }
});

test('deleting an account removes its tracking tokens', async () => {
  const s = await startServer(MOCK);
  try {
    const email = 'tl-del@example.com';
    const A = (await req(s, 'POST', '/api/auth/signup', { email, name: 'Del', password: PW })).d.token;
    const id = (await req(s, 'POST', '/api/leads', { name: 'Asha Rao', email: 'asha@agency.example' }, A)).d.lead.id;
    const link = await req(s, 'POST', '/api/tracking/link', { lead_id: id, url: 'https://example.com/nurture' }, A);
    assert.equal(link.status, 200);
    assert.equal((await req(s, 'POST', '/api/auth/delete', { password: PW }, A)).status, 200);
    const gone = await req(s, 'GET', link.d.path, undefined, undefined, { redirect: 'manual' });
    assert.notEqual(gone.status, 302);
    const rows = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    assert.deepEqual(Object.keys(rows).filter((k) => (k.includes(email) || k.startsWith('as_trk:')) && rows[k].v != null), []);
  } finally { await s.stop(); }
});
