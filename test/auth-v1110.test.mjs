// v1.11.0: password rules, reset token lifecycle, friendlier lockout messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { weakPassword, HttpError, _throttleForTests as T } from '../lib/backend.js';
import { issueResetToken, useResetToken, RESET_TTL_MS } from '../lib/pwreset.js';

const memStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? { v: m.get(k) } : null), put: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); } }; };

test('password rules: min 8 for customers, common and easy ones rejected, good ones pass', () => {
  assert.match(weakPassword('short1', 8), /at least 8/);
  assert.match(weakPassword('password123', 8), /common|easy/);
  assert.match(weakPassword('aaaaaaaaaa', 8), /easy/);
  assert.equal(weakPassword('Mango-river-42', 8), '');
  assert.match(weakPassword('Mango-river', 12), /at least 12/); // staff
});

test('reset token: hashed at rest, single use, expires after 30 min, newer link cancels older', async () => {
  const st = memStore(), now = Date.now();
  const t1 = await issueResetToken(st, 'a@x.com', now);
  assert.ok(![...st.m.keys()].some((k) => k.includes(t1)) && ![...st.m.values()].some((v) => v.includes(t1)), 'raw token never stored');
  const t2 = await issueResetToken(st, 'a@x.com', now);
  assert.equal(await useResetToken(st, t1, { now }), '', 'older link stops working');
  assert.equal(await useResetToken(st, t2, { consume: false, now }), 'a@x.com');
  assert.equal(await useResetToken(st, t2, { now }), 'a@x.com');
  assert.equal(await useResetToken(st, t2, { now }), '', 'single use');
  const t3 = await issueResetToken(st, 'a@x.com', now);
  assert.equal(await useResetToken(st, t3, { now: now + RESET_TTL_MS + 1 }), '', 'expired');
  assert.equal(await useResetToken(st, 'garbage', { now }), '');
});

test('lockout message says how long to wait', () => {
  T.clear();
  for (let i = 0; i < 10; i++) T.noteAttempt('login:z@x.com');
  try { T.throttle('login:z@x.com', 10); assert.fail('should throttle'); }
  catch (e) { assert.ok(e instanceof HttpError); assert.equal(e.status, 429); assert.match(e.message, /try again in 15 minutes/); assert.match(e.message, /Forgot password/); assert.ok(e.extra.retryAfter > 800); }
  T.clear();
});

test('forgot + reset over HTTP: no email enumeration, no token leak without mock, old password stops working', async () => {
  const srv = await startServer({ RATE_LIMIT: 'off' });
  try {
    const em = 'e2e-unit-1@example.com';
    assert.equal((await srv.api('/api/auth/signup', { email: em, name: 'U', password: 'password123' })).status, 400);
    assert.equal((await srv.api('/api/auth/signup', { email: em, name: 'U', password: 'Old-pass-829x' })).status, 200);
    const a = await srv.api('/api/auth/forgot', { email: em }), b = await srv.api('/api/auth/forgot', { email: 'nobody@example.com' });
    assert.equal(a.status, 200); assert.equal(a.d.message.replace(em, ''), b.d.message.replace('nobody@example.com', ''), 'same answer either way');
    assert.equal(a.d.testToken, undefined, 'token never in the reply without mock AI');
    const link = srv.log().match(/#as_reset=([\w-]+)/g); assert.ok(link && link.length === 1, 'local server logs the link once (no log for unknown email)');
    const tok = link[0].split('=')[1];
    assert.equal((await srv.api('/api/auth/reset-password', { token: tok, password: 'short' })).status, 400);
    const ok = await srv.api('/api/auth/reset-password', { token: tok, password: 'New-pass-551y' }); assert.equal(ok.status, 200);
    assert.equal((await srv.api('/api/auth/reset-password', { token: tok, password: 'New-pass-551y' })).d.error, 'reset_invalid');
    assert.equal((await srv.api('/api/auth/login', { email: em, password: 'Old-pass-829x' })).status, 401);
    assert.equal((await srv.api('/api/auth/login', { email: em, password: 'New-pass-551y' })).status, 200);
  } finally { await srv.stop(); }
});

test('mock-AI server returns the test token for e2e throwaway emails only', async () => {
  const srv = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on' });
  try {
    await srv.api('/api/auth/signup', { email: 'e2e-unit-2@example.com', name: 'U', password: 'Old-pass-829x' });
    await srv.api('/api/auth/signup', { email: 'real@example.org', name: 'U', password: 'Old-pass-829x' });
    assert.ok((await srv.api('/api/auth/forgot', { email: 'e2e-unit-2@example.com' })).d.testToken);
    assert.equal((await srv.api('/api/auth/forgot', { email: 'real@example.org' })).d.testToken, undefined);
  } finally { await srv.stop(); }
});

test('wrong password shows tries left; login redirects go to the one sign-in screen', async () => {
  const srv = await startServer({});
  try {
    await srv.api('/api/auth/signup', { email: 'e2e-unit-3@example.com', name: 'U', password: 'Old-pass-829x' });
    let r; for (let i = 0; i < 8; i++) r = await srv.api('/api/auth/login', { email: 'e2e-unit-3@example.com', password: 'wrong-wrong' });
    assert.match(r.d.message, /2 tries left/); assert.equal(r.d.triesLeft, 2);
    for (let i = 0; i < 2; i++) r = await srv.api('/api/auth/login', { email: 'e2e-unit-3@example.com', password: 'wrong-wrong' });
    r = await srv.api('/api/auth/login', { email: 'e2e-unit-3@example.com', password: 'Old-pass-829x' });
    assert.equal(r.status, 429); assert.match(r.d.message, /try again in \d+ minutes/);
    const s = await fetch(srv.base + '/signup', { redirect: 'manual' }); assert.equal(s.status, 302); assert.equal(s.headers.get('location'), '/#signup');
  } finally { await srv.stop(); }
});
