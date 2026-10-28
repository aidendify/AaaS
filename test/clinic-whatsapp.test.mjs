// Official WhatsApp: Meta and Gupshup adapters, opt-in, delivery webhook. Network is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { sendTemplate, sendDecision, parseWaWebhook, nextWaStatus, metaSignature, waPublic } from '../lib/clinic-whatsapp.js';

const PW = 'Clinic-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1' };
const TOKEN = 'meta_token_unit_value';
const SECRET = 'meta_app_secret_unit';
const VERIFY = 'verify_token_unit';
const META = {
  ...MOCK, CLINIC_WA_MOCK: 'on', CLINIC_WA_PROVIDER: 'meta',
  CLINIC_WA_META_TOKEN: TOKEN, CLINIC_WA_META_PHONE_ID: '1099887766',
  CLINIC_WA_META_APP_SECRET: SECRET, CLINIC_WA_META_VERIFY_TOKEN: VERIFY,
};

test('Meta and Gupshup template calls stay on the adapter and omit the keys from the result', async () => {
  assert.equal(waPublic({}).configured, false);
  assert.equal(sendDecision({ configured: false, demo: false, opt: 'in', to: '919000000001' }).reason, 'unconfigured');
  assert.equal(sendDecision({ configured: true, demo: true, opt: 'in', to: '919000000001' }).send, false);
  assert.equal(sendDecision({ configured: true, demo: false, opt: 'out', to: '919000000001' }).reason, 'opt_out');
  assert.equal(sendDecision({ configured: true, demo: false, opt: '', to: '919000000001' }).reason, 'no_opt_in');
  assert.equal(sendDecision({ configured: true, demo: false, opt: '', to: '919000000000', owner: true }).send, true);
  assert.deepEqual(await sendTemplate({ to: '919000000001', body: 'Hello', env: {} }), { sent: false, reason: 'unconfigured' });
  const mocked = await sendTemplate({ to: '919000000001', body: 'Hello there', env: META });
  assert.equal(mocked.provider, 'meta');
  assert.match(mocked.id, /^wamid\.mock[a-f0-9]+$/);
  assert.doesNotMatch(JSON.stringify(mocked), new RegExp(TOKEN));
  let meta = null;
  const live = await sendTemplate({
    to: '919000000001', body: 'Hello\nthere',
    env: { CLINIC_WA_PROVIDER: 'meta', CLINIC_WA_META_TOKEN: TOKEN, CLINIC_WA_META_PHONE_ID: '1099887766' },
    fetchImpl: async (url, opts) => { meta = { url, opts }; return { ok: true, json: async () => ({ messages: [{ id: 'wamid.REAL1' }] }) }; },
  });
  assert.equal(meta.url, 'https://graph.facebook.com/v21.0/1099887766/messages');
  assert.equal(meta.opts.headers.authorization, 'Bearer ' + TOKEN);
  const body = JSON.parse(meta.opts.body);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'aaas_note');
  assert.equal(body.template.components[0].parameters[0].text, 'Hello there');
  assert.equal(live.id, 'wamid.REAL1');
  assert.doesNotMatch(JSON.stringify(live), new RegExp(TOKEN));
  let gup = null;
  const gupEnv = { CLINIC_WA_PROVIDER: 'gupshup', CLINIC_WA_GUPSHUP_API_KEY: 'gup_key_unit', CLINIC_WA_GUPSHUP_SOURCE: '919000000000', CLINIC_WA_GUPSHUP_APP_NAME: 'AaaSApp' };
  const sent = await sendTemplate({
    to: '919000000001', body: 'Pay this',
    env: gupEnv,
    fetchImpl: async (url, opts) => { gup = { url, opts }; return { ok: true, json: async () => ({ status: 'submitted', messageId: 'gup-msg-1' }) }; },
  });
  assert.equal(gup.url, 'https://api.gupshup.io/wa/api/v1/template/msg');
  assert.equal(gup.opts.headers.apikey, 'gup_key_unit');
  const form = new URLSearchParams(gup.opts.body);
  assert.equal(form.get('source'), '919000000000');
  assert.equal(JSON.parse(form.get('template')).id, 'aaas_note');
  assert.equal(sent.provider, 'gupshup');
  assert.doesNotMatch(JSON.stringify(sent), /gup_key_unit/);
  const inbound = parseWaWebhook('meta', { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.REAL1', status: 'delivered', recipient_id: '919000000001' }], messages: [{ from: '919000000001', type: 'text', text: { body: 'STOP' }, id: 'in1' }] } }] }] });
  assert.equal(inbound.statuses[0].status, 'delivered');
  assert.equal(inbound.inbound[0].text, 'STOP');
  const gupIn = parseWaWebhook('gupshup', { type: 'message-event', payload: { id: 'gup-msg-1', type: 'read', destination: '919000000001' } });
  assert.equal(gupIn.statuses[0].status, 'read');
  assert.equal(nextWaStatus('delivered', 'sent'), 'delivered');
  assert.equal(nextWaStatus('sent', 'read'), 'read');
  assert.equal(nextWaStatus('read', 'failed'), 'failed');
});

test('an approved draft sends only when the provider is configured and the person opted in', async () => {
  const bare = await startServer(MOCK);
  try {
    const closed = await fetch(bare.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(closed.status, 404);
    const demo = await bare.api('/api/clinic/demo', {});
    const clinic = await bare.api('/api/clinic/role', { role: 'dental' }, demo.d.token);
    assert.equal(clinic.d.whatsapp.configured, false);
    assert.equal(clinic.d.connections.find((c) => c.id === 'whatsapp').name, 'WhatsApp click-to-chat');
    const review = clinic.d.pending.find((d) => d.kind === 'review');
    const approved = await bare.api('/api/clinic/decide', { id: review.approvalId, decision: 'approve' }, demo.d.token);
    assert.match(approved.d.approval.result, /Nothing was sent/);
    const after = await bare.api('/api/clinic', undefined, demo.d.token);
    assert.equal(after.d.drafts.find((d) => d.id === review.id).waMessageId || '', '');
  } finally { await bare.stop(); }

  const s = await startServer(META);
  try {
    const demo = await s.api('/api/clinic/demo', {});
    await s.api('/api/clinic/role', { role: 'dental' }, demo.d.token);
    const sample = await s.api('/api/clinic', undefined, demo.d.token);
    const sampleReview = sample.d.pending.find((d) => d.kind === 'review');
    const sampleOk = await s.api('/api/clinic/decide', { id: sampleReview.approvalId, decision: 'approve' }, demo.d.token);
    assert.match(sampleOk.d.approval.result, /Nothing was sent/);

    const signed = await s.api('/api/auth/signup', { email: 'wa-owner@example.com', name: 'WA Owner', password: PW });
    await s.api('/api/clinic/profile', { biz: 'WA Clinic', city: 'Hyderabad', services: 'Check-up', prices: '₹1500', audience: 'Local', offer: 'This week' }, signed.d.token);
    const clinic = await s.api('/api/clinic/role', { role: 'dental' }, signed.d.token);
    assert.equal(clinic.d.whatsapp.provider, 'meta');
    assert.equal(clinic.d.connections.find((c) => c.id === 'whatsapp').name, 'WhatsApp Business (Meta)');
    const ananya = clinic.d.patients.find((p) => p.name === 'Ananya Reddy');
    const opted = await s.api('/api/clinic/whatsapp/opt', { patientId: ananya.id, status: 'in' }, signed.d.token);
    assert.equal(opted.status, 200, JSON.stringify(opted.d));
    const draft = await s.api('/api/clinic/reviews/draft', { patientId: ananya.id }, signed.d.token);
    assert.match(draft.d.draft.waLink, /^https:\/\/wa\.me\//);
    const approved = await s.api('/api/clinic/decide', { id: draft.d.draft.approvalId, decision: 'approve' }, signed.d.token);
    assert.match(approved.d.approval.result, /Sent on WhatsApp \(Meta\)/);
    let seen = await s.api('/api/clinic', undefined, signed.d.token);
    const sent = seen.d.drafts.find((d) => d.id === draft.d.draft.id);
    assert.equal(sent.waStatus, 'sent');
    assert.match(sent.waMessageId, /^wamid\.mock/);
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: sent.waMessageId, status: 'delivered', recipient_id: '919000000001' }] } }] }] });
    const sig = metaSignature(raw, SECRET);
    const bad = await fetch(s.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + 'ab'.repeat(32) }, body: raw });
    assert.equal(bad.status, 401);
    const ok = await fetch(s.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    assert.equal(ok.status, 200, await ok.clone().text());
    seen = await s.api('/api/clinic', undefined, signed.d.token);
    assert.equal(seen.d.drafts.find((d) => d.id === draft.d.draft.id).waStatus, 'delivered');
    const stop = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '919000000001', type: 'text', text: { body: 'STOP' }, id: 'in1' }] } }] }] });
    const stopped = await fetch(s.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSignature(stop, SECRET) }, body: stop });
    assert.equal(stopped.status, 200);
    seen = await s.api('/api/clinic', undefined, signed.d.token);
    assert.equal(seen.d.patients.find((p) => p.name === 'Ananya Reddy').waOpt, 'out');
    const again = await s.api('/api/clinic/reviews/draft', { patientId: ananya.id }, signed.d.token);
    const blocked = await s.api('/api/clinic/decide', { id: again.d.draft.approvalId, decision: 'approve' }, signed.d.token);
    assert.match(blocked.d.approval.result, /opted out/);
    const verify = await fetch(s.base + '/api/clinic/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=' + VERIFY + '&hub.challenge=challenge123');
    assert.equal(verify.status, 200);
    assert.equal(await verify.text(), 'challenge123');
    const kv = fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8');
    assert.doesNotMatch(kv, new RegExp(TOKEN));
    assert.doesNotMatch(kv, new RegExp(SECRET));
    assert.doesNotMatch(s.log(), /graph\.facebook\.com|gupshup\.io/);
    const del = await s.api('/api/auth/delete', { password: PW }, signed.d.token);
    assert.equal(del.status, 200);
    const left = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    const rows = Object.values(left).filter((r) => r && r.v && String(r.v).includes('wa-owner@example.com'));
    assert.deepEqual(rows, []);
  } finally { await s.stop(); }
});

