// /api/settings/* for settings.html. Admin-only: role admin, or an email listed in SETTINGS_OWNERS
// (default: SLACK_ACCOUNT_EMAIL, the account the server runs for). Secrets are never returned.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA, ENV_ONLY, publicView, saveSettings, auditLog, audit, redact, sourceOf } from './settings.js';
import { providerOrder, providerConfig, PROVIDERS, complete, resolveModel } from './llm.js';
import { usageSummary, orModels } from './usage.js';
import { logLines } from './logbuf.js';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
const started = Date.now();

export function isSettingsAdmin(who) {
  if (who.role === 'admin') return true;
  const owners = (env('SETTINGS_OWNERS') || env('SLACK_ACCOUNT_EMAIL')).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return owners.includes(String(who.email || '').toLowerCase());
}
const j = async (url, opt = {}, ms = 12000) => {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { /* not json */ }
  return { ok: r.ok, status: r.status, d, t: t.slice(0, 300) };
};
const msg = (r, what) => (r.ok ? null : `${what} answered ${r.status}: ${redact((r.d && (r.d.error?.message || r.d.error || r.d.message)) || r.t).toString().slice(0, 200)}`);

// ---------- tests ----------
async function runTest(kind) {
  const t0 = Date.now(), done = (ok, detail) => ({ ok, detail, ms: Date.now() - t0 });
  if (kind === 'ai_ping' || kind === 'ai_ping_strong') {
    try { const r = await complete('Reply with the single word OK.', { max: 200, model: resolveModel({ tier: kind === 'ai_ping_strong' ? 'strong' : 'cheap' }), meta: { agent: 'settings-test' } }); return done(true, `${r.provider}${r.model ? ' / ' + r.model : ''} answered: ${redact(r.text).trim().slice(0, 80) || '(empty reply)'}${r.failed.length ? ` (after falling back from ${r.failed.join(', ')})` : ''}`); }
    catch (e) { return done(false, redact(e.message || String(e))); }
  }
  if (PROVIDERS.includes(kind)) {
    const P = providerConfig(kind);
    if (kind !== 'ollama' && !P.key) return done(false, 'No key set.');
    if (kind === 'ollama' && !P.base) return done(false, 'No base URL set.');
    if (kind === 'anthropic') { const r = await j(P.base + '/v1/models', { headers: { 'x-api-key': P.key, 'anthropic-version': '2023-06-01' } }); return done(r.ok, msg(r, 'Anthropic') || `Key works (${(r.d?.data || []).length} models visible).`); }
    if (kind === 'openrouter') { const r = await j(P.base + '/key', { headers: { authorization: 'Bearer ' + P.key } }); const d = r.d?.data || {}; return done(r.ok, msg(r, 'OpenRouter') || `Key works.${d.limit != null ? ` Limit $${d.limit}.` : ''}${d.usage != null ? ` Used $${Number(d.usage).toFixed(4)} on this key.` : ''}`); }
    const r = await j(P.base + '/models', { headers: { authorization: 'Bearer ' + P.key } });
    return done(r.ok, msg(r, P.name) || `Works (${(r.d?.data || r.d?.models || []).length} models visible).`);
  }
  if (kind === 'slack') {
    const tok = env('SLACK_BOT_TOKEN'); if (!tok) return done(false, 'No bot token set.');
    const r = await j('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: 'Bearer ' + tok } });
    if (!r.d?.ok) return done(false, 'Slack: ' + (r.d?.error || r.status));
    const { slackStatus } = await import('./slack.js');
    const scopes = ''; // auth.test does not list scopes
    return done(true, `Token works: bot ${r.d.user} in ${r.d.team}. Socket ${slackStatus().running ? 'running' : 'not running'}.${scopes}`);
  }
  if (kind === 'slack_dm') {
    const tok = env('SLACK_BOT_TOKEN'), owner = env('SLACK_OWNER_USER_ID'); if (!tok || !owner) return done(false, 'Bot token and owner ID are needed.');
    const o = await j('https://slack.com/api/conversations.open', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ users: owner }) });
    if (!o.d?.ok) return done(false, 'Slack: ' + (o.d?.error || o.status));
    const p = await j('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ channel: o.d.channel.id, text: 'Test from AIdentify Settings: the bot can reach you here.' }) });
    return done(!!p.d?.ok, p.d?.ok ? 'Test DM sent to the owner.' : 'Slack: ' + (p.d?.error || p.status));
  }
  if (kind === 'github') { const tok = env('GITHUB_TOKEN'); if (!tok) return done(false, 'No token set.'); const r = await j('https://api.github.com/user', { headers: { authorization: 'Bearer ' + tok, 'user-agent': 'AIdentify' } }); return done(r.ok, msg(r, 'GitHub') || `Works: signed in as ${r.d.login}.`); }
  if (kind === 'gumroad') { const tok = env('GUMROAD_ACCESS_TOKEN'); if (!tok) return done(false, 'No token set.'); const r = await j('https://api.gumroad.com/v2/user?access_token=' + encodeURIComponent(tok)); return done(!!r.d?.success, r.d?.success ? `Works: ${r.d.user?.name || r.d.user?.email || 'account'}.` : msg({ ...r, ok: false }, 'Gumroad')); }
  if (kind === 'buffer') { const tok = env('BUFFER_API_KEY'); if (!tok) return done(false, 'No key set.'); const { bufferChannels } = await import('./buffer.js'); try { const c = await bufferChannels(tok); return done(true, `Works: ${c.length} channel(s).`); } catch (e) { return done(false, redact(e.message)); } }
  if (kind === 'composio') { const tok = env('COMPOSIO_API_KEY'); if (!tok) return done(false, 'No key set.'); const r = await j((env('COMPOSIO_BASE_URL') || 'https://backend.composio.dev') + '/api/v3/auth_configs?limit=1', { headers: { 'x-api-key': tok } }); return done(r.ok, msg(r, 'Composio') || 'Key works.'); }
  if (kind === 'tavily') { const tok = env('TAVILY_API_KEY'); if (!tok) return done(false, 'No key set.'); const r = await j('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: tok, query: 'test', max_results: 1 }) }); return done(r.ok, msg(r, 'Tavily') || 'Key works.'); }
  if (kind === 'gmail') {
    if (!env('GMAIL_USER') || !env('GMAIL_APP_PASSWORD')) return done(false, 'Gmail address and app password are needed.');
    try { const nm = (await import('nodemailer')).default; const tr = nm.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: env('GMAIL_USER'), pass: env('GMAIL_APP_PASSWORD') } }); await tr.verify(); return done(true, 'Gmail sign-in works (SMTP).'); }
    catch (e) { return done(false, redact(e.message).slice(0, 200)); }
  }
  if (kind === 'browser_tools') {
    const have = (p) => p.some((x) => { try { fs.accessSync(x, fs.constants.X_OK); return true; } catch { return false; } });
    const t = { chrome: have(['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']), Xvfb: have(['/usr/bin/Xvfb']), x11vnc: have(['/usr/bin/x11vnc']), websockify: have(['/usr/bin/websockify', '/usr/local/bin/websockify']), noVNC: fs.existsSync('/usr/share/novnc/vnc.html'), ngrok: have(['/usr/local/bin/ngrok', '/usr/bin/ngrok', '/workspace/aaas-run/bin/ngrok']), cloudflared: have(['/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/workspace/aaas-run/bin/cloudflared']) };
    const miss = Object.entries(t).filter(([, v]) => !v).map(([k]) => k);
    return done(t.chrome && t.Xvfb && t.x11vnc && t.websockify && t.noVNC && (t.ngrok || t.cloudflared), (miss.length ? 'Missing: ' + miss.join(', ') + '. ' : 'All tools found. ') + (env('NGROK_AUTHTOKEN') ? 'ngrok token set.' : 'No ngrok token (cloudflared needs outbound port 7844).'));
  }
  return done(false, 'Unknown test ' + kind);
}

