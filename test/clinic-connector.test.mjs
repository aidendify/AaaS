// Eka.care adapter, generic webhook, visit-kit answers, and the health check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { ekaConnection, pullEka, ekaAppointmentStatus, rowsFromWebhook } from '../lib/clinic-connectors.js';
import { normalizeVisit, VISIT_QUESTIONS } from '../lib/clinic-visit.js';

const PW = 'Clinic-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' };

test('Eka.care adapter follows the public login, directory and appointment calls', async () => {
  const calls = [];
  const secret = 'super-secret-value';
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (String(url).endsWith('/connect-auth/v1/account/login')) return json({ access_token: 'tok-live', expires_in: 1800, refresh_token: 'refresh-should-not-leak' });
    if (String(url).includes('/profiles/v1/patient/minified/')) {
      return json({ profiles: [{ oid: 'pat_1', fln: 'Asha Rao', mobile: '+919876543210', u_ate: 1700000000 }], currPageMeta: { currPageNo: 1, nextPage: 0 } });
    }
    if (String(url).includes('/dr/v1/appointment')) {
      return json({ appointments: [{ appointment_id: 'apt_1', patient_id: 'pat_1', status: 'CM', start_time: 1700001000 }, { appointment_id: 'apt_2', patient_id: 'pat_missing', status: 'NS', start_time: 1700002000 }] });
    }
    if (String(url).includes('/dr/v1/patient/pat_missing')) {
      return json({ patient_id: 'pat_missing', first_name: 'Ravi', last_name: 'Teja', mobile: '+919888877766', email: 'ravi@example.com', created_at: 1700000000, address: { line1: 'hidden' } });
    }
    return json({ error: 'no' }, 404);
  };
  const out = await pullEka({ EKA_CLIENT_ID: 'client-id', EKA_CLIENT_SECRET: secret, EKA_BASE_URL: 'https://api.eka.care' }, fetchImpl, Date.parse('2026-10-27T06:30:00Z'));
  assert.equal(calls[0].url, 'https://api.eka.care/connect-auth/v1/account/login');
  assert.equal(JSON.parse(calls[0].opts.body).client_secret, secret);
  assert.match(calls[1].opts.headers.authorization, /^Bearer tok-live$/);
  assert.equal(calls[1].opts.headers['client-id'], 'client-id');
  const appt = calls.find((c) => c.url.includes('/dr/v1/appointment'));
  const q = new URL(appt.url).searchParams;
  const start = q.get('start_date'), end = q.get('end_date');
  assert.ok(end >= start);
  const days = (Date.parse(end) - Date.parse(start)) / 864e5;
  assert.ok(days <= 6, 'appointment window stays inside 7 days');
  assert.equal(appt.opts.headers.auth, 'tok-live');
  assert.equal(out.patients.length, 2);
  assert.equal(out.appointments.length, 2);
  assert.equal(out.appointments[0].status, 'completed');
  assert.equal(out.appointments[1].status, 'noshow');
  const dumped = JSON.stringify(out);
  assert.equal(dumped.includes(secret), false);
  assert.equal(dumped.includes('tok-live'), false);
  assert.equal(dumped.includes('refresh-should-not-leak'), false);
  assert.equal(dumped.includes('hidden'), false);
  assert.equal(ekaAppointmentStatus('BK'), 'booked');
  const shown = ekaConnection({ demo: false }, { EKA_CLIENT_ID: 'client-id', EKA_CLIENT_SECRET: secret });
  assert.equal(JSON.stringify(shown).includes(secret), false);
  assert.equal(shown.status, 'ready');
  let fetched = false;
  await assert.rejects(() => pullEka({ EKA_CLIENT_ID: '', EKA_CLIENT_SECRET: '' }, () => { fetched = true; }), /EKA_CLIENT_ID/);
  assert.equal(fetched, false);
  assert.equal(rowsFromWebhook({ patients: [{ name: 'Asha', phone: '919000000111' }] })[0].type, 'patient');
});

