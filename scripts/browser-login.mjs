// Opens the agents' persistent browser profile in a visible window so the owner can sign in to sites himself
// (Gmail, Gumroad, marketplaces...). Agents reuse the saved cookies afterwards. Nothing typed here is seen by the server.
//
//   npm run browser:login -- [url ...]            uses BROWSER_PROFILE_DIR from .env (default data/browser-profile)
//   BROWSER_DISPLAY=:1 npm run browser:login      pick the X display / desktop the window opens on
//
// Close the window when done. While it is open the agents' browser tool reports "in use"; if an agent is using
// the browser, this script says so (the agents' browser closes after 10 idle minutes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*(BROWSER_[A-Z_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim();
  }
} catch { /* no .env */ }
const dir = path.resolve(root, process.env.BROWSER_PROFILE_DIR || 'data/browser-profile');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const { browserLaunchOptions, profileLock, releaseProfileLock } = await import('../lib/browser.js');
const holder = profileLock(dir, false);
if (holder) { console.error(`An agent is using the browser right now (process ${holder}). It closes after 10 idle minutes; try again then.`); process.exit(1); }
profileLock(dir, true);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseProfileLock(dir); process.exit(0); });
const { chromium } = await import('playwright');
const urls = process.argv.slice(2).filter((u) => /^https:\/\//.test(u));
const ctx = await chromium.launchPersistentContext(dir, { ...browserLaunchOptions({ show: true }), viewport: null });
const pages = ctx.pages();
for (const [i, u] of (urls.length ? urls : ['https://accounts.google.com/']).entries()) await (i === 0 && pages[0] ? pages[0] : await ctx.newPage()).goto(u).catch(() => {});
console.log(`Sign-in window open on display ${process.env.BROWSER_DISPLAY || process.env.DISPLAY} (profile ${dir}). Close it when done.`);
await new Promise((r) => ctx.on('close', r));
releaseProfileLock(dir);
console.log('Saved. Agents will use these sign-ins.');
process.exit(0);
