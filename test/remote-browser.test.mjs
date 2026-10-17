// Unit checks of the remote browser limits, without starting Chrome or a tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('remote browser: hard max session, rate limit and audit log exist and are configurable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidentify-rb-'));
  process.env.AIDENTIFY_DATA_DIR = dir;
  process.env.REMOTE_BROWSER_MAX_MIN = '30';
  process.env.REMOTE_BROWSER_OPENS_PER_HOUR = '1';
  process.env.REMOTE_BROWSER_TUNNEL = 'invalid-for-test'; // fails before any process is started
  const rb = await import('../lib/remote-browser.js');
  const st = rb.remoteBrowserStatus();
  assert.equal(st.state, 'closed'); assert.equal(st.maxMin, 30);
  // first open fails at once (invalid tunnel) but counts toward the limit and is audited
  await assert.rejects(rb.openRemoteBrowser({ by: 'test' }));
  await assert.rejects(rb.openRemoteBrowser({ by: 'test' }), /limit 1/);
  const log = rb.remoteBrowserAuditLog();
  assert.ok(log.some((e) => e.action === 'failed' && e.by === 'test'));
  assert.ok(log.some((e) => e.action === 'refused' && e.detail === 'rate limit'));
  assert.ok(!fs.readFileSync(path.join(dir, 'remote-browser-audit.jsonl'), 'utf8').includes('password='), 'no link or password in the audit log');
  fs.rmSync(dir, { recursive: true, force: true });
});