// ---------- model lists ----------
async function models(provider) {
  if (provider === 'openrouter' || provider === 'any') {
    const list = await orModels();
    return list.map((m) => ({ id: m.id, name: m.name, context: m.context, in_per_m: +(m.prompt * 1e6).toFixed(4), out_per_m: +(m.completion * 1e6).toFixed(4), tools: m.tools }));
  }
  const P = providerConfig(provider);
  if (provider === 'anthropic') { const r = await j(P.base + '/v1/models?limit=100', { headers: { 'x-api-key': P.key, 'anthropic-version': '2023-06-01' } }); if (!r.ok) throw new Error(msg(r, 'Anthropic')); return (r.d.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id })); }
  if (!P.base) throw new Error('No base URL set.');
  const r = await j(P.base + '/models', { headers: { authorization: 'Bearer ' + P.key } });
  if (!r.ok) throw new Error(msg(r, P.name));
  return (r.d.data || r.d.models || []).map((m) => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), name: m.display_name || m.id || m.name }));
}

// ---------- update check ----------
let relCache = { at: 0, d: null };
async function latestRelease(force) {
  if (!force && relCache.d && Date.now() - relCache.at < 3600e3) return relCache.d;
  const ch = env('UPDATE_CHANNEL', 'releases');
  const repo = 'aidendify/AaaS';
  if (ch === 'main') { const r = await j(`https://api.github.com/repos/${repo}/commits/main`, { headers: { 'user-agent': 'AIdentify' } }); relCache = { at: Date.now(), d: r.ok ? { channel: 'main', sha: r.d.sha.slice(0, 7), date: r.d.commit?.committer?.date, message: String(r.d.commit?.message || '').split('\n')[0] } : { error: msg(r, 'GitHub') } }; return relCache.d; }
  const r = await j(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'user-agent': 'AIdentify' } });
  relCache = { at: Date.now(), d: r.ok ? { channel: 'releases', tag: r.d.tag_name, version: String(r.d.tag_name || '').replace(/^v/, ''), date: r.d.published_at, url: r.d.html_url, notes: String(r.d.body || '').slice(0, 3000) } : { error: msg(r, 'GitHub') } };
  return relCache.d;
}
const newer = (a, b) => { const p = (v) => String(v || '0').split('.').map((x) => Number(x) || 0); const x = p(a), y = p(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

// ---------- routes ----------
export async function settingsRoutes({ method, pathname, query, b, st, who, HttpError, users, saveUsers, hashPassword }) {
  if (pathname === '/api/settings/me' && method === 'GET') return { admin: isSettingsAdmin(who), email: who.email };
  if (!pathname.startsWith('/api/settings')) return undefined;
  if (!isSettingsAdmin(who)) throw new HttpError(403, 'forbidden', 'Only the server owner or an admin can open Settings.');
  const route = method + ' ' + pathname;
  const data = async () => parse((await st.get('as_data:' + who.email))?.v, {}) || {};
  switch (route) {
    case 'GET /api/settings': {
      const envOnly = Object.fromEntries(ENV_ONLY.map((k) => [k, k === 'PORT' || k === 'HOST' || k === 'ADMIN_EMAIL' ? env(k) || '(default)' : env(k) ? 'set' : 'not set']));
      return { version: VERSION, schema: SCHEMA, values: publicView(), envOnly, providersOn: providerOrder(), defaultAdminPassword: (env('ADMIN_PASSWORD') || 'admin1234') === 'admin1234' && !(users[env('ADMIN_EMAIL') || 'admin@agentsphere.com'] || {}).pwChanged, sessionSecret: env('SESSION_SECRET') ? 'set' : 'missing' };
    }
    case 'POST /api/settings': {
      try { const r = await saveSettings(b.patch || {}, who.email); return { ...r, values: publicView() }; }
      catch (e) { throw new HttpError(400, 'invalid', e.message); }
    }
    case 'POST /api/settings/test': { const r = await runTest(String(b.kind || '')); await audit(who.email, 'test', [String(b.kind || '')]); return r; }
    case 'GET /api/settings/models': { try { return { models: await models(String(query.get('provider') || 'openrouter')) }; } catch (e) { throw new HttpError(400, 'models', redact(e.message)); } }
    case 'GET /api/settings/usage': return usageSummary(st, query.get('month') || undefined);
    case 'GET /api/settings/audit': return { log: await auditLog() };
    case 'GET /api/settings/logs': return { lines: logLines(Number(query.get('n')) || 400).map((l) => ({ ...l, text: redact(l.text) })) };
    case 'GET /api/settings/status': {
      const { slackStatus } = await import('./slack.js'); const { remoteBrowserStatus } = await import('./remote-browser.js');
      return { version: VERSION, uptimeSec: Math.round((Date.now() - started) / 1000), node: process.version, db: st.kind, providers: providerOrder(), slack: slackStatus(), remoteBrowser: remoteBrowserStatus(), sources: Object.fromEntries(SCHEMA.map((f) => [f.k, sourceOf(f.k)])) };
    }
    case 'GET /api/settings/diagnostics': {
      const { slackStatus } = await import('./slack.js');
      return { generated: new Date().toISOString(), version: VERSION, node: process.version, platform: process.platform, db: st.kind, providers: providerOrder(), slack: slackStatus(), settings: publicView(), log: logLines(500).map((l) => redact(new Date(l.at).toISOString() + ' ' + l.level + ' ' + l.text)) };
    }
    case 'GET /api/settings/update': {
      const rel = await latestRelease(query.get('force') === '1');
      return { version: VERSION, latest: rel, updateAvailable: !!(rel && rel.version && newer(rel.version, VERSION)), command: 'npm run update' };
    }
    case 'POST /api/settings/remote-browser': {
      const rb = await import('./remote-browser.js');
      if (b.action === 'close') return rb.closeRemoteBrowser();
      if (b.action === 'open') { const r = await rb.openRemoteBrowser(); const sent = await rb.sendRemoteLinkPrivately(rb.remoteBrowserMessage(r)); await audit(who.email, 'remote-browser-open'); return { ...rb.remoteBrowserStatus(), link: r.link, sentToSlack: sent }; }
      return rb.remoteBrowserStatus();
    }
    case 'GET /api/settings/agents': { const d = await data(); return { agents: (d.agents || []).filter(Boolean).map((a) => ({ id: a.id, name: a.name, kind: a.kind, model: a.model || '', tier: a.tier || '', tools: a.tools || [], group: a.group || '' })) }; }
    case 'POST /api/settings/agents': {
      const { withDataLock } = await import('./backend.js');
      return withDataLock(who.email, async () => {
        const d = await data(); const a = (d.agents || []).find((x) => x && x.id === Number(b.id)); if (!a) throw new HttpError(404, 'not_found', 'No such agent.');
        if (b.model != null) { const m = String(b.model).trim().slice(0, 120); if (/\s/.test(m)) throw new HttpError(400, 'invalid', 'Model id has spaces.'); a.model = m; }
        if (b.tier != null) { if (!['', 'cheap', 'strong'].includes(b.tier)) throw new HttpError(400, 'invalid', 'Tier is cheap or strong.'); a.tier = b.tier; }
        if (Array.isArray(b.tools)) a.tools = b.tools.filter((t) => ['sandbox', 'publish', 'ops'].includes(t));
        await st.put('as_data:' + who.email, JSON.stringify(d), Date.now()); await audit(who.email, 'agent', [String(a.id)]);
        return { ok: true, agent: { id: a.id, model: a.model || '', tier: a.tier || '', tools: a.tools || [] } };
      });
    }
    case 'GET /api/settings/routines': { const rs = parse((await st.get('as_rt:' + who.email))?.v, []) || []; return { routines: rs.filter((r) => r.on).map((r) => ({ id: r.id, title: r.title, aid: r.aid, paused: !!r.paused, next: r.next || null, every: r.every || r.repeat || null })) }; }
    case 'POST /api/settings/routines': {
      const G = await import('./groups.js'); const rs = (parse((await st.get('as_rt:' + who.email))?.v, []) || []).filter((r) => r.on);
      const ids = b.all ? rs.map((r) => r.id) : [String(b.id)]; const out = [];
      for (const id of ids) { try { const r = await G.setRoutinePaused(st, who.email, id, !!b.paused); out.push({ id, paused: r.paused }); } catch (e) { out.push({ id, error: e.message }); } }
      await audit(who.email, b.paused ? 'pause-routines' : 'resume-routines', ids); return { changed: out };
    }
    case 'GET /api/settings/memory': { const m = parse((await st.get('as_mem:' + who.email))?.v, {}) || {}; const d = await data(); const name = (id) => ((d.agents || []).find((a) => a && String(a.id) === String(id)) || {}).name || 'Agent ' + id; return { memory: Object.entries(m).map(([aid, list]) => ({ aid, name: name(aid), items: (list || []).slice(-200) })), knowledge: (d.agents || []).filter(Boolean).map((a) => ({ id: a.id, name: a.name, docs: (a.kb || a.docs || []).length || 0 })) }; }
    case 'POST /api/settings/memory/delete': {
      const k = 'as_mem:' + who.email, m = parse((await st.get(k))?.v, {}) || {};
      const list = m[String(b.aid)] || []; m[String(b.aid)] = b.all ? [] : list.filter((x) => x.id !== b.id);
      await st.put(k, JSON.stringify(m), Date.now()); await audit(who.email, 'memory-delete', [String(b.aid)]); return { ok: true, left: m[String(b.aid)].length };
    }
    case 'GET /api/settings/backup': {
      const items = (await st.all()).filter((it) => it && it.k && !/^as_(sess|rl|throttle)/.test(it.k));
      await audit(who.email, 'backup-download');
      return { __bytes: Buffer.from(JSON.stringify({ app: 'AIdentify', version: VERSION, exported: new Date().toISOString(), note: 'Secrets saved in Settings and connector credentials stay encrypted with this server\'s SESSION_SECRET.', items }, null, 1)), __type: 'application/json' };
    }
    case 'POST /api/settings/restore': {
      const items = Array.isArray(b.items) ? b.items : (b.backup && b.backup.items) || [];
      if (!items.length || !items.every((it) => it && typeof it.k === 'string' && it.k.startsWith('as_'))) throw new HttpError(400, 'invalid', 'This is not an AIdentify backup file.');
      const cur = Object.fromEntries((await st.all()).map((it) => [it.k, it]));
      const diff = { add: items.filter((it) => !cur[it.k]).length, change: items.filter((it) => cur[it.k] && cur[it.k].v !== it.v).length, same: items.filter((it) => cur[it.k] && cur[it.k].v === it.v).length, total: items.length };
      if (b.dryRun !== false) return { dryRun: true, diff };
      // safety copy of the current data first
      const dir = path.join(ROOT, 'data', 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'before-restore-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
      fs.writeFileSync(file, JSON.stringify({ items: Object.values(cur) }), { mode: 0o600 });
      for (const it of items) await st.put(it.k, it.v, it.at || Date.now());
      await audit(who.email, 'restore', [String(items.length) + ' keys']);
      return { dryRun: false, diff, safetyCopy: path.relative(ROOT, file), note: 'Restart the server so every module reloads the restored data.' };
    }
    case 'POST /api/settings/password': {
      const which = b.account === 'team' ? (env('TEAM_EMAIL') || 'team@agentsphere.com') : (env('ADMIN_EMAIL') || 'admin@agentsphere.com');
      const pw = String(b.next || ''); if (pw.length < 12) throw new HttpError(400, 'weak_password', 'Use at least 12 characters.');
      if (['admin1234', 'team1234'].includes(pw)) throw new HttpError(400, 'weak_password', 'Choose a password that is not the default.');
      const u = users[which]; if (!u) throw new HttpError(404, 'not_found', 'That staff account does not exist yet.');
      u.hash = hashPassword(pw); u.sv = (u.sv || 1) + 1; u.pwChanged = Date.now(); await saveUsers(st, users);
      await audit(who.email, 'staff-password', [b.account === 'team' ? 'team' : 'admin']); return { ok: true, account: which };
    }
    case 'POST /api/settings/signout-all': {
      let n = 0; for (const [em, u] of Object.entries(users)) { if (b.exceptMe && em === who.email) continue; u.sv = (u.sv || 1) + 1; n++; }
      await saveUsers(st, users); await audit(who.email, 'signout-all', [String(n)]); return { ok: true, accounts: n };
    }
    default: throw new HttpError(404, 'not_found');
  }
}
