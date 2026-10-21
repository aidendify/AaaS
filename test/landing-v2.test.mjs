// Landing site (AIDENTIFY_SITE=landing): v2 is /. v1 stays at /v1. /v2 and /white-label keep working.
// The product server still serves the app at /.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, ROOT } from './helpers.mjs';
import { BUSINESS_TYPES } from '../lib/waitlist.js';

const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('landing v2 reuses the waitlist business types, with no default on the main page', () => {
  const js = read('landing-v2.js');
  const listed = Function('return ' + js.match(/const BUSINESS_TYPES = (\[[\s\S]*?\]);/)[1])();
  assert.deepEqual(listed, BUSINESS_TYPES);
  assert.ok(BUSINESS_TYPES.length >= 14, 'canonical list is the server list');
  assert.equal(new Set(BUSINESS_TYPES).size, BUSINESS_TYPES.length);
  assert.ok(BUSINESS_TYPES.includes('Digital marketing agency'));
  assert.ok(BUSINESS_TYPES.includes('Other'));

  const main = read('landing-v2.html');
  const wl = read('white-label.html');
  assert.match(main, /name="businessType" required/);
  assert.match(main, /<option value="" selected>Choose one<\/option>/);
  assert.doesNotMatch(main, /data-preselect/);
  assert.match(wl, /data-preselect="Digital marketing agency"/);
  assert.match(js, /sel\.value = pre && BUSINESS_TYPES\.includes\(pre\) \? pre : ''/);
  for (const page of [main, wl]) {
    assert.match(page, /id="join-form"/);
    assert.match(page, /name="consent"/);
    assert.match(page, /name="website"/);
    assert.match(page, /src="\/landing-v2\.js"/);
  }
  assert.match(js, /fetch\('\/api\/waitlist'/);
  assert.match(main, /class="tab" href="\/white-label"/);
  assert.doesNotMatch(main, /₹14,999/);
  assert.match(wl, /₹14,999/);
  assert.match(main, /₹2,999/);
  assert.match(main, /₹5,999/);
  assert.match(main, /Product preview/);
  assert.doesNotMatch(main, /testimonial|trusted by|★★|customers love/i);
  assert.match(read('waitlist.html'), /Join the waitlist/);
  assert.doesNotMatch(read('waitlist.html'), /landing-v2/);
});

test('landing build serves v2 at / and keeps v1 as waitlist.html', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rewrite = (src) => vercel.rewrites.find((r) => r.source === src);
  assert.equal(rewrite('/v1').destination, '/waitlist.html');
  assert.equal(rewrite('/v2').destination, '/landing-v2.html');
  assert.equal(rewrite('/white-label').destination, '/white-label.html');
  assert.equal(vercel.rewrites.some((r) => r.source === '/' || r.source === '/index.html'), false);
  const build = (env) => execFileSync(process.execPath, ['scripts/vercel-build.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
  const pub = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
  try {
    build({ AIDENTIFY_SITE: '' });
    assert.equal(pub('index.html'), read('index.html'), 'product build keeps the app at /');
    build({ AIDENTIFY_SITE: 'landing' });
    assert.equal(pub('index.html'), read('landing-v2.html'));
    assert.notEqual(pub('index.html'), read('waitlist.html'));
    for (const f of ['landing-v2.html', 'white-label.html', 'landing-v2.css', 'landing-v2.js', 'waitlist.html']) {
      assert.equal(pub(f), read(f));
    }
  } finally {
    fs.rmSync(path.join(ROOT, 'public'), { recursive: true, force: true });
  }
});

test('server serves /v2 and /white-label and leaves / on the app', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const v2 = await fetch(s.base + '/v2');
  assert.equal(v2.status, 200);
  assert.match(v2.headers.get('content-type'), /text\/html/);
  const html = await v2.text();
  assert.match(html, /Hire an AI team/);
  assert.match(html, /White Label/);
  const wl = await fetch(s.base + '/white-label');
  assert.equal(wl.status, 200);
  assert.match(await wl.text(), /Resell AaaS under your brand/);
  const css = await fetch(s.base + '/landing-v2.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(s.base + '/landing-v2.js');
  assert.equal(js.status, 200);
  const home = await fetch(s.base + '/');
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.doesNotMatch(homeHtml, /Hire an AI team/);
  const v1 = await fetch(s.base + '/v1');
  assert.equal(v1.status, 200);
  assert.match(await v1.text(), /Never miss a lead again/);
  const wait = await fetch(s.base + '/waitlist');
  assert.match(await wait.text(), /Join the waitlist/);
  const opts = await s.api('/api/waitlist/options');
  assert.deepEqual(opts.d.businessTypes, BUSINESS_TYPES);
  const joined = await s.api('/api/waitlist', {
    name: 'Asha Rao', email: 'asha@clinic.example', businessType: 'Clinic: skin / aesthetic / hair',
    city: 'Pune', whatsapp: '9876543211', consent: true, source: 'landing-v2',
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.d.ok, true);
  const missing = await s.api('/api/waitlist', {
    name: 'Asha Rao', email: 'asha@clinic.example', businessType: '',
    city: 'Pune', whatsapp: '9876543211', consent: true,
  });
  assert.equal(missing.status, 400);
  assert.ok(missing.d.fields.businessType);
});

test('landing site serves v2 at / and v1 at /v1', async (t) => {
  const s = await startServer({ AIDENTIFY_SITE: 'landing' });
  t.after(s.stop);
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Hire an AI team/);
  assert.match(homeHtml, /href="\/white-label"/);
  const v2 = await fetch(s.base + '/v2');
  assert.match(await v2.text(), /Hire an AI team/);
  const v1 = await fetch(s.base + '/v1');
  const v1Html = await v1.text();
  assert.match(v1Html, /Never miss a lead again/);
  assert.doesNotMatch(v1Html, /landing-v2/);
  const wl = await fetch(s.base + '/white-label');
  assert.match(await wl.text(), /Resell AaaS under your brand/);
});
