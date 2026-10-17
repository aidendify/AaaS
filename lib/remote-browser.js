// Remote browser: lets the owner open the agents' shared Chrome profile from any phone or laptop (sign in to sites,
// watch or help the agents). Started on demand from Slack ("open browser") or the Chief's browser_remote tool.
//
//   Xvfb :N  ->  google-chrome (agents' profile, same plain flags as scripts/browser-login.mjs)
//   x11vnc (127.0.0.1 only, VNC password)  ->  websockify + noVNC (127.0.0.1)
//   token gate (127.0.0.1, only /<random token>/... is served)  ->  cloudflared quick tunnel (public https)
//
// The link holds a 128-bit random path token plus the VNC password; neither is ever logged. Every process is started
// without a shell and killed by its exact PID. While a session is open the profile lock (<profile>/agentsphere.lock)
// holds Chrome's pid, so agent browser tasks fail with "in use" exactly as with the sign-in window.
// The session closes after REMOTE_BROWSER_IDLE_MIN idle minutes (default 20) with no viewer input, or on "close browser".
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { profileLock, agentsBrowserBusy } from './browser.js';

const env = (k) => (process.env[k] || '').trim();
const which = (cands) => cands.filter(Boolean).find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idleMs = () => Math.max(1, Number(env('REMOTE_BROWSER_IDLE_MIN')) || 20) * 60 * 1000;
const profile = () => path.resolve(env('BROWSER_PROFILE_DIR') || 'data/browser-profile');
const NOVNC = env('NOVNC_DIR') || (fs.existsSync('/usr/share/novnc/vnc.html') ? '/usr/share/novnc' : '');
const fmt = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) + ' IST';

let S = null;        // the open session
let starting = null; // a start in progress
let onClosed = null; // callback(reason) when a session ends on its own
export const onRemoteBrowserClosed = (fn) => { onClosed = fn; };
// Where links go: Slack registers a function that posts to the owner's DM only. Agents never see the link.
let linkSender = null;
export const setRemoteLinkSender = (fn) => { linkSender = fn; };
export async function sendRemoteLinkPrivately(text) { if (!linkSender) return false; await linkSender(text); return true; }
export function remoteBrowserMessage(r) {
  return `:computer: Browser is open: <${r.link}|open the agents' browser>\nWorks on phone or laptop. Closes after ${r.idleMin} idle minutes (now about ${r.expiresText}) or when you say "close browser". Agents' browser tasks wait while it is open. Keep this link private.`;
}

async function freePort() {
  return new Promise((ok, no) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); s.on('error', no); });
}
function freeDisplay() {
  for (let n = 90; n < 140; n++) if (!fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error('No free X display.');
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function run(name, bin, args, extraEnv = {}) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv }, detached: false });
  p.label = name; p.out = '';
  const keep = (d) => { p.out = (p.out + d.toString()).slice(-8000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  p.on('error', (e) => { p.out += '\nspawn error: ' + e.message; });
  return p;
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
  throw new Error('Timed out waiting for ' + what + '.');
}
const tcpOpen = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });

// Only /<token>/... reaches websockify (noVNC files + the /websockify socket); everything else is 404.
function tokenGate(token, upstream, touch) {
  const pre = '/' + token;
  const strip = (u) => (u.startsWith(pre + '/') ? u.slice(pre.length) : null);
  const srv = http.createServer((req, res) => {
    const u = strip(req.url || '');
    if (!u || req.method !== 'GET') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const up = http.request({ host: '127.0.0.1', port: upstream, path: u, method: 'GET', headers: { ...req.headers, host: '127.0.0.1:' + upstream } }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' }); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    up.end();
  });
  srv.on('upgrade', (req, sock, head) => {
    const u = strip(req.url || '');
    if (!u) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const up = net.connect(upstream, '127.0.0.1', () => {
      const h = Object.entries(req.headers).filter(([k]) => k !== 'host').map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`GET ${u} HTTP/1.1\r\nhost: 127.0.0.1:${upstream}\r\n${h}\r\n\r\n`); if (head && head.length) up.write(head);
      sock.pipe(up); up.pipe(sock);
    });
    S && S.viewers++;
    sock.on('data', touch);
    const done = () => { up.destroy(); sock.destroy(); };
    sock.on('close', () => { if (S) { S.viewers = Math.max(0, S.viewers - 1); touch(); } done(); });
    sock.on('error', done); up.on('error', done);
  });
  return srv;
}

export function remoteBrowserStatus() {
  if (starting && !S) return { state: 'starting' };
  if (!S) return { state: 'closed', idleMin: idleMs() / 60000 };
  return { state: 'open', since: S.at, expires: S.last + idleMs(), expiresText: fmt(S.last + idleMs()), viewers: S.viewers, idleMin: idleMs() / 60000, pids: S.procs.map((p) => p.pid) };
}

export async function openRemoteBrowser({ url } = {}) {
  if (S) return { ...remoteBrowserStatus(), link: S.link, reused: true };
  if (starting) return starting;
  starting = start(url).finally(() => { starting = null; });
  return starting;
}

