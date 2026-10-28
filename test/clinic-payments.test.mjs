// Clinic payment links: UPI fallback, Razorpay test Payment Links, signed webhook, demo simulate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { razorpaySignature } from '../lib/billing.js';
import { paymentEnv, upiDeepLink, createRazorpayLink, paymentLinkId } from '../lib/clinic-payments.js';

const PW = 'Clinic-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1' };
const KEY = 'rzp_test_unitkey';
const SECRET = 'unit_secret_value';
const WHSEC = 'whsec_unit_value';

test('a UPI deep link is the fallback, and only a test Razorpay key creates a Payment Link', async () => {
  const link = upiDeepLink({ vpa: 'sample@upi', name: 'Smile Dental', amount: 1800, note: 'INV-1006' });
  assert.match(link, /^upi:\/\/pay\?pa=sample%40upi&pn=/);
  assert.match(link, /am=1800\.00&cu=INR/);
  assert.equal(upiDeepLink({ vpa: 'not-a-vpa', amount: 10 }), '');
  assert.equal(paymentEnv({}).configured, false);
  assert.equal(paymentEnv({ RAZORPAY_KEY_ID: 'rzp_live_nope', RAZORPAY_KEY_SECRET: SECRET }).configured, false);
  assert.equal(paymentEnv({ RAZORPAY_KEY_ID: 'rzp_live_nope', RAZORPAY_KEY_SECRET: SECRET }).liveBlocked, true);
  assert.equal(await createRazorpayLink({ amountInr: 1800, reference: 'INV-1006', env: {} }), null);
  let called = 0;
  const live = await createRazorpayLink({
    amountInr: 1800, reference: 'INV-1006',
    env: { RAZORPAY_KEY_ID: 'rzp_live_nope', RAZORPAY_KEY_SECRET: SECRET },
    fetchImpl: async () => { called += 1; throw new Error('must not call'); },
  });
  assert.equal(live, null);
  assert.equal(called, 0);
  const mocked = await createRazorpayLink({
    amountInr: 1800, reference: 'INV-1006',
    env: { ...MOCK, CLINIC_PAY_MOCK: 'on', RAZORPAY_KEY_ID: KEY, RAZORPAY_KEY_SECRET: SECRET },
    fetchImpl: async () => { called += 1; throw new Error('must not call'); },
  });
  assert.equal(mocked.url, 'https://rzp.io/i/mockINV1006');
  assert.equal(called, 0);
  assert.doesNotMatch(JSON.stringify(mocked), new RegExp(SECRET));
  let sent = null;
  const made = await createRazorpayLink({
    amountInr: 1800, description: 'Smile Dental INV-1006', name: 'Rohan Mehta', phone: '919000000002', reference: 'INV-1006',
    env: { RAZORPAY_KEY_ID: KEY, RAZORPAY_KEY_SECRET: SECRET },
    fetchImpl: async (url, opts) => {
      sent = { url, opts };
      return { ok: true, status: 200, json: async () => ({ id: 'plink_TestLink1', short_url: 'https://rzp.io/i/realtest' }) };
    },
  });
  assert.equal(sent.url, 'https://api.razorpay.com/v1/payment_links');
  assert.equal(sent.opts.headers.authorization, 'Basic ' + Buffer.from(KEY + ':' + SECRET).toString('base64'));
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.amount, 180000);
  assert.equal(body.currency, 'INR');
  assert.equal(body.notify.sms, false);
  assert.equal(body.notify.email, false);
  assert.equal(body.reminder_enable, false);
  assert.equal(made.url, 'https://rzp.io/i/realtest');
  assert.equal(made.id, 'plink_TestLink1');
  assert.doesNotMatch(JSON.stringify(made), new RegExp(SECRET));
  assert.equal(paymentLinkId({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_TestLink1' } } } }), 'plink_TestLink1');
});

test('demo mode simulates a paid webhook and does not call Razorpay', async () => {
  const s = await startServer(MOCK);
  try {
    const demo = await s.api('/api/clinic/demo', {});
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, demo.d.token);
    const open = clinic.d.invoices.find((i) => i.number === 'INV-1003');
    assert.equal(open.state, 'unpaid');
    assert.equal(open.payMode, 'demo');
    assert.match(open.payLink, /^upi:\/\/pay\?/);
    const sim = await s.api('/api/clinic/payments/simulate', { id: open.id }, demo.d.token);
    assert.equal(sim.status, 200, JSON.stringify(sim.d));
    assert.equal(sim.d.via, 'demo');
    const after = await s.api('/api/clinic', undefined, demo.d.token);
    const paid = after.d.invoices.find((i) => i.number === 'INV-1003');
    assert.equal(paid.state, 'paid');
    assert.equal(paid.paidVia, 'demo');
    const closed = await fetch(s.base + '/api/clinic/payments/razorpay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(closed.status, 404);
    assert.doesNotMatch(s.log(), /api\.razorpay\.com/);
  } finally { await s.stop(); }
});

test('a test Razorpay link is on the invoice and the reminder, and the webhook marks it paid', async () => {
  const s = await startServer({ ...MOCK, CLINIC_PAY_MOCK: 'on', RAZORPAY_KEY_ID: KEY, RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WHSEC });
  try {
    const signed = await s.api('/api/auth/signup', { email: 'pay-owner@example.com', name: 'Pay Owner', password: PW });
    await s.api('/api/clinic/profile', { biz: 'Pay Clinic', city: 'Hyderabad', services: 'Check-up', prices: '₹1500', audience: 'Local', offer: 'This week' }, signed.d.token);
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, signed.d.token);
    assert.equal(clinic.status, 200, JSON.stringify(clinic.d));
    const who = clinic.d.patients.find((p) => p.name === 'Rohan Mehta');
    const made = await s.api('/api/clinic/invoices', { patientId: who.id, items: [{ desc: 'Filling', qty: 1, rate: 1800 }], gst: '' }, signed.d.token);
    assert.equal(made.status, 200, JSON.stringify(made.d));
    assert.equal(made.d.invoice.payMode, 'razorpay');
    assert.equal(made.d.invoice.payLink, 'https://rzp.io/i/mockINV' + made.d.invoice.number.replace(/\D/g, ''));
    assert.match(made.d.invoice.payId, /^plink_mock[A-Za-z0-9]+$/);
    const remind = await s.api('/api/clinic/invoices/remind', { id: made.d.invoice.id }, signed.d.token);
    assert.match(remind.d.draft.body, new RegExp('Payment link: ' + made.d.invoice.payLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const blocked = await s.api('/api/clinic/payments/simulate', { id: made.d.invoice.id }, signed.d.token);
    assert.equal(blocked.status, 400, JSON.stringify(blocked.d));
    const raw = JSON.stringify({ entity: 'event', event: 'payment_link.paid', payload: { payment_link: { entity: { id: made.d.invoice.payId, status: 'paid' } } } });
    const bad = await fetch(s.base + '/api/clinic/payments/razorpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'ab'.repeat(32), 'x-razorpay-event-id': 'evt_bad' }, body: raw });
    assert.equal(bad.status, 400);
    const post = (eventId) => fetch(s.base + '/api/clinic/payments/razorpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': razorpaySignature(raw, WHSEC), 'x-razorpay-event-id': eventId },
      body: raw,
    });
    const ok = await post('evt_paid_1');
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await ok.json()).paid, true);
    const again = await post('evt_paid_1');
    assert.equal((await again.json()).duplicate, true);
    const after = await s.api('/api/clinic', undefined, signed.d.token);
    const inv = after.d.invoices.find((i) => i.id === made.d.invoice.id);
    assert.equal(inv.state, 'paid');
    assert.equal(inv.paidVia, 'razorpay');
    const kv = fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8');
    assert.doesNotMatch(kv, new RegExp(SECRET));
    assert.doesNotMatch(kv, new RegExp(WHSEC));
    assert.doesNotMatch(kv, new RegExp(KEY));
    assert.match(kv, new RegExp(made.d.invoice.payId));
    const del = await s.api('/api/auth/delete', { password: PW }, signed.d.token);
    assert.equal(del.status, 200, JSON.stringify(del.d));
    const left = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    const rows = Object.values(left).filter((r) => r && r.v && (String(r.v).includes('pay-owner@example.com') || String(r.k || r).includes(made.d.invoice.payId)));
    assert.deepEqual(rows, []);
    assert.doesNotMatch(s.log(), /api\.razorpay\.com/);
  } finally { await s.stop(); }
});
