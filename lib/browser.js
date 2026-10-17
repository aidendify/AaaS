// A real Chromium session for the Research agent and the Browser agent.
// One window (tab) per customer + agent, kept for 10 minutes. Screenshots are signed URLs, not stored in the workspace blob.
// Needs Playwright and Chromium on the machine that runs the server (a VPS or a PC). Serverless hosts cannot run this.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertPublicHttpUrl } from './web.js';

const sessions = new Map();
const shots = new Map();
const LIFE = 10 * 60 * 1000;
const SENSITIVE = /\b(pay|buy|purchase|checkout|place order|submit|send money|sign in|log in|confirm payment|delete|transfer)\b/i;

function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Browser modes:
//   default                 a fresh headless browser per customer + agent (no cookies kept)
//   BROWSER_PROFILE_DIR set  ONE persistent Chromium profile shared by the agents. The owner signs in to sites once
//                           himself (npm run browser:login opens a visible window on the box display); agents reuse
//                           those cookies. Passwords never pass through chat, the KB or this server.
//   BROWSER_HEADLESS=false  show the agents' window on DISPLAY (or BROWSER_DISPLAY) so the owner can watch.
const profileDir = () => (process.env.BROWSER_PROFILE_DIR || '').trim();
const headless = () => !/^(0|false|no|off)$/i.test((process.env.BROWSER_HEADLESS || '').trim());
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function playwright() {
  try { return await import('playwright'); }
  catch { throw new Error('The browser is not installed on this server. On a VPS run: npx playwright install chromium'); }
}
export function browserLaunchOptions({ show = !headless() } = {}) {
  const executablePath = process.env.BROWSER_EXECUTABLE || undefined;
  const display = (process.env.BROWSER_DISPLAY || process.env.DISPLAY || '').trim();
  return {
    headless: !show,
    ...(executablePath ? { executablePath } : {}),
    ...(show && display ? { env: { ...process.env, DISPLAY: display } } : {}),
    // Look like a normal browser so sites (Google) keep accepting the owner's saved sign-ins.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  };
}
// The persistent profile is signed in with real Google Chrome (npm run browser:login), so agents use the same
// Chrome when it is installed (BROWSER_CHANNEL=chrome by default; set BROWSER_CHANNEL=chromium to use Playwright's).
const CHROME_BIN = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
function channelOpt() {
  if (process.env.BROWSER_EXECUTABLE) return {};
  const ch = (process.env.BROWSER_CHANNEL || (CHROME_BIN ? 'chrome' : '')).trim();
  return ch && ch !== 'chromium' ? { channel: ch } : {};
}

async function launch() {
  const pw = await playwright();
  return pw.chromium.launch(browserLaunchOptions());
}

// The shared persistent profile. Only one process may use it at a time: whoever opens it writes its pid into
// <profile>/aidentify.lock (the sign-in window or this server). A lock held by a live process means "in use".
// Versions before 1.4 wrote agentsphere.lock; a live pid in that file is still respected.
export const LOCK_NAME = 'aidentify.lock';
export function profileLock(dir, take) {
  const f = path.join(dir, LOCK_NAME);
  for (const name of [LOCK_NAME, 'agentsphere.lock']) {
    try {
      const pid = Number(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (pid && pid !== process.pid) { try { process.kill(pid, 0); return pid; } catch { /* stale lock */ } }
    } catch { /* no lock */ }
  }
  if (take) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(f, String(process.pid)); }
  return 0;
}
export function releaseProfileLock(dir) {
  const f = path.join(dir, LOCK_NAME);
  try { if (Number(fs.readFileSync(f, 'utf8')) === process.pid) fs.rmSync(f); } catch { /* gone */ }
}
let shared = null;
// True while the agents' own (Playwright) browser holds the shared profile.
export const agentsBrowserBusy = () => !!shared;
async function sharedContext() {
  if (shared && shared.ctx) return shared.ctx;
  if (shared && shared.starting) return shared.starting;
  const pw = await playwright();
  const dir = path.resolve(profileDir());
  if (profileLock(dir, true)) throw new Error('The browser profile is in use: the owner\'s sign-in window or remote browser session ("open browser" in Slack) is open. Try again after it is closed (Slack: "close browser").');
  const starting = pw.chromium.launchPersistentContext(dir, { ...browserLaunchOptions(), ...channelOpt(), viewport: { width: 1280, height: 800 } })
    .catch((e) => {
      shared = null;
      if (/ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(e.message)) throw new Error('The browser profile is in use (a sign-in window may be open). Close it and try again.');
      throw e;
    });
  shared = { starting };
  const ctx = await starting;
  shared = { ctx };
  ctx.on('close', () => { shared = null; releaseProfileLock(dir); for (const [k, v] of sessions) if (v.shared) sessions.delete(k); });
  return ctx;
}
// Close idle tabs after LIFE, and the shared browser once no agent uses it, so the owner can open the sign-in window.
setInterval(async () => {
  for (const [k, v] of sessions) if (Date.now() - v.at > LIFE) { sessions.delete(k); await (v.shared ? v.page.close() : v.browser.close()).catch(() => {}); }
  if (shared && shared.ctx && ![...sessions.values()].some((v) => v.shared)) { const c = shared.ctx; shared = null; await c.close().catch(() => {}); }
}, 60 * 1000).unref();

async function sessionFor(email, aid) {
  const k = email + '\n' + aid;
  const cur = sessions.get(k);
  if (cur && Date.now() - cur.at < LIFE && !cur.page.isClosed()) { cur.at = Date.now(); return cur; }
  if (cur) { try { cur.shared ? await cur.page.close() : await cur.browser.close(); } catch { /* already closed */ } }
  let s;
  if (profileDir()) {
    const page = await (await sharedContext()).newPage();
    s = { page, shared: true, at: Date.now(), email, aid };
  } else {
    const browser = await launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
    s = { browser, page: await context.newPage(), at: Date.now(), email, aid };
  }
  s.page.setDefaultTimeout(20000);
  sessions.set(k, s);
  return s;
}

// Close everything (server shutdown). The persistent profile's cookies are already on disk.
export async function closeBrowsers() {
  const jobs = [...sessions.values()].map((s) => (s.shared ? s.page.close() : s.browser.close()).catch(() => {}));
  sessions.clear();
  if (shared && shared.ctx) jobs.push(shared.ctx.close().catch(() => {}));
  shared = null;
  await Promise.all(jobs);
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

// Which steps wait for the owner: clicking pay/buy/submit/sign-in/delete…, and typing passwords or codes.
export function needsOwnerApproval(op, input = {}) {
  if (op === 'click') return SENSITIVE.test(String(input.text || '').trim().slice(0, 120));
  if (op === 'type') return !!input.secret || /password|passwd|otp|pin code/i.test(String(input.into || ''));
  return false;
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
    if (!approved && needsOwnerApproval('click', input)) return { needsApproval: true, summary: `Browser click “${text}” on ${page.url()}` };
    await page.getByText(text, { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(500);
  } else if (op === 'type') {
    const into = String(input.into || '').trim().slice(0, 80);
    const text = String(input.text || '').slice(0, 2000);
    if (!into) throw new Error('Say which field to type into (its label or placeholder).');
    if (!approved && needsOwnerApproval('type', input)) return { needsApproval: true, summary: `Browser type into “${into}” on ${page.url()}` };
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
