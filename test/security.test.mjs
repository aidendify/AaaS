import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';

const STRONG = 'Correct-Horse-Battery-42';
process.env.AIDENTIFY_DATA_DIR ||= (await import('node:fs')).mkdtempSync('/tmp/aidentify-unit-');

test('first run: no admin, setup is required, default passwords do not work', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  assert.deepEqual((await s.api('/api/setup')).d, { needed: true });
  assert.match(s.log(), /FIRST RUN: no admin account yet/);
  for (const [email, password] of [['admin@agentsphere.com', 'admin1234'], ['team@agentsphere.com', 'team1234'], ['admin@aidentify.local', 'admin1234'], ['team@aidentify.local', 'team1234']]) {
    const r = await s.api('/api/auth/login', { email, password });
    assert.equal(r.status, 401, `default login ${email} must fail`);
  }
  const code = fs.readFileSync(path.join(s.dir, 'data', 'setup-code'), 'utf8').trim();
  // wrong code, weak passwords
  assert.equal((await s.api('/api/setup', { code: 'nope', email: 'boss@example.com', password: STRONG })).status, 403);
  for (const pw of ['admin1234', 'short', 'password1234', 'aaaaaaaaaaaaaa', 'team1234team']) {
    const r = await s.api('/api/setup', { code, email: 'boss@example.com', password: pw });
    assert.equal(r.status, 400, `weak password "${pw}" must be rejected`);
    assert.equal(r.d.error, 'weak_password');
  }
  const ok = await s.api('/api/setup', { code, email: 'boss@example.com', password: STRONG, name: 'Boss' });
  assert.equal(ok.status, 200); assert.equal(ok.d.user.role, 'admin');
  assert.ok(!fs.existsSync(path.join(s.dir, 'data', 'setup-code')), 'setup code is removed after use');
  assert.deepEqual((await s.api('/api/setup')).d, { needed: false });
  assert.equal((await s.api('/api/setup', { code, email: 'evil@example.com', password: STRONG })).status, 409, 'setup cannot run twice');
  const login = await s.api('/api/auth/login', { email: 'boss@example.com', password: STRONG });
  assert.equal(login.status, 200);
  assert.equal((await s.api('/api/settings/me', undefined, login.d.token)).d.admin, true);
});

test('existing installs: a strong ADMIN_PASSWORD still creates and signs in the admin; a weak one is ignored', async (t) => {
  const s = await startServer({ ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: STRONG });
  t.after(s.stop);
  assert.deepEqual((await s.api('/api/setup')).d, { needed: false });
  assert.equal((await s.api('/api/auth/login', { email: 'owner@example.com', password: STRONG })).status, 200);
  const w = await startServer({ ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'admin1234' });
  t.after(w.stop);
  assert.deepEqual((await w.api('/api/setup')).d, { needed: true });
  assert.equal((await w.api('/api/auth/login', { email: 'owner@example.com', password: 'admin1234' })).status, 401);
  assert.match(w.log(), /ADMIN_PASSWORD in \.env is too weak/);
});

test('remote browser and settings endpoints reject unauthenticated and non-owner requests', async (t) => {
  const s = await startServer({ ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: STRONG, SLACK_ACCOUNT_EMAIL: 'owner@example.com' });
  t.after(s.stop);
  for (const action of ['open', 'close', 'status']) {
    assert.equal((await s.api('/api/settings/remote-browser', { action })).status, 401, `no session: ${action}`);
    assert.equal((await s.api('/api/settings/remote-browser', { action }, 'forged.token')).status, 401, `forged token: ${action}`);
  }
  for (const p of ['/api/settings', '/api/settings/status', '/api/settings/audit', '/api/settings/backup', '/api/settings/logs']) assert.equal((await s.api(p)).status, 401, p);
  // a normal customer account is refused (403)
  const up = await s.api('/api/auth/signup', { email: 'customer@example.com', name: 'C', password: 'customer-pass-123' });
  assert.equal(up.status, 200);
  for (const action of ['open', 'close', 'status']) assert.equal((await s.api('/api/settings/remote-browser', { action }, up.d.token)).status, 403, `customer: ${action}`);
  // no other route starts it
  for (const p of ['/remote-browser', '/api/remote-browser', '/api/browser/open', '/api/remote-browser/open']) {
    const r = await s.api(p, { action: 'open' });
    assert.ok([401, 404, 405].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.doesNotMatch(s.log(), /Remote browser: open/);
});

test('weakPassword rules', async () => {
  process.env.AIDENTIFY_DATA_DIR = fs.mkdtempSync('/tmp/aidentify-unit-');
  const { weakPassword } = await import('../lib/backend.js');
  for (const pw of ['', 'admin1234', 'team1234', 'demo12345', 'Password1234', 'changeme123', '111111111111', '1234567890ab']) assert.ok(weakPassword(pw), pw);
  for (const pw of [STRONG, 'blue-kite-river-7', 'Tr0ub4dor&3xyz']) assert.equal(weakPassword(pw), '', pw);
  fs.rmSync(process.env.AIDENTIFY_DATA_DIR, { recursive: true, force: true });
});

test('upgrade: an account still on the old default password cannot sign in, and takes a strong ADMIN_PASSWORD', async (t) => {
  const { _test } = await import('../lib/backend.js');
  const fsP = await import('node:fs'); const os = await import('node:os'); const pathM = await import('node:path');
  const mk = (pw) => {
    const dir = fsP.mkdtempSync(pathM.join(os.tmpdir(), 'aidentify-up-')); fsP.mkdirSync(pathM.join(dir, 'data'));
    const users = { 'admin@agentsphere.com': { name: 'Admin', role: 'admin', hash: _test.hashPassword('admin1234') } };
    fsP.writeFileSync(pathM.join(dir, 'data', 'kv.json'), JSON.stringify({ as_users: { k: 'as_users', v: JSON.stringify(users), at: 1 } }));
    return dir;
  };
  // old data, no new password in .env: default login refused, no setup needed (an admin exists)
  const d1 = mk();
  const a = await startServer({ AIDENTIFY_DATA_DIR: pathM.join(d1, 'data'), ADMIN_EMAIL: 'admin@agentsphere.com' });
  t.after(async () => { await a.stop(); fsP.rmSync(d1, { recursive: true, force: true }); });
  const r = await a.api('/api/auth/login', { email: 'admin@agentsphere.com', password: 'admin1234' });
  assert.equal(r.status, 403); assert.equal(r.d.error, 'default_password');
  // with a strong ADMIN_PASSWORD the account takes it, and the default stops working
  const d2 = mk();
  const b = await startServer({ AIDENTIFY_DATA_DIR: pathM.join(d2, 'data'), ADMIN_EMAIL: 'admin@agentsphere.com', ADMIN_PASSWORD: STRONG });
  t.after(async () => { await b.stop(); fsP.rmSync(d2, { recursive: true, force: true }); });
  assert.equal((await b.api('/api/auth/login', { email: 'admin@agentsphere.com', password: STRONG })).status, 200);
  assert.notEqual((await b.api('/api/auth/login', { email: 'admin@agentsphere.com', password: 'admin1234' })).status, 200);
});
