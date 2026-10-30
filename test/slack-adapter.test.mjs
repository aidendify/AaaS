// Slack adapter: owner DM -> Chief, customer DM -> approval draft only, send only after approve.
// Two tenants, mock tokens (CHANNELS_MOCK/AI_MOCK). Nothing calls Slack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { slackSignature } from '../lib/freech.js';

const PW = 'Channels-pass-123!';
const MOCK = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on' };
async function req(s, method, p, body, token) {
  const r = await fetch(s.base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch { /* not json */ }
  return { status: r.status, d };
}
function poster(s, hook, secret) {
  return async (obj) => {
    const body = JSON.stringify(obj); const ts = String(Math.floor(Date.now() / 1000));
    const r = await fetch(s.base + '/api/channels/slack/webhook/' + hook, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, body) } });
    let d = null; try { d = await r.json(); } catch { /* plain */ }
    return { status: r.status, d };
  };
}
const ev = (team, id, user, channel, text) => ({ type: 'event_callback', team_id: team, event_id: id, event: { type: 'message', channel_type: 'im', user, text, channel, ts: id } });

test('slack: owner to chief, customers only via approval, tenants isolated', { timeout: 120000 }, async () => {
  const s = await startServer(MOCK);
  try {
    const A = (await req(s, 'POST', '/api/auth/signup', { email: 'sl-a@example.com', name: 'A', password: PW })).d.token;
    const B = (await req(s, 'POST', '/api/auth/signup', { email: 'sl-b@example.com', name: 'B', password: PW })).d.token;
    await req(s, 'POST', '/api/frontdesk', { enabled: true, auto: 'needs_approval', faqs: [{ q: 'Hours', a: 'Weekdays.' }] }, A);
    const ca = await req(s, 'POST', '/api/channels/slack', { bot_token: 'mock_sl_tenant_aaa', signing_secret: 'slack-secret-tenant-a', owner_user_id: 'U0OWNERA', customers: true }, A);
    const cb = await req(s, 'POST', '/api/channels/slack', { bot_token: 'mock_sl_tenant_bbb', signing_secret: 'slack-secret-tenant-b', owner_user_id: 'U0OWNERB', customers: true }, B);
    assert.equal(ca.status, 200, JSON.stringify(ca.d)); assert.equal(cb.status, 200, JSON.stringify(cb.d));
    const hookA = ca.d.slack.webhook_url.split('/').pop(); const hookB = cb.d.slack.webhook_url.split('/').pop();
    assert.notEqual(hookA, hookB);
    const postA = poster(s, hookA, 'slack-secret-tenant-a');
    // B's signing secret cannot drive A's hook.
    assert.equal((await poster(s, hookA, 'slack-secret-tenant-b')(ev(ca.d.slack.team_id, 'X1', 'U0OWNERA', 'D1', 'hi'))).status, 401);

    const own = await postA(ev(ca.d.slack.team_id, 'E1', 'U0OWNERA', 'D1', 'Chief, what is on today?'));
    assert.equal(own.d.route, 'chief');
    const cust = await postA(ev(ca.d.slack.team_id, 'E2', 'UCUST01', 'D9', 'Are you open Saturday?'));
    assert.equal(cust.d.route, 'desk'); assert.equal(cust.d.sent, false);

    const thread = () => req(s, 'GET', '/api/channels', undefined, A).then((r) => r.d.conversations.find((c) => c.channel === 'slack' && c.peer === 'D9'));
    let t = await thread();
    assert.equal(t.messages.some((m) => m.dir === 'out' && m.status === 'sent'), false);
    const draft = t.messages.find((m) => m.dir === 'out' && m.status === 'draft');
    assert.ok(draft && draft.approval_id);
    const pending = (await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, A)).d.items;
    assert.ok(pending.some((a) => a.id === draft.approval_id && a.kind === 'slack'));

    // Tenant B sees nothing and cannot approve A's draft.
    assert.equal((await req(s, 'GET', '/api/channels', undefined, B)).d.conversations.length, 0);
    assert.equal((await req(s, 'GET', '/api/agents/approvals?status=pending', undefined, B)).d.items.some((a) => a.id === draft.approval_id), false);
    const cross = await req(s, 'POST', '/api/agents/approval', { id: draft.approval_id, decision: 'approve' }, B);
    assert.notEqual(cross.d && cross.d.approval && cross.d.approval.status, 'done');
    t = await thread();
    assert.equal(t.messages.some((m) => m.dir === 'out' && m.status === 'sent'), false);

    // Owner approves: now (and only now) it sends.
    const ok = await req(s, 'POST', '/api/agents/approval', { id: draft.approval_id, decision: 'approve' }, A);
    assert.equal(ok.status, 200, JSON.stringify(ok.d));
    t = await thread();
    assert.ok(t.messages.some((m) => m.approval_id === draft.approval_id && m.status === 'sent'));

    // Direct send to a Slack customer is held for approval, never sent straight away.
    const direct = await req(s, 'POST', '/api/channels/send', { channel: 'slack', to: 'D9', body: 'Follow-up' }, A);
    assert.equal(direct.status, 200, JSON.stringify(direct.d));
    assert.equal(direct.d.sent, false); assert.ok(direct.d.approval);
    const log = s.log();
    for (const x of ['mock_sl_tenant_aaa', 'mock_sl_tenant_bbb', 'slack-secret-tenant-a', 'slack-secret-tenant-b']) assert.equal(log.includes(x), false);
  } finally { await s.stop(); }
});
