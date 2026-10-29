// Product display name lives in lib/brand.js; draft privacy/terms stubs are served and linked from sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ROOT } from './helpers.mjs';
import { BRAND, DISPLAY_NAME, LEGAL_NAME, applyBrandTokens } from '../lib/brand.js';

const read = (n) => fs.readFileSync(path.join(ROOT, n), 'utf8');

test('brand module exports a non-final display name and legal placeholder', () => {
  assert.equal(DISPLAY_NAME, 'AIdentify');
  assert.match(LEGAL_NAME, /TBD/);
  assert.deepEqual(BRAND, { displayName: DISPLAY_NAME, legalName: LEGAL_NAME, final: false });
  assert.equal(applyBrandTokens('{{PRODUCT_NAME}}/{{LEGAL_NAME}}'), `${DISPLAY_NAME}/${LEGAL_NAME}`);
});

test('high-traffic page titles use the brand display name', () => {
  for (const f of ['index.html', 'clinic.html', 'settings.html']) {
    assert.ok(read(f).match(/<title>([^<]*)<\/title>/)[1].includes(DISPLAY_NAME), f);
  }
});

test('privacy and terms stubs are drafts, linked from sign-in, and served with the brand name', async () => {
  const idx = read('index.html');
  assert.ok(idx.includes('href="/privacy.html"') && idx.includes('href="/terms.html"'));
  const s = await startServer();
  try {
    for (const p of ['/privacy', '/terms.html']) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.match(html, /Draft/);
      assert.match(html, /not legal advice/);
      assert.ok(html.includes(DISPLAY_NAME) && !html.includes('{{'), p);
    }
  } finally { await s.stop(); }
});
