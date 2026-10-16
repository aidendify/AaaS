// Factory tools for agents whose `tools` list includes them (set in the Groups tab → Agents table).
//
//   sandbox  project_files / read_file / write_file / run_command, all inside data/projects/<project>/.
//            Commands run in a bubblewrap sandbox (no network, no access outside the project folder, no secrets in
//            the environment). Commands that need the network (npm install, pip install, git clone, curl…) wait for
//            the owner's approval and then run with network on. Without bubblewrap every command needs approval.
//   (any)    gumroad_stats (read-only product and sales numbers; needs GUMROAD_ACCESS_TOKEN)
//   publish  github_publish (create a repo and push a project; needs GITHUB_TOKEN) and gumroad_create_draft
//            (a draft product; needs GUMROAD_ACCESS_TOKEN). Both always wait for approval. Gumroad listings may not
//            contain GitHub (or other code-host) links.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (k) => (process.env[k] || '').trim();
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters)` : s; };
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const PROJECTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'projects'); // same data folder as lib/backend.js
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HAS_BWRAP = spawnSync('bwrap', ['--version']).status === 0;
const NEEDS_NET = /\b(npm\s+(i|install|ci|add|update)|npx|pnpm|yarn|pip3?\s+install|python3?\s+-m\s+pip|curl|wget|git\s+(clone|fetch|pull|push|submodule)|go\s+get|cargo\s+(install|build|fetch))\b/;
const REFUSED = /\b(sudo|su|apt|apt-get|dnf|yum|docker|podman|systemctl|mount|chroot|ssh|scp)\b/;
const CODE_HOST = /(github\.com|gitlab\.com|bitbucket\.org|git\s+clone|codeberg\.org)/i;

export const factoryInfo = () => ({ sandbox: HAS_BWRAP ? 'bubblewrap' : 'approval-only', github: !!env('GITHUB_TOKEN'), gumroad: !!env('GUMROAD_ACCESS_TOKEN'), docker: false });

async function projectDir(project) {
  const slug = String(project || '').toLowerCase();
  if (!SLUG.test(slug)) throw new Error('Project must be a short slug like "agency-dashboard" (a-z, 0-9, dashes).');
  const dir = path.join(PROJECTS, slug); await fs.mkdir(dir, { recursive: true }); return dir;
}
// resolve a path inside the project; anything that escapes (.., absolute, symlinks out) is refused
async function inside(dir, p = '.') {
  const full = path.resolve(dir, String(p || '.'));
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error('Paths must stay inside the project folder.');
  let real = full; try { real = await fs.realpath(full); } catch { real = path.join(await fs.realpath(path.dirname(full)).catch(() => path.dirname(full)), path.basename(full)); }
  if (real !== dir && !real.startsWith(dir + path.sep)) throw new Error('Paths must stay inside the project folder.');
  return full;
}

// run one command in the project folder; network only after approval
function runIn(dir, command, { timeout = 60, net = false } = {}) {
  return new Promise((resolve) => {
    const cleanEnv = ['--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/work', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'npm_config_cache', '/work/.cache/npm'];
    const args = HAS_BWRAP
      ? ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
        '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates', ...(net ? ['--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts'] : []),
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', dir, '/work', '--chdir', '/work', '--unshare-all', ...(net ? ['--share-net'] : []), '--die-with-parent', '--new-session', ...cleanEnv, 'sh', '-c', command]
      : ['-c', command];
    const p = spawn(HAS_BWRAP ? 'bwrap' : 'sh', args, { cwd: dir, env: HAS_BWRAP ? {} : { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' }, detached: true });
    let out = '', done = false;
    const add = (b) => { if (out.length < 200000) out += b.toString(); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} out += `\n[stopped after ${timeout}s]`; }, Math.max(5, Math.min(300, Number(timeout) || 60)) * 1000);
    p.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve(`exit ${code}\n${clip(out, 10000)}`); });
    p.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve('Could not run: ' + e.message); });
  });
}

async function addApproval({ st, email, aid, approvals, steps, uid, op, summary, input }) {
  const k = 'as_appr:' + email, all = parse((await st.get(k))?.v, []) || [];
  const a = { id: 'a' + uid(), aid, app: 'factory', kind: 'factory', op, summary: String(summary).slice(0, 200), input, status: 'pending', at: Date.now() };
  all.unshift(a); await st.put(k, JSON.stringify(all.slice(0, 200)), Date.now()); approvals.push(a);
  steps.push({ k: 'approval', t: 'Waiting for your approval: ' + a.summary });
  return `Approval ${a.id} requested: ${a.summary}. It runs only after the owner approves; do not say it is done.`;
}

// tools for one agent run (called by the orchestrator)
export function factoryTools({ agent, st, email, approvals, steps, uid }) {
  const want = new Set((agent && agent.tools) || []); const tools = [];
  const aid = agent ? agent.id : 'assistant';
  const P = { type: 'string', description: 'Project slug, e.g. "agency-dashboard". Files live in data/projects/<slug>/.' };
  if (want.has('sandbox')) {
    tools.push({ name: 'project_files', description: 'List files in a project folder (or a subfolder).', schema: { type: 'object', properties: { project: P, path: { type: 'string' } }, required: ['project'] },
      run: async (i) => { const dir = await projectDir(i.project), d = await inside(dir, i.path); const list = await fs.readdir(d, { withFileTypes: true }).catch(() => []); return list.filter((e) => e.name !== '.git').map((e) => e.name + (e.isDirectory() ? '/' : '')).join('\n') || '(empty)'; } });
    tools.push({ name: 'read_file', description: 'Read a text file from the project folder.', schema: { type: 'object', properties: { project: P, path: { type: 'string' } }, required: ['project', 'path'] },
      run: async (i) => clip(await fs.readFile(await inside(await projectDir(i.project), i.path), 'utf8'), 20000) });
    tools.push({ name: 'write_file', description: 'Create or overwrite a text file in the project folder (folders are created as needed).', schema: { type: 'object', properties: { project: P, path: { type: 'string' }, content: { type: 'string' } }, required: ['project', 'path', 'content'] },
      run: async (i) => { const f = await inside(await projectDir(i.project), i.path); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, String(i.content ?? '')); steps.push({ k: 'file', t: 'Wrote ' + i.project + '/' + i.path }); return 'Saved ' + i.path; } });
    tools.push({ name: 'run_command', description: `Run a shell command inside the project folder (${HAS_BWRAP ? 'sandboxed, no network' : 'every command waits for approval'}): tests, builds, git init/add/commit/status/log/diff, python, node. Commands that need the network (npm install, pip install, git clone, curl) wait for the owner's approval. sudo, apt and docker are not available.`,
      schema: { type: 'object', properties: { project: P, command: { type: 'string' }, timeout_seconds: { type: 'number', description: '5-300, default 60' } }, required: ['project', 'command'] },
      run: async (i) => {
        const cmd = String(i.command || '').trim(); if (!cmd) return 'Give a command.';
        if (REFUSED.test(cmd)) return 'That command is not available in the sandbox (no sudo, package managers or docker).';
        const dir = await projectDir(i.project);
        if (!HAS_BWRAP || NEEDS_NET.test(cmd)) return addApproval({ st, email, aid, approvals, steps, uid, op: 'command', summary: `Run in ${i.project}: ${cmd.slice(0, 140)}`, input: { project: i.project, command: cmd, timeout: i.timeout_seconds, net: true } });
        steps.push({ k: 'cmd', t: 'Ran in ' + i.project + ': ' + cmd.slice(0, 80) });
        return runIn(dir, cmd, { timeout: i.timeout_seconds });
      } });
  }
  if (want.has('publish') && env('GITHUB_TOKEN')) tools.push({ name: 'github_publish', description: 'Create a GitHub repository and push a project folder to it. Always waits for the owner\'s approval.',
    schema: { type: 'object', properties: { project: P, repo: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['project', 'repo'] },
    run: async (i) => { await projectDir(i.project); const repo = String(i.repo || '').replace(/[^\w.-]/g, '-').slice(0, 90); const owner = env('GITHUB_OWNER') || 'your GitHub account';
      return addApproval({ st, email, aid, approvals, steps, uid, op: 'github', summary: `Create ${i.private ? 'private' : 'public'} repo ${owner}/${repo} and push ${i.project}`, input: { project: i.project, repo, description: String(i.description || '').slice(0, 300), private: !!i.private } }); } });
  if (want.has('publish') && env('GUMROAD_ACCESS_TOKEN')) tools.push({ name: 'gumroad_create_draft', description: 'Create a Gumroad product as an unpublished DRAFT (name, description HTML, price). Never include GitHub or other code-host links in the description. Always waits for the owner\'s approval.',
    schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price_cents: { type: 'number', description: '0 for free' }, pay_what_you_want: { type: 'boolean' } }, required: ['name', 'description'] },
    run: async (i) => { if (CODE_HOST.test(String(i.description) + ' ' + String(i.name))) return 'Refused: Gumroad listings must not contain GitHub or other code-host links. Remove them and try again.';
      return addApproval({ st, email, aid, approvals, steps, uid, op: 'gumroad', summary: `Gumroad draft "${String(i.name).slice(0, 80)}" at ${(Number(i.price_cents) || 0) / 100}${i.pay_what_you_want ? '+ (pay what you want)' : ''}`, input: { name: String(i.name).slice(0, 200), description: String(i.description).slice(0, 20000), price: Math.max(0, Math.round(Number(i.price_cents) || 0)), pwyw: !!i.pay_what_you_want } }); } });
  // Read-only Gumroad numbers for any agent (no approval needed: it changes nothing).
  if (env('GUMROAD_ACCESS_TOKEN')) tools.push({ name: 'gumroad_stats', description: 'Read Gumroad numbers from the API: every product with price, published state, sales count and revenue, plus sales since a date. Read-only. Use this instead of the Gumroad dashboard.',
    schema: { type: 'object', properties: { since: { type: 'string', description: 'YYYY-MM-DD; sales after this date (default: last 30 days)' } } },
    run: async (i) => gumroadStats(i.since) });
  return tools;
}

