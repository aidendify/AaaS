// AaaS v2 clinic team: role, seeded numbers, CRUD, approvals, CSV, public form, Chief chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { waMe, parseCsv, buildSeed, forecastOf, trialOf, assertWritable, recoveredOf, weeklySummaryText } from '../lib/clinic.js';

const PW = 'Clinic-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };

test('a free trial lasts 14 days and then the workspace is read-only', () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const day = 864e5;
  const fresh = trialOf({ trialStarted: start, plan: '' }, start + 1000, 14);
  assert.equal(fresh.days, 14);
  assert.equal(fresh.daysLeft, 14);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.noCard, true);
  const last = trialOf({ trialStarted: start }, start + 14 * day - 1, 14);
  assert.equal(last.expired, false);
  assert.equal(last.daysLeft, 1);
  const done = trialOf({ trialStarted: start }, start + 14 * day, 14);
  assert.equal(done.expired, true);
  assert.equal(done.daysLeft, 0);
  class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  assert.throws(() => assertWritable({ trialStarted: start, demo: false }, HttpError, start + 14 * day), (e) => e.code === 'trial_ended' && e.status === 403);
  assert.doesNotThrow(() => assertWritable({ trialStarted: start, demo: true }, HttpError, start + 20 * day));
});

test('forecast includes sample invoices even before 11:00 India time', () => {
  const now = Date.parse('2026-10-27T19:00:00.000Z');
  const f = forecastOf(buildSeed('dental', now), now);
  assert.ok(f.collections > 0, JSON.stringify(f));
  assert.ok(f.revenue > f.collections);
});

test('recovered this month counts bookings, referrals, reactivated customers and other paid invoices once', () => {
  const now = Date.parse('2026-10-27T19:00:00.000Z');
  const seed = buildSeed('dental', now);
  const rec = recoveredOf(seed, now);
  assert.equal(rec.bookings, 13700);
  assert.equal(rec.referrals, 1500);
  assert.equal(rec.reactivated, 4500);
  assert.equal(rec.invoices, 15200);
  assert.equal(rec.total, rec.bookings + rec.referrals + rec.reactivated + rec.invoices);
  assert.equal(rec.total, 34900);
  assert.match(rec.method, /counted once/);
  const text = weeklySummaryText(seed, now);
  assert.match(text, /₹34,900/);
  assert.match(text, /Nothing is sent until you approve/);
  assert.doesNotMatch(text, /patient/i);
  const weekly = seed.drafts.find((d) => d.kind === 'weekly');
  assert.equal(weekly.agent, 'insights');
  assert.equal(weekly.status, 'pending');
  assert.match(weekly.waLink, /^https:\/\/wa\.me\//);
  assert.match(weekly.body, /recovered this month/i);
});

test('corner chat renders markdown without raw stars', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'clinic.html'), 'utf8');
  const chatMd = new Function(src.match(/function chatMd\(raw\) \{[\s\S]*?\n\}/)[0] + '\nreturn chatMd;')();
  assert.equal(chatMd('See **bold** and <script>'), 'See <strong>bold</strong> and &lt;script&gt;');
  assert.equal(chatMd('use `wa.me` only'), 'use <code>wa.me</code> only');
  assert.doesNotMatch(chatMd('**patients** last 2 months'), /\*\*/);
  assert.match(src, /m\.r==='a'\?chatMd\(m\.t\):esc\(m\.t\)/);
});

test('WhatsApp links are click-to-chat URLs and CSV rows parse', () => {
  assert.equal(waMe('919000000001', 'Hello there'), 'https://wa.me/919000000001?text=Hello%20there');
  assert.equal(waMe('9000000001', 'Hi'), 'https://wa.me/919000000001?text=Hi');
  assert.equal(waMe('123', 'Hi'), '');
  const rows = parseCsv('type,name,phone,email,last_visit,value\npatient,Asha Rao,919000000111,asha@example.com,2026-10-01,1200\n');
  assert.equal(rows[0].name, 'Asha Rao');
  assert.equal(rows[0].type, 'patient');
});

