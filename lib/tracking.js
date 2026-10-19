// Tracking (v2.0). Open pixel, click redirects and page-visit beacons for ONE account's contacts.
// Tokens are unguessable and stored server-side (as_trk:<token> → that account and lead). The destination
// of a click is the URL saved when the link was created, never a value from the request, so this cannot
// be used as an open redirect. Opted-out contacts are not recorded. Creating a link or a pixel does not
// send an email: the owner adds tracking to a draft, then approves it separately.
import crypto from 'node:crypto';
import { optedOut } from './timeline.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
const TOKEN = /^[a-f0-9]{32}$/;
const BOT = /(whatsapp|facebookexternalhit|facebot|slackbot|twitterbot|telegrambot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview)/i;
const hits = new Map();
function crowded(ip) { const now = Date.now(), l = (hits.get(ip) || []).filter((t) => now - t < 60000); l.push(now); hits.set(ip, l); return l.length > 60; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function utmOf(query) {
  if (!query || typeof query.get !== 'function') return null;
  const o = {};
  for (const k of UTM_KEYS) { const v = String(query.get(k) || '').trim().slice(0, 120); if (v) o[k] = v; }
  return Object.keys(o).length ? o : null;
}
export function mergeUtm(primary, fallback) {
  const o = { ...(fallback || {}), ...(primary || {}) };
  return Object.keys(o).length ? o : null;
}
export function safeRef(headers = {}) {
  const raw = String(headers.referer || headers.referrer || headers.Referer || '').trim();
  if (!raw) return '';
  try { const u = new URL(raw); if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''; return (u.origin + u.pathname).slice(0, 300); } catch { return ''; }
}
export function safeHttpUrl(u) {
  try {
    const x = new URL(String(u || ''));
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
    if (!x.hostname || x.username || x.password) return '';
    if (x.href.length > 2000) return '';
    return x.href;
  } catch { return ''; }
}
// base: only the origin of a normal http(s) address (the page's own origin or APP_URL); anything else is ignored
function abs(base, path) {
  const pick = (u) => { const x = safeHttpUrl(u); return x ? new URL(x).origin : ''; };
  const b = pick(base) || pick(process.env.APP_URL);
  return b ? b + path : path;
}
function lost(title, text) {
  return { __html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;background:#0a0a0a;color:#f4f4f5;margin:0"><main style="max-width:520px;margin:48px auto;padding:0 16px"><h1 style="font-weight:500">${esc(title)}</h1><p style="color:#a1a1aa">${esc(text)}</p></main></body></html>` };
}

async function readLead(st, email, id) {
  const data = parse((await st.get('as_data:' + email))?.v, null);
  const a = data && (data.agents || []).find((x) => x && x.kind === 'crm');
  const lead = a && a.db && Array.isArray(a.db.lead) ? a.db.lead.find((l) => l && l.id === Number(id)) : null;
  return lead || null;
}
async function tokenList(st, email) { return parse((await st.get('as_trks:' + email))?.v, []) || []; }

async function mint(st, email, rec) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const token = crypto.randomBytes(16).toString('hex');
    const list = await tokenList(st, email);
    list.push({ token, lead_id: rec.lead_id, kind: rec.kind });
    await st.put('as_trks:' + email, JSON.stringify(list.slice(-5000)), Date.now());
    await st.put('as_trk:' + token, JSON.stringify({ account: email, lead_id: rec.lead_id, kind: rec.kind, url: rec.url || '', subject: rec.subject || '', at: Date.now() }), Date.now());
    return token;
  });
}
async function loadToken(st, token) {
  if (!TOKEN.test(token)) return null;
  const row = parse((await st.get('as_trk:' + token))?.v, null);
  if (!row || !row.account || row.lead_id == null) return null;
  return row;
}

export async function visitPath(st, email, leadId) {
  const list = await tokenList(st, email);
  const have = list.find((x) => x && x.kind === 'visit' && Number(x.lead_id) === Number(leadId));
  const token = have ? have.token : await mint(st, email, { lead_id: leadId, kind: 'visit' });
  return '/t/v/' + token;
}

