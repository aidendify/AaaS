// Shared helpers for the local demo recordings. Fake accounts only.
import crypto from 'node:crypto';

export const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3210';
export const CRON = 'c'.repeat(32);
export const PW = 'Glow-atelier-123!';

export async function api(token, method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  if (!r.ok) {
    const err = new Error(`${method} ${path} → ${r.status} ${data && (data.message || data.error) || text.slice(0, 180)}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function signup(email, name, password = PW, business) {
  const d = await api(null, 'POST', '/api/auth/signup', { email, name, password, ...(business ? { business } : {}) });
  return { token: d.token, user: d.user, email, password };
}

export function slackHeaders(secret, raw) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + ts + ':' + raw).digest('hex');
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

export async function postRaw(path, raw, headers) {
  const r = await fetch(BASE + path, { method: 'POST', headers, body: raw });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  return data;
}

export async function workspace(token, email, profile) {
  const body = {
    agents: [], feed: [], tasks: [], nid: 4,
    wp: { convs: [], cur: null, profile },
    seeded: ['research', 'finance', 'support', 'changeslip'],
    rev: 0,
    pubIds: [],
  };
  const saved = await api(token, 'PUT', '/api/kv', { k: 'as_data:' + email, v: JSON.stringify(body), at: Date.now() });
  body.rev = saved.rev || 1;
  return JSON.stringify(body);
}

export async function setupDesk(token, { faqs, days, start, end, calendar = 'mock' }) {
  await api(token, 'POST', '/api/frontdesk', {
    enabled: true, auto: 'needs_approval', faqs, outside_template: '', limits: { daily_cap: 20 },
  });
  const av = await api(token, 'POST', '/api/frontdesk/availability', {
    timezone: 'Asia/Kolkata', days, start, end, slot_minutes: 30, calendar,
  });
  const widget = await api(token, 'POST', '/api/frontdesk/widget', {});
  return { slots: av.slots || [], widget: widget.widget };
}

export function captions() {
  const t0 = Date.now();
  const items = [];
  return {
    t0,
    say(text) { items.push({ at: Date.now() - t0, text: String(text) }); },
    items,
  };
}

export async function hold(page, ms) { await page.waitForTimeout(ms); }

const H = () => Number(process.env.HOLD_MS || 2600);

export async function beat(page, caps, text, ms) {
  caps.say(text);
  await hold(page, ms == null ? H() : ms);
}

export async function openApp(page, account) {
  await page.addInitScript(({ token, email, data }) => {
    localStorage.setItem('as_tok', token);
    localStorage.setItem('as_session', email);
    if (data) localStorage.setItem('as_data:' + email, data);
  }, account);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const ready = page.locator('#wpIn');
  try {
    await ready.waitFor({ timeout: 20000 });
  } catch (e) {
    const info = await page.evaluate((email) => ({
      onboard: !!document.querySelector('#onboard'),
      authHidden: document.querySelector('#auth') ? document.querySelector('#auth').classList.contains('hide') : null,
      body: document.body.className,
      hasData: !!localStorage.getItem('as_data:' + email),
      business: (() => { try { return JSON.parse(localStorage.getItem('as_data:' + email) || 'null').wp.profile.business; } catch { return ''; } })(),
    }), account.email);
    throw new Error('Workplace did not open ' + JSON.stringify(info));
  }
  const onboard = page.locator('#onboard');
  if (await onboard.count()) await onboard.evaluate((el) => el.remove());
  await page.waitForTimeout(500);
}

export async function askChief(page, text) {
  const box = page.locator('#wpIn');
  await box.click();
  await box.fill('');
  await box.pressSequentially(text, { delay: 18 });
  await page.waitForTimeout(350);
  await box.press('Enter');
  await page.locator('.wp-m.bot .wp-b').filter({ hasText: 'Here is a draft' }).last().waitFor({ timeout: 30000 });
}

export async function goTab(page, name) {
  const onWp = await page.locator('.wp-user').isVisible().catch(() => false);
  if (onWp) {
    if (name === 'My Workplace') return;
    await page.locator('.wp-user').click();
    await page.locator(`#wpUM [data-go="${name}"]`).click();
  } else {
    await page.locator('#avatarBtn').click();
    await page.locator(`#userPop [data-go="${name}"]`).click();
  }
  await page.waitForTimeout(500);
}

export async function approve(page, snippet, lookMs = 700) {
  if (!(await page.locator('.wp-user').isVisible().catch(() => false))) await goTab(page, 'My Workplace');
  await page.locator('.wp-user').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.wp-user').click();
  await page.locator('[data-act="wpUmHelp"]').click();
  await page.locator('[data-act="wpUmAppr"]').click();
  const row = page.locator('#apprOv .ap').filter({ hasText: snippet }).first();
  try {
    await row.waitFor({ timeout: 20000 });
  } catch (e) {
    const lines = await page.locator('#apprOv').innerText().catch(() => '');
    throw new Error('No pending approval matching ' + JSON.stringify(snippet) + '. Panel: ' + lines.slice(0, 500));
  }
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(lookMs);
  await row.locator('[data-ap="approve"]').click();
  await page.locator('#toast .toast').getByText('Approved', { exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await page.locator('#apprOv [data-x]').click();
  await page.waitForTimeout(400);
}

export async function frameWidget(page) {
  await page.locator('input[aria-label="Message"]').waitFor({ timeout: 20000 });
  await page.evaluate(() => {
    const box = document.querySelector('body > div');
    const title = document.querySelector('body > p');
    document.body.style.cssText = 'margin:0;background:#10141c;min-height:100vh;';
    if (!box) return;
    box.style.cssText = 'position:fixed;left:50%;top:46%;transform:translate(-50%,-50%);width:820px;max-width:94vw;font:22px/1.45 system-ui,sans-serif;z-index:2';
    const log = box.querySelector('div');
    if (log) log.style.cssText = 'background:#fff;color:#141414;border:1px solid #d8dee8;border-radius:18px;padding:22px 26px;min-height:220px;max-height:560px;overflow:auto;margin-bottom:12px;font-size:24px';
    const input = box.querySelector('input');
    if (input) input.style.cssText = 'width:100%;box-sizing:border-box;padding:16px 18px;font-size:22px;border-radius:12px;border:1px solid #c9d1dc';
    if (title) {
      title.style.cssText = 'font:600 28px/1.2 system-ui,sans-serif;color:#f4f7fb;margin:0 0 14px';
      box.insertBefore(title, box.firstChild);
    }
  });
}

export async function widgetSay(page, url, text, { fresh = false, token = '' } = {}) {
  if (fresh && token) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => localStorage.removeItem(key), 'aidc-' + token);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  const input = page.locator('input[aria-label="Message"]');
  await input.click();
  await input.pressSequentially(text, { delay: 22 });
  await page.waitForTimeout(280);
  await input.press('Enter');
  await page.locator('text=The team will reply shortly.').waitFor({ timeout: 20000 });
}

export async function widgetNext(page, url, text, seen) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  const input = page.locator('input[aria-label="Message"]');
  await input.click();
  await input.pressSequentially(text, { delay: 16 });
  await page.waitForTimeout(200);
  await input.press('Enter');
  await page.getByText('The team will reply shortly.').waitFor({ timeout: 20000 });
  if (seen) await page.getByText(seen).first().waitFor({ timeout: 20000 });
}

export async function widgetReload(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  await page.waitForTimeout(400);
}

export async function backToApp(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#wpIn').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(500);
}