test('dental team: seeded numbers, CRUD, approvals, import, form, and chat', async () => {
  const s = await startServer(MOCK);
  try {
    const meta = await fetch(s.base + '/api/clinic/meta').then((r) => r.json());
    assert.equal(meta.product, 'AaaS');
    assert.equal(meta.demoLogin, true);
    const demo = await s.api('/api/clinic/demo', {});
    assert.equal(demo.status, 200, JSON.stringify(demo.d));
    const token = demo.d.token;
    const page = await fetch(s.base + '/clinic');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AaaS/);

    let clinic = await s.api('/api/clinic/role', { role: 'dental' }, token);
    assert.equal(clinic.status, 200, JSON.stringify(clinic.d));
    const d = clinic.d;
    assert.equal(d.product, 'AaaS');
    assert.equal(d.demo, true);
    assert.equal(d.biz, 'Smile Dental (sample)');
    assert.deepEqual(d.agents.map((a) => a.name), ['Front Desk', 'Patient Recall', 'Reviews & Referrals', 'Social Media', 'Owner Insights', 'Billing & Invoicing']);
    assert.equal(d.hero, "A small team's work, without hiring one");
    assert.equal(d.plans.find((p) => p.id === 'one').priceInr, 2999);
    assert.equal(d.plans.find((p) => p.id === 'social').priceInr, 8000);
    assert.equal(d.plans.find((p) => p.id === 'team').priceInr, 15000);
    assert.equal(d.trial.sample, true);
    assert.equal(d.trial.expired, false);
    assert.equal(d.invoices.filter((i) => i.state === 'paid').length, 3);
    assert.equal(d.invoices.filter((i) => i.state === 'overdue').length, 1);
    assert.equal(d.invoices.every((i) => i.gst == null), true);
    assert.equal(d.stats.patientsLast2Months, 11);
    assert.equal(d.stats.patientsTotal, 18);
    assert.equal(d.stats.recallsDue, 6);
    assert.equal(d.stats.highValue, 4);
    assert.equal(d.stats.bookingsWeek, 5);
    assert.equal(d.stats.noshows, 1);
    assert.equal(d.stats.enquiriesWeek, 3);
    assert.equal(d.stats.enquiriesOpen, 3);
    assert.ok(d.stats.revenue > 0);
    assert.equal(d.stats.reviews, 2);
    assert.equal(d.stats.posts, 2);
    assert.equal(d.stats.referralBookings, 1);
    const rec = d.stats.recovered;
    assert.equal(rec.reactivated, 4500);
    assert.ok(rec.total > 0);
    assert.equal(rec.total, Math.round((rec.bookings + rec.referrals + rec.reactivated + rec.invoices) * 100) / 100);
    assert.match(rec.method, /counted once/);
    const weekly = d.pending.find((x) => x.kind === 'weekly');
    assert.equal(weekly.agent, 'insights');
    assert.match(weekly.body, /recovered this month/i);
    assert.match(weekly.waLink, /^https:\/\/wa\.me\//);
    assert.match(weekly.body, /Nothing is sent until you approve/);
    assert.ok(weekly.approvalId);
    assert.match(d.patients.find((p) => p.name === 'Ananya Reddy').ref, /^[a-f0-9]{10}$/);
    assert.match(d.forecast.method, /28 days/);
    assert.match(d.forecast.method, /not a promise/);
    assert.ok(d.forecast.bookings > 0);
    assert.ok(d.forecast.revenue > d.forecast.collections);
    assert.ok(d.forecast.collections > 0);
    assert.equal(d.rules.everyDays, 7);
    assert.equal(d.rules.cap, 2);
    assert.equal(d.labels.service, 'Check-up');
    assert.equal(d.labels.place, 'clinic');
    assert.match(d.posts.map((p) => p.text).join(' '), /cleaning/);
    assert.match(d.summary.text, new RegExp('₹' + d.stats.revenue.toLocaleString('en-IN').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(d.connections.find((c) => c.id === 'eka').name, 'Eka.care');
    assert.equal(d.connections.find((c) => c.id === 'eka').status, 'demo');
    assert.equal(d.connections.find((c) => c.id === 'eka').label, 'Connected (demo)');
    assert.equal(d.stats.fromSoftware, 4);
    assert.equal(d.stats.broughtBackInr, 4500);
    assert.ok(d.stats.broughtBackNames.includes('Suresh Patil'));
    assert.ok(d.patients.some((p) => p.name === 'Suresh Patil' && p.source === 'Eka.care'));
    assert.ok(d.patients.every((p) => p.demo === true && /@example\.com$/.test(p.email)));
    assert.ok(d.pending.length >= 3);
    assert.ok(d.pending.every((x) => x.approvalId));

    const leads = await s.api('/api/leads?limit=50', undefined, token);
    assert.equal(leads.status, 200);
    assert.ok(leads.d.leads.some((l) => l.first_name === 'Ananya' && (l.tags || []).includes('demo')));

    const en = await s.api('/api/clinic/enquiries', { name: 'Test Enquiry', phone: '919000009999', message: 'Pain', channel: 'Phone' }, token);
    assert.equal(en.status, 200, JSON.stringify(en.d));
    assert.equal((await s.api('/api/clinic/enquiries/update', { id: en.d.enquiry.id, status: 'booked' }, token)).status, 200);
    assert.equal((await s.api('/api/clinic/enquiries/delete', { id: en.d.enquiry.id }, token)).status, 200);

    const patientId = d.patients[0].id;
    const ap = await s.api('/api/clinic/appointments', { patientId, at: new Date().toISOString(), service: 'Filling', fee: 1800, status: 'booked' }, token);
    assert.equal(ap.status, 200, JSON.stringify(ap.d));
    assert.equal((await s.api('/api/clinic/appointments/update', { id: ap.d.appointment.id, status: 'completed', fee: 2000 }, token)).status, 200);
    const rem = await s.api('/api/clinic/reminders', { appointmentId: ap.d.appointment.id }, token);
    assert.equal(rem.status, 200, JSON.stringify(rem.d));
    assert.equal(rem.d.draft.status, 'pending');
    assert.match(rem.d.draft.waLink, /^https:\/\/wa\.me\/919000000001\?text=/);
    assert.match(rem.d.draft.body, /does not send/i);
    assert.match(rem.d.draft.body, /Send window 09:00/);
    assert.match(rem.d.draft.body, /Quiet hours/);
    assert.equal((await s.api('/api/clinic/appointments/delete', { id: ap.d.appointment.id }, token)).status, 200);

    const lapsed = d.patients.find((p) => p.name === 'Suresh Patil');
    const follow = await s.api('/api/clinic/recall/draft', { patientId: lapsed.id }, token);
    assert.equal(follow.status, 200, JSON.stringify(follow.d));
    assert.match(follow.d.draft.waLink, /^https:\/\/wa\.me\//);
    assert.equal((await s.api('/api/clinic/rules', { cap: 1, everyDays: 7, from: '09:00', to: '20:00' }, token)).status, 200);
    const blocked = await s.api('/api/clinic/recall/draft', { patientId: lapsed.id }, token);
    assert.equal(blocked.status, 400, JSON.stringify(blocked.d));
    assert.match(blocked.d.message, /Cap is 1/);
    assert.equal((await s.api('/api/clinic/rules', { cap: 2, everyDays: 7, from: '09:00', to: '20:00' }, token)).status, 200);
    const review = d.pending.find((x) => x.kind === 'review');
    assert.match(review.waLink, /^https:\/\/wa\.me\//);
    assert.doesNotMatch(review.body + review.waLink, /graph\.facebook|twilio|sms/i);

    const edited = await s.api('/api/clinic/drafts/edit', { id: review.id, body: 'Edited review request for the owner. DEMO.' }, token);
    assert.equal(edited.status, 200, JSON.stringify(edited.d));
    const learned = await s.api('/api/clinic/reviews/draft', { patientId: d.patients[1].id }, token);
    assert.equal(learned.status, 200, JSON.stringify(learned.d));
    assert.equal(learned.d.draft.body, 'Edited review request for the owner. DEMO.');
    const resetTone = await s.api('/api/clinic/tone/reset', {}, token);
    assert.equal(resetTone.status, 200, JSON.stringify(resetTone.d));
    assert.equal(resetTone.d.toneExamples.length, 0);
    const stockReview = await s.api('/api/clinic/reviews/draft', { patientId: d.patients[2].id }, token);
    assert.match(stockReview.d.draft.body, /Google review/);
    assert.doesNotMatch(stockReview.d.draft.body, /Edited review request/);
    const approved = await s.api('/api/clinic/decide', { id: review.approvalId, decision: 'approve' }, token);
    assert.equal(approved.status, 200, JSON.stringify(approved.d));
    assert.equal(approved.d.approval.status, 'done');
    assert.match(approved.d.approval.result, /Nothing was sent/);
    const other = d.pending.find((x) => x.kind === 'followup');
    const rejected = await s.api('/api/clinic/decide', { id: other.approvalId, decision: 'reject' }, token);
    assert.equal(rejected.d.approval.status, 'declined');

    const post = await s.api('/api/clinic/social/draft', { topic: 'weekend cleaning slots', when: new Date(Date.now() + 2 * 864e5).toISOString() }, token);
    assert.equal(post.status, 200, JSON.stringify(post.d));
    assert.equal(post.d.post.status, 'draft');
    assert.match(post.d.post.text, /weekend cleaning slots/);
    const sum = await s.api('/api/clinic/insights/refresh', {}, token);
    assert.match(sum.d.summary.text, /Paid invoices this month: ₹/);
    const weeklyAgain = await s.api('/api/clinic/summary/weekly', {}, token);
    assert.equal(weeklyAgain.status, 200, JSON.stringify(weeklyAgain.d));
    assert.equal(weeklyAgain.d.draft.kind, 'weekly');
    assert.equal(weeklyAgain.d.draft.id, weekly.id);
    assert.match(weeklyAgain.d.draft.body, /recovered this month/i);
    const billTo = d.patients.find((p) => p.name === 'Rohan Mehta');
    const made = await s.api('/api/clinic/invoices', { patientId: billTo.id, items: [{ desc: 'Filling', qty: 1, rate: 1800 }], gst: '' }, token);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    assert.equal(made.d.invoice.gst, null);
    assert.equal(made.d.invoice.total, 1800);
    assert.equal(made.d.invoice.state, 'unpaid');
    const pdf = await fetch(s.base + '/api/clinic/invoices/' + made.d.invoice.id + '/pdf', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /pdf/);
    assert.match(Buffer.from(await pdf.arrayBuffer()).toString('latin1'), /^%PDF-1.4/);
    const remind = await s.api('/api/clinic/invoices/remind', { id: made.d.invoice.id }, token);
    assert.match(remind.d.draft.waLink, /^https:\/\/wa\.me\//);
    assert.match(remind.d.draft.body, /Email draft/);
    assert.equal((await s.api('/api/clinic/invoices/update', { id: made.d.invoice.id, status: 'paid' }, token)).status, 200);
    const paid = await s.api('/api/clinic', undefined, token);
    assert.ok(paid.d.stats.revenue >= 15200 + 1800);

    const exp = await fetch(s.base + '/api/clinic/export', { headers: { authorization: 'Bearer ' + token } });
    const exported = JSON.parse(Buffer.from(await exp.arrayBuffer()).toString('utf8'));
    assert.equal(exported.clinic.formToken, 'redacted');
    assert.ok(exported.clinic.patients.some((p) => p.name === 'Ananya Reddy'));
    assert.equal((await s.api('/api/clinic/checklist', { id: 'form' }, token)).d.checklist.find((x) => x.id === 'form').done, true);

    const csv = 'type,name,phone,email,last_visit,value,when,service,status,fee\npatient,Demo Import,919000000099,import@example.com,2026-10-01,1800,,,,\nappointment,Demo Import,919000000099,,,,2026-10-28T05:30:00.000Z,Check-up,booked,900\n';
    const imp = await s.api('/api/clinic/import', { csv }, token);
    assert.equal(imp.status, 200, JSON.stringify(imp.d));
    assert.equal(imp.d.patients, 1);
    assert.equal(imp.d.appointments, 1);
    assert.ok(imp.d.clinic.patients.some((p) => p.name === 'Demo Import' && p.demo === false));

    const formToken = d.formPath.split('/').pop();
    const html = await fetch(s.base + '/book/' + formToken);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Book a visit/);
    const sent = await fetch(s.base + '/api/clinic/form/' + formToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Website Guest', phone: '919000008888', message: 'Cleaning please', service: 'Cleaning' }) });
    assert.equal(sent.status, 200, await sent.clone().text());
    const after = await s.api('/api/clinic', undefined, token);
    assert.ok(after.d.enquiries.some((e) => e.name === 'Website Guest' && e.source === 'Website form'));
    const ananya = after.d.patients.find((p) => p.name === 'Ananya Reddy');
    const refPage = await fetch(s.base + '/book/' + formToken + '?ref=' + ananya.ref);
    assert.match(await refPage.text(), new RegExp('name="ref" value="' + ananya.ref + '"'));
    const referred = await s.api('/api/clinic/referrals/draft', { patientId: ananya.id }, token);
    assert.equal(referred.status, 200, JSON.stringify(referred.d));
    assert.equal(referred.d.draft.agent, 'social');
    assert.equal(referred.d.draft.kind, 'referral');
    assert.match(referred.d.draft.body, /Smile Dental \(sample\)/);
    assert.match(referred.d.draft.body, /Check-up/);
    assert.match(referred.d.draft.body, new RegExp('/book/' + formToken + '\\?ref=' + ananya.ref));
    assert.match(referred.d.draft.waLink, /^https:\/\/wa\.me\/919000000001/);
    const booked = await fetch(s.base + '/api/clinic/form/' + formToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Referred Guest', phone: '919000007777', message: 'From a friend', service: 'Check-up', when: new Date(Date.now() + 2 * 864e5).toISOString(), ref: ananya.ref }) });
    assert.equal(booked.status, 200, await booked.clone().text());
    const withRef = await s.api('/api/clinic', undefined, token);
    assert.ok(withRef.d.enquiries.some((e) => e.name === 'Referred Guest' && e.source === 'Referral' && e.referredBy === 'Ananya Reddy'));
    assert.ok(withRef.d.appointments.some((a) => a.referral && a.referredBy === 'Ananya Reddy' && a.status === 'booked'));
    assert.equal(withRef.d.stats.referralBookings, 2);
    assert.ok(withRef.d.pending.some((x) => x.kind === 'referral' && x.approvalId));
    const kv = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    const approvalRows = JSON.parse(Object.values(kv).find((r) => r && r.k && r.k.startsWith('as_appr:')).v);
    assert.equal(approvalRows.find((a) => /Forwardable referral/.test(a.summary)).kind, 'draft');
    assert.equal(approvalRows.find((a) => /Weekly WhatsApp summary/.test(a.summary)).kind, 'draft');
    const crm = await s.api('/api/leads?q=Website', undefined, token);
    assert.ok(crm.d.leads.some((l) => l.first_name === 'Website'));
    assert.equal((await fetch(s.base + '/book/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);

    const chat = await s.api('/api/clinic/chat', { message: 'how many patients last 2 months', run_id: 'clinic-run-01' }, token);
    assert.equal(chat.status, 200, JSON.stringify(chat.d));
    assert.equal(chat.d.mode, 'agent');
    assert.match(chat.d.answer, new RegExp('There are ' + chat.d.facts.patientsLast2Months + ' patients in the last 2 months'));
    assert.ok(chat.d.facts.patientsLast2Months >= 11);

    const rules = await s.api('/api/clinic/rules', { from: '10:00', to: '19:00', tone: 'Short and kind' }, token);
    assert.equal(rules.d.rules.from, '10:00');
    const paused = await s.api('/api/clinic/agent', { key: 'front', paused: true }, token);
    assert.equal(paused.d.paused, true);

    const re = await s.api('/api/clinic/role', { role: 'realestate' }, token);
    assert.equal(re.d.agents[0].name, 'Lead Desk');
    assert.equal(re.d.usage.sample, true);
    assert.ok(re.d.usage.runs.filter((r) => r.source === 'sample').length >= 6);
    assert.ok(re.d.forecast.collections > 0);
    assert.equal(re.d.agents[1].name, 'Lead Follow-up');
    assert.equal(re.d.labels.who, 'leads');
    assert.equal(re.d.biz, 'Sample Realty');
    assert.match(re.d.posts.map((p) => p.text).join(' '), /2BHK/);
    assert.doesNotMatch(re.d.appointments.map((a) => a.service).join(' '), /Check-up|Cleaning|RCT/);
    assert.equal(re.d.stats.referralBookings, 1);
    assert.ok(re.d.patients.some((p) => p.name === 'Ananya Reddy'));
    const chat2 = await s.api('/api/clinic/chat', { message: 'how many leads in the last 2 months' }, token);
    assert.match(chat2.d.answer, /leads in the last 2 months/);
    const usage = await s.api('/api/clinic/usage', undefined, token);
    assert.equal(usage.status, 200, JSON.stringify(usage.d));
    assert.ok(usage.d.usage.calls >= 1, JSON.stringify(usage.d));
    assert.ok(usage.d.usage.tokens > 0);
    assert.equal(usage.d.usage.sample, true);
    assert.ok(usage.d.usage.runs.filter((r) => r.source === 'sample').length >= 6);
    assert.ok(usage.d.usage.costInr > 0);
    assert.ok(usage.d.usage.byAgent.some((a) => a.agent === 'social'));
    assert.ok(usage.d.usage.runs.some((r) => r.source === 'model' && r.tokensIn > 0));
    assert.equal(usage.d.usage.inrPerUsd, 84);
    assert.equal(usage.d.plans.find((p) => p.id === 'one').priceInr, 2999);
    assert.equal(usage.d.plans.find((p) => p.id === 'social').priceInr, 8000);
  } finally { await s.stop(); }
});

test('every industry pack creates the same six screens with its own labels', async () => {
  const s = await startServer(MOCK);
  try {
    const meta = await fetch(s.base + '/api/clinic/meta').then((r) => r.json());
    assert.equal(meta.hero, "A small team's work, without hiring one");
    assert.equal(typeof meta.google, 'boolean');
    assert.equal(meta.plans.length, 3);
    assert.deepEqual(meta.plans.map((p) => p.priceInr), [2999, 8000, 15000]);
    const ids = meta.packs.map((p) => p.id);
    assert.deepEqual(ids, ['dental', 'aesthetic', 'coach', 'realestate', 'studio', 'home', 'institute']);
    for (const pack of meta.packs) {
      const email = pack.id + '-owner@example.com';
      const signed = await s.api('/api/auth/signup', { email, name: pack.title, password: PW });
      assert.equal(signed.status, 200, JSON.stringify(signed.d));
      const prof = await s.api('/api/clinic/profile', { biz: pack.title + ' Co', city: 'Hyderabad', services: 'Sample service', prices: '₹1000', audience: 'Local owners', offer: 'A visit this week' }, signed.d.token);
      assert.equal(prof.status, 200, JSON.stringify(prof.d));
      const clinic = await s.api('/api/clinic/role', { role: pack.id }, signed.d.token);
      assert.equal(clinic.status, 200, JSON.stringify(clinic.d));
      assert.equal(clinic.d.role, pack.id);
      assert.equal(clinic.d.biz, pack.title + ' Co');
      assert.equal(clinic.d.agents.length, 6);
      assert.deepEqual(clinic.d.agents.map((a) => a.name), pack.agents);
      assert.equal(clinic.d.agents[5].key, 'billing');
      assert.ok(clinic.d.stats.revenue > 0);
      const rec = clinic.d.stats.recovered;
      assert.equal(rec.reactivated, 4500);
      assert.equal(rec.total, Math.round((rec.bookings + rec.referrals + rec.reactivated + rec.invoices) * 100) / 100);
      const weekly = clinic.d.pending.find((x) => x.kind === 'weekly');
      assert.equal(weekly.agent, 'insights');
      assert.match(weekly.waLink, /^https:\/\/wa\.me\//);
      assert.match(weekly.body, /recovered this month/i);
      if (pack.id !== 'dental') assert.doesNotMatch(weekly.body, /Check-up|cleaning|RCT|patient/i);
      assert.equal(clinic.d.connections.find((c) => c.id === 'eka').name, 'Eka.care');
      assert.equal(clinic.d.connections.find((c) => c.id === 'eka').status, 'needs_credentials');
      assert.equal(clinic.d.connections.find((c) => c.id === 'eka').label, 'Available, connect with credentials');
      const word = {
        dental: ['patients', 'Check-up', 'clinic', /cleaning/],
        aesthetic: ['clients', 'Skin consult', 'clinic', /glow/],
        coach: ['clients', 'Discovery call', 'practice', /discovery/],
        realestate: ['leads', 'Site visit', 'desk', /2BHK/],
        studio: ['members', 'Class', 'studio', /class/],
        home: ['customers', 'Site visit', 'business', /room/],
        institute: ['students', 'Trial class', 'centre', /trial/],
      }[pack.id];
      const refPerson = clinic.d.patients.find((p) => p.name === 'Ananya Reddy');
      const refDraft = await s.api('/api/clinic/referrals/draft', { patientId: refPerson.id }, signed.d.token);
      assert.equal(refDraft.status, 200, JSON.stringify(refDraft.d));
      assert.equal(refDraft.d.draft.kind, 'referral');
      assert.equal(refDraft.d.draft.agent, 'social');
      assert.match(refDraft.d.draft.body, new RegExp(word[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(refDraft.d.draft.waLink, /^https:\/\/wa\.me\//);
      assert.match(refDraft.d.draft.body, /\/book\/[a-f0-9]{32}\?ref=[a-f0-9]{10}/);
      if (pack.id !== 'dental') assert.doesNotMatch(refDraft.d.draft.body, /Check-up|cleaning|RCT|patient/i);
      assert.equal(clinic.d.connections.find((c) => c.id === 'other').detail.includes('CSV'), true);
      assert.equal(clinic.d.connections.find((c) => c.id === 'gcal').status, 'placeholder');
      assert.equal(clinic.d.connections.find((c) => c.id === 'whatsapp').status, 'ready');
      assert.ok(clinic.d.patients.some((p) => p.name === 'Ananya Reddy' && p.demo === true));
      assert.equal(clinic.d.labels.who, word[0]);
      assert.equal(clinic.d.labels.service, word[1]);
      assert.equal(clinic.d.labels.place, word[2]);
      assert.match(clinic.d.posts.map((p) => p.text).join(' '), word[3]);
      assert.match(clinic.d.labels.example, word[3]);
      if (pack.id !== 'dental') assert.doesNotMatch(JSON.stringify(clinic.d.agents) + clinic.d.posts.map((p) => p.text).join(' '), /RCT|Patient Recall|receptionist|Check-up/);
      if (pack.id === 'realestate') assert.equal(clinic.d.labels.highValue, 10000000);
    }
    const coach = await s.api('/api/auth/login', { email: 'coach-owner@example.com', password: PW });
    const home = await s.api('/api/clinic/role', { role: 'home' }, coach.d.token);
    assert.equal(home.status, 200, JSON.stringify(home.d));
    assert.equal(home.d.biz, 'Coach or consultant Co');
    assert.match(home.d.posts.map((p) => p.text).join(' '), /room/);
    assert.doesNotMatch(home.d.appointments.map((a) => a.service).join(' '), /Discovery/);
    assert.equal(home.d.labels.service, 'Site visit');
    const plain = await s.api('/api/auth/signup', { email: 'sample-switch@example.com', name: 'Sample Switch', password: PW });
    const dental = await s.api('/api/clinic/role', { role: 'dental' }, plain.d.token);
    assert.equal(dental.d.biz, 'Smile Dental (sample)');
    const realty = await s.api('/api/clinic/role', { role: 'realestate' }, plain.d.token);
    assert.equal(realty.d.biz, 'Sample Realty');
    assert.match(realty.d.posts.map((p) => p.text).join(' '), /2BHK/);
    assert.doesNotMatch(realty.d.appointments.map((a) => a.service).join(' '), /Check-up|Cleaning|RCT/);
  } finally { await s.stop(); }
});

test('an ended trial is read-only, still shows plans, and does not take a card', async () => {
  const s = await startServer({ ...MOCK, CLINIC_TRIAL_DAYS: '0' });
  try {
    const signed = await s.api('/api/auth/signup', { email: 'trial-ended@example.com', name: 'Trial Owner', password: PW });
    assert.equal(signed.status, 200, JSON.stringify(signed.d));
    const clinic = await s.api('/api/clinic/role', { role: 'coach' }, signed.d.token);
    assert.equal(clinic.status, 200, JSON.stringify(clinic.d));
    assert.equal(clinic.d.trial.expired, true);
    assert.equal(clinic.d.trial.daysLeft, 0);
    assert.equal(clinic.d.trial.noCard, true);
    assert.equal(clinic.d.plans.find((p) => p.id === 'one').priceInr, 2999);
    const write = await s.api('/api/clinic/enquiries', { name: 'Asha Rao', phone: '919000000111', message: 'Hello' }, signed.d.token);
    assert.equal(write.status, 403, JSON.stringify(write.d));
    assert.match(write.d.message, /read-only/);
    const seen = await s.api('/api/clinic', undefined, signed.d.token);
    assert.equal(seen.status, 200);
    assert.ok(seen.d.patients.length > 0);
    const plan = await s.api('/api/clinic/plan', { plan: 'one' }, signed.d.token);
    assert.equal(plan.status, 200, JSON.stringify(plan.d));
    assert.equal(plan.d.trial.plan, 'one');
    assert.equal(plan.d.trial.expired, true);
  } finally { await s.stop(); }
});

test('another account cannot read or decide the clinic, and delete removes the form', async () => {
  const s = await startServer(MOCK);
  try {
    const a = await s.api('/api/auth/signup', { email: 'owner-a@example.com', name: 'Owner A', password: PW });
    const b = await s.api('/api/auth/signup', { email: 'owner-b@example.com', name: 'Owner B', password: PW });
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, a.d.token);
    assert.equal(clinic.status, 200, JSON.stringify(clinic.d));
    const approval = clinic.d.pending[0].approvalId;
    const secretName = 'Ananya Reddy';
    const peek = await s.api('/api/clinic', undefined, b.d.token);
    assert.equal(peek.d.needsRole, true);
    assert.doesNotMatch(JSON.stringify(peek.d), new RegExp(secretName));
    assert.equal((await s.api('/api/clinic/decide', { id: approval, decision: 'approve' }, b.d.token)).status, 404);
    assert.equal((await s.api('/api/clinic/enquiries/delete', { id: 1 }, b.d.token)).status, 409);
    const still = await s.api('/api/clinic', undefined, a.d.token);
    assert.equal(still.d.pending.find((x) => x.approvalId === approval).status, 'pending');

    const token = clinic.d.formPath.split('/').pop();
    assert.match(await (await fetch(s.base + '/book/' + token)).text(), /Book a visit/);
    const del = await s.api('/api/auth/delete', { password: PW }, a.d.token);
    assert.equal(del.status, 200, JSON.stringify(del.d));
    assert.equal((await fetch(s.base + '/book/' + token)).status, 404);
    const kv = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    const left = Object.values(kv).filter((r) => r && r.v && String(r.v).includes('owner-a@example.com'));
    assert.deepEqual(left.map((r) => r.k), []);
  } finally { await s.stop(); }
});
