// A real Chromium session for the Research agent and the Browser agent.
// One window per customer + agent, kept for 10 minutes. Screenshots are signed URLs, not stored in the workspace blob.
// Needs Playwright and Chromium on the machine that runs the server (a VPS or a PC). Serverless hosts cannot run this.
import crypto from 'node:crypto';
import { assertPublicHttpUrl } from './web.js';

const sessions = new Map();
const shots = new Map();
const LIFE = 10 * 60 * 1000;
const SENSITIVE = /\b(pay|buy|purchase|checkout|place order|submit|send money|sign in|log in|confirm payment|delete|transfer)\b/i;

function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

async function launch() {
  let pw;
  try { pw = await import('playwright'); }
  catch { throw new Error('The browser is not installed on this server. On a VPS run: npx playwright install chromium'); }
  const executablePath = process.env.BROWSER_EXECUTABLE || undefined;
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

async function sessionFor(email, aid) {
  const k = email + '\n' + aid;
  const cur = sessions.get(k);
  if (cur && Date.now() - cur.at < LIFE) { cur.at = Date.now(); return cur; }
  if (cur) { try { await cur.browser.close(); } catch { /* already closed */ } }
  const browser = await launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const s = { browser, page, at: Date.now(), email, aid };
  sessions.set(k, s);
  return s;
}

async function rememberShot(s) {
  const buf = await s.page.screenshot({ type: 'png' });
  const id = crypto.randomBytes(9).toString('hex');
  shots.set(id, { buf, email: s.email, at: Date.now() });
  if (shots.size > 80) {
    const oldest = [...shots.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    oldest.forEach(([k]) => shots.delete(k));
  }
  return id;
}

export function shotUrl(id, email, secretStr) {
  const exp = Date.now() + 60 * 60 * 1000;
  const sig = crypto.createHmac('sha256', String(secretStr)).update(`${id}|${email}|${exp}`).digest('base64url');
  return `/api/browser/shot/${id}?exp=${exp}&sig=${sig}`;
}

export function readShot(id, exp, sig, secretStr) {
  const rec = shots.get(id);
  if (!rec || !exp || !sig || Number(exp) < Date.now()) return null;
  const want = crypto.createHmac('sha256', String(secretStr)).update(`${id}|${rec.email}|${exp}`).digest('base64url');
  if (!safeEqual(want, sig)) return null;
  return rec.buf;
}

async function describe(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = await page.evaluate(() => {
    const el = document.querySelector('main, article, [role="main"]') || document.body;
    return (el && el.innerText ? el.innerText : '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4500);
  }).catch(() => '');
  return { title, url, text };
}

// op: open | read | click | type | press. approved=true runs a step that would otherwise wait for the owner.
export async function browserAct({ email, aid, op, input = {}, approved = false }) {
  const s = await sessionFor(email, String(aid));
  const page = s.page;
  if (op === 'open') {
    const u = await assertPublicHttpUrl(input.url);
    const res = await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await assertPublicHttpUrl(page.url()).catch(async (e) => { await page.goto('about:blank'); throw e; });
    if (res && res.status() >= 400) throw new Error('The page answered ' + res.status());
  } else if (op === 'click') {
    const text = String(input.text || '').trim().slice(0, 120);
    if (!text) throw new Error('Say which words to click.');
    if (!approved && SENSITIVE.test(text)) return { needsApproval: true, summary: `Browser click “${text}” on ${page.url()}` };
    await page.getByText(text, { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(500);
  } else if (op === 'type') {
    const into = String(input.into || '').trim().slice(0, 80);
    const text = String(input.text || '').slice(0, 2000);
    if (!into) throw new Error('Say which field to type into (its label or placeholder).');
    const secret = !!input.secret || /password|passwd|otp|pin code/i.test(into);
    if (secret && !approved) return { needsApproval: true, summary: `Browser type into “${into}” on ${page.url()}` };
    const loc = page.getByLabel(into, { exact: false }).or(page.getByPlaceholder(into, { exact: false })).first();
    await loc.fill(text, { timeout: 8000 });
  } else if (op === 'press') {
    const key = String(input.key || 'Enter').slice(0, 24);
    if (!/^[A-Za-z0-9+]+$/.test(key)) throw new Error('That key is not allowed.');
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
  } else if (op !== 'read') throw new Error('Unknown browser action.');
  if (op !== 'open') await assertPublicHttpUrl(page.url()).catch(async (e) => { await page.goto('about:blank'); throw e; });
  const d = await describe(page);
  const shot = await rememberShot(s);
  s.at = Date.now();
  return { ...d, shot };
}
