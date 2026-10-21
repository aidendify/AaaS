// Agency white-label (v2.4, pillar 6) on the current per-account store.
// An agency owns client workspaces. Each client is still a normal account (as_*:<client email>),
// so one client cannot read another, and one agency cannot read another agency's clients.
// Billing is not wired: the invoice helper is a usage summary for a manual invoice.
// Mail to a client's contacts still leaves only from that client's own connected Gmail (ownOnly / no allowPlatform).
import crypto from 'node:crypto';
import { loadInstall } from './playbooks.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const AG = 'as_ag:', USE = 'as_aguse:', AUDIT = 'as_agaudit:', DOM = 'as_agdom:';
const ROLES = ['owner', 'admin', 'member'];
const WRITE = new Set(['owner', 'admin']);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const emptyUse = () => ({ ai_calls: 0, ai_cost_usd: 0, messages: 0, leads: 0 });
const emptyLimits = () => ({ ai_calls: null, ai_cost_usd: null, messages: null, leads: null });

function monthOf(t = Date.now()) {
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(t).slice(0, 7);
}
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function fail(status, code, message) { const e = new Error(message); e.status = status; e.code = code; throw e; }
function limitMessage(kind) {
  const what = kind === 'messages' ? 'message' : kind === 'leads' ? 'lead' : 'AI';
  return `This workspace has used its ${what} allowance for the month. Nothing was sent.`;
}

export function platformBrand() {
  const env = (k, d = '') => String(process.env[k] ?? d).trim();
  return { name: env('BRAND_NAME') || 'AaaS', color: env('BRAND_COLOR') || '', accent: '', logo: env('BRAND_LOGO_URL') || '', support_email: '', domain: '', source: 'platform' };
}

export function safeColor(c) { return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c || '')) ? String(c).toLowerCase() : ''; }

export function hostOf(v, { required = false } = {}) {
  let s = String(v || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (!s) { if (required) fail(400, 'bad_domain', 'Enter a hostname like app.youragency.com.'); return ''; }
  if (s.length > 253 || !/^[a-z0-9.-]+$/.test(s) || s.includes('..') || !s.includes('.') || s.startsWith('-') || s.endsWith('-')) fail(400, 'bad_domain', 'Enter a hostname like app.youragency.com, with no path.');
  return s;
}

// Branding input: a bare hostname only. A path, port, query or markup is refused, not silently trimmed.
function domainOf(v) {
  const raw = String(v || '').trim();
  if (raw && !/^(https?:\/\/)?[a-zA-Z0-9.-]+\/?$/.test(raw)) fail(400, 'bad_domain', 'Enter a hostname like app.youragency.com, with no path.');
  return hostOf(raw);
}
function colorOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!safeColor(s)) fail(400, 'bad_brand', 'Colour must look like #1f6b4a.');
  return safeColor(s);
}
function logoOf(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https:\/\/[^\s]{8,300}$/.test(s)) return s;
  if (/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(s) && s.length <= 60000) return s.replace(/\s/g, '');
  fail(400, 'bad_brand', 'Logo must be an https link, or a small PNG, JPEG, GIF or WebP.');
}
function emailOf(v, okEmail, { required = false } = {}) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) { if (required) fail(400, 'bad_email', 'Enter an email address.'); return ''; }
  if (!okEmail(s)) fail(400, 'bad_email', 'Enter a valid email address.');
  return s;
}

function roleOf(user) {
  if (!user) return '';
  if (user.kind === 'agency' && user.agencyRole === 'owner') return 'owner';
  if (user.kind === 'staff' && ROLES.includes(user.agencyRole)) return user.agencyRole;
  return '';
}
function agencyIdOf(user, email) {
  const role = roleOf(user);
  if (!role) return '';
  return String(user.agency || (role === 'owner' ? email : '') || '').toLowerCase();
}

async function readAg(st, id) { return parse((await st.get(AG + id))?.v, null); }
async function writeAg(st, id, row) { await st.put(AG + id, JSON.stringify(row), Date.now()); }

