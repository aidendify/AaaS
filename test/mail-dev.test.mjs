import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendSystemEmail, devMailMode, systemMailReady, _resetEthereal } from '../lib/mailer.js';

const clean = () => { for (const k of ['MAIL_DEV', 'MAIL_DEV_FILE', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'VERCEL']) delete process.env[k]; };

test('no MAIL_DEV and no Gmail → no_system_mail', async () => {
  clean(); assert.equal(systemMailReady(), false);
  await assert.rejects(sendSystemEmail({ to: 'a@b.co', subject: 's', body: 'b' }), /no_system_mail/);
});

test('MAIL_DEV ignored on Vercel and for unknown values', () => {
  clean(); process.env.MAIL_DEV = 'log'; process.env.VERCEL = '1'; assert.equal(devMailMode(), '');
  clean(); process.env.MAIL_DEV = 'ses'; assert.equal(devMailMode(), ''); clean();
});

test('MAIL_DEV=log prints the message, no network', async () => {
  clean(); process.env.MAIL_DEV = 'log';
  const logs = [], orig = console.log; console.log = (m) => logs.push(String(m));
  try { await sendSystemEmail({ to: 'a@b.co', subject: 'Your code', body: '123456', fromName: 'Acme' }); } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.includes('Your code') && l.includes('123456')));
  clean();
});

test('MAIL_DEV=file appends JSON lines', async () => {
  clean(); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-')), 'out.jsonl');
  process.env.MAIL_DEV = 'file'; process.env.MAIL_DEV_FILE = f;
  const orig = console.log; console.log = () => {};
  try { await sendSystemEmail({ to: 'x@y.co', subject: 'Reset', body: '<p>link</p>' }); await sendSystemEmail({ to: 'z@y.co', subject: 'Two', body: 'b' }); } finally { console.log = orig; }
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); assert.equal(lines[0].subject, 'Reset'); assert.match(lines[0].html, /link/);
  clean();
});

test('MAIL_DEV=ethereal uses test account (mocked nodemailer)', async () => {
  clean(); _resetEthereal(); process.env.MAIL_DEV = 'ethereal';
  const sent = []; let accts = 0;
  const nodemailer = {
    createTestAccount: async () => { accts++; return { user: 'u@ethereal.email', pass: 'p', smtp: { host: 'smtp.ethereal.email', port: 587, secure: false } }; },
    createTransport: (o) => { assert.equal(o.host, 'smtp.ethereal.email'); return { sendMail: async (m) => { sent.push(m); return { messageId: '<id1>' }; } }; },
    getTestMessageUrl: () => 'https://ethereal.email/message/x',
  };
  const logs = [], orig = console.log; console.log = (m) => logs.push(String(m));
  try {
    assert.equal(await sendSystemEmail({ to: 'a@b.co', subject: 's', body: 'b' }, { nodemailer }), '<id1>');
    await sendSystemEmail({ to: 'a@b.co', subject: 's2', body: 'b' }, { nodemailer });
  } finally { console.log = orig; }
  assert.equal(accts, 1); assert.equal(sent.length, 2);
  assert.ok(logs.some((l) => l.includes('ethereal.email/message/x')));
  clean(); _resetEthereal();
});
