// Postgres storage (Neon or any Postgres). One key-value table, the same shape as data/kv.json.
//
//   Driver:  Neon URLs (*.neon.tech) use @neondatabase/serverless over HTTPS (works on Vercel and behind firewalls);
//            every other URL uses node-postgres ("pg") with a connection pool. DB_DRIVER=neon|pg forces one.
//   Schema:  DATABASE_SCHEMA=<name> keeps the tables in their own Postgres schema (tests, several apps in one database).
//   Tables:  agentsphere_kv (k, v, at, ver, updated_at): the data. The old name is kept so existing databases keep working.
//            agentsphere_locks: short leases, so only one server instance changes one workspace at a time.
//            agentsphere_migrations: which schema steps have run.
//   Writes:  put() is an upsert. update() is compare-and-swap on "ver" and retries, so two servers saving the same key
//            at the same moment cannot silently drop one of the changes. lock() gives a cross-instance lease.
//   Retries: transient network and Postgres errors (connection reset, admin shutdown, serialization) are retried.
import crypto from 'node:crypto';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|Connection terminated|timeout|terminating connection|too many connections/i;
const TRANSIENT_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '40001', '40P01', '53300']);
export const isTransient = (e) => !!e && (TRANSIENT_CODES.has(e.code) || TRANSIENT.test(String(e.message || e)));

export function driverFor(url) {
  const forced = env('DB_DRIVER').toLowerCase();
  if (forced === 'neon' || forced === 'pg') return forced;
  try { return /\.neon\.tech$/i.test(new URL(url).hostname) ? 'neon' : 'pg'; } catch { return 'pg'; }
}

// → { q(text, params) => rows, close(), driver }
export async function connect(url, { driver = driverFor(url), retries = 3 } = {}) {
  let raw, close = async () => {};
  if (driver === 'neon') {
    const mod = await import('@neondatabase/serverless');
    const sql = mod.neon(url);
    raw = async (text, params) => sql.query(text, params);
  } else {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: Number(env('DB_POOL_MAX', '10')) || 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    pool.on('error', (e) => console.error('Postgres pool:', e.message)); // an idle client dropped; the pool replaces it
    raw = async (text, params) => (await pool.query(text, params)).rows;
    close = () => pool.end();
  }
  const q = async (text, params = []) => {
    for (let i = 0; ; i++) {
      try { return await raw(text, params); }
      catch (e) { if (i >= retries || !isTransient(e)) throw e; await sleep(150 * 3 ** i + Math.random() * 100); }
    }
  };
  return { q, close, driver };
}

const ident = (s) => { if (!/^[a-z_][a-z0-9_]{0,50}$/.test(s)) throw new Error('DATABASE_SCHEMA must be lower-case letters, digits and _'); return '"' + s + '"'; };

export function sqlStore(q, { schema = env('DATABASE_SCHEMA'), driver = 'pg', close = async () => {} } = {}) {
  const S = schema ? ident(schema) + '.' : '';
  const T = S + 'agentsphere_kv', L = S + 'agentsphere_locks', M = S + 'agentsphere_migrations';
  // Every step is idempotent, so two instances starting at once are safe.
  const MIGRATIONS = [
    [1, `create table if not exists ${T} (k text primary key, v text, at bigint not null default 0, updated_at timestamptz not null default now())`],
    [2, `alter table ${T} add column if not exists ver bigint not null default 0`],
    [3, `create index if not exists agentsphere_kv_k_prefix on ${T} (k text_pattern_ops)`],
    [4, `create table if not exists ${L} (name text primary key, holder text not null, expires timestamptz not null)`],
  ];
  let ready = null;
  const init = () => (ready ||= (async () => {
    if (schema) await q(`create schema if not exists ${ident(schema)}`);
    await q(`create table if not exists ${M} (version int primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await q(`select version from ${M}`)).map((r) => Number(r.version)));
    for (const [v, text] of MIGRATIONS) {
      if (done.has(v)) continue;
      await q(text);
      await q(`insert into ${M} (version) values ($1) on conflict do nothing`, [v]);
    }
  })().catch((e) => { ready = null; throw e; }));
  const row = (r) => ({ k: r.k, v: r.v, at: Number(r.at) || 0 });
  const st = {
    kind: driver === 'neon' ? 'neon' : 'postgres',
    driver,
    schema: schema || 'public',
    init,
    close,
    async all() { await init(); return (await q(`select k, v, at from ${T}`)).map(row); },
    async get(k) { await init(); const r = await q(`select k, v, at, ver from ${T} where k = $1`, [k]); return r[0] ? { ...row(r[0]), ver: Number(r[0].ver) || 0 } : null; },
    async put(k, v, at) {
      await init();
      await q(`insert into ${T} (k, v, at) values ($1, $2, $3)
               on conflict (k) do update set v = excluded.v, at = excluded.at, ver = ${T}.ver + 1, updated_at = now()`, [k, v, Number(at) || Date.now()]);
    },
    async del(k) { await init(); await q(`delete from ${T} where k = $1`, [k]); },
    async listPrefix(prefix) {
      await init();
      const like = String(prefix).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      return (await q(`select k, v, at from ${T} where k like $1 escape '\\'`, [like])).map(row);
    },
    // Read-modify-write without lost updates: fn(currentText|null) → new text (or undefined to leave it).
    async update(k, fn, { tries = 40 } = {}) {
      await init();
      for (let i = 0; i < tries; i++) {
        const cur = await st.get(k);
        const next = await fn(cur ? cur.v : null);
        if (next === undefined) return cur ? cur.v : null;
        const at = Date.now();
        const r = cur
          ? await q(`update ${T} set v = $2, at = $3, ver = ver + 1, updated_at = now() where k = $1 and ver = $4 returning k`, [k, next, at, cur.ver])
          : await q(`insert into ${T} (k, v, at) values ($1, $2, $3) on conflict (k) do nothing returning k`, [k, next, at]);
        if (r.length) return next;
        await sleep(Math.random() * Math.min(1000, 20 * 2 ** Math.min(i, 6))); // someone else wrote first: read again and re-apply
      }
      throw new Error('Too many concurrent changes to ' + k + '; try again.');
    },
    // Cross-instance lease. Returns release(). Waits up to waitMs; a crashed holder's lease expires after ttlMs.
    async lock(name, { ttlMs = 30000, waitMs = 20000 } = {}) {
      await init();
      const holder = crypto.randomBytes(8).toString('hex'), end = Date.now() + waitMs;
      for (let i = 0; ; i++) {
        const r = await q(`insert into ${L} (name, holder, expires) values ($1, $2, now() + ($3::text || ' milliseconds')::interval)
                           on conflict (name) do update set holder = excluded.holder, expires = excluded.expires where ${L}.expires < now()
                           returning holder`, [name, holder, String(ttlMs)]);
        if (r[0] && r[0].holder === holder) return async () => { await q(`delete from ${L} where name = $1 and holder = $2`, [name, holder]).catch(() => {}); };
        if (Date.now() > end) throw new Error('Busy: another server is changing ' + name + '. Try again.');
        await sleep(Math.min(500, 20 * (i + 1)));
      }
    },
    async dropSchema() { if (!schema || schema === 'public') throw new Error('refusing to drop'); await q(`drop schema if exists ${ident(schema)} cascade`); ready = null; },
  };
  return st;
}