async function audit(st, id, row) {
  const line = { id: 'au' + uid(), at: Date.now(), ...row };
  const key = AUDIT + id;
  const apply = (cur) => { const all = parse(cur, []) || []; all.unshift(line); return JSON.stringify(all.slice(0, 200)); };
  if (st.update) await st.update(key, apply);
  else await st.put(key, apply((await st.get(key))?.v), Date.now());
  return line;
}

function publicBrand(row) {
  const b = (row && row.branding) || {};
  return {
    name: b.name || row.name || 'Workspace',
    logo: b.logo || '',
    color: b.color || '',
    accent: b.accent || '',
    support_email: b.support_email || '',
    domain: b.domain || '',
    source: 'agency',
  };
}

export async function brandForHost(st, host) {
  const h = hostOf(host);
  if (!h) return null;
  const id = parse((await st.get(DOM + h))?.v, null);
  if (!id || typeof id !== 'string') return null;
  const row = await readAg(st, id);
  if (!row || !row.branding || row.branding.domain !== h) return null;
  return publicBrand(row);
}

export async function brandForAccount(st, email) {
  const users = parse((await st.get('as_users'))?.v, {}) || {};
  const u = users[String(email || '').toLowerCase()];
  if (!u) return null;
  const id = u.kind === 'client' || u.kind === 'staff' || u.kind === 'agency' ? (u.agency || (u.kind === 'agency' ? email : '')) : '';
  if (!id) return null;
  const row = await readAg(st, id);
  return row ? publicBrand(row) : null;
}

// Sign-in and password-reset copy only. Those still use the server mailbox (sendSystemEmail).
// They are not mail to a client's contacts. That mail uses the account's own Gmail.
export async function emailCopy(st, email, kind, extra = {}) {
  const brand = await brandForAccount(st, email);
  const name = (brand && brand.name) || 'AaaS';
  const support = (brand && brand.support_email) || '';
  const foot = support ? `\n\nIf you need help, write to ${support}.` : '';
  if (kind === 'reset') {
    return {
      fromName: name,
      subject: `Reset your ${name} password`,
      body: `Someone (hopefully you) asked to reset the password for ${email} on ${name}.\n\nSet a new password here (works once, expires in 30 minutes):\n${extra.link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.${foot}`,
    };
  }
  return {
    fromName: name,
    subject: `Your ${name} sign-in code: ${extra.code}`,
    body: `Your ${name} sign-in code is ${extra.code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.${foot}`,
  };
}

export function dnsGuide(domain, appHost) {
  const target = appHost || 'the host this app is served from';
  return {
    domain: domain || '',
    records: domain ? [{ type: 'CNAME', host: domain, value: target, purpose: 'Login page on your hostname' }] : [],
    steps: [
      'Pick a hostname you control, such as app.youragency.com.',
      'Create a CNAME record from that hostname to ' + target + '. On a self-hosted server, point the name at the machine that already serves this app and terminates TLS.',
      'Save the same hostname under Agency branding. Saving it does not buy the name or change DNS for you.',
      'Open the login page on that hostname. The name, logo, colours and support email are your agency’s.',
      'This build does not call a domain API and does not issue a certificate. TLS stays with your host or reverse proxy.',
    ],
    mail: 'Sign-in and password-reset emails use your agency name. Mail to a client’s contacts is sent only from the Gmail that client has connected. The platform mailbox is not used for that.',
    payment: 'Nothing here takes a payment.',
  };
}

function appHostOf(headers) {
  const set = String(process.env.APP_URL || '').trim();
  if (set) { try { return new URL(set).host; } catch { /* fall through */ } }
  const host = String((headers && (headers['x-forwarded-host'] || headers.host)) || '').split(',')[0].trim();
  return host || 'your AaaS host';
}

async function monthBucket(st, email, month) {
  const all = parse((await st.get(USE + email))?.v, null) || { months: {} };
  return { ...(all.months[month] || emptyUse()) };
}

