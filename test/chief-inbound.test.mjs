// v2.7 spike: Chief inbound router. In-memory store, fetch stubbed to throw: nothing here may call a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeChiefInbound, parseSendIntent } from '../lib/chief-inbound.js';
import { buildSeed } from '../lib/clinic.js';

function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? { v: m.get(k) } : null; }, async put(k, v) { if (v == null) m.delete(k); else m.set(k, v); } };
}
const A = 'a@example.com', B = 'b@example.com';
async function seeded() {
  const st = memStore();
  await st.put('as_clinic:' + A, JSON.stringify({ ...buildSeed('clinic'), demo: true, biz: 'A Clinic' }));
  await st.put('as_clinic:' + B, JSON.stringify({ ...buildSeed('clinic'), demo: true, biz: 'B Clinic' }));
  return st;
}
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = () => { throw new Error('provider call attempted'); }; });
test.afterEach(() => { globalThis.fetch = realFetch; });

test('owner question gets a Chief answer from this account, no provider call', async () => {
  const st = await seeded();
  const r = await routeChiefInbound(st, A, { channel: 'whatsapp_qr', peer: '919000000001', owner: '919000000001', text: 'how many patients total?' });
  assert.equal(r.route, 'chief');
  assert.match(r.reply, /counted from this account/);
});

test('non-owner and unknown channels are dropped', async () => {
  const st = await seeded();
  assert.equal((await routeChiefInbound(st, A, { channel: 'telegram', peer: '1', owner: '2', text: 'hi' })).route, 'drop');
  assert.equal((await routeChiefInbound(st, A, { channel: 'telegram', peer: '1', owner: '', text: 'hi' })).route, 'drop');
  assert.equal((await routeChiefInbound(st, A, { channel: 'sms', peer: '1', owner: '1', text: 'hi' })).route, 'drop');
});

test('send intent only queues an approval and never sends', async () => {
  const st = await seeded();
  const r = await routeChiefInbound(st, A, { channel: 'telegram', peer: '42', owner: '42', text: 'send +919811112222: your report is ready' });
  assert.equal(r.route, 'approval');
  assert.equal(r.approval.status, 'pending');
  assert.match(r.reply, /Nothing was sent/);
  const appr = JSON.parse(st.m.get('as_appr:' + A));
  assert.equal(appr.length, 1);
  assert.equal(appr[0].status, 'pending');
  assert.equal(appr[0].to, '+919811112222');
  assert.ok(![...st.m.keys()].some((k) => k.startsWith('as_chconv')), 'no outbound message recorded as sent');
});

test('WhatsApp QR send intent drafts on official WhatsApp, not QR (QR is owner-only)', async () => {
  const st = await seeded();
  const r = await routeChiefInbound(st, A, { channel: 'whatsapp_qr', peer: '9', owner: '9', text: 'tell +919800000000: hello' });
  assert.equal(r.route, 'approval');
  assert.equal(JSON.parse(st.m.get('as_appr:' + A))[0].app, 'whatsapp');
});

test('tenant isolation: routing for A never writes B keys', async () => {
  const st = await seeded();
  const before = new Map([...st.m].filter(([k]) => k.endsWith(B)));
  await routeChiefInbound(st, A, { channel: 'telegram', peer: '7', owner: '7', text: 'send x@y.com: hi' });
  await routeChiefInbound(st, A, { channel: 'telegram', peer: '7', owner: '7', text: 'enquiries?' });
  const after = new Map([...st.m].filter(([k]) => k.endsWith(B)));
  assert.deepEqual(after, before);
  assert.equal(st.m.get('as_appr:' + B), undefined);
});

test('STOP pauses and parseSendIntent is strict', async () => {
  const st = await seeded();
  assert.equal((await routeChiefInbound(st, A, { channel: 'slack', peer: 'U1', owner: 'U1', text: 'STOP' })).route, 'stopped');
  assert.equal(parseSendIntent('how are sends going'), null);
  assert.deepEqual(parseSendIntent('reply to tg:5: ok'), { to: 'tg:5', body: 'ok' });
});
