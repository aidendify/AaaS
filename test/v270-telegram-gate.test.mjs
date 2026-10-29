// v2.7 spike: Telegram webhook secret gate + approval-first. Mock tokens only; no Telegram calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const PW = 'Channels-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on' };
async function req(s, method, p, body, token) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
const hookPost = (s, hook, body, headers = {}) => fetch(s.base + '/api/channels/telegram/webhook/' + hook, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('telegram webhook secret: missing, wrong, cross-tenant and unknown hook are all refused', { timeout: 120000 }, async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'gate-a@example.com', name: 'A', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'gate-b@example.com', name: 'B', password: PW })).d.token;
    const a = (await req(s, 'POST', '/api/channels/telegram', { bot_token: 'mock_tg_gate_aaa', owner_user_id: '500111', customers: true }, A)).d.telegram;
    const b = (await req(s, 'POST', '/api/channels/telegram', { bot_token: 'mock_tg_gate_bbb', owner_user_id: '600111' }, B)).d.telegram;
    const hookA = a.webhook_url.split('/').pop();
    const msg = (id, from, text) => JSON.stringify({ update_id: id, message: { message_id: id, from: { id: from, first_name: 'X' }, chat: { id: from, type: 'private' }, text } });
    assert.equal((await hookPost(s, hookA, msg(1, 500111, 'hi'))).status, 401);
    assert.equal((await hookPost(s, hookA, msg(2, 500111, 'hi'), { 'x-telegram-bot-api-secret-token': '' })).status, 401);
    assert.equal((await hookPost(s, hookA, msg(3, 500111, 'hi'), { 'x-telegram-bot-api-secret-token': b.secret_token })).status, 401);
    assert.equal((await hookPost(s, 'ef'.repeat(16), msg(4, 500111, 'hi'), { 'x-telegram-bot-api-secret-token': a.secret_token })).status, 404);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.length, 0);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, B)).d.conversations.length, 0);

    // Customer message: reply is only a pending approval; nothing is sent to the customer.
    await req(s, 'POST', '/api/frontdesk', { enabled: true, auto: 'needs_approval', faqs: [{ q: 'Hours', a: 'Weekdays.' }] }, A);
    const r = await hookPost(s, hookA, msg(5, 777711, 'Are you open Monday?'), { 'x-telegram-bot-api-secret-token': a.secret_token });
    assert.equal(r.status, 200);
    const conv = (await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.find((c) => c.peer === '777711');
    assert.ok(conv);
    assert.equal(conv.messages.some((m) => m.dir === 'out' && m.status === 'sent'), false, 'nothing sent before approval');
    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    assert.ok(pending.some((x) => x.kind === 'telegram'));
    assert.equal(((await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, B)).d.items || []).some((x) => x.kind === 'telegram'), false);
  } finally { await s.stop(); }
});