async function gumroadStats(since) {
  const token = env('GUMROAD_ACCESS_TOKEN'), H = { authorization: 'Bearer ' + token };
  const get = async (u) => { const r = await fetch('https://api.gumroad.com/v2/' + u, { headers: H, signal: AbortSignal.timeout(20000) }); const j = await r.json().catch(() => ({})); if (!r.ok || !j.success) throw new Error('Gumroad ' + r.status + ': ' + clip(j.message || '', 120)); return j; };
  const after = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? since : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const { products = [] } = await get('products');
  const lines = products.map((p) => `- ${p.name}: ${p.published ? 'published' : 'draft/unpublished'}, price ${p.formatted_price || (p.price / 100)}, sales ${p.sales_count ?? 'unknown'}, revenue ${p.sales_usd_cents != null ? '$' + (p.sales_usd_cents / 100).toFixed(2) : 'unknown'}`);
  let sales = [], page = '', pages = 0;
  do { const j = await get('sales?after=' + after + (page ? '&page_key=' + encodeURIComponent(page) : '')); sales = sales.concat(j.sales || []); page = j.next_page_key || ''; pages++; } while (page && pages < 10);
  const byProduct = {};
  for (const x of sales) { const k = x.product_name || 'unknown'; byProduct[k] = byProduct[k] || { n: 0, cents: 0 }; byProduct[k].n++; byProduct[k].cents += Number(x.price) || 0; }
  const recent = Object.entries(byProduct).map(([k, v]) => `- ${k}: ${v.n} sale(s), $${(v.cents / 100).toFixed(2)}`);
  return `Gumroad products (${products.length}):\n${lines.join('\n') || '(none)'}\n\nSales since ${after}: ${sales.length}${pages >= 10 && page ? ' (first 10 pages only)' : ''}\n${recent.join('\n') || '(none)'}\nSource: Gumroad API, read ${new Date().toISOString()}.`;
}

