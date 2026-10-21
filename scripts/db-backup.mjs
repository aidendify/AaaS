#!/usr/bin/env node
// Backups for the hosted database (Neon / any Postgres). Run from a trusted machine, never from a browser.
//
//   node scripts/db-backup.mjs backup  [--schema demo] [--out backups/]           → backups/aidentify-<schema>-<time>.json.gz[.enc]
//   node scripts/db-backup.mjs verify  --file <backup>                            → checks the file opens and its hash matches
//   node scripts/db-backup.mjs restore --file <backup> --schema <target> [--yes]  → copies every row into <target>
//   node scripts/db-backup.mjs drill   [--schema staging]                         → backup → restore into a throw-away
//                                                                                    schema → compare → drop it (see docs/BACKUPS.md)
// DATABASE_URL comes from the environment (or AIDENTIFY_ENV_FILE / .env); it is never printed.
// BACKUP_KEY (any long random string) encrypts the file with AES-256-GCM. Without it the file holds customer data
// in the clear: keep it off shared drives. Restore refuses "public" and the live schema "demo" unless --yes is given,
// and refuses a target that already has rows (restore into a new schema, check it, then switch DATABASE_SCHEMA).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = 'AIDBK1';

export function hashRows(rows) {
  const h = crypto.createHash('sha256');
  for (const r of [...rows].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))) h.update(JSON.stringify([r.k, r.v ?? null, Number(r.at) || 0]) + '\n');
  return h.digest('hex');
}
const keyOf = (k) => crypto.createHash('sha256').update(String(k)).digest();
export function packBackup(rows, { schema = '', key = '' } = {}) {
  const meta = { app: 'aidentify', schema, at: new Date().toISOString(), count: rows.length, sha256: hashRows(rows), enc: !!key };
  let buf = zlib.gzipSync(Buffer.from(JSON.stringify({ meta, rows: rows.map((r) => ({ k: r.k, v: r.v ?? null, at: Number(r.at) || 0 })) })));
  if (key) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyOf(key), iv); const body = Buffer.concat([c.update(buf), c.final()]); buf = Buffer.concat([Buffer.from(MAGIC), iv, c.getAuthTag(), body]); }
  return { buf, meta };
}
export function unpackBackup(buf, { key = '' } = {}) {
  if (buf.subarray(0, 6).toString() === MAGIC) {
    if (!key) throw new Error('This backup is encrypted: set BACKUP_KEY.');
    const iv = buf.subarray(6, 18), tag = buf.subarray(18, 34), d = crypto.createDecipheriv('aes-256-gcm', keyOf(key), iv); d.setAuthTag(tag);
    try { buf = Buffer.concat([d.update(buf.subarray(34)), d.final()]); } catch { throw new Error('Wrong BACKUP_KEY, or the file is damaged.'); }
  }
  const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  if (!j.meta || !Array.isArray(j.rows)) throw new Error('Not an AaaS backup.');
  if (j.rows.length !== j.meta.count || hashRows(j.rows) !== j.meta.sha256) throw new Error('Backup check failed: row count or hash does not match.');
  return j;
}
export function restoreAllowed(target, { yes = false, existing = 0 } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,50}$/.test(target || '')) return 'Give --schema <name> (lower-case letters, digits, _).';
  if ((target === 'public' || target === 'demo') && !yes) return `Refusing to restore into the live schema "${target}" without --yes. Restore into a new schema first and check it.`;
  if (existing > 0) return `Schema "${target}" already has ${existing} rows. Restore into an empty schema.`;
  return '';
}

function loadEnv() {
  const f = process.env.AIDENTIFY_ENV_FILE || path.join(ROOT, '.env'); if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m || (process.env[m[1]] ?? '') !== '') continue; let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); process.env[m[1]] = v; }
}
async function storeFor(schema) {
  const { connect, sqlStore } = await import('../lib/db.js');
  const url = process.env.DATABASE_URL; if (!url) throw new Error('Set DATABASE_URL.');
  const c = await connect(url); return sqlStore(c.q, { driver: c.driver, close: c.close, schema });
}
async function main(argv) {
  const [cmd, ...a] = argv, opt = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 && a[i + 1] ? a[i + 1] : d; }, flag = (n) => a.includes('--' + n);
  loadEnv(); const key = process.env.BACKUP_KEY || '';
  if (cmd === 'backup' || cmd === 'drill') {
    const schema = opt('schema', process.env.DATABASE_SCHEMA || 'public'), st = await storeFor(schema);
    const rows = await st.all(); await st.close?.();
    const { buf, meta } = packBackup(rows, { schema, key });
    const dir = path.resolve(opt('out', path.join(ROOT, 'backups'))); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `aidentify-${schema}-${meta.at.replace(/[:.]/g, '-')}.json.gz${key ? '.enc' : ''}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    console.log(`Backup: ${meta.count} rows from "${schema}" → ${file} (${(buf.length / 1024).toFixed(1)} KB, sha256 ${meta.sha256.slice(0, 12)}…${key ? ', encrypted' : ', NOT encrypted: set BACKUP_KEY'})`);
    if (cmd === 'backup') return;
    const target = 'restore_drill_' + Date.now().toString(36);
    const t0 = Date.now(); const n = await restore(file, target, key, false);
    const back = await storeFor(target), got = await back.all();
    const ok = got.length === meta.count && hashRows(got) === meta.sha256;
    console.log(`Drill: restored ${n} rows into "${target}" in ${((Date.now() - t0) / 1000).toFixed(1)} s, compare ${ok ? 'OK' : 'MISMATCH'}`);
    await back.dropSchema(); await back.close?.(); console.log(`Drill: dropped "${target}". Backup kept at ${file}.`);
    if (!ok) process.exitCode = 1; return;
  }
  if (cmd === 'verify') { const j = unpackBackup(fs.readFileSync(opt('file')), { key }); console.log(`OK: ${j.meta.count} rows from "${j.meta.schema}" at ${j.meta.at}, hash matches.`); return; }
  if (cmd === 'restore') { const n = await restore(opt('file'), opt('schema'), key, flag('yes')); console.log(`Restored ${n} rows into "${opt('schema')}".`); return; }
  console.log('Usage: node scripts/db-backup.mjs backup|verify|restore|drill (see the top of this file).'); process.exitCode = 2;
}
async function restore(file, target, key, yes) {
  const j = unpackBackup(fs.readFileSync(file), { key });
  let why = restoreAllowed(target, { yes }); if (why) throw new Error(why);
  const st = await storeFor(target); const existing = (await st.all()).length;
  why = restoreAllowed(target, { yes, existing }); if (why) { await st.close?.(); throw new Error(why); }
  for (const r of j.rows) await st.put(r.k, r.v, r.at);
  await st.close?.(); return j.rows.length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => { console.error('Error:', e.message); process.exitCode = 1; });