async function limitsFor(st, email) {
  const users = parse((await st.get('as_users'))?.v, {}) || {};
  const u = users[email];
  if (!u || u.kind !== 'client') return null;
  return { ...emptyLimits(), ...(u.limits || {}) };
}

export async function roomFor(st, email, kind, add = 1) {
  const lim = await limitsFor(st, email);
  if (!lim || lim[kind] == null) return true;
  const u = await monthBucket(st, email, monthOf());
  return (Number(u[kind]) || 0) + add <= Number(lim[kind]);
}

export async function assertRoom(st, email, kind, add = 1) {
  if (await roomFor(st, email, kind, add)) return;
  fail(402, 'client_limit', limitMessage(kind));
}

export async function assertAiRoom(st, email) {
  const lim = await limitsFor(st, email);
  if (!lim) return;
  const u = await monthBucket(st, email, monthOf());
  if (lim.ai_calls != null && (Number(u.ai_calls) || 0) + 1 > Number(lim.ai_calls)) {
    const { LlmError } = await import('./llm.js');
    throw new LlmError(limitMessage('ai_calls'), 429, 'client_limit');
  }
  if (lim.ai_cost_usd != null && (Number(u.ai_cost_usd) || 0) >= Number(lim.ai_cost_usd)) {
    const { LlmError } = await import('./llm.js');
    throw new LlmError('This workspace has used its AI cost allowance for the month. Nothing was sent.', 429, 'client_limit');
  }
}

export async function noteUsage(st, email, delta) {
  if (!email || !delta) return;
  const users = parse((await st.get('as_users'))?.v, {}) || {};
  if (!users[email] || users[email].kind !== 'client') return;
  const month = monthOf();
  const key = USE + email;
  const apply = (cur) => {
    const all = parse(cur, null) || { months: {} };
    const m = { ...emptyUse(), ...(all.months[month] || {}) };
    if (delta.ai_calls) m.ai_calls += delta.ai_calls;
    if (delta.ai_cost_usd) m.ai_cost_usd = round4(m.ai_cost_usd + delta.ai_cost_usd);
    if (delta.messages) m.messages += delta.messages;
    if (delta.leads) m.leads += delta.leads;
    all.months[month] = m;
    const keys = Object.keys(all.months).sort();
    for (const k of keys.slice(0, -18)) delete all.months[k];
    return JSON.stringify(all);
  };
  if (st.update) await st.update(key, apply);
  else await st.put(key, apply((await st.get(key))?.v), Date.now());
}

export async function forgetAgency(st, email) {
  const raw = parse((await st.get(AG + email))?.v, null);
  const domain = raw && raw.branding && raw.branding.domain;
  const keys = [USE + email, AG + email, AUDIT + email];
  if (domain) {
    const ix = parse((await st.get(DOM + domain))?.v, null);
    if (ix === email) keys.push(DOM + domain);
  }
  if (st.delMany) await st.delMany(keys);
  else for (const k of keys) await st.put(k, null, Date.now());
}

export function removalBlock(users, email) {
  const u = users[email];
  if (!u || roleOf(u) !== 'owner') return '';
  const id = agencyIdOf(u, email);
  const left = Object.entries(users).filter(([e, x]) => e !== email && x && x.agency === id && (x.kind === 'client' || x.kind === 'staff'));
  if (!left.length) return '';
  const clients = left.filter(([, x]) => x.kind === 'client').length;
  const staff = left.length - clients;
  return 'Remove this agency’s client workspaces' + (staff ? ' and staff logins' : '') + ' before deleting the agency account. Nothing was deleted.';
}

export function assertViewAsSession(users, who) {
  if (!who || !who.imp) return;
  const actor = users[who.act];
  const client = users[who.email];
  if (!actor || !client || actor.agency !== who.ag || !WRITE.has(roleOf(actor)) || client.kind !== 'client' || client.agency !== who.ag) fail(401, 'signed_out', 'View-as has ended. Sign in again.');
  if (client.suspended) fail(403, 'suspended', 'This account is suspended.');
}

