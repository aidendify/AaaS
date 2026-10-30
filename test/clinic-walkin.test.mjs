// Walk-in desk payments: one tap records cash, UPI or card as a paid invoice that counts in ₹ recovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers.mjs';

const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1' };

test('walk-in cash, UPI and card create paid invoices and raise ₹ recovered without calling Razorpay', async () => {
  const s = await startServer(MOCK);
  try {
    const demo = await s.api('/api/clinic/demo', {});
    const t = demo.d.token;
    const before = await s.api('/api/clinic/role', { role: 'dental' }, t);
    const pid = before.d.patients[0].id;
    let total = before.d.stats.recovered.total;
    for (const [method, amount] of [['cash', 500], ['upi', 1200.5], ['card', 800]]) {
      const r = await s.api('/api/clinic/payments/walkin', { patientId: pid, amount, method }, t);
      assert.equal(r.status, 200, JSON.stringify(r.d));
      assert.equal(r.d.invoice.state, 'paid');
      assert.equal(r.d.invoice.paidVia, method);
      assert.equal(r.d.invoice.total, amount);
      assert.equal(r.d.invoice.walkIn, true);
      assert.equal(r.d.invoice.payLink, '');
      assert.equal(Math.round((r.d.recovered.total - total) * 100) / 100, amount);
      total = r.d.recovered.total;
    }
    const after = await s.api('/api/clinic', undefined, t);
    assert.equal(after.d.stats.recovered.total, total);
    assert.equal(after.d.invoices.filter((i) => i.walkIn).length, 3);
    assert.doesNotMatch(s.log(), /api\.razorpay\.com/);
  } finally { await s.stop(); }
});

test('walk-in rejects a bad method, amount or person; mark paid can record the method', async () => {
  const s = await startServer(MOCK);
  try {
    const t = (await s.api('/api/clinic/demo', {})).d.token;
    const c = await s.api('/api/clinic/role', { role: 'dental' }, t);
    const pid = c.d.patients[0].id;
    assert.equal((await s.api('/api/clinic/payments/walkin', { patientId: pid, amount: 100, method: 'bitcoin' }, t)).status, 400);
    assert.equal((await s.api('/api/clinic/payments/walkin', { patientId: pid, amount: 0, method: 'cash' }, t)).status, 400);
    assert.equal((await s.api('/api/clinic/payments/walkin', { patientId: pid, amount: -5, method: 'cash' }, t)).status, 400);
    assert.notEqual((await s.api('/api/clinic/payments/walkin', { patientId: 999999, amount: 100, method: 'cash' }, t)).status, 200);
    const open = c.d.invoices.find((i) => i.state !== 'paid');
    const up = await s.api('/api/clinic/invoices/update', { id: open.id, status: 'paid', method: 'upi' }, t);
    assert.equal(up.status, 200, JSON.stringify(up.d));
    const now = await s.api('/api/clinic', undefined, t);
    const inv = now.d.invoices.find((i) => i.id === open.id);
    assert.equal(inv.state, 'paid');
    assert.equal(inv.paidVia, 'upi');
    assert.notEqual((await s.api('/api/clinic/invoices/update', { id: open.id, status: 'paid', method: 'cheque' }, t)).status, 200);
  } finally { await s.stop(); }
});

test('billing screen has the one-tap walk-in buttons', () => {
  const html = fs.readFileSync(new URL('../clinic.html', import.meta.url), 'utf8');
  assert.match(html, /data-act="walkin"/);
  for (const v of ['cash', 'upi', 'card']) assert.match(html, new RegExp(`name="method" value="${v}"`));
  assert.match(html, /\/api\/clinic\/payments\/walkin/);
});
