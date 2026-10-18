import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { normWhatsApp, validateEntry } from '../lib/waitlist.js';

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

test('waitlist: public sign-up, de-duplicated by number, admin-only list and CSV', async (t) => {
  const s = await startServer({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: STRONG });
  t.after(s.stop);
  const base = { name: 'Ravi Kumar', businessType: 'Salon / wellness', city: 'Hyderabad', whatsapp: '98765 43210', consent: true };
  const r1 = await s.api('/api/waitlist', base);
  assert.equal(r1.status, 200); assert.equal(r1.d.again, false);
  const r2 = await s.api('/api/waitlist', { ...base, city: 'Vijayawada', whatsapp: '+91 98765-43210' });
  assert.equal(r2.d.again, true);
  const bad = await s.api('/api/waitlist', { ...base, whatsapp: '123', consent: false });
  assert.equal(bad.status, 400); assert.ok(bad.d.fields.whatsapp); assert.ok(bad.d.fields.consent);
  const hp = await s.api('/api/waitlist', { ...base, whatsapp: '9123456789', website: 'http://spam' });
  assert.equal(hp.status, 200);
  assert.equal((await s.api('/api/waitlist')).status, 401, 'signed-out list is refused');
  const cust = await s.api('/api/auth/signup', { email: 'c@example.com', name: 'C', password: 'customer-pass-1' });
  assert.equal((await s.api('/api/waitlist', undefined, cust.d.token)).status, 403, 'customers cannot list');
  const kv = await s.api('/api/kv', undefined, cust.d.token);
  assert.ok(!kv.d.items.some((it) => it.k.startsWith('as_wl:')), 'waitlist rows never go through /api/kv');
  const adm = await s.api('/api/auth/login', { email: 'boss@example.com', password: STRONG });
  const list = await s.api('/api/waitlist', undefined, adm.d.token);
  assert.equal(list.status, 200); assert.equal(list.d.count, 1, 'honeypot row not stored, duplicate merged');
  assert.equal(list.d.entries[0].city, 'Vijayawada'); assert.equal(list.d.entries[0].whatsapp, '+919876543210');
  const csv = await fetch(s.base + '/api/waitlist?format=csv', { headers: { authorization: 'Bearer ' + adm.d.token } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Ravi Kumar,Salon \/ wellness,Vijayawada,\+919876543210/);
  const page = await fetch(s.base + '/waitlist');
  assert.equal(page.status, 200); assert.match(await page.text(), /Join the waitlist/);
});