function requireAgency(users, email) {
  const u = users[email];
  const role = roleOf(u);
  const id = agencyIdOf(u, email);
  if (!role || !id) fail(403, 'not_agency', 'This login is not an agency staff account.');
  return { user: u, role, id };
}
function requireWrite(ctx) { if (!WRITE.has(ctx.role)) fail(403, 'forbidden', 'Your agency role can view clients. It cannot change them.'); }
function requireOwner(ctx) { if (ctx.role !== 'owner') fail(403, 'forbidden', 'Only the agency owner can change that.'); }

function clientsOf(users, id) {
  return Object.entries(users).filter(([, u]) => u && u.kind === 'client' && u.agency === id).map(([email, u]) => ({ email, u }));
}
function staffOf(users, id) {
  return Object.entries(users).filter(([, u]) => u && (u.kind === 'staff' || u.kind === 'agency') && (u.agency === id || (u.kind === 'agency' && agencyIdOf(u, '') === id))).map(([email, u]) => ({ email, name: u.name || '', role: roleOf(u) || 'member' }));
}

async function usageView(st, email, limits) {
  const month = monthOf();
  const u = await monthBucket(st, email, month);
  return { month, ai_calls: u.ai_calls || 0, ai_cost_usd: round4(u.ai_cost_usd), messages: u.messages || 0, leads: u.leads || 0, limits: limits || emptyLimits() };
}

function clientCard(email, u, usage) {
  return {
    email, name: u.name || '', suspended: !!u.suspended, joined: u.joined || null,
    limits: { ...emptyLimits(), ...(u.limits || {}) },
    usage,
  };
}

function cleanLimits(b, cur) {
  const out = { ...emptyLimits(), ...(cur || {}) };
  if (!b || typeof b !== 'object') return out;
  for (const k of ['ai_calls', 'ai_cost_usd', 'messages', 'leads']) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    if (b[k] == null || b[k] === '') { out[k] = null; continue; }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) fail(400, 'bad_limit', 'A limit must be a number, or empty for no cap.');
    out[k] = k === 'ai_cost_usd' ? round4(n) : Math.floor(n);
  }
  return out;
}

async function ownClient(st, users, id, email) {
  const e = String(email || '').trim().toLowerCase();
  const u = users[e];
  if (!u || u.kind !== 'client' || u.agency !== id) fail(404, 'not_found', 'No client workspace with that email on this agency.');
  return { email: e, u };
}

async function setDomain(st, id, prev, next) {
  if (prev && prev !== next) {
    const ix = parse((await st.get(DOM + prev))?.v, null);
    if (ix === id) await st.put(DOM + prev, null, Date.now());
  }
  if (!next) return;
  const ix = parse((await st.get(DOM + next))?.v, null);
  if (ix && ix !== id) fail(409, 'domain_taken', 'That hostname is already used by another agency.');
  await st.put(DOM + next, JSON.stringify(id), Date.now());
}

function lineFor(card, markup) {
  const pct = Number(markup.percent) || 0;
  const ai = card.usage.ai_cost_usd || 0;
  const messages = card.usage.messages || 0;
  const leads = card.usage.leads || 0;
  return {
    email: card.email,
    name: card.name,
    ai_calls: card.usage.ai_calls || 0,
    ai_cost_usd: round4(ai),
    ai_billed_usd: round4(ai * (1 + pct / 100)),
    messages,
    message_rate_inr: markup.message_inr,
    message_billed_inr: round4(messages * markup.message_inr),
    leads,
    lead_rate_inr: markup.lead_inr,
    lead_billed_inr: round4(leads * markup.lead_inr),
  };
}

async function invoiceRows(st, users, id, month) {
  const row = await readAg(st, id);
  const markup = { percent: 0, message_inr: 0, lead_inr: 0, currency: 'INR', ...((row && row.markup) || {}) };
  const lines = [];
  for (const { email, u } of clientsOf(users, id)) {
    const usage = await monthBucket(st, email, month);
    lines.push(lineFor({ email, name: u.name || '', usage }, markup));
  }
  lines.sort((a, b) => a.email.localeCompare(b.email));
  return { row, markup, lines, month };
}