// Rewrite links and, for HTML, append a 1×1 image. Does not send anything.
export async function buildTrackedEmail(st, email, lead, body, base) {
  if (optedOut(lead)) return { html: String(body || ''), tracked: false, reason: 'opted_out', links: 0, pixel: '' };
  const raw = String(body || '');
  const found = new Set();
  for (const m of raw.matchAll(/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi)) found.add(m[2]);
  for (const m of raw.matchAll(/(?<!["'=])\bhttps?:\/\/[^\s<>"']+/gi)) found.add(m[0].replace(/[),.;]+$/, ''));
  const map = new Map();
  for (const u of [...found].sort((a, b) => b.length - a.length)) {
    const safe = safeHttpUrl(u);
    if (!safe || /\/t\/[ocv]\//.test(safe)) continue;
    const token = await mint(st, email, { lead_id: lead.id, kind: 'click', url: safe });
    map.set(u, abs(base, '/t/c/' + token));
  }
  let out = raw;
  for (const [u, to] of map) out = out.split(u).join(to);
  const pixelToken = await mint(st, email, { lead_id: lead.id, kind: 'open' });
  const pixel = abs(base, '/t/o/' + pixelToken + '.gif');
  if (/<[a-z!/]/i.test(out)) out += `<img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
  return { html: out, tracked: true, reason: '', links: map.size, pixel: /<[a-z!/]/i.test(raw) || /<[a-z!/]/i.test(out) ? pixel : '' };
}

async function record(st, row, token, { kind, title, detail, dedupeMs }) {
  const lead = await readLead(st, row.account, row.lead_id);
  if (!lead || optedOut(lead)) return false;
  const { appendTl } = await import('./timeline.js');
  await appendTl(st, row.account, { lead_id: lead.id, kind, title, detail, dedupeToken: token, dedupeMs });
  return true;
}
async function noteVisitRow(st, email, row) {
  const { withDataLock } = await import('./backend.js');
  await withDataLock(email, async () => {
    const all = parse((await st.get('as_vis:' + email))?.v, []) || [];
    all.push(row);
    await st.put('as_vis:' + email, JSON.stringify(all.slice(-300)), Date.now());
  });
}

export async function notePublicVisit(st, email, { token, page, utm, ref, ip = '' } = {}) {
  if (!email || crowded('vis:' + (ip || '?'))) return; // public GETs: cap writes per IP
  await noteVisitRow(st, email, { at: Date.now(), token: String(token || '').slice(0, 64), page: String(page || '').slice(0, 40), ...(utm ? { utm } : {}), ...(ref ? { ref: String(ref).slice(0, 300) } : {}) });
}
export async function lastUtm(st, email, token) {
  const all = parse((await st.get('as_vis:' + email))?.v, []) || [];
  for (let i = all.length - 1; i >= 0; i--) if (all[i] && all[i].token === token && all[i].utm) return all[i].utm;
  return null;
}

function quiet(ip, ua) { return crowded(ip) || BOT.test(String(ua || '')); }

export async function trackPublic({ method, pathname, query, headers = {}, ip = '', st }) {
  if (method !== 'GET' && method !== 'HEAD') return lost('Not available', 'Open this link in a browser.');
  const open = pathname.match(/^\/t\/o\/([a-f0-9]{32})\.gif$/);
  const click = pathname.match(/^\/t\/c\/([a-f0-9]{32})$/);
  const visit = pathname.match(/^\/t\/v\/([a-f0-9]{32})$/);
  const ua = headers['user-agent'] || headers['User-Agent'] || '';
  if (open) {
    const row = await loadToken(st, open[1]);
    if (row && row.kind === 'open' && !quiet(ip, ua)) await record(st, row, open[1], { kind: 'open', title: 'Email opened', detail: row.subject || '', dedupeMs: 30 * 60e3 }).catch(() => {});
    return { __bytes: PIXEL, __type: 'image/gif' };
  }
  if (click) {
    const row = await loadToken(st, click[1]);
    const url = row && row.kind === 'click' ? safeHttpUrl(row.url) : '';
    if (!url) return lost('Link not found', 'This link isn’t active. It may have been removed.');
    if (!quiet(ip, ua)) await record(st, row, click[1], { kind: 'click', title: 'Link clicked', detail: url, dedupeMs: 2 * 60e3 }).catch(() => {});
    return { __redirect: url };
  }
  if (visit) {
    const row = await loadToken(st, visit[1]);
    if (!row || row.kind !== 'visit') return lost('Page not found', 'This visit link isn’t active.');
    const utm = utmOf(query);
    if (!quiet(ip, ua)) {
      const lead = await readLead(st, row.account, row.lead_id);
      if (lead && !optedOut(lead)) {
        const from = utm && utm.utm_source ? utm.utm_source : '';
        const { appendTl } = await import('./timeline.js');
        await appendTl(st, row.account, { lead_id: lead.id, kind: 'visit', title: from ? 'Page visit from ' + from : 'Page visit', detail: [utm && utm.utm_campaign, utm && utm.utm_medium].filter(Boolean).join(' · '), dedupeToken: 'visit:' + (from || 'direct'), dedupeMs: 2 * 60e3 }).catch(() => {});
        await noteVisitRow(st, row.account, { at: Date.now(), token: visit[1], page: 'beacon', ...(utm ? { utm } : {}) }).catch(() => {});
      }
    }
    const from = utm && utm.utm_source ? ' from ' + utm.utm_source : '';
    return lost('Visit noted', 'This visit' + from + ' was recorded for the business that shared the link.');
  }
  return lost('Link not found', 'This link isn’t active.');
}

export async function trackingApi({ method, pathname, b, st, email, HttpError }) {
  if (pathname === '/api/tracking/link' && method === 'POST') {
    const lead = await readLead(st, email, b.lead_id);
    if (!lead) throw new HttpError(404, 'not_found', 'No lead with that id.');
    if (optedOut(lead)) throw new HttpError(400, 'opted_out', 'This contact opted out, so no tracking link was created.');
    const url = safeHttpUrl(b.url);
    if (!url) throw new HttpError(400, 'bad_url', 'Give a normal http or https link.');
    const token = await mint(st, email, { lead_id: lead.id, kind: 'click', url });
    const path = '/t/c/' + token;
    return { path, url: abs(b.base, path), tracked: true, sent: false };
  }
  if (pathname === '/api/tracking/email' && method === 'POST') {
    const lead = await readLead(st, email, b.lead_id);
    if (!lead) throw new HttpError(404, 'not_found', 'No lead with that id.');
    const out = await buildTrackedEmail(st, email, lead, b.html, b.base);
    return { ...out, sent: false };
  }
  if (pathname === '/api/tracking/apply' && method === 'POST') {
    const lead = await readLead(st, email, b.lead_id);
    if (!lead) throw new HttpError(404, 'not_found', 'No lead with that id.');
    if (optedOut(lead)) throw new HttpError(400, 'opted_out', 'This contact opted out, so tracking was not added.');
    const key = 'as_appr:' + email;
    const list = parse((await st.get(key))?.v, []) || [];
    const a = list.find((x) => x && x.id === String(b.approval_id || ''));
    if (!a) throw new HttpError(404, 'not_found', 'That approval is not in your account.');
    if (a.kind !== 'email' || a.status !== 'pending') throw new HttpError(409, 'not_editable', 'Tracking can only be added to an email that is still waiting for approval. Nothing was sent.');
    const out = await buildTrackedEmail(st, email, lead, a.body, b.base);
    a.body = out.html; a.edited = true; a.tracked = true;
    (a.edits ||= []).push({ at: Date.now(), f: ['body'], tracking: true });
    await st.put(key, JSON.stringify(list), Date.now());
    return { approval: { id: a.id, status: a.status, edited: true, tracked: true }, links: out.links, pixel: out.pixel, sent: false };
  }
  if (pathname.startsWith('/api/tracking')) throw new HttpError(405, 'method_not_allowed');
  return undefined;
}
