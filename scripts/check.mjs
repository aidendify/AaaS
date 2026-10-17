// Syntax check for every server-side JS file (used by CI and `npm run check`). No dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const roots = ['server.js', 'api', 'lib', 'scripts'];
const files = [];
const walk = (p) => { const s = fs.statSync(p); if (s.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f)); else if (/\.(m?js)$/.test(p)) files.push(p); };
for (const r of roots) if (fs.existsSync(r)) walk(r);
let bad = 0;
for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error('✗', f, '\n' + e.stderr.toString()); } }
try { execFileSync('bash', ['-n', 'install.sh'], { stdio: 'pipe' }); } catch (e) { bad++; console.error('✗ install.sh', e.stderr.toString()); }
console.log(`${files.length + 1 - bad}/${files.length + 1} files OK`);
process.exit(bad ? 1 : 0);
