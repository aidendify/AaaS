// Chief inbound wire: owner messages on free channels go through lib/chief-inbound.js. Mock tokens only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers.mjs';

const PW = 'Channels-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on' };
async function req(s, method, p, body, token) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
const hookPost = (s, hook, body, secret) => fetch(s.base + '/api/channels/telegram/webhook/' + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body });
const msg = (id, from, text) => JSON.stringify({ update_id: id, message: { message_id: id, from: { id: from, first_name: 'X' }, chat: { id: from, type: 'private' }, text } });

test('freech owner inbound is wired through chief-inbound', () => {
  const src = fs.readFileSync(new URL('../lib/freech.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ routeChiefInbound \} from '\.\/chief-inbound\.js'/);
  assert.match(src, /routeChiefInbound\(st, email,/);
});

test('telegram owner send intent -> pending approval only; non-owner dropped; tenants isolated', { timeout: 120000 }, async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'wire-a@example.com', name: 'A', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'wire-b@example.com', name: 'B', password: PW })).d.token;
    const a = (await req(s, 'POST', '/api/channels/telegram', { bot_token: 'mock_tg_wire_aaa', owner_user_id: '510111' }, A)).d.telegram;
    await req(s, 'POST', '/api/channels/telegram', { bot_token: 'mock_tg_wire_bbb', owner_user_id: '610111' }, B);
    const hookA = a.webhook_url.split('/').pop();
    const pend = async (t) => ((await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, t)).d.items || []);
    const before = (await pend(A)).length;

    assert.equal((await hookPost(s, hookA, msg(1, 510111, 'tell 777722: your slot moved to 5pm'), a.secret_token)).status, 200);
    const pa = await pend(A);
    assert.equal(pa.length, before + 1, 'one approval queued');
    assert.ok(pa.some((x) => JSON.stringify(x).includes('777722')));
    const conv = (await req(s, 'GET', '/api/channels', undefined, A)).d.conversations;
    assert.equal(conv.some((c) => c.peer === '777722'), false, 'nothing sent to the customer');
    assert.equal((await pend(B)).some((x) => JSON.stringify(x).includes('777722')), false, 'B sees nothing');

    // Non-owner, customers off: dropped, no approval, no conversation.
    assert.equal((await hookPost(s, hookA, msg(2, 999333, 'tell 777722: hi'), a.secret_token)).status, 200);
    assert.equal((await pend(A)).length, before + 1);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.some((c) => c.peer === '999333'), false);
  } finally { await s.stop(); }
});