async function start(url) {
  const chrome = which([env('LOGIN_BROWSER'), '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']);
  const tools = { Xvfb: which(['/usr/bin/Xvfb']), x11vnc: which(['/usr/bin/x11vnc']), websockify: which(['/usr/bin/websockify', '/usr/local/bin/websockify']), };
  const tunnel = tunnelKind();
  if (tunnel === 'cloudflared') tools.cloudflared = which([env('CLOUDFLARED_BIN'), '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/workspace/aaas-run/bin/cloudflared', path.join(os.homedir(), '.local/bin/cloudflared')]);
  if (tunnel === 'ngrok') tools.ngrok = which([env('NGROK_BIN'), '/usr/local/bin/ngrok', '/usr/bin/ngrok', '/workspace/aaas-run/bin/ngrok', path.join(os.homedir(), '.local/bin/ngrok')]);
  const missing = [...Object.entries(tools).filter(([, v]) => !v).map(([k]) => k), ...(chrome ? [] : ['google-chrome']), ...(NOVNC ? [] : ['novnc'])];
  if (missing.length) throw new Error('Remote browser needs: ' + missing.join(', ') + '. See docs/browser-and-logins.md.');
  const dir = profile();
  if (agentsBrowserBusy()) throw new Error('An agent is using the browser right now. It frees itself after 10 idle minutes; try again then (or pause the agents first).');
  const holder = profileLock(dir, false);
  if (holder) throw new Error(`The browser profile is in use by another window (process ${holder}), probably the sign-in window. Close it first.`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const procs = [];
  const s = { at: Date.now(), last: Date.now(), viewers: 0, procs, dir, chromePid: 0 };
  const kill = () => killAll(s);
  try {
    const n = freeDisplay(), disp = ':' + n;
    const vncPort = await freePort(), wsPort = await freePort(), gatePort = await freePort();
    const xv = run('Xvfb', tools.Xvfb, [disp, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-ac']); procs.push(xv);
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${n}`) || (xv.exitCode != null && Promise.reject(new Error('Xvfb exited: ' + xv.out.slice(-200)))), 10000, 'the virtual display');

    const ch = run('chrome', chrome, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--disable-dev-shm-usage', '--new-window',
      '--window-position=0,0', '--window-size=1280,800', /^https:\/\//.test(url || '') ? url : 'https://accounts.google.com/'], { DISPLAY: disp }); procs.push(ch);
    s.chromePid = ch.pid;
    fs.writeFileSync(path.join(dir, 'agentsphere.lock'), String(ch.pid)); // agents now see "in use"
    await sleep(1500);
    if (ch.exitCode != null) throw new Error('Chrome exited at once (profile in use?): ' + ch.out.slice(-200));

    const pw = crypto.randomBytes(6).toString('base64url').slice(0, 8);           // VNC passwords are max 8 chars
    const pwFile = path.join(os.tmpdir(), `rb-${crypto.randomBytes(6).toString('hex')}.pass`);
    execFileSync(tools.x11vnc, ['-storepasswd', pw, pwFile], { stdio: 'ignore' }); fs.chmodSync(pwFile, 0o600); s.pwFile = pwFile;
    const vnc = run('x11vnc', tools.x11vnc, ['-display', disp, '-localhost', '-rfbport', String(vncPort), '-rfbauth', pwFile, '-forever', '-shared', '-noxdamage', '-quiet']); procs.push(vnc);
    await waitFor(() => tcpOpen(vncPort), 10000, 'the VNC server');

    const ws = run('websockify', tools.websockify, ['--web', NOVNC, `127.0.0.1:${wsPort}`, `127.0.0.1:${vncPort}`]); procs.push(ws);
    await waitFor(() => tcpOpen(wsPort), 10000, 'websockify');

    const token = crypto.randomBytes(16).toString('hex');
    const gate = tokenGate(token, wsPort, () => { s.last = Date.now(); });
    await new Promise((ok, no) => { gate.listen(gatePort, '127.0.0.1', ok); gate.on('error', no); }); s.gate = gate;

    const base = await openTunnel(tools, gatePort, procs, s);
    const pageUrl = `${base}/${token}/vnc.html`;
    await waitFor(async () => { try { const r = await fetch(pageUrl, { signal: AbortSignal.timeout(5000), headers: { 'ngrok-skip-browser-warning': '1' } }); return r.status === 200; } catch { return false; } }, 60000, 'the public link to answer');
    s.base = base; s.token = token;
    s.link = `${pageUrl}?autoconnect=1&resize=scale&reconnect=1&path=${token}/websockify&password=${encodeURIComponent(pw)}`;
    s.last = Date.now();
    s.timer = setInterval(() => {
      if (!S) return;
      if (procs.some((p) => p.exitCode != null || p.signalCode)) { const d = procs.find((p) => p.exitCode != null || p.signalCode); closeRemoteBrowser(`${d.label} stopped`); return; }
      if (S.viewers === 0 && Date.now() - S.last > idleMs()) closeRemoteBrowser('idle for ' + idleMs() / 60000 + ' minutes');
      else if (S.viewers > 0 && Date.now() - S.last > idleMs()) closeRemoteBrowser('no input for ' + idleMs() / 60000 + ' minutes');
    }, 30 * 1000); s.timer.unref();
    S = s;
    console.log(`Remote browser: open on display ${disp} (pids ${procs.map((p) => p.pid).join(',')}), via ${tunnelKind()} ${base.replace(/^https?:\/\//, '')}/${token.slice(0, 4)}…`);
    return { ...remoteBrowserStatus(), link: s.link };
  } catch (e) { await kill(); throw e; }
}

// Public tunnel. REMOTE_BROWSER_TUNNEL = auto (default: ngrok when NGROK_AUTHTOKEN is set, else cloudflared) | ngrok | cloudflared | none.
// cloudflared quick tunnels need no account but need outbound TCP/UDP 7844; ngrok needs a free authtoken but only HTTPS (443).
// none = local link only (testing, or when the server is already reachable another way).
function tunnelKind() {
  const k = (env('REMOTE_BROWSER_TUNNEL') || 'auto').toLowerCase();
  if (k === 'auto') return env('NGROK_AUTHTOKEN') ? 'ngrok' : 'cloudflared';
  return k;
}
async function openTunnel(tools, port, procs, s) {
  const kind = tunnelKind();
  if (kind === 'none') return `http://127.0.0.1:${port}`;
  if (kind === 'ngrok') {
    const cfg = path.join(os.tmpdir(), `rb-ngrok-${crypto.randomBytes(4).toString('hex')}.yml`);
    fs.writeFileSync(cfg, 'version: "3"\nagent:\n  crl_noverify: true\n', { mode: 0o600 }); s.ngrokCfg = cfg;
    const ng = run('ngrok', tools.ngrok, ['http', `127.0.0.1:${port}`, '--config', cfg, '--log', 'stdout', '--log-format', 'json']); procs.push(ng); // token comes from NGROK_AUTHTOKEN in env
    return waitFor(() => {
      if (ng.exitCode != null || /ERR_NGROK_\d+/.test(ng.out)) throw new Error('ngrok could not start: ' + ((ng.out.match(/ERR_NGROK_\d+/) || ['check NGROK_AUTHTOKEN'])[0]));
      const m = ng.out.match(/"url":"(https:\/\/[^"]+)"/); return m && m[1];
    }, 30000, 'the ngrok tunnel');
  }
  const cf = run('cloudflared', tools.cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]); procs.push(cf);
  const base = await waitFor(() => { if (cf.exitCode != null) throw new Error('cloudflared exited: ' + cf.out.slice(-200)); const m = cf.out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); return m && m[0]; }, 45000, 'the public tunnel');
  // a quick tunnel prints its URL before it has a live edge connection; fail fast if the edge is unreachable (port 7844 blocked)
  await waitFor(() => { if (/Registered tunnel connection/.test(cf.out)) return true; if (/Allow outbound TCP on port 7844|edge.*i\/o timeout/i.test(cf.out)) throw new Error('cloudflared cannot reach Cloudflare (outbound port 7844 is blocked on this network). Set NGROK_AUTHTOKEN to use ngrok instead.'); return false; }, 40000, 'cloudflared to connect');
  return base;
}

async function killAll(s) {
  if (s.timer) clearInterval(s.timer);
  if (s.gate) await new Promise((r) => { s.gate.close(() => r()); s.gate.closeAllConnections?.(); setTimeout(r, 1000); });
  // Chrome first (so it saves cookies and drops its SingletonLock), then the rest, each by its own exact PID.
  for (const p of [...s.procs].sort((a) => (a.label === 'chrome' ? -1 : 1))) {
    if (!p.pid || p.exitCode != null || p.signalCode) continue;
    try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ }
    const end = Date.now() + (p.label === 'chrome' ? 5000 : 2000);
    while (alive(p.pid) && p.exitCode == null && !p.signalCode && Date.now() < end) await sleep(150);
    if (p.exitCode == null && !p.signalCode) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } await sleep(200); }
  }
  if (s.pwFile) fs.rmSync(s.pwFile, { force: true });
  if (s.ngrokCfg) fs.rmSync(s.ngrokCfg, { force: true });
  const f = path.join(s.dir, 'agentsphere.lock');
  try { if (s.chromePid && Number(fs.readFileSync(f, 'utf8')) === s.chromePid) fs.rmSync(f); } catch { /* gone */ }
}

export async function closeRemoteBrowser(reason = 'closed by command') {
  const s = S; S = null;
  if (!s) return { state: 'closed', was: false };
  await killAll(s);
  console.log('Remote browser: closed (' + reason + ')');
  if (reason !== 'closed by command' && onClosed) { try { onClosed(reason); } catch { /* ignore */ } }
  return { state: 'closed', was: true, reason, pids: s.procs.map((p) => p.pid) };
}
process.on('exit', () => { if (!S) return; for (const p of S.procs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } for (const f of [S.pwFile, S.ngrokCfg]) if (f) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } } try { if (Number(fs.readFileSync(path.join(S.dir, 'agentsphere.lock'), 'utf8')) === S.chromePid) fs.rmSync(path.join(S.dir, 'agentsphere.lock')); } catch { /* gone */ } });