function invoiceHtml(pack) {
  const b = publicBrand(pack.row || { name: 'Agency', branding: {} });
  const color = safeColor(b.color) || '#111111';
  const rows = pack.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.email)}</td><td>${l.ai_calls}</td><td>${l.ai_cost_usd}</td><td>${l.ai_billed_usd}</td><td>${l.messages}</td><td>${l.message_billed_inr}</td><td>${l.leads}</td><td>${l.lead_billed_inr}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(b.name)} usage ${esc(pack.month)}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;color:#111;margin:32px} h1{font-size:22px;margin:0 0 4px} table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:13px} th{background:${esc(color)};color:#fff}
.note{margin-top:18px;color:#333} @media print{body{margin:12px}}
</style></head><body>
<h1>${esc(b.name)}</h1>
<p>Usage summary for ${esc(pack.month)}. Markup ${esc(String(pack.markup.percent))}% on AI cost. Messages at ₹${esc(String(pack.markup.message_inr))} each. Leads at ₹${esc(String(pack.markup.lead_inr))} each.</p>
${b.support_email ? `<p>Support: ${esc(b.support_email)}</p>` : ''}
<table><thead><tr><th>Client</th><th>Email</th><th>AI calls</th><th>AI cost USD</th><th>AI billed USD</th><th>Messages</th><th>Messages billed INR</th><th>Leads</th><th>Leads billed INR</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9">No client workspaces this month.</td></tr>'}</tbody></table>
<p class="note">This is a usage summary so you can raise your own invoice. This app does not take payment, and it is not a tax invoice.</p>
</body></html>`;
}

function invoiceCsv(pack) {
  const head = ['month', 'client_name', 'client_email', 'ai_calls', 'ai_cost_usd', 'markup_percent', 'ai_billed_usd', 'messages', 'message_rate_inr', 'message_billed_inr', 'leads', 'lead_rate_inr', 'lead_billed_inr', 'currency', 'note'];
  const note = 'Manual usage summary. No payment is taken.';
  const lines = [head.join(',')];
  for (const l of pack.lines) lines.push([pack.month, l.name, l.email, l.ai_calls, l.ai_cost_usd, pack.markup.percent, l.ai_billed_usd, l.messages, l.message_rate_inr, l.message_billed_inr, l.leads, l.lead_rate_inr, l.lead_billed_inr, pack.markup.currency, note].map(csvCell).join(','));
  if (!pack.lines.length) lines.push([pack.month, '', '', 0, 0, pack.markup.percent, 0, 0, pack.markup.message_inr, 0, 0, pack.markup.lead_inr, 0, pack.markup.currency, note].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

export async function agencyRoutes({ method, pathname, query, b, st, email, users, saveUsers, headers, HttpError, signToken, hashPassword, weakPassword, okEmail, removeAccount, presentUser }) {
  if (pathname !== '/api/agency' && !pathname.startsWith('/api/agency/')) return undefined;
  const boom = (e) => { throw new HttpError(e.status || 400, e.code || 'bad_agency', e.message || 'Check that and try again.'); };
  try {
    if (pathname === '/api/agency' && method === 'POST') {
      const me = users[email];
      if (!me || (me.role && me.role !== 'customer')) fail(403, 'forbidden', 'Agency accounts are customer logins.');
      if (me.kind === 'client') fail(403, 'forbidden', 'A client workspace cannot become an agency.');
      if (me.kind === 'staff') fail(403, 'forbidden', 'Staff use the agency they already belong to.');
      if (roleOf(me) === 'owner') {
        const row = await readAg(st, email);
        return { agency: { id: email, name: row.name, role: 'owner' }, created: false };
      }
      const name = clip(b.name || me.name || 'Agency', 80);
      if (!name) fail(400, 'bad_name', 'Enter the agency name.');
      me.kind = 'agency'; me.agencyRole = 'owner'; me.agency = email;
      await saveUsers(st, users);
      const row = { id: email, name, created: Date.now(), branding: { name, logo: '', color: '', accent: '', support_email: '', domain: '' }, markup: { percent: 0, message_inr: 0, lead_inr: 0, currency: 'INR' } };
      await writeAg(st, email, row);
      await audit(st, email, { action: 'agency_created', actor: email, name });
      return { agency: { id: email, name, role: 'owner' }, created: true, mailed: false, payment: false };
    }

    const ctx = requireAgency(users, email);
    const row = await readAg(st, ctx.id);
    if (!row) fail(404, 'not_found', 'This agency record is missing.');

    if (pathname === '/api/agency' && method === 'GET') {
      const clients = [];
      for (const c of clientsOf(users, ctx.id)) clients.push(clientCard(c.email, c.u, await usageView(st, c.email, { ...emptyLimits(), ...(c.u.limits || {}) })));
      clients.sort((a, c) => a.email.localeCompare(c.email));
      return {
        role: ctx.role,
        agency: { name: row.name, branding: publicBrand(row), ...(ctx.role === 'member' ? {} : { markup: row.markup }), created: row.created },
        staff: staffOf(users, ctx.id).sort((a, c) => a.email.localeCompare(c.email)),
        clients,
        playbooks: ['pb_agency', 'pb_digital', 'pb_email'],
        payment: false,
        mail: 'Client contact mail sends only from that client’s connected Gmail. This screen does not send it.',
      };
    }
    if (pathname === '/api/agency/dns' && method === 'GET') return dnsGuide(row.branding.domain || '', appHostOf(headers));

    if (pathname === '/api/agency/branding' && method === 'POST') {
      requireOwner(ctx);
      const prev = row.branding.domain || '';
      const branding = {
        name: clip(b.name != null ? b.name : row.branding.name, 80) || row.name,
        logo: b.logo != null ? logoOf(b.logo) : (row.branding.logo || ''),
        color: b.color != null ? colorOf(b.color) : (row.branding.color || ''),
        accent: b.accent != null ? colorOf(b.accent) : (row.branding.accent || ''),
        support_email: b.support_email != null ? emailOf(b.support_email, okEmail) : (row.branding.support_email || ''),
        domain: b.domain != null ? domainOf(b.domain) : prev,
      };
      await setDomain(st, ctx.id, prev, branding.domain);
      row.branding = branding;
      if (b.name) row.name = branding.name;
      await writeAg(st, ctx.id, row);
      await audit(st, ctx.id, { action: 'branding_saved', actor: email, domain: branding.domain || '' });
      return { branding: publicBrand(row), dns: dnsGuide(branding.domain, appHostOf(headers)) };
    }

    if (pathname === '/api/agency/markup' && method === 'POST') {
      requireOwner(ctx);
      const pct = b.percent != null ? Number(b.percent) : Number(row.markup.percent) || 0;
      const msg = b.message_inr != null ? Number(b.message_inr) : Number(row.markup.message_inr) || 0;
      const lead = b.lead_inr != null ? Number(b.lead_inr) : Number(row.markup.lead_inr) || 0;
      if (![pct, msg, lead].every((n) => Number.isFinite(n) && n >= 0 && n <= 100000)) fail(400, 'bad_markup', 'Markup must be a number from 0 up.');
      if (pct > 500) fail(400, 'bad_markup', 'AI markup percent can be at most 500.');
      row.markup = { percent: round4(pct), message_inr: round4(msg), lead_inr: round4(lead), currency: 'INR' };
      await writeAg(st, ctx.id, row);
      await audit(st, ctx.id, { action: 'markup_saved', actor: email, percent: row.markup.percent });
      return { markup: row.markup, payment: false };
    }

    if (pathname === '/api/agency/staff' && method === 'POST') {
      const role = String(b.role || 'member');
      if (role !== 'admin' && role !== 'member') fail(400, 'bad_role', 'A staff role is admin or member.');
      if (role === 'admin') requireOwner(ctx); else requireWrite(ctx);
      const em = emailOf(b.email, okEmail, { required: true });
      const name = clip(b.name, 120);
      const pw = String(b.password || '');
      if (!name) fail(400, 'bad_name', 'Enter the person’s name.');
      const weak = weakPassword(pw, 8); if (weak) fail(400, 'weak_password', weak);
      if (users[em]) fail(409, 'exists', 'That email already has a login.');
      users[em] = { name, role: 'customer', kind: 'staff', agency: ctx.id, agencyRole: role, hash: hashPassword(pw), joined: Date.now(), sv: 1 };
      await saveUsers(st, users);
      await audit(st, ctx.id, { action: 'staff_added', actor: email, staff: em, staff_role: role });
      return { staff: { email: em, name, role }, mailed: false };
    }
    if (pathname === '/api/agency/staff/role' && method === 'POST') {
      requireOwner(ctx);
      const em = emailOf(b.email, okEmail, { required: true });
      const role = String(b.role || '');
      if (role !== 'admin' && role !== 'member') fail(400, 'bad_role', 'Set admin or member.');
      const u = users[em];
      if (!u || u.kind !== 'staff' || u.agency !== ctx.id) fail(404, 'not_found', 'That person is not on this agency’s staff.');
      u.agencyRole = role;
      await saveUsers(st, users);
      await audit(st, ctx.id, { action: 'staff_role', actor: email, staff: em, staff_role: role });
      return { staff: { email: em, role } };
    }
    if (pathname === '/api/agency/staff/remove' && method === 'POST') {
      const em = emailOf(b.email, okEmail, { required: true });
      const u = users[em];
      if (!u || u.agency !== ctx.id || roleOf(u) === 'owner' || u.kind !== 'staff') fail(404, 'not_found', 'That person is not a removable staff login on this agency.');
      if (u.agencyRole === 'admin') requireOwner(ctx); else requireWrite(ctx);
      delete users[em];
      await saveUsers(st, users);
      await removeAccount(st, em);
      await audit(st, ctx.id, { action: 'staff_removed', actor: email, staff: em });
      return { ok: true };
    }

    if (pathname === '/api/agency/clients' && method === 'POST') {
      requireWrite(ctx);
      const em = emailOf(b.email, okEmail, { required: true });
      const name = clip(b.name, 120);
      const pw = String(b.password || '');
      if (!name) fail(400, 'bad_name', 'Enter the client’s name.');
      const weak = weakPassword(pw, 8); if (weak) fail(400, 'weak_password', weak);
      if (users[em]) fail(409, 'exists', 'That email already has a login.');
      const about = clip((b.business && b.business.about) || b.about || '', 300);
      users[em] = {
        name, role: 'customer', kind: 'client', agency: ctx.id, hash: hashPassword(pw), joined: Date.now(), sv: 1, suspended: false,
        limits: emptyLimits(), ...(about ? { profile: { about, name: clip(b.business_name || name, 120) } } : {}),
      };
      await saveUsers(st, users);
      await audit(st, ctx.id, { action: 'client_created', actor: email, client: em });
      return { client: { email: em, name, suspended: false, limits: emptyLimits() }, mailed: false, payment: false, mail: 'No email was sent. When this client connects Gmail, their own mail uses that mailbox only.' };
    }
    if (pathname === '/api/agency/clients/update' && method === 'POST') {
      requireWrite(ctx);
      const { email: em, u } = await ownClient(st, users, ctx.id, b.email);
      if (b.suspended != null) u.suspended = !!b.suspended;
      if (b.name) u.name = clip(b.name, 120);
      if (b.limits) u.limits = cleanLimits(b.limits, u.limits);
      await saveUsers(st, users);
      await audit(st, ctx.id, { action: 'client_updated', actor: email, client: em, suspended: !!u.suspended });
      return { client: clientCard(em, u, await usageView(st, em, u.limits)) };
    }
    if (pathname === '/api/agency/clients/remove' && method === 'POST') {
      requireWrite(ctx);
      const { email: em } = await ownClient(st, users, ctx.id, b.email);
      delete users[em];
      await saveUsers(st, users);
      await removeAccount(st, em);
      await audit(st, ctx.id, { action: 'client_removed', actor: email, client: em });
      return { ok: true };
    }
    if (pathname === '/api/agency/clients/usage' && method === 'GET') {
      const { email: em, u } = await ownClient(st, users, ctx.id, query.get('email'));
      const usage = await usageView(st, em, { ...emptyLimits(), ...(u.limits || {}) });
      return { client: { email: em, name: u.name || '', suspended: !!u.suspended }, usage };
    }

    if (pathname === '/api/agency/playbook' && method === 'POST') {
      requireWrite(ctx);
      const { email: em } = await ownClient(st, users, ctx.id, b.email);
      let loaded;
      try { loaded = await loadInstall(st, ctx.id, em, { id: b.id, bundle: b.bundle }); }
      catch (e) { fail(e.status || 400, 'bad_playbook', e.message || 'That playbook could not be prepared.'); }
      const view = {
        playbook: { id: loaded.plan.id || b.id || '', name: loaded.plan.name, for: loaded.plan.for || '' },
        creates: loaded.plan.workflows.map((w) => ({ name: w.name, status: w.status, approval: 'needs_approval' })),
        installed: false, needs_confirmation: true, sent: false, payment: false,
      };
      if (b.confirm !== true) return view;
      const wrote = await loaded.write();
      await audit(st, ctx.id, { action: 'playbook_installed', actor: email, client: em, playbook: loaded.plan.id || loaded.plan.name || '' });
      return { ...view, installed: true, needs_confirmation: false, sent: false, result: { workflows: wrote.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status })), agents_created: wrote.created } };
    }

    if (pathname === '/api/agency/view-as' && method === 'POST') {
      requireWrite(ctx);
      const { email: em, u } = await ownClient(st, users, ctx.id, b.email);
      if (u.suspended) fail(403, 'suspended', 'This client is suspended.');
      const line = await audit(st, ctx.id, { action: 'view_as', actor: email, client: em, actor_role: ctx.role });
      const token = await signToken(em, 'customer', u.sv || 1, { imp: true, act: email, ag: ctx.id });
      const user = await presentUser(st, em, u, { imp: true });
      return { token, user, audit_id: line.id, read_only: true };
    }

    if (pathname === '/api/agency/audit' && method === 'GET') {
      requireWrite(ctx);
      const all = parse((await st.get(AUDIT + ctx.id))?.v, []) || [];
      return { audit: all.slice(0, 100).map((a) => ({ id: a.id, at: a.at, action: a.action, actor: a.actor, client: a.client || '', staff: a.staff || '', actor_role: a.actor_role || '' })) };
    }

    if (pathname === '/api/agency/invoice' || pathname === '/api/agency/invoice.csv' || pathname === '/api/agency/invoice.html') {
      if (method !== 'GET') fail(405, 'method_not_allowed', 'Use GET.');
      requireWrite(ctx);
      const month = String(query.get('month') || monthOf());
      if (!MONTH_RE.test(month)) fail(400, 'bad_month', 'Month looks like 2026-10.');
      const pack = await invoiceRows(st, users, ctx.id, month);
      if (pathname === '/api/agency/invoice.csv') return { __bytes: Buffer.from('\uFEFF' + invoiceCsv(pack), 'utf8'), __type: 'text/csv; charset=utf-8', __name: 'usage-' + month + '.csv' };
      if (pathname === '/api/agency/invoice.html') return { __html: invoiceHtml(pack) };
      return { month, markup: pack.markup, lines: pack.lines, payment: false, note: 'Usage summary for a manual invoice. No payment is taken.' };
    }

    fail(404, 'not_found', 'No agency route there.');
  } catch (e) { boom(e); }
}
