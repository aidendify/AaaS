// Bot Mode reuses the existing workplace chat. The demo-key continue exists only when CLINIC_DEMO_PLATFORM_KEY=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';
import { buildSeed, chiefBrief } from '../lib/clinic.js';

const PW = 'Clinic-pass-123!';
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('chat is the default and Advanced opens the dashboards', () => {
  const clinic = read('clinic.html');
  assert.match(clinic, />Advanced</);
  assert.match(clinic, /aaas_advanced:/);
  assert.match(clinic, /aaas_bot_mode:/);
  assert.match(clinic, /\/clinic#chat/);
  assert.match(clinic, /\/clinic#advanced/);
  assert.match(clinic, /data-act="advanced"/);
  assert.match(clinic, /data-act="open-chief"/);
  assert.match(clinic, /aria-label="Chief"/);
  assert.match(clinic, /data-act="decide"/);
  assert.match(clinic, /href="\/clinic-theme.css"/);
  assert.match(read('clinic-theme.css'), /--primary:/);
  assert.match(read('clinic-theme.css'), /Inter/);
  assert.match(clinic, /Nothing is sent until you approve/);
});

test('the Chief opener uses today’s leads, approvals and payments', () => {
  const now = Date.parse('2026-10-28T06:30:00.000Z');
  const brief = chiefBrief(buildSeed('dental', now), now);
  assert.equal(brief.name, 'Chief');
  assert.match(brief.opener, /open enquiries/);
  assert.match(brief.opener, /waiting for approval/);
  assert.match(brief.opener, /unpaid/);
  assert.match(brief.opener, /booked today/);
  assert.match(brief.opener, /Nothing is sent until you approve/);
  assert.ok(brief.pending > 0);
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
