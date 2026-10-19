// PR #2 review: auto email limits, no platform-mailbox fallback for workflows, HTML emails sent as HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOutbound, normalizeCompiled } from '../lib/workflows.js';
import { looksHtml, htmlToText } from '../lib/mailer.js';
import { fakeSMTP } from './mocks.mjs';

const auto = { type: 'send_email', autonomy: 'auto' };
test('auto email: contact only, step cap, account ceiling', () => {
  assert.equal(decideOutbound(auto, { recipient: 'a@x.co', leadEmail: 'a@x.co' }).action, 'send');
  assert.equal(decideOutbound(auto, { recipient: 'evil@x.co', leadEmail: 'a@x.co' }).reason, 'recipient');
  assert.equal(decideOutbound(auto, { recipient: 'a@x.co', sentToday: 25 }).reason, 'cap');
  assert.equal(decideOutbound({ ...auto, limits: { daily_cap: 2 } }, { recipient: 'a@x.co', sentToday: 2 }).reason, 'cap');
  assert.equal(decideOutbound(auto, { recipient: 'a@x.co', sentTodayAll: 50 }).reason, 'cap');
  assert.equal(decideOutbound({ type: 'send_email', autonomy: 'auto_within_limits', limits: { daily_cap: 5, allowed_recipients: ['lead'] } }, { recipient: 'a@x.co', sentTodayAll: 50 }).reason, 'cap');
  assert.equal(decideOutbound({ type: 'pay', autonomy: 'auto' }, { recipient: 'a@x.co' }).action, 'queue');
  assert.equal(decideOutbound({ type: 'social_post', autonomy: 'auto' }, { recipient: 'a@x.co' }).action, 'queue');
});

test('compiled workflows (model or injected text) can never start outbound steps on auto', () => {
  const n = normalizeCompiled({ name: 'x', trigger: { type: 'lead.created' }, steps: [{ type: 'send_email', autonomy: 'auto', subject: 's', body: 'b' }, { type: 'pay', autonomy: 'auto' }, { type: 'social_post', autonomy: 'auto_within_limits' }] });
  for (const s of n.steps.filter((x) => ['send_email', 'pay', 'social_post'].includes(x.type))) assert.equal(s.autonomy, 'needs_approval');
});

test('HTML detection and the plain-text copy', () => {
  assert.equal(looksHtml('Hi there, see https://x.co'), false);
  assert.equal(looksHtml('<p>Hi</p><img src="https://a/t/o/x.gif">'), true);
  assert.equal(htmlToText('<p>Hi <a href="https://a.co/t/c/1">pricing</a></p><img src="x">'), 'Hi pricing (https://a.co/t/c/1)');
});

test('sendEmail: HTML body goes out as HTML; ownOnly never falls back to the platform mailbox', async () => {
  const smtp = await fakeSMTP();
  const save = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_IGNORE_TLS: 'true', GMAIL_USER: 'platform@example.com', GMAIL_APP_PASSWORD: 'test-app-password' });
  try {
    const { sendEmail } = await import('../lib/mailer.js');
    const st = { get: async () => null, put: async () => {} };
    await assert.rejects(sendEmail({ st, email: 't@x.co', secret: async () => 's', to: 'lead@x.co', subject: 'Hi', body: 'x', ownOnly: true }), /isn’t connected/);
    await sendEmail({ st, email: 't@x.co', secret: async () => 's', to: 'lead@x.co', subject: 'Hi', body: '<p>Hello <a href="https://a.co/t/c/1">here</a></p>' });
    const m = smtp.mails[smtp.mails.length - 1];
    assert.match(m.data, /text\/html/i); assert.match(m.data, /text\/plain/i);
  } finally { process.env = save; await smtp.close(); }
});