// runs an approved factory action (called from decideApproval)
export async function runFactoryApproval(a) {
  const i = a.input || {};
  if (a.op === 'command') return runIn(await projectDir(i.project), i.command, { timeout: i.timeout || 120, net: !!i.net });
  if (a.op === 'github') return githubPublish(i);
  if (a.op === 'gumroad') return gumroadDraft(i);
  throw new Error('Unknown factory action.');
}

const git = (dir, args, extraEnv = {}) => { const r = spawnSync('git', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: '0', ...extraEnv }, encoding: 'utf8', timeout: 120000 }); if (r.status !== 0) throw new Error('git ' + args[0] + ': ' + String(r.stderr || r.stdout).slice(0, 300)); return r.stdout; };
async function githubPublish({ project, repo, description, private: priv }) {
  const token = env('GITHUB_TOKEN'); if (!token) throw new Error('GITHUB_TOKEN is not set.');
  const dir = await projectDir(project);
  // never push secrets: refuse obvious secret files
  const found = spawnSync('sh', ['-c', 'ls -a; find . -maxdepth 3 -name ".env" -o -maxdepth 3 -name "*.pem" -o -maxdepth 3 -name "id_rsa*"'], { cwd: dir, encoding: 'utf8' }).stdout || '';
  if (/(^|\/)\.env$|\.pem$|id_rsa/m.test(found.split('\n').filter((l) => l.startsWith('./')).join('\n'))) throw new Error('The project contains a .env, key or certificate file. Remove it before publishing.');
  const H = { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'user-agent': 'AgentSphere' };
  const me = await (await fetch('https://api.github.com/user', { headers: H })).json();
  if (!me.login) throw new Error('GITHUB_TOKEN was not accepted.');
  const owner = env('GITHUB_OWNER') || me.login;
  const url = owner === me.login ? 'https://api.github.com/user/repos' : `https://api.github.com/orgs/${owner}/repos`;
  const r = await fetch(url, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: repo, description, private: !!priv }) });
  if (!r.ok && r.status !== 422) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 200));
  try { git(dir, ['rev-parse', '--git-dir']); } catch { git(dir, ['init', '-b', 'main']); }
  git(dir, ['add', '-A']);
  try { git(dir, ['-c', 'user.name=AgentSphere', '-c', 'user.email=agents@agentsphere.local', 'commit', '-m', 'Publish ' + repo]); } catch { /* nothing new to commit */ }
  // token goes in a one-off header via env, never into the remote URL or git config on disk
  const auth = Buffer.from('x-access-token:' + token).toString('base64');
  git(dir, ['push', `https://github.com/${owner}/${repo}.git`, 'HEAD:main'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + auth });
  return `Pushed ${project} to https://github.com/${owner}/${repo}`;
}
async function gumroadDraft({ name, description, price, pwyw }) {
  const token = env('GUMROAD_ACCESS_TOKEN'); if (!token) throw new Error('GUMROAD_ACCESS_TOKEN is not set.');
  if (CODE_HOST.test(description + ' ' + name)) throw new Error('Gumroad listings must not contain GitHub or other code-host links.');
  const body = new URLSearchParams({ name, description, price: String(price || 0), draft: 'true', customizable_price: pwyw ? 'true' : 'false' });
  const r = await fetch('https://api.gumroad.com/v2/products', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error('Gumroad: ' + String(j.message || r.status).slice(0, 200));
  return `Created Gumroad draft "${j.product.name}" (not published). Attach the zip and publish it in Gumroad when ready.`;
}
