import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../clinic.html', import.meta.url), 'utf8');
test('clinic UI labels AI vs scheduled rule', () => {
  assert.match(html, /AI wrote this/);
  assert.match(html, /Scheduled rule/);
  assert.match(html, /function originTag\(d\)/);
  assert.match(html, /\$\{originTag\(d\)\}/);
  assert.match(html, /<b>Chief<\/b> <span class="origin ai"/);
  assert.match(html, /\.origin\.ai/);
  assert.match(html, /\.origin\.rule/);
});
