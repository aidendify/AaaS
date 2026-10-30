import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACK, PACK_IDS, PACKS, publicPacks } from '../lib/clinic-packs.js';

test('default demo pack is salon/studio, real estate next, dental still available', () => {
  assert.equal(DEFAULT_PACK, 'studio');
  assert.deepEqual(PACK_IDS.slice(0, 2), ['studio', 'realestate']);
  assert.equal(publicPacks()[0].id, 'studio');
  assert.ok(PACKS.dental && PACK_IDS.includes('dental'));
  assert.equal(new Set(PACK_IDS).size, Object.keys(PACKS).length);
});
