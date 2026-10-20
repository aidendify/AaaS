// v2.5 free channels. Routing, Slack signatures, and WhatsApp QR owner-only rules.
// Mock tokens only. Nothing here calls Telegram, Slack or WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { redactSecrets } from '../lib/channels.js';
import { routeFreeInbound, slackSignature, slackSignatureOk, freeHints } from '../lib/freech.js';
import { waqrMaySend } from '../lib/waqr.js';

const PW = 'Channels-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on' };

async function req(s, method, p, body, token, extra = {}) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(extra.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
async function raw(s, method, p, body, headers = {}) {
  const r = await fetch(s.base + p, { method, headers, body });
  const text = await r.text();
  let d = text; try { d = JSON.parse(text); } catch { /* plain */ }
  return { status: r.status, d, text };
}

test('routing, signatures and owner-only rules are pure', () => {
  assert.equal(routeFreeInbound({ channel: 'telegram', sender: '42', owner: '42', customers: false }), 'chief');
  assert.equal(routeFreeInbound({ channel: 'telegram', sender: '99', owner: '42', customers: false }), 'drop');
  assert.equal(routeFreeInbound({ channel: 'telegram', sender: '99', owner: '42', customers: true }), 'desk');
  assert.equal(routeFreeInbound({ channel: 'slack', sender: 'UOWNER', owner: 'UOWNER', customers: true }), 'chief');
  assert.equal(routeFreeInbound({ channel: 'slack', sender: 'UOTHER', owner: 'UOWNER', customers: true }), 'desk');
  assert.equal(routeFreeInbound({ channel: 'slack', sender: 'UOTHER', owner: 'UOWNER', customers: false }), 'drop');
  assert.equal(routeFreeInbound({ channel: 'whatsapp_qr', sender: '919800011199', owner: '919800011199', customers: true }), 'chief');
  assert.equal(routeFreeInbound({ channel: 'whatsapp_qr', sender: '919800022288', owner: '919800011199', customers: true }), 'drop');
  assert.equal(waqrMaySend('919800011199', '919800011199'), true);
  assert.equal(waqrMaySend('+91 98000 11199', '919800011199'), true);
  assert.equal(waqrMaySend('919800022288', '919800011199'), false);
  assert.equal(waqrMaySend('919800011199@g.us', '919800011199'), false);
  assert.equal(waqrMaySend('status@broadcast', '919800011199'), false);
  assert.equal(waqrMaySend('', '919800011199'), false);
  const rawBody = '{"type":"url_verification","challenge":"abc"}';
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const sig = slackSignature('signing-secret-abc', ts, rawBody);
  assert.equal(slackSignatureOk({ secret: 'signing-secret-abc', timestamp: ts, signature: sig, raw: rawBody, now }), true);
  assert.equal(slackSignatureOk({ secret: 'other-secret-abc', timestamp: ts, signature: sig, raw: rawBody, now }), false);
  assert.equal(slackSignatureOk({ secret: 'signing-secret-abc', timestamp: String(Math.floor(now / 1000) - 600), signature: sig, raw: rawBody, now }), false);
  assert.match(redactSecrets('failed https://api.telegram.org/bot123456:ABCDEFghijklMNOPQRstuvwxYZ012345/sendMessage'), /bot\[redacted\]/);
  assert.equal(redactSecrets('xoxb-1234-secret').includes('xoxb-1234'), false);
  const hints = freeHints({
    telegram: { token: '123456:ABCDEFghijklMNOPQRstuvwxYZ012345', secret_token: 'sekret-token-value', link_code: 'linkcode12', bot_id: '9', hook_id: 'ab'.repeat(16), owner_user_id: '42' },
    slack: { bot_token: 'xoxb-secret-token-value', signing_secret: 'signing-secret-value', hook_id: 'cd'.repeat(16), team_id: 'T123' },
    waqr: { owner_phone: '919800011199', session: 'SUPERSECRETSESSION', status: 'linked' },
  });
  const blob = JSON.stringify(hints);
  assert.equal(blob.includes('sekret-token-value'), false);
  assert.equal(blob.includes('ABCDEFghijkl'), false);
  assert.equal(blob.includes('xoxb-secret-token-value'), false);
  assert.equal(blob.includes('signing-secret-value'), false);
  assert.equal(blob.includes('SUPERSECRETSESSION'), false);
  assert.equal(blob.includes('linkcode12'), false);
  assert.equal(hints.whatsapp_qr.owner_only, true);
  assert.equal(hints.whatsapp_qr.beta, true);
  assert.match(hints.whatsapp_qr.warning, /unofficial/i);
  assert.match(hints.whatsapp_qr.warning, /restrict|ban/i);
});

test('telegram and slack route the owner to the chief and customers to a draft', { timeout: 120000 }, async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'tg-a@example.com', name: 'North', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'tg-b@example.com', name: 'Other', password: PW })).d.token;
    const tgToken = 'mock_tg_owner_aaa';
    const saved = await req(s, 'POST', '/api/channels/telegram', { bot_token: tgToken, owner_user_id: '424242', customers: false }, A);
    assert.equal(saved.status, 200, JSON.stringify(saved.d));
    const hook = (saved.d.telegram.webhook_url || '').split('/').pop();
    const secret = saved.d.telegram.secret_token;
    assert.match(hook, /^[a-f0-9]{32}$/);
    assert.ok(secret && secret.length >= 16);
    const view = await req(s, 'GET', '/api/channels', undefined, A);
    const viewText = JSON.stringify(view.d);
    assert.equal(viewText.includes(tgToken), false);
    assert.equal(viewText.includes(secret), false);
    assert.equal(viewText.includes(saved.d.telegram.link_code), false);
    assert.equal(view.d.channels.telegram.connected, true);
    assert.equal(view.d.channels.telegram.customers, false);
    assert.match(view.d.channels.whatsapp_qr.warning, /unofficial/i);
    assert.equal(view.d.channels.whatsapp_qr.enabled, false);
    const taken = await req(s, 'POST', '/api/channels/telegram', { bot_token: tgToken, owner_user_id: '111111' }, B);
    assert.equal(taken.status, 409);

    const tg = (text, from, id, extra = {}) => {
      const body = JSON.stringify({ update_id: id, account: 'tg-b@example.com', message: { message_id: id, from: { id: from, first_name: extra.name || 'Ada' }, chat: { id: from, type: 'private' }, text } });
      return raw(s, 'POST', '/api/channels/telegram/webhook/' + hook, body, { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': extra.secret || secret });
    };
    assert.equal((await tg('forged', 424242, 1, { secret: 'not-the-secret-value' })).status, 401);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.length, 0);
    const owner = await tg('Hello chief, what is on today?', 424242, 2);
    assert.equal(owner.status, 200, JSON.stringify(owner.d));
    assert.equal(owner.d.route, 'chief');
    const box = (await req(s, 'GET', '/api/channels', undefined, A)).d;
    const mine = box.conversations.find((c) => c.channel === 'telegram' && c.peer === '424242');
    assert.ok(mine, JSON.stringify(box.conversations));
    assert.ok(mine.messages.some((m) => m.dir === 'out' && m.status === 'sent' && /draft/i.test(m.body)));
    assert.equal((await req(s, 'GET', '/api/leads?limit=50', undefined, A)).d.leads.length, 0);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, B)).d.conversations.length, 0);
    const stranger = await tg('I am a customer', 777001, 3);
    assert.equal(stranger.status, 200, JSON.stringify(stranger.d));
    assert.equal(stranger.d.route, 'drop');
    assert.equal((await req(s, 'GET', '/api/leads?limit=50', undefined, A)).d.leads.length, 0);
    assert.equal((await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.length, 1);

    assert.equal((await req(s, 'POST', '/api/frontdesk', { auto: 'auto' }, A)).status, 400);
    await req(s, 'POST', '/api/frontdesk', { enabled: true, auto: 'needs_approval', faqs: [{ q: 'Hours', a: 'We are open on weekdays.' }] }, A);
    await req(s, 'POST', '/api/channels/telegram', { customers: true }, A);
    const customer = await tg('Do you have time this week?', 777001, 4, { name: 'Meera' });
    assert.equal(customer.status, 200, JSON.stringify(customer.d));
    assert.equal(customer.d.route, 'desk');
    const desk = (await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.find((c) => c.peer === '777001');
    assert.ok(desk, 'customer thread');
    assert.equal(desk.messages.some((m) => m.status === 'sent'), false);
    assert.ok(desk.messages.some((m) => m.dir === 'out' && m.status === 'draft'));
    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    assert.ok(pending.some((a) => a.kind === 'telegram'));
    assert.equal((await req(s, 'GET', '/api/channels', undefined, B)).d.conversations.length, 0);

    const slToken = 'mock_sl_owner_aaa';
    const slSecret = 'slack-signing-secret-a';
    const sl = await req(s, 'POST', '/api/channels/slack', { bot_token: slToken, signing_secret: slSecret, owner_user_id: 'U0OWNER1', customers: false }, A);
    assert.equal(sl.status, 200, JSON.stringify(sl.d));
    const slHook = (sl.d.slack.webhook_url || '').split('/').pop();
    const team = sl.d.slack.team_id;
    assert.equal(JSON.stringify((await req(s, 'GET', '/api/channels', undefined, A)).d).includes(slToken), false);
    assert.equal(JSON.stringify((await req(s, 'GET', '/api/channels', undefined, A)).d).includes(slSecret), false);
    const post = (obj, { secret = slSecret, ts = Math.floor(Date.now() / 1000), sign = true } = {}) => {
      const body = JSON.stringify(obj);
      const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts) };
      if (sign) headers['x-slack-signature'] = slackSignature(secret, String(ts), body);
      return raw(s, 'POST', '/api/channels/slack/webhook/' + slHook, body, headers);
    };
    const challenge = { type: 'url_verification', challenge: 'challenge-plain', team_id: team };
    const unsigned = await post(challenge, { sign: false });
    assert.equal(unsigned.status, 401);
    assert.equal(String(unsigned.text).includes('challenge-plain'), false);
    const signed = await post(challenge);
    assert.equal(signed.status, 200, JSON.stringify(signed.d));
    assert.equal(signed.d.challenge, 'challenge-plain');
    const stale = await post({ type: 'event_callback', team_id: team, event_id: 'Estale', event: { type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'late', channel: 'D111', ts: '1' } }, { ts: Math.floor(Date.now() / 1000) - 600 });
    assert.equal(stale.status, 401);
    const wrongTeam = await post({ type: 'event_callback', team_id: 'TOTHER999', event_id: 'Eteam', event: { type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'wrong team', channel: 'D111', ts: '2' } });
    assert.equal(wrongTeam.status, 401);
    const dm = await post({ type: 'event_callback', team_id: team, event_id: 'Edm', event: { type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'Slack hello chief', channel: 'D111', ts: '3' } });
    assert.equal(dm.status, 200, JSON.stringify(dm.d));
    assert.equal(dm.d.route, 'chief');
    const mention = await post({ type: 'event_callback', team_id: team, event_id: 'Emen', event: { type: 'app_mention', user: 'U0OWNER1', text: '<@B1> plan the week', channel: 'C222', ts: '4' } });
    assert.equal(mention.status, 200, JSON.stringify(mention.d));
    assert.equal(mention.d.route, 'chief');
    const other = await post({ type: 'event_callback', team_id: team, event_id: 'Eoth', event: { type: 'message', channel_type: 'im', user: 'USTRANGE', text: 'I am a customer', channel: 'D333', ts: '5' } });
    assert.equal(other.d.route, 'drop');
    const slackThreads = (await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.filter((c) => c.channel === 'slack');
    assert.ok(slackThreads.some((c) => c.peer === 'D111' && c.messages.some((m) => m.status === 'sent')));
    assert.equal(slackThreads.some((c) => c.peer === 'D333'), false);
    await req(s, 'POST', '/api/channels/slack', { customers: true }, A);
    const cust = await post({ type: 'event_callback', team_id: team, event_id: 'Ecust', event: { type: 'message', channel_type: 'im', user: 'USTRANGE', text: 'Can someone help?', channel: 'D333', ts: '6' } });
    assert.equal(cust.d.route, 'desk');
    const custThread = (await req(s, 'GET', '/api/channels', undefined, A)).d.conversations.find((c) => c.channel === 'slack' && c.peer === 'D333');
    assert.ok(custThread);
    assert.equal(custThread.messages.some((m) => m.status === 'sent'), false);
    assert.ok(custThread.messages.some((m) => m.status === 'draft'));
    assert.equal((await req(s, 'POST', '/api/channels/send', { channel: 'whatsapp_qr', to: '919800022288', body: 'hello customer' }, A)).status, 400);
    assert.equal((await req(s, 'POST', '/api/channels/whatsapp-qr/start', {}, A)).status, 403);
    const log = s.log();
    assert.equal(log.includes(tgToken), false);
    assert.equal(log.includes(secret), false);
    assert.equal(log.includes(slToken), false);
    assert.equal(log.includes(slSecret), false);
    assert.equal(log.includes(saved.d.telegram.link_code), false);
  } finally { await s.stop(); }
});

