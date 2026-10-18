import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { normWhatsApp, normEmail, validateEntry } from '../lib/waitlist.js';

const STRONG = 'Correct-Horse-Battery-42';

test('WhatsApp numbers are normalised to E.164', () => {
  assert.equal(normWhatsApp('98765 43210'), '+919876543210');
  assert.equal(normWhatsApp('098765-43210'), '+919876543210');
  assert.equal(normWhatsApp('+91 98765 43210'), '+919876543210');
  assert.equal(normWhatsApp('919876543210'), '+919876543210');
  assert.equal(normWhatsApp('+44 7700 900123'), '+447700900123');
  for (const bad of ['', '12345', '5876543210', '+91 12345', 'abc', '+0123456789']) assert.equal(normWhatsApp(bad), '', bad);
  assert.equal(validateEntry({ name: 'A', businessType: '', city: '', whatsapp: '1' }).ok, false);
});

test('waitlist email is required and validated', () => {
  assert.equal(normEmail('  Ravi.K@Shop.IN '), 'ravi.k@shop.in');
  for (const bad of ['', 'x@y', 'a@@b.com', 'a..b@c.com', 'ab@c.d', 'no spaces@x.com', 'a'.repeat(120) + '@x.com']) assert.equal(normEmail(bad), '', bad);
  const base = { name: 'Ravi', businessType: 'Agency', city: 'Pune', whatsapp: '9876543210', consent: true };
  const missing = validateEntry(base);
  assert.equal(missing.ok, false); assert.ok(missing.errs.email);
  const ok = validateEntry({ ...base, email: 'Ravi@Example.com' });
  assert.equal(ok.ok, true); assert.equal(ok.entry.email, 'ravi@example.com');
});

test('waitlist: public sign-up, unique by email or number (upsert), admin-only list and CSV', async (t) => {
  const s = await startServer({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: STRONG });
  t.after(s.stop);
  const base = { name: 'Ravi Kumar', email: 'ravi@example.com', businessType: 'Salon / wellness', city: 'Hyderabad', whatsapp: '98765 43210', consent: true };
  const r1 = await s.api('/api/waitlist', base);
  assert.equal(r1.status, 200); assert.equal(r1.d.again, false);
  const r2 = await s.api('/api/waitlist', { ...base, city: 'Vijayawada', whatsapp: '+91 98765-43210' });
  assert.equal(r2.d.again, true);
  const bad = await s.api('/api/waitlist', { ...base, whatsapp: '123', consent: false, email: 'nope' });
  assert.equal(bad.status, 400); assert.ok(bad.d.fields.whatsapp); assert.ok(bad.d.fields.consent); assert.ok(bad.d.fields.email);
  const noEmail = await s.api('/api/waitlist', { ...base, email: '' });
  assert.equal(noEmail.status, 400); assert.ok(noEmail.d.fields.email, 'email is required');
  // same email, new WhatsApp number: same person, so the row moves to the new number (no duplicate)
  const r3 = await s.api('/api/waitlist', { ...base, city: 'Vijayawada', whatsapp: '91234 56780', email: 'RAVI@example.com' });
  assert.equal(r3.d.again, true);
  // same number, new email: updates the row and frees the old email
  const r4 = await s.api('/api/waitlist', { ...base, city: 'Vijayawada', whatsapp: '91234 56780', email: 'ravi.k@shop.in' });
  assert.equal(r4.d.again, true);
  // a different person can now use the freed email
  const other = await s.api('/api/waitlist', { ...base, name: 'Asha', whatsapp: '9988776655', email: 'ravi@example.com', city: 'Pune' });
  assert.equal(other.d.again, false);
  const hp = await s.api('/api/waitlist', { ...base, whatsapp: '9123456789', website: 'http://spam' });
  assert.equal(hp.status, 200);
  assert.equal((await s.api('/api/waitlist')).status, 401, 'signed-out list is refused');
  const cust = await s.api('/api/auth/signup', { email: 'c@example.com', name: 'C', password: 'customer-pass-1' });
  assert.equal((await s.api('/api/waitlist', undefined, cust.d.token)).status, 403, 'customers cannot list');
  const kv = await s.api('/api/kv', undefined, cust.d.token);
  assert.ok(!kv.d.items.some((it) => it.k.startsWith('as_wl')), 'waitlist rows and email index never go through /api/kv');
  const adm = await s.api('/api/auth/login', { email: 'boss@example.com', password: STRONG });
  const list = await s.api('/api/waitlist', undefined, adm.d.token);
  assert.equal(list.status, 200); assert.equal(list.d.count, 2, 'honeypot row not stored, duplicates merged');
  const ravi = list.d.entries.find((e) => e.name === 'Ravi Kumar');
  assert.equal(ravi.city, 'Vijayawada'); assert.equal(ravi.whatsapp, '+919123456780'); assert.equal(ravi.email, 'ravi.k@shop.in'); assert.equal(ravi.n, 4);
  assert.equal(list.d.entries.find((e) => e.name === 'Asha').email, 'ravi@example.com');
  const csv = await fetch(s.base + '/api/waitlist?format=csv', { headers: { authorization: 'Bearer ' + adm.d.token } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^at,name,email,whatsapp,businessType,city,/);
  assert.match(text, /Ravi Kumar,ravi\.k@shop\.in,\+919123456780,Salon \/ wellness,Vijayawada/);
  const page = await fetch(s.base + '/waitlist');
  assert.equal(page.status, 200); assert.match(await page.text(), /Join the waitlist/);
});
