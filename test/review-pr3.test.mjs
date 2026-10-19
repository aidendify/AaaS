import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareInstall } from '../lib/playbooks.js';

const base = { name: 'P', workflows: [{ name: 'W', trigger: { type: 'lead_created' }, steps: [{ id: 's1', type: 'send_email', autonomy: 'auto', autonomy_set_by: 'customer', subject: 'Hi', body: '<p onclick="x()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">x</a></p>', limits: { allowed_recipients: ['lead', 'boss@corp.com'] } }] }] };

test('playbook import: size cap, no script, no autonomy escalation', () => {
  assert.throws(() => prepareInstall({ name: 'big', summary: 'x'.repeat(300 * 1024) }), /too big/);
  const p = prepareInstall(structuredClone(base));
  const s = JSON.stringify(p);
  assert.doesNotMatch(s, /<script|onclick|javascript:/i);
  assert.doesNotMatch(s, /"autonomy":"auto"/);
  assert.doesNotMatch(s, /boss@corp\.com/);
});
test('playbook export scrub strips contact details from text', () => {
  const p = prepareInstall({ name: 'P', summary: 'x', templates: [{ name: 'T', subject: 'Hi', body: 'Call Ravi on +91 98765 43210 or ravi@acme.in' }] }, { pii: true });
  assert.doesNotMatch(JSON.stringify(p), /98765|ravi@acme/);
});
