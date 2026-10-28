// 15-minute setup wizard and the book-a-setup-call request. Nothing is emailed or sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { parsePaste } from '../lib/clinic.js';

const PW = 'Clinic-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1' };
const KEY = 'sk-mock-setup-' + 'k'.repeat(24) + 'wxyz';
const html = () => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'clinic.html'), 'utf8');

test('a paste of name and phone becomes customer rows', () => {
  const rows = parsePaste('Name, phone\nAsha Rao, 919000000111, asha@example.com\n, 919\nskip\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Asha Rao');
  assert.equal(rows[0].phone, '919000000111');
  assert.equal(rows[0].email, 'asha@example.com');
  assert.deepEqual(parsePaste(''), []);
});

test('the setup screen is a wizard plus a call request and an optional AI key', () => {
  const src = html();
  assert.match(src, /15-minute setup/);
  assert.match(src, /Book a setup call/);
  assert.match(src, /Use your own AI key/);
  assert.match(src, /data-act="setup-key"/);
  assert.doesNotMatch(src, /data-act="setup-key-skip"/);
  assert.doesNotMatch(src, /Choose this plan/);
  assert.match(src, /data-act="setup-tone"/);
  assert.match(src, /data-act="setup-call"/);
  assert.match(src, /Nothing was emailed/);
  assert.match(src, /let wiz = 1, wizPaste = '', wizCsv = '', wizPhone = '', wizTone = '', wizDrafts = \[\]/);
});

test('finishing setup queues three approval drafts and does not send them', async () => {
  const s = await startServer(MOCK);
  try {
    const signed = await s.api('/api/auth/signup', { email: 'setup-owner@example.com', name: 'Setup Owner', password: PW });
    assert.equal(signed.status, 200, JSON.stringify(signed.d));
    const token = signed.d.token;
    const early = await s.api('/api/clinic/setup/finish', { tone: 'Hi', phone: '919812340099', ack: true }, token);
    assert.equal(early.status, 409, JSON.stringify(early.d));

    const role = await s.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.status, 200, JSON.stringify(role.d));
    assert.equal(role.d.agents.length, 6);
    const profile = await s.api('/api/clinic/profile', {
      biz: 'North Studio', city: 'Pune', services: 'Discovery calls and follow-ups', prices: '₹4,000 a session', audience: 'Founders', offer: 'A Thursday session',
    }, token);
    assert.equal(profile.status, 200, JSON.stringify(profile.d));
    assert.equal(profile.d.biz, 'North Studio');

    const tone = 'Hi, just checking in. Want me to hold Thursday?';
    const paste = 'Asha Rao, 919000000111, asha@example.com';
    const csv = 'type,name,phone\npatient,Meera Iyer,919000000222\n';
    const blocked = await s.api('/api/clinic/setup/finish', { tone, phone: '919812340099', paste, csv, ack: true }, token);
    assert.equal(blocked.status, 400, JSON.stringify(blocked.d));
    assert.equal(blocked.d.error, 'needs_ai_key');
    const saved = await s.api('/api/ai/key', { provider: 'openrouter', key: KEY }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved.d));
    assert.equal(saved.d.byok.hint, '…wxyz');
    const done = await s.api('/api/clinic/setup/finish', { tone, phone: '919812340099', paste, csv, ack: true }, token);
    assert.equal(done.status, 200, JSON.stringify(done.d));
    const drafts = done.d.drafts;
    assert.equal(drafts.length, 3);
    assert.ok(drafts.every((d) => d.setup === true && d.status === 'pending'));
    assert.deepEqual(drafts.map((d) => d.agent).sort(), ['recall', 'reviews', 'social']);
    const text = drafts.map((d) => d.body).join('\n');
    assert.match(text, /Asha Rao/);
    assert.match(text, /Meera Iyer/);
    assert.match(text, /North Studio/);
    assert.doesNotMatch(text, /Check-up|cleaning|RCT|patient/i);
    const linked = drafts.filter((d) => d.waLink);
    assert.equal(linked.length, 2);
    assert.ok(linked.every((d) => d.waLink.startsWith('https://wa.me/')));
    const clinic = done.d.clinic;
    assert.equal(clinic.phone, '919812340099');
    assert.equal(clinic.rules.tone, tone);
    assert.equal(clinic.setup.minutes, 15);
    assert.equal(clinic.setup.ack, true);
    assert.equal(clinic.agents.length, 6);
    const asha = clinic.patients.find((p) => p.name === 'Asha Rao');
    const meera = clinic.patients.find((p) => p.name === 'Meera Iyer');
    assert.equal(asha.demo, false);
    assert.equal(asha.source, 'Paste');
    assert.equal(meera.demo, false);
    assert.equal(meera.source, 'CSV');
    assert.equal(clinic.drafts.filter((d) => d.setup).length, 3);
    assert.equal(clinic.pending.filter((d) => d.setup).length, 3);

    const again = await s.api('/api/clinic/setup/finish', { tone, phone: '919812340099', paste, csv, ack: true }, token);
    assert.equal(again.status, 200, JSON.stringify(again.d));
    assert.equal(again.d.clinic.drafts.filter((d) => d.setup).length, 3);
    assert.equal(again.d.drafts.length, 3);

    const groups = await s.api('/api/groups', undefined, token);
    assert.equal(groups.status, 200, JSON.stringify(groups.d));
    const ids = new Set(drafts.map((d) => d.approvalId));
    const rows = (groups.d.approvals || []).filter((a) => ids.has(a.id));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((a) => a.kind === 'draft'));

    const follow = drafts.find((d) => d.kind === 'followup');
    const decided = await s.api('/api/clinic/decide', { id: follow.approvalId, decision: 'approve' }, token);
    assert.equal(decided.status, 200, JSON.stringify(decided.d));
    assert.match(decided.d.approval.result, /Nothing was sent/);
    assert.doesNotMatch(decided.d.approval.result, /Sent on WhatsApp/);
  } finally { await s.stop(); }
});

