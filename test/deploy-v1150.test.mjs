// v1.15: backups (pack / verify / encrypt / restore guard) and the monitoring endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packBackup, unpackBackup, restoreAllowed, hashRows } from '../scripts/db-backup.mjs';
import { startServer } from './helpers.mjs';

const rows = [{ k: 'as_data:a@x.co', v: '{"agents":[]}', at: 5 }, { k: 'as_users', v: '{}', at: 7 }];

test('backup round trip, hash check, encryption', () => {
  const plain = unpackBackup(packBackup(rows, { schema: 'staging' }).buf);
  assert.equal(plain.meta.count, 2); assert.equal(plain.meta.sha256, hashRows(rows)); assert.deepEqual(plain.rows.map((r) => r.k).sort(), ['as_data:a@x.co', 'as_users']);
  const enc = packBackup(rows, { key: 'k'.repeat(40) }).buf;
  assert.ok(!enc.toString('latin1').includes('as_users'), 'encrypted file hides the data');
  assert.throws(() => unpackBackup(enc), /encrypted/);
  assert.throws(() => unpackBackup(enc, { key: 'wrong' }), /Wrong BACKUP_KEY/);
  assert.equal(unpackBackup(enc, { key: 'k'.repeat(40) }).meta.count, 2);
});

test('restore guard: never into the live schema by accident, never over existing rows', () => {
  assert.match(restoreAllowed('demo'), /live schema/);
  assert.match(restoreAllowed('public'), /live schema/);
  assert.equal(restoreAllowed('demo', { yes: true }), '');
  assert.match(restoreAllowed('restore_1', { existing: 3 }), /already has 3/);
  assert.match(restoreAllowed('Bad-Name'), /--schema/);
  assert.equal(restoreAllowed('restore_drill_x'), '');
});

test('/api/health/deep: db, version, ai, cron; no customer data', async () => {
  const s = await startServer({ AI_PROVIDER: 'mock', AI_MOCK: 'on', CRON_SECRET: 'c'.repeat(32) });
  try {
    let h = await s.api('/api/health/deep');
    assert.equal(h.status, 200); assert.equal(h.d.ok, true); assert.equal(h.d.db.ok, true); assert.equal(h.d.version, '2.3.0'); assert.equal(h.d.cron, null);
    const t = await fetch(s.base + '/api/cron/tick', { headers: { authorization: 'Bearer ' + 'c'.repeat(32) } }); assert.equal(t.status, 200);
    h = await s.api('/api/health/deep'); assert.equal(h.d.cron.ok, true); assert.equal(h.d.cron.hoursAgo, 0);
    assert.doesNotMatch(JSON.stringify(h.d), /@|token|key/i);
  } finally { await s.stop(); }
});
