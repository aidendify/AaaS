// Vercel build: copy only the public pages into public/ so Vercel serves just these as static files.
// Without this, Vercel would also serve lib/, docs/, .env.example and everything else in the repo as plain files.
// The serverless function (api/index.js) still bundles lib/ on its own.
import fs from 'node:fs';
const OUT = 'public';
const PAGES = ['index.html', 'setup.html', 'settings.html', 'board.html', 'waitlist.html'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const p of PAGES) fs.copyFileSync(p, `${OUT}/${p}`);
for (const d of ['logos']) if (fs.existsSync(d)) fs.cpSync(d, `${OUT}/${d}`, { recursive: true, filter: (s) => !/README\.md$/.test(s) });
if (fs.existsSync('zips')) { fs.mkdirSync(`${OUT}/zips`); for (const z of fs.readdirSync('zips')) if (/^[a-z-]+\.zip\.txt$/.test(z)) fs.copyFileSync(`zips/${z}`, `${OUT}/zips/${z}`); }
console.log('public/:', fs.readdirSync(OUT).join(', '));
