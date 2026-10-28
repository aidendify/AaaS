// Bot Mode reuses the existing workplace chat. The demo-key continue exists only when CLINIC_DEMO_PLATFORM_KEY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';

const PW = 'Clinic-pass-123!';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Bot Mode reuses the workplace chat and remembers the choice', () => {
  const clinic = read('clinic.html');
  const app = read('index.html');
  assert.match(clinic, /Bot Mode/);
  assert.match(clinic, /aaas_bot_mode:/);
  assert.match(clinic, /\/clinic#bot/);
  assert.match(clinic, /\/\?bot=1#as_auth=/);
  assert.match(clinic, /title="Bot Mode"/);
  assert.match(clinic, /data-act="bot-mode"/);
  assert.match(clinic, /aria-pressed/);
  assert.match(app, /const botMode=/);
  assert.match(app, /if\(!botMode\)\{try\{const su=await fetch\('\/api\/setup'\)/);
  assert.match(app, /tab='My Workplace'/);
  assert.match(app, /class="wp-side"/);
  assert.match(app, /data-ap="approve"/);
  assert.doesNotMatch(clinic, /bot=1#as_auth=.*skipApproval/);
});

test('the demo-key continue is rendered only for a demo platform key', () => {
  const src = read('clinic.html');
  assert.match(src, /state\.aiKey\.source === 'demo'\) \? '<p><button class="btn-ghost" type="button" data-act="setup-demo-key">Continue with demo key \(demo only\)<\/button><\/p>' : ''/);
  assert.doesNotMatch(src, /data-act="setup-key-skip"/);
});

test('setup can finish on the demo key only when the flag is set', async () => {
  const off = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' });
  try {
    const signed = await off.api('/api/auth/signup', { email: 'demo-key-off@example.com', name: 'Off Owner', password: PW });
    const token = signed.d.token;
    await off.api('/api/clinic/profile', { biz: 'Off Studio', city: 'Pune', services: 'Calls', prices: '₹1000', audience: 'Owners', offer: 'Thursday' }, token);
    const role = await off.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.status, 200, JSON.stringify(role.d));
    assert.notEqual(role.d.aiKey.source, 'demo');
    const blocked = await off.api('/api/clinic/setup/finish', { tone: 'Short', phone: '919812340099', ack: true, demoKey: true }, token);
    assert.equal(blocked.status, 400, JSON.stringify(blocked.d));
    assert.equal(blocked.d.error, 'needs_ai_key');
  } finally { await off.stop(); }

  const on = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1', CLINIC_DEMO: '1' });
  try {
    const signed = await on.api('/api/auth/signup', { email: 'demo-key-on@example.com', name: 'On Owner', password: PW });
    const token = signed.d.token;
    await on.api('/api/clinic/profile', { biz: 'On Studio', city: 'Pune', services: 'Calls', prices: '₹1000', audience: 'Owners', offer: 'Thursday' }, token);
    const role = await on.api('/api/clinic/role', { role: 'coach' }, token);
    assert.equal(role.d.aiKey.source, 'demo');
    assert.equal(role.d.aiKey.label, 'Demo key, demo only');
    const still = await on.api('/api/clinic/setup/finish', { tone: 'Short', phone: '919812340099', ack: true }, token);
    assert.equal(still.status, 400, JSON.stringify(still.d));
    const done = await on.api('/api/clinic/setup/finish', { tone: 'Short and warm', phone: '919812340099', ack: true, demoKey: true }, token);
    assert.equal(done.status, 200, JSON.stringify(done.d));
    assert.equal(done.d.drafts.length, 3);
    assert.ok(done.d.drafts.every((d) => d.status === 'pending'));
    const key = await on.api('/api/ai/key', undefined, token);
    assert.equal(key.d.byok, null);
    const home = await on.api('/api/clinic', undefined, token);
    assert.equal(home.d.account, 'demo-key-on@example.com');
    assert.equal(home.d.agents.length, 6);
  } finally { await on.stop(); }
});
