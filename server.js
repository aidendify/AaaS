// AaaS server: serves the site, the shared data API (Neon Postgres or a local file) and the AI proxy.
// Needs Node 20+. `npm install` only matters when DATABASE_URL is set (it adds the Neon driver).
import './lib/logbuf.js'; // keep recent log lines for Settings → Logs
import { obsScope, obs, obsDone } from './lib/obs.js';
import { mockOn } from './lib/llm.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Load .env without any package
try {
  const txt = await fs.readFile(process.env.AIDENTIFY_ENV_FILE || path.join(dir, '.env'), 'utf8'); // AIDENTIFY_ENV_FILE: tests use their own
  for (const line of txt.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/(^|\s+)#.*$/, '').replace(/^["']|["']$/g, ''); // drop inline # comments
  }
} catch { /* no .env file: fine */ }

// Local defaults. Do not force the rate limit off: a public server should keep it on.
// Set RATE_LIMIT=off in .env only for a private demo on this computer.
const { handle, HttpError, store, runDueRoutines, runBoardWorker, resetBoards, DATA_DIR, storageProblem, hostedMode } = await import('./lib/backend.js');
if (storageProblem()) { console.error('\n*** ' + storageProblem() + '\n'); process.exit(1); }
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
async function readBody(req, max = 4 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, 'too_large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer((req, res) => obsScope(() => { // one JSON log line per API request (lib/obs.js)
  const t0 = Date.now(), store = obs(), pth = new URL(req.url, 'http://x').pathname;
  if (pth.startsWith('/api/') || pth.startsWith('/p/') || pth.startsWith('/t/') || pth.startsWith('/c/')) res.on('finish', () => { try { obsDone({ method: req.method, pathname: pth, status: res.statusCode, ms: Date.now() - t0, store }); } catch { /* never break a response */ } });
  return serve(req, res);
}));
async function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || 'local';
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const home = process.env.AIDENTIFY_SITE === 'landing' ? 'landing-v2.html' : 'index.html';
      return send(res, 200, await fs.readFile(path.join(dir, home)), 'text/html; charset=utf-8');
    }
    { const to = { '/login': '/', '/signin': '/', '/signup': '/#signup', '/register': '/#signup', '/forgot-password': '/#forgot', '/reset-password': '/#forgot' }[url.pathname]; // one sign-in screen
      if (req.method === 'GET' && to) { res.writeHead(302, { Location: to }); return res.end(); } }
    if (req.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/setup.html')) { // first-run admin setup
      return send(res, 200, await fs.readFile(path.join(dir, 'setup.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/settings' || url.pathname === '/settings.html')) { // admin settings (Hermes-style)
      return send(res, 200, await fs.readFile(path.join(dir, 'settings.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/waitlist' || url.pathname === '/waitlist.html' || url.pathname === '/early-access' || url.pathname === '/v1')) { // v1 early-access page; /v1 keeps it after the landing home moves to v2
      return send(res, 200, await fs.readFile(path.join(dir, 'waitlist.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/v2' || url.pathname === '/landing-v2.html')) {
      return send(res, 200, await fs.readFile(path.join(dir, 'landing-v2.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/white-label' || url.pathname === '/white-label.html')) {
      return send(res, 200, await fs.readFile(path.join(dir, 'white-label.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/landing-v2.css' || url.pathname === '/landing-v2.js')) {
      const file = url.pathname.slice(1);
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      return send(res, 200, await fs.readFile(path.join(dir, file)), type);
    }
    if (req.method === 'GET' && url.pathname === '/board.html') { // groups + task boards (shown inside the Groups tab)
      return send(res, 200, await fs.readFile(path.join(dir, 'board.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && /^\/zips\/[a-z-]+\.zip\.txt$/.test(url.pathname)) {
      return send(res, 200, await fs.readFile(path.join(dir, url.pathname)), 'text/plain; charset=utf-8');
    }
    if (url.pathname.startsWith('/c/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (url.pathname.startsWith('/p/') || url.pathname.startsWith('/t/') || url.pathname.startsWith('/c/') || url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req, url.pathname === '/api/ai' ? 65536 : 4 * 1024 * 1024);
      if (url.pathname === '/api/health') {
        const out = await handle({ method: 'GET', pathname: '/api/health', headers: req.headers, ip });
        return send(res, 200, { ...out, ai: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.XAI_API_KEY) || mockOn(), aiMock: mockOn() || undefined });
      }
      const out = await handle({ method: req.method, pathname: url.pathname, body, headers: req.headers, ip, query: url.searchParams });
      if (out && out.__redirect) { res.writeHead(302, { Location: out.__redirect, 'Cache-Control': 'no-store' }); return res.end(); }
      if (out && out.__bytes && out.__name) res.setHeader('Content-Disposition', 'attachment; filename="' + out.__name + '"');
      if (out && out.__bytes) return send(res, 200, out.__bytes, out.__type || 'application/octet-stream');
      if (out && out.__html) return send(res, 200, out.__html, 'text/html; charset=utf-8');
      if (out && typeof out.__text === 'string') return send(res, 200, out.__text, 'text/plain; charset=utf-8');
      return send(res, 200, out);
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    console.error(e);
    // local server: say what broke (e.g. data folder not writable) instead of a blank "Something went wrong"
    const disk = e && ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EINVAL', 'EBUSY', 'ENOSPC', 'EEXIST', 'ENOTDIR'].includes(e.code);
    send(res, 500, { error: 'server_error', message: disk ? `Server can't save data (${e.code}). Move the AaaS folder to Desktop/Documents (not OneDrive or inside the zip), then run npm start again.` : 'Server error: ' + String(e && e.message || e).slice(0, 160) + ' (see the npm start window)' });
  }
}

// ---- shutdown: SIGTERM / SIGINT stop cleanly within a few seconds ----
// (Playwright installs its own SIGTERM handler that can hang on open browsers, so ours runs first and always exits.)
const timers = [];
let slackMod = null, stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`${sig}: shutting down`);
  const force = setTimeout(() => { console.error('Shutdown took too long, exiting.'); process.exit(1); }, 8000);
  force.unref();
  timers.forEach(clearInterval);
  server.close();
  await Promise.allSettled([
    slackMod && slackMod.stopSlack ? slackMod.stopSlack() : null,
    import('./lib/waqr.js').then((m) => m.stopAllWaqr()).catch(() => {}),
    import('./lib/browser.js').then((m) => m.closeBrowsers()).catch(() => {}),
    import('./lib/remote-browser.js').then((m) => m.closeRemoteBrowser('server shutdown')).catch(() => {}),
  ]);
  try { const st = await store(); if (st.flush) await st.flush(); } catch { /* nothing to flush */ }
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.prependListener(sig, () => { shutdown(sig); });

server.listen(PORT, HOST, async () => {
  console.log(`AaaS running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  try { const st = await store();
    if (st.kind === 'file') console.log('Database: local file ' + path.join(DATA_DIR, 'kv.json') + (hostedMode() ? '' : ' (fine for one self-hosted server; for a hosted deploy set DATABASE_URL to Postgres/Neon and HOSTED=1)'));
    else { await st.init(); console.log(`Database: ${st.kind === 'neon' ? 'Neon Postgres' : 'Postgres'} (DATABASE_URL, schema ${st.schema}, driver ${st.driver})`); }
    if (st.kind === 'file') { try { await fs.mkdir(DATA_DIR, { recursive: true }); await fs.writeFile(path.join(DATA_DIR, '.write-test'), 'ok'); await fs.rm(path.join(DATA_DIR, '.write-test'), { force: true }); }
      catch (e) { console.error('\n*** Cannot write to ' + DATA_DIR + ' (' + e.code + '). Sign-in will fail.\n*** Move the folder somewhere you own (e.g. Desktop or Documents, not inside the zip / OneDrive / Program Files) and run npm start again.\n'); } } }
  catch (e) { console.error('Database error:', e.message); }
  { const on = [['ANTHROPIC_API_KEY', 'Anthropic'], ['OPENROUTER_API_KEY', 'OpenRouter'], ['OPENAI_API_KEY', 'OpenAI'], ['XAI_API_KEY', 'xAI'], ['GOOGLE_AI_API_KEY', 'Google'], ['OLLAMA_BASE_URL', 'Ollama/local']].filter(([k]) => process.env[k]).map(([, n]) => n);
    console.log(on.length ? 'AI agents: ON (' + on.join(' + ') + ')' : 'AI agents: OFF (add OPENROUTER_API_KEY or ANTHROPIC_API_KEY to .env)'); }
  // Settings saved in the app (lib/settings.js) override .env; apply them before anything else starts.
  try {
    const st = await store(); const { secret } = (await import('./lib/backend.js')).helpers;
    const S = await import('./lib/settings.js'); await S.initSettings(st, secret);
    const U = await import('./lib/usage.js'); await U.initUsage(st, { onAlert: (t) => import('./lib/slack.js').then((m) => m.notifyOwner(t)).catch(() => {}) });
    S.onSettingsChanged(async (keys) => {
      if (keys.some((k) => k.startsWith('SLACK_')) && process.env.AIDENTIFY_WORKERS !== 'off') {
        console.log('Settings: Slack settings changed, reconnecting the bot');
        const m = slackMod || await import('./lib/slack.js'); slackMod = m; await m.stopSlack(); m.startSlack().catch((e) => console.error('Slack bot failed to start:', e.message));
      }
    });
  } catch (e) { console.error('Settings failed to load (using .env only):', e.message); }
  const workers = process.env.AIDENTIFY_WORKERS !== 'off'; // off = no routines, board worker or Slack (a test copy)
  if (!workers) console.log('Workers: OFF (AIDENTIFY_WORKERS=off): routines, board worker and Slack are not started');
  if (workers) {
  // agents' scheduled routines run here every minute (on Vercel, call /api/cron/tick instead — see README)
  timers.push(setInterval(() => runDueRoutines().then((r) => { if (r.ran) console.log('Routines run:', r.ran); }).catch((e) => console.error('Routines:', e.message)), 60000));
  // task boards: interrupted tasks go back to todo, then the worker picks up todo tasks every 20 seconds
  resetBoards().catch((e) => console.error('Boards:', e.message));
  let working = false;
  timers.push(setInterval(() => { if (working) return; working = true; runBoardWorker().then((r) => { if (r.started) console.log('Board tasks started:', r.started); }).catch((e) => console.error('Board worker:', e.message)).finally(() => { working = false; }); }, 20000));
  // Slack bot in Socket Mode (lib/slack.js); stays off without its tokens
  import('./lib/slack.js').then((m) => { slackMod = m; return m.startSlack(); }).catch((e) => console.error('Slack bot failed to start:', e.message));
  import('./lib/freech.js').then((m) => m.bootFreeChannels()).catch((e) => console.error('Free channels:', String(e && e.message || e).slice(0, 200)));
  }
  // Demo account only when DEMO_MODE=1 (previews and local try-outs). The password is never printed.
  if (process.env.DEMO_MODE === '1') {
    const demoEmail = process.env.DEMO_USER_EMAIL || 'demo@aidentify.local';
    const demoPass = process.env.DEMO_USER_PASSWORD || '';
    if (!demoPass) console.warn('DEMO_MODE=1 but DEMO_USER_PASSWORD is not set: no demo account was created.');
    else try { await handle({ method: 'POST', pathname: '/api/auth/signup', body: JSON.stringify({ email: demoEmail, name: 'Demo User', password: demoPass }), headers: {}, ip: 'seed' }); }
    catch (e) { if (!(e instanceof HttpError && e.status === 409)) console.error('Demo login:', e.message); }
    console.log('Demo sign-in is on (DEMO_MODE=1) for ' + demoEmail + '. The password is the one in .env and is not printed here.');
  }
  try {
    const be = await import('./lib/backend.js');
    if (await be.setupNeeded()) console.warn(`FIRST RUN: no admin account yet. Open ${process.env.APP_URL || `http://localhost:${PORT}`}/setup and create one with this one-time setup code: ${await be.setupCode()}  (or set a strong ADMIN_PASSWORD in .env and restart). Nobody can sign in as admin until then.`);
  } catch (e) { console.error('Setup check:', e.message); }
  console.log(process.env.COMPOSIO_API_KEY ? 'Connectors: Composio managed sign-in ON' : 'Connectors: own OAuth apps only (add COMPOSIO_API_KEY for managed sign-in)');
});
