// Record the five local demos. Videos stay out of git; this script only drives them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { seedAll } from './seed.mjs';
import { recordStory, STORY_META } from './shots.mjs';
import { renderStory } from './post.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DATA = '/tmp/aidentify-demo-data';
const WORK = '/tmp/aidentify-demo-videos';
const ART = process.env.DEMO_ARTIFACTS || '/opt/cursor/artifacts';
const ONLY = (process.env.ONLY || 'clinic,coach,broker,studio,agency').split(',').map((s) => s.trim()).filter(Boolean);

function startServer() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const envFile = '/tmp/aidentify-demo.env';
  const session = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(envFile, [
    'PORT=3210',
    'HOST=127.0.0.1',
    'AI_PROVIDER=mock',
    'AI_MOCK=on',
    'CHANNELS_MOCK=on',
    'RATE_LIMIT=off',
    'CRON_SECRET=' + 'c'.repeat(32),
    'SESSION_SECRET=' + session,
    'APP_URL=http://127.0.0.1:3210',
    'ADMIN_EMAIL=admin@aidentify.local',
    'ADMIN_PASSWORD=Kx7-river-maple-91!',
  ].join('\n') + '\n');
  const log = fs.createWriteStream('/tmp/aidentify-demo-server.log');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: '3210',
      HOST: '127.0.0.1',
      AI_PROVIDER: 'mock',
      AI_MOCK: 'on',
      CHANNELS_MOCK: 'on',
      RATE_LIMIT: 'off',
      CRON_SECRET: 'c'.repeat(32),
      SESSION_SECRET: session,
      APP_URL: 'http://127.0.0.1:3210',
      AIDENTIFY_DATA_DIR: DATA,
      AIDENTIFY_ENV_FILE: envFile,
      ADMIN_EMAIL: 'admin@aidentify.local',
      ADMIN_PASSWORD: 'Kx7-river-maple-91!',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3210/api/health');
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Server did not answer /api/health. See /tmp/aidentify-demo-server.log');
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(ART, { recursive: true });
  const server = startServer();
  const stopped = new Promise((resolve) => server.on('exit', resolve));
  try {
    await waitHealth();
    const manifest = await seedAll();
    console.log('seeded', JSON.stringify({
      clinicSlots: manifest.clinic.slots,
      monday: manifest.broker.monday.slice(0, 80),
      telegram: !!manifest.coach.telegram.secret_token,
      slack: manifest.studio.slack.team_id,
    }));
    if (ONLY.includes('seed') && ONLY.length === 1) return;
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const report = [];
    try {
      for (const id of ONLY) {
        if (!STORY_META[id]) throw new Error('Unknown story ' + id);
        console.log('recording', id);
        const dir = path.join(WORK, id);
        fs.mkdirSync(dir, { recursive: true });
        const shot = await recordStory(browser, id, manifest, dir);
        fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(shot.captions, null, 2));
        const out16 = path.join(ART, STORY_META[id].file + '_16x9.mp4');
        const out9 = path.join(ART, STORY_META[id].file + '_9x16.mp4');
        const timing = await renderStory({
          raw: shot.src,
          captions: shot.captions,
          title: STORY_META[id].title,
          work: path.join(dir, 'post'),
          out16, out9,
        });
        console.log(id, timing);
        report.push({ id, ...timing, out16, out9 });
        for (const file of [out16, out9]) {
          const s = timing.duration16 && file.endsWith('16x9.mp4') ? timing.duration16 : timing.duration9;
          if (s < 60 || s > 90) console.error('DURATION', file, s);
        }
      }
    } finally {
      await browser.close();
    }
    fs.writeFileSync(path.join(WORK, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.kill('SIGTERM');
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 4000))]);
    if (!server.killed) server.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
