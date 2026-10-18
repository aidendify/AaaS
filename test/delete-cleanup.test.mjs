// Deleting an account also retires its public page links (as_tok:<token> rows that point at the email).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers.mjs';

test('account delete removes public form tokens, so the lead form 404s and no row keeps the email', async () => {
  const s = await startServer({ RATE_LIMIT: 'off' });
  try {
    const email = 'del-' + Date.now() + '@example.com', pw = 'Delete-me-123!';
    const su = await s.api('/api/auth/signup', { email, name: 'Del Test', password: pw }); assert.equal(su.status, 200);
    const tok = crypto.randomBytes(16).toString('hex');
    const put = await fetch(s.base + '/api/kv', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + su.d.token }, body: JSON.stringify({ k: 'as_data:' + email, v: JSON.stringify({ agents: [{ id: 1, kind: 'formfirst', name: 'FormFirst', forms: [{ token: tok, title: 'Quote' }], recs: [] }] }), at: Date.now() }) });
    assert.equal(put.status, 200);
    assert.match(await (await fetch(s.base + '/p/f/' + tok)).text(), /<form/);
    const del = await s.api('/api/auth/delete', { password: pw }, su.d.token); assert.equal(del.status, 200);
    assert.doesNotMatch(await (await fetch(s.base + '/p/f/' + tok)).text(), /<form/);
    const kv = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'kv.json'), 'utf8'));
    const left = Object.values(kv).filter((r) => r && r.v && String(r.v).includes(email));
    assert.deepEqual(left.map((r) => r.k), []);
  } finally { await s.stop(); }
});
