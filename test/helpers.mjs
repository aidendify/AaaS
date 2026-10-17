// Starts a real AIdentify server on a free port with its own temp data dir and env file (never the real .env or data/).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function startServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidentify-test-'));
  const envFile = path.join(dir, 'test.env'); fs.writeFileSync(envFile, '');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: dir, PORT: String(port), HOST: '127.0.0.1', AIDENTIFY_DATA_DIR: path.join(dir, 'data'), AIDENTIFY_ENV_FILE: envFile, AIDENTIFY_WORKERS: 'off', SESSION_SECRET: crypto.randomBytes(24).toString('hex'), ...env },
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 400)); // let the listen callback print the setup line
  const api = async (p, body, token) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let d = null; try { d = await r.json(); } catch { /* not json */ }
    return { status: r.status, d };
  };
  return { base, api, dir, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
