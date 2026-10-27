// Phone and tablet screenshots of the clinic team. Not part of npm test.
// Usage: node scripts/clinic-mobile-shots.mjs
// Writes PNG files under SHOT_DIR (default /opt/cursor/artifacts).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../test/helpers.mjs';

const outDir = process.env.SHOT_DIR || '/opt/cursor/artifacts';
const widths = [375, 768];
const shots = [];

function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, inner: window.innerWidth, extra: doc.scrollWidth - window.innerWidth };
  });
}

async function shot(page, name) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  const box = await overflow(page);
  shots.push({ name, ...box, file });
  if (box.extra > 24) console.error('WIDE', name, box);
  else console.log('ok', name, box.inner + 'px');
}

async function boot(page, base, token, hash) {
  if (token) await page.addInitScript((t) => sessionStorage.setItem('aaas_clinic_token', t), token);
  // A query forces a real load. A hash-only change would keep the previous signed-in page.
  await page.goto(base + '/clinic?shot=' + Date.now() + (hash || ''), { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
}

const server = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO: '1' });
const browser = await chromium.launch({ headless: true });
try {
  const demo = await server.api('/api/clinic/demo', {});
  const ready = await server.api('/api/clinic/role', { role: 'dental' }, demo.d.token);
  if (ready.status !== 200) throw new Error('demo role failed ' + JSON.stringify(ready.d));
  const book = server.base + ready.d.formPath;

  for (const width of widths) {
    const owner = await server.api('/api/auth/signup', { email: 'mobile-' + width + '@example.com', name: 'Mobile Owner', password: 'Clinic-pass-123!' });
    if (owner.status !== 200) throw new Error('signup failed ' + JSON.stringify(owner.d));
    const page = await browser.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: 1 });
    const tag = 'mobile_' + width;

    await page.goto(server.base + '/clinic', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Create account' }).click();
    await shot(page, tag + '_signup');

    await boot(page, server.base, owner.d.token, '');
    await page.getByRole('heading', { name: 'Tell the team who you are' }).waitFor();
    await shot(page, tag + '_onboarding');

    await page.locator('input[name=biz]').fill('Mobile Dental');
    await page.locator('input[name=city]').fill('Hyderabad');
    await page.locator('input[name=services]').fill('Check-up, cleaning');
    await page.locator('input[name=prices]').fill('Check-up ₹1,200');
    await page.locator('input[name=audience]').fill('Families nearby');
    await page.locator('input[name=offer]').fill('A cleaning this week');
    await page.getByRole('button', { name: 'Continue to industry' }).click();
    await page.getByRole('heading', { name: 'Which business is this?' }).waitFor();
    await shot(page, tag + '_onboarding_industry');

    await boot(page, server.base, demo.d.token, '#dash');
    await page.getByRole('heading', { name: /Here is your week/ }).waitFor();
    await shot(page, tag + '_dashboard');

    await page.locator('nav').getByRole('button', { name: 'Approvals' }).click();
    await page.getByRole('heading', { name: 'Approvals inbox' }).waitFor();
    await shot(page, tag + '_approvals');

    await page.locator('nav').getByRole('button', { name: 'Billing & Invoicing' }).first().click();
    await page.getByRole('button', { name: 'Create invoice' }).waitFor();
    await shot(page, tag + '_billing');

    await page.locator('nav').getByRole('button', { name: 'Pricing' }).click();
    await page.getByRole('heading', { name: 'Launch pricing' }).waitFor();
    await shot(page, tag + '_pricing');

    await page.goto(book, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Book a visit' }).waitFor();
    await shot(page, tag + '_booking_form');

    await boot(page, server.base, demo.d.token, '#dash');
    await page.getByRole('button', { name: 'Chat' }).click();
    await page.getByPlaceholder(/How many/).waitFor();
    await page.locator('#chatIn').fill('How many patients in the last 2 months?');
    await page.locator('section.chat').getByRole('button', { name: 'Send' }).click();
    await page.locator('.bubble.a').first().waitFor({ timeout: 20000 });
    await shot(page, tag + '_chat');

    await page.close();
  }
} finally {
  await browser.close();
  await server.stop();
}

const wide = shots.filter((s) => s.extra > 24);
fs.writeFileSync(path.join(outDir, 'clinic_mobile_shots.json'), JSON.stringify({ shots, wide }, null, 2));
if (wide.length) {
  console.error(JSON.stringify(wide, null, 2));
  process.exit(1);
}
console.log('wrote', shots.length, 'screenshots to', outDir);