test('a Gupshup webhook secret is required and a reject does not send', async () => {
  const env = {
    ...MOCK, CLINIC_WA_MOCK: 'on', CLINIC_WA_PROVIDER: 'gupshup',
    CLINIC_WA_GUPSHUP_API_KEY: 'gup_key_unit', CLINIC_WA_GUPSHUP_SOURCE: '919000000000', CLINIC_WA_GUPSHUP_APP_NAME: 'AaaSApp',
  };
  const closed = await startServer(env);
  try {
    const missing = await fetch(closed.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);
  } finally { await closed.stop(); }
  const s = await startServer({ ...env, CLINIC_WA_WEBHOOK_SECRET: 'gup_hook_unit' });
  try {
    const signed = await s.api('/api/auth/signup', { email: 'gup-owner@example.com', name: 'Gup Owner', password: PW });
    await s.api('/api/clinic/profile', { biz: 'Gup Clinic', city: 'Hyderabad', services: 'Check-up', prices: '₹1500', audience: 'Local', offer: 'This week' }, signed.d.token);
    const clinic = await s.api('/api/clinic/role', { role: 'coach' }, signed.d.token);
    assert.equal(clinic.d.connections.find((c) => c.id === 'whatsapp').name, 'WhatsApp Business (Gupshup)');
    const person = clinic.d.patients[0];
    await s.api('/api/clinic/whatsapp/opt', { patientId: person.id, status: 'in' }, signed.d.token);
    const draft = await s.api('/api/clinic/reviews/draft', { patientId: person.id }, signed.d.token);
    const rejected = await s.api('/api/clinic/decide', { id: draft.d.draft.approvalId, decision: 'reject' }, signed.d.token);
    assert.equal(rejected.d.approval.status, 'declined');
    const seen = await s.api('/api/clinic', undefined, signed.d.token);
    assert.equal(seen.d.drafts.find((d) => d.id === draft.d.draft.id).waMessageId || '', '');
    const raw = JSON.stringify({ type: 'message', payload: { source: person.phone, type: 'text', payload: { text: 'START' }, id: 'g1' } });
    const bad = await fetch(s.base + '/api/clinic/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aaas-wa-secret': 'nope' }, body: raw });
    assert.equal(bad.status, 401);
    assert.doesNotMatch(s.log(), /gupshup\.io/);
  } finally { await s.stop(); }
});