test('whatsapp qr stays owner-only and refuses a serverless host', { timeout: 120000 }, async () => {
  const on = await startServer({ ...MOCK, WHATSAPP_QR: 'on' });
  const offHost = await startServer({ ...MOCK, WHATSAPP_QR: 'on', VERCEL: '1', ALLOW_FILE_STORE: '1' });
  try {
    const A = (await req(on, 'POST', '/api/auth/signup', { email: 'qr-a@example.com', name: 'Owner', password: PW })).d.token;
    const link = await req(on, 'POST', '/api/channels/whatsapp-qr/mock', { action: 'link', owner: '919800011199' }, A);
    assert.equal(link.status, 200, JSON.stringify(link.d));
    assert.match(link.d.warning, /unofficial/i);
    assert.match(link.d.warning, /never messages customers|cannot message customers|never broadcasts|It never messages/i);
    const other = await req(on, 'POST', '/api/channels/whatsapp-qr/mock', { action: 'inbound', from: '919800022288', body: 'I am a customer', id: 'c1' }, A);
    assert.equal(other.status, 200, JSON.stringify(other.d));
    assert.equal(other.d.route, 'drop');
    assert.equal((await req(on, 'GET', '/api/leads?limit=20', undefined, A)).d.leads.length, 0);
    assert.equal((await req(on, 'GET', '/api/channels', undefined, A)).d.conversations.length, 0);
    const self = await req(on, 'POST', '/api/channels/whatsapp-qr/mock', { action: 'inbound', from: '919800011199', body: 'Chief, what should I do today?', id: 'o1' }, A);
    assert.equal(self.status, 200, JSON.stringify(self.d));
    assert.equal(self.d.route, 'chief');
    const threads = (await req(on, 'GET', '/api/channels', undefined, A)).d.conversations;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].channel, 'whatsapp_qr');
    assert.equal(threads[0].peer, '919800011199');
    assert.ok(threads[0].messages.some((m) => m.dir === 'out' && m.status === 'sent'));
    assert.equal((await req(on, 'GET', '/api/leads?limit=20', undefined, A)).d.leads.length, 0);
    const blast = await req(on, 'POST', '/api/channels/whatsapp-qr/mock', { action: 'send', to: '919800022288', body: 'broadcast' }, A);
    assert.equal(blast.status, 400);
    assert.equal(blast.d.error, 'owner_only');
    const group = await req(on, 'POST', '/api/channels/whatsapp-qr/mock', { action: 'send', to: '919800011199@g.us', body: 'group' }, A);
    assert.equal(group.status, 400);
    assert.equal(group.d.error, 'owner_only');
    assert.equal((await req(on, 'GET', '/api/channels', undefined, A)).d.conversations.length, 1);
    const hinted = (await req(on, 'GET', '/api/channels', undefined, A)).d;
    assert.equal(JSON.stringify(hinted).includes('SUPERSECRET'), false);
    assert.equal(hinted.channels.whatsapp_qr.beta, true);
    assert.equal(hinted.channels.whatsapp_qr.linked, true);
    assert.match(hinted.channels.whatsapp_qr.warning, /Vercel|serverless|persistent/i);

    const B = (await req(offHost, 'POST', '/api/auth/signup', { email: 'qr-b@example.com', name: 'Hosted', password: PW })).d.token;
    const start = await req(offHost, 'POST', '/api/channels/whatsapp-qr/start', {}, B);
    assert.equal(start.status, 503, JSON.stringify(start.d));
    assert.match(start.d.message, /Vercel|serverless|persistent/i);
    assert.equal((await req(offHost, 'GET', '/api/health')).status, 200);
    assert.equal(offHost.log().includes('wss://web.whatsapp.com'), false);
  } finally {
    await on.stop();
    await offHost.stop();
  }
});
