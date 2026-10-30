// BYOK is the primary path for real AI; UI copy must not push a shared/platform key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const fn = html.slice(html.indexOf('function aiKeyStatus(){'), html.indexOf('function', html.indexOf('function aiKeyStatus(){') + 10));
test('AI key status copy makes BYOK primary', () => {
  assert.match(fn, /Real AI (replies|use) needs? your own key/);
  assert.match(fn, /you pay your provider directly/i);
  assert.doesNotMatch(fn, /shared demo key|free AI calls/i);
});
