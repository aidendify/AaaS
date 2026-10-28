// Vercel build: copy only the public pages into public/ so Vercel serves just these as static files.
// Without this, Vercel would also serve lib/, docs/, .env.example and everything else in the repo as plain files.
// The serverless function (api/index.js) still bundles lib/ on its own.
import fs from 'node:fs';
import { applyPriceTokens } from '../lib/pricing.js';
const OUT = 'public';
const PAGES = ['index.html', 'setup.html', 'settings.html', 'board.html', 'waitlist.html', 'landing-v2.html', 'white-label.html', 'clinic.html'];
const ASSETS = ['landing-v2.css', 'landing-v2.js'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const p of PAGES) {
  const body = p === 'landing-v2.html' ? applyPriceTokens(fs.readFileSync(p, 'utf8')) : fs.readFileSync(p);
  fs.writeFileSync(`${OUT}/${p}`, body);
}
for (const p of ASSETS) fs.copyFileSync(p, `${OUT}/${p}`);
for (const d of ['logos']) if (fs.existsSync(d)) fs.cpSync(d, `${OUT}/${d}`, { recursive: true, filter: (s) => !/README\.md$/.test(s) });
if (fs.existsSync('zips')) { fs.mkdirSync(`${OUT}/zips`); for (const z of fs.readdirSync('zips')) if (/^[a-z-]+\.zip\.txt$/.test(z)) fs.copyFileSync(`zips/${z}`, `${OUT}/zips/${z}`); }
// Landing project (aidentify.vercel.app): v2 is the home page. v1 stays at /v1 (waitlist.html).
if (process.env.AIDENTIFY_SITE === 'landing') fs.writeFileSync(`${OUT}/index.html`, applyPriceTokens(fs.readFileSync('landing-v2.html', 'utf8')));
console.log('public/:', fs.readdirSync(OUT).join(', '));
