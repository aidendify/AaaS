// Storage backends. The file store always runs. Postgres runs when a test database is available:
//   DATABASE_URL_TEST=postgres://...   (CI: a postgres service container)
//   or NEON_ENV_FILE=<file with NEON_DATABASE_URL='...'> (a Neon project; read here, never printed)
// Each run uses its own schema aidentify_test_<random> and drops it at the end, so the main database stays clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startServer } from './helpers.mjs';
import { connect, sqlStore, driverFor } from '../lib/db.js';
import { hashRows } from '../scripts/db-migrate.mjs';

function testUrl() {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const f = process.env.NEON_ENV_FILE;
  if (f && fs.existsSync(f)) { const m = fs.readFileSync(f, 'utf8').match(/^\s*NEON_DATABASE_URL\s*=\s*(['"]?)(.*)\1\s*$/m); if (m) return m[2]; }
  return '';
}
const URL_ = testUrl();
const schema = 'aidentify_test_' + crypto.randomBytes(4).toString('hex');

async function signupMany(srv, n, tag) {
  return Promise.all(Array.from({ length: n }, (_, i) => srv.api('/api/auth/signup', { email: `${tag}${i}@agency.test`, name: 'U' + i, password: 'Correct-Horse-42!' })));
}

test('file store: hosted mode refuses to start without DATABASE_URL', async () => {
  const srv = await startServer({ HOSTED: '1' }).catch((e) => e);
  // the process exits; health never answers
  const r = await fetch(srv.base + '/api/health').then(() => 'up', () => 'down');
  assert.equal(r, 'down'); assert.match(srv.log(), /Hosted mode .* needs DATABASE_URL/);
  await srv.stop();
});

test('file store: concurrent sign-ups are all kept', async () => {
  const srv = await startServer();
  try {
    const rs = await signupMany(srv, 8, 'f');
    assert.ok(rs.every((r) => r.status === 200));
    for (let i = 0; i < 8; i++) assert.equal((await srv.api('/api/auth/login', { email: `f${i}@agency.test`, password: 'Correct-Horse-42!' })).status, 200);
  } finally { await srv.stop(); }
});

test('postgres store', { skip: URL_ ? false : 'no test database (set DATABASE_URL_TEST or NEON_ENV_FILE)' }, async (t) => {
  const c = await connect(URL_);
  const st = sqlStore(c.q, { schema, driver: c.driver });
  try {
    await t.test('schema, migrations are idempotent', async () => {
      await st.init(); const st2 = sqlStore(c.q, { schema, driver: c.driver }); await st2.init();
      const m = await c.q(`select version from "${schema}".agentsphere_migrations order by version`);
      assert.deepEqual(m.map((r) => Number(r.version)), [1, 2, 3, 4]);
      const ix = await c.q(`select indexname from pg_indexes where schemaname = $1`, [schema]);
      assert.ok(ix.some((r) => r.indexname === 'agentsphere_kv_k_prefix'));
    });
    await t.test('get / put / listPrefix (LIKE characters escaped)', async () => {
      await st.put('as_a:x', '1', 1); await st.put('as_b:x', '2', 2); await st.put('as_a:x', '3', 3);
      assert.equal((await st.get('as_a:x')).v, '3');
      assert.equal((await st.listPrefix('as_')).length, 2);
      assert.equal((await st.listPrefix('as%')).length, 0);
    });
    await t.test('update() loses no concurrent changes', async () => {
      await Promise.all(Array.from({ length: 8 }, () => st.update('counter', (cur) => String((Number(cur) || 0) + 1))));
      assert.equal((await st.get('counter')).v, '8');
    });
    await t.test('lock() is exclusive and released', async () => {
      const rel = await st.lock('ws'); await assert.rejects(st.lock('ws', { waitMs: 200 }), /Busy/); await rel();
      const rel2 = await st.lock('ws', { waitMs: 2000 }); await rel2();
    });
    await t.test('server on Postgres: concurrent sign-ups and login', async () => {
      const srv = await startServer({ DATABASE_URL: URL_, DATABASE_SCHEMA: schema, HOSTED: '1' });
      try {
        const rs = await signupMany(srv, 6, 'p');
        assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
        for (let i = 0; i < 6; i++) assert.equal((await srv.api('/api/auth/login', { email: `p${i}@agency.test`, password: 'Correct-Horse-42!' })).status, 200);
        assert.match(srv.log(), /Database: (Neon )?Postgres/);
        assert.equal((await srv.api('/api/health')).d.db, driverFor(URL_) === 'neon' ? 'neon' : 'postgres');
      } finally { await srv.stop(); }
    });
    await t.test('hash helper is order-independent', () => {
      assert.equal(hashRows([{ k: 'b', v: '1', at: 1 }, { k: 'a', v: '2', at: 2 }]), hashRows([{ k: 'a', v: '2', at: 2 }, { k: 'b', v: '1', at: 1 }]));
    });
  } finally { await st.dropSchema().catch(() => {}); await c.close(); }
});