test('demo connector, webhook, visit notes and health stay inside the account', async () => {
  const s = await startServer({ ...MOCK, CLINIC_CONNECTOR_WEBHOOK_SECRET: 'hook-secret-test' });
  try {
    const health = await fetch(s.base + '/api/health').then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.auth, 'server');
    const demo = await s.api('/api/clinic/demo', {});
    const token = demo.d.token;
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, token);
    assert.equal(clinic.d.connections.find((c) => c.id === 'eka').label, 'Connected (demo)');
    const sync = await s.api('/api/clinic/connectors/sync', { provider: 'eka' }, token);
    assert.equal(sync.status, 200, JSON.stringify(sync.d));
    assert.equal(sync.d.calledNetwork, false);
    assert.equal(sync.d.mode, 'demo');
    assert.equal(sync.d.patients, 4);
    assert.equal(sync.d.broughtBackInr, 4500);

    const off = await fetch(s.base + '/api/clinic/connectors/webhook/' + clinic.d.formPath.split('/').pop(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patients: [{ name: 'Nope', phone: '919000000222' }] }),
    });
    assert.equal(off.status, 401);

    const formToken = clinic.d.formPath.split('/').pop();
    const hooked = await fetch(s.base + '/api/clinic/connectors/webhook/' + formToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aaas-connector-secret': 'hook-secret-test' },
      body: JSON.stringify({ patients: [{ name: 'Webhook Patient', phone: '919000000333', last_visit: '2026-10-01' }], csv: '' }),
    });
    const hookedBody = await hooked.json();
    assert.equal(hooked.status, 200, JSON.stringify(hookedBody));
    assert.equal(hookedBody.patients, 1);
    const after = await s.api('/api/clinic', undefined, token);
    const added = after.d.patients.find((p) => p.name === 'Webhook Patient');
    assert.equal(added.source, 'Clinic software');
    assert.equal(added.demo, false);
    assert.ok(after.d.stats.fromSoftware >= 5);

    const kavita = after.d.patients.find((p) => p.name === 'Kavita Joshi');
    assert.equal(kavita.broughtBack, undefined);
    const draft = await s.api('/api/clinic/recall/draft', { patientId: kavita.id }, token);
    const decided = await s.api('/api/clinic/decide', { id: draft.d.draft.approvalId, decision: 'approve' }, token);
    assert.equal(decided.status, 200, JSON.stringify(decided.d));
    const marked = await s.api('/api/clinic', undefined, token);
    assert.equal(marked.d.patients.find((p) => p.id === kavita.id).broughtBack, true);

    assert.equal(VISIT_QUESTIONS.length, 10);
    assert.throws(() => normalizeVisit({ answers: { q1: 'Walk-ins' } }), /free-pilot/);
    const visit = await s.api('/api/clinic/visit', { who: 'Dr Sample', accept: true, answers: { q1: 'Mostly walk-ins, then Instagram.', q3: 'Eka.care, about ₹2,000 a month.' } }, token);
    assert.equal(visit.status, 200, JSON.stringify(visit.d));
    assert.equal(visit.d.visit.saved.answers.q1.includes('walk-ins'), true);
    assert.equal(visit.d.visit.questions.length, 10);
    const again = await s.api('/api/clinic/visit', undefined, token);
    assert.equal(again.d.saved.who, 'Dr Sample');

    const other = await s.api('/api/auth/signup', { email: 'visit-other@example.com', name: 'Other', password: PW });
    const peek = await s.api('/api/clinic/visit', undefined, other.d.token);
    assert.equal(peek.status, 409);
    assert.equal(JSON.stringify(peek.d).includes('walk-ins'), false);
  } finally { await s.stop(); }
});

test('webhook stays closed when the secret is unset', async () => {
  const s = await startServer(MOCK);
  try {
    const demo = await s.api('/api/clinic/demo', {});
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, demo.d.token);
    const token = clinic.d.formPath.split('/').pop();
    const res = await fetch(s.base + '/api/clinic/connectors/webhook/' + token, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aaas-connector-secret': 'anything' },
      body: JSON.stringify({ patients: [{ name: 'Closed', phone: '919000000444' }] }),
    });
    assert.equal(res.status, 404);
  } finally { await s.stop(); }
});