test('booking a setup call stores the request and does not email it', async () => {
  const s = await startServer(MOCK);
  try {
    const signed = await s.api('/api/auth/signup', { email: 'call-owner@example.com', name: 'Call Owner', password: PW });
    const token = signed.d.token;
    const missing = await s.api('/api/clinic/setup/call', { name: 'Call Owner' }, token);
    assert.equal(missing.status, 400);
    const booked = await s.api('/api/clinic/setup/call', { name: 'Call Owner', phone: '919800001111', when: 'Tuesday 11:00', note: 'Help with the first drafts' }, token);
    assert.equal(booked.status, 200, JSON.stringify(booked.d));
    assert.equal(booked.d.sent, false);
    assert.equal(booked.d.ok, true);
    assert.equal(booked.d.setupCall.phone, '919800001111');
    assert.equal(booked.d.setupCall.when, 'Tuesday 11:00');
    const before = await s.api('/api/clinic', undefined, token);
    assert.equal(before.d.needsRole, true);
    assert.equal(before.d.setupCall.when, 'Tuesday 11:00');
    const role = await s.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.d.setupCall.phone, '919800001111');
    assert.equal(role.d.setupCall.note, 'Help with the first drafts');
    assert.equal(role.d.agents.length, 6);
  } finally { await s.stop(); }
});

test('setup finish needs a saved AI key, and a setup call still stores without sending', async () => {
  const s = await startServer(MOCK);
  try {
    const signed = await s.api('/api/auth/signup', { email: 'setup-key@example.com', name: 'Key Setup', password: PW });
    const token = signed.d.token;
    await s.api('/api/clinic/profile', { biz: 'Key Desk', city: 'Pune', services: 'Sessions', prices: '₹1000', audience: 'Owners', offer: 'This week' }, token);
    const role = await s.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.d.biz, 'Key Desk');
    const finish = await s.api('/api/clinic/setup/finish', { tone: 'Short and warm', phone: '919812340099', ack: true }, token);
    assert.equal(finish.status, 400, JSON.stringify(finish.d));
    assert.equal(finish.d.error, 'needs_ai_key');
    const call = await s.api('/api/clinic/setup/call', { name: 'Key Setup', phone: '919800002222', when: 'Friday 16:00' }, token);
    assert.equal(call.status, 200, JSON.stringify(call.d));
    assert.equal(call.d.sent, false);
    assert.equal(call.d.setupCall.when, 'Friday 16:00');
  } finally { await s.stop(); }
});

test('the business profile still comes before industry on the original path', async () => {
  const s = await startServer(MOCK);
  try {
    const signed = await s.api('/api/auth/signup', { email: 'profile-path@example.com', name: 'Profile Path', password: PW });
    const token = signed.d.token;
    const prof = await s.api('/api/clinic/profile', { biz: 'Profile First', city: 'Jaipur', services: 'Site visits', prices: '₹2000', audience: 'Home owners', offer: 'A visit this week' }, token);
    assert.equal(prof.status, 200, JSON.stringify(prof.d));
    assert.equal(prof.d.biz, 'Profile First');
    const role = await s.api('/api/clinic/role', { role: 'home' }, token);
    assert.equal(role.status, 200, JSON.stringify(role.d));
    assert.equal(role.d.biz, 'Profile First');
    assert.equal(role.d.setup, null);
    assert.equal(role.d.agents.length, 6);
  } finally { await s.stop(); }
});
