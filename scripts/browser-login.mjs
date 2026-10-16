// Opens the agents' persistent browser profile in a plain, visible Google Chrome window so the owner can sign in
// to sites himself (Gmail, Gumroad, marketplaces...). Agents reuse the saved cookies afterwards.
// No Playwright and no automation or remote-debugging flags here: Google refuses sign-in from automated browsers
// ("This browser or app may not be secure"). Nothing typed in the window is seen by the server.
//
//   npm run browser:login -- [url ...]            uses BROWSER_PROFILE_DIR from .env (default data/browser-profile)
//   BROWSER_DISPLAY=:1 npm run browser:login      pick the X display / desktop the window opens on
//   LOGIN_BROWSER=/path/to/chrome                 override the browser binary
//
// Close the window when done. While it is open the agents' browser tool reports "in use"; if an agent is using
// the browser, this script says so (the agents' browser closes after 10 idle minutes).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*(BROWSER_[A-Z_]+|LOGIN_BROWSER)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').trim();
  }
} catch { /* no .env */ }
const dir = path.resolve(root, process.env.BROWSER_PROFILE_DIR || 'data/browser-profile');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const { profileLock, releaseProfileLock } = await import('../lib/browser.js');

const candidates = [process.env.LOGIN_BROWSER, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const bin = candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
if (!bin) { console.error('No Google Chrome or Chromium found. Install Google Chrome (or set LOGIN_BROWSER).'); process.exit(1); }

const holder = profileLock(dir, false);
if (holder) { console.error(`An agent is using the browser right now (process ${holder}). It closes after 10 idle minutes; try again then.`); process.exit(1); }
profileLock(dir, true);

const urls = process.argv.slice(2).filter((u) => /^https:\/\//.test(u));
const display = process.env.BROWSER_DISPLAY || process.env.DISPLAY;
const args = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--disable-dev-shm-usage', '--new-window',
  ...(urls.length ? urls : ['https://accounts.google.com/'])];
const child = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); releaseProfileLock(dir); process.exit(0); });
console.log(`Sign-in window open on display ${display} with ${bin} (pid ${child.pid}, profile ${dir}). Close it when done.`);
child.on('exit', (code) => { releaseProfileLock(dir); console.log(`Browser closed (code ${code}). Saved; agents will use these sign-ins.`); process.exit(0); });
