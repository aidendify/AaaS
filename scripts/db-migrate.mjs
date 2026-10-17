#!/usr/bin/env node
// Move data between data/kv.json and Postgres (Neon or any Postgres).
//
//   npm run db:migrate-from-file -- [--dry-run] [--file data/kv.json] [--overwrite]
//       Copies every key from kv.json into the database (DATABASE_URL, optional DATABASE_SCHEMA).
//       Safe to run again: identical rows are skipped; a row that is newer in the database is kept unless --overwrite.
//       Afterwards it re-reads the database and checks the row count and a sha256 hash of the copied rows.
//   npm run db:export-to-file -- [--out data/kv-export.json] [--dry-run]
//       Writes the whole database back to a kv.json-shaped file (never overwrites an existing file).
//
// DATABASE_URL is read from the environment or from .env. It is never printed.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, sqlStore } from '../lib/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > 0 && args[i + 1] ? args[i + 1] : d; };

function loadEnvFile() {
  const f = process.env.AIDENTIFY_ENV_FILE || path.join(ROOT, '.env');
  if (!fss.existsSync(f)) return;
  for (const line of fss.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || (process.env[m[1]] ?? '') !== '') continue;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

// Hash of rows sorted by key, over (k, v, at), so both sides can be compared exactly.
export function hashRows(rows) {
  const h = crypto.createHash('sha256');
  for (const r of [...rows].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))) h.update(JSON.stringify([r.k, r.v ?? null, Number(r.at) || 0]) + '\n');
  return h.digest('hex');
}

async function openDb() {
  loadEnvFile();
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) { console.error('DATABASE_URL is not set (environment or .env).'); process.exit(2); }
  const c = await connect(url);
  const st = sqlStore(c.q, { driver: c.driver, close: c.close });
  await st.init();
  return st;
}

async function fromFile() {
  const DATA_DIR = process.env.AIDENTIFY_DATA_DIR ? path.resolve(process.env.AIDENTIFY_DATA_DIR) : path.join(ROOT, 'data');
  const file = path.resolve(opt('file', path.join(DATA_DIR, 'kv.json')));
  const dry = flag('dry-run'), overwrite = flag('overwrite');
  const src = Object.values(JSON.parse(await fs.readFile(file, 'utf8')) || {}).filter((r) => r && typeof r.k === 'string')
    .map((r) => ({ k: r.k, v: typeof r.v === 'string' ? r.v : JSON.stringify(r.v ?? null), at: Number(r.at) || 0 }));
  const st = await openDb();
  try {
    const cur = new Map((await st.all()).map((r) => [r.k, r]));
    const plan = { insert: [], update: [], same: [], keptNewer: [] };
    for (const r of src) {
      const d = cur.get(r.k);
      if (!d) plan.insert.push(r);
      else if (d.v === r.v && d.at === r.at) plan.same.push(r);
      else if (d.at > r.at && !overwrite) plan.keptNewer.push(r);
      else plan.update.push(r);
    }
    console.log(`Source ${path.basename(file)}: ${src.length} rows. Database (${st.kind}, schema ${st.schema}): ${cur.size} rows before.`);
    console.log(`Plan: insert ${plan.insert.length}, update ${plan.update.length}, already identical ${plan.same.length}, newer in database (kept) ${plan.keptNewer.length}.`);
    if (dry) { console.log('Dry run: nothing written.'); return 0; }
    for (const r of [...plan.insert, ...plan.update]) await st.put(r.k, r.v, r.at);
    // verify
    const after = new Map((await st.all()).map((r) => [r.k, r]));
    const expect = src.filter((r) => !plan.keptNewer.includes(r));
    const got = expect.map((r) => after.get(r.k)).filter(Boolean);
    const okCount = got.length === expect.length, okHash = hashRows(got) === hashRows(expect);
    console.log(`Verify: ${got.length}/${expect.length} rows present, hash ${okHash ? 'matches' : 'DIFFERS'} (sha256 ${hashRows(expect).slice(0, 16)}…). Database now has ${after.size} rows.`);
    if (!okCount || !okHash) { console.error('Verification failed.'); return 1; }
    console.log('Done. Point the server at the database with DATABASE_URL (and HOSTED=1 for a hosted deploy).');
    return 0;
  } finally { await st.close(); }
}

async function toFile() {
  const out = path.resolve(opt('out', path.join(ROOT, 'data', 'kv-export.json')));
  const st = await openDb();
  try {
    const rows = await st.all();
    console.log(`Database (${st.kind}, schema ${st.schema}): ${rows.length} rows.`);
    if (flag('dry-run')) { console.log('Dry run: nothing written.'); return 0; }
    if (fss.existsSync(out)) { console.error(`${out} already exists; choose another --out.`); return 1; }
    const obj = Object.fromEntries(rows.map((r) => [r.k, { k: r.k, v: r.v, at: r.at }]));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(obj), { mode: 0o600 });
    const back = Object.values(JSON.parse(await fs.readFile(out, 'utf8')));
    const ok = back.length === rows.length && hashRows(back) === hashRows(rows);
    console.log(`Wrote ${out}: ${back.length} rows, hash ${ok ? 'matches' : 'DIFFERS'}.`);
    return ok ? 0 : 1;
  } finally { await st.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = cmd === 'from-file' ? fromFile : cmd === 'to-file' ? toFile : null;
  if (!run) { console.error('Usage: db-migrate.mjs from-file [--dry-run] [--file F] [--overwrite] | to-file [--out F] [--dry-run]'); process.exit(2); }
  run().then((c) => process.exit(c), (e) => { console.error('Error:', String(e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>')); process.exit(1); });
}
