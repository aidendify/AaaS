import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../clinic.html', import.meta.url), 'utf8');
test('monthly calendar screen is wired', () => {
  assert.match(src, /'setup','calendar'\]/);
  assert.match(src, /item\('calendar','Calendar'\)/);
  assert.match(src, /function calendar\(\)/);
  assert.match(src, /visit, calendar, settings/);
  assert.match(src, /class="cal-grid"/);
});
test('calendar shows visits and posts and adds via existing APIs', () => {
  const fn = src.slice(src.indexOf('function calendar()'), src.indexOf('function insights()'));
  assert.match(fn, /state\.appointments/);
  assert.match(fn, /state\.posts/);
  assert.match(fn, /data-act="cal-day"/);
  assert.match(fn, /data-act="add-appt"/);
  assert.match(fn, /data-act="social"/);
  assert.match(src, /name === 'cal-day'/);
  assert.match(src, /name === 'cal-nav'/);
});
