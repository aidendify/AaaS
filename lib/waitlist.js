// Waitlist / early access: a public form (waitlist.html → POST /api/waitlist) and an admin list (GET /api/waitlist).
// One row per WhatsApp number in as_wl:<number> (server-only key, never sent through /api/kv), so signing up twice
// updates the same row instead of adding a duplicate. Admins export with GET /api/waitlist?format=csv.
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const BUSINESS_TYPES = ['Agency', 'Clinic / healthcare', 'Coaching / education', 'Consulting', 'E-commerce / D2C', 'Home services', 'Manufacturing', 'Real estate', 'Restaurant / food', 'Retail shop', 'Salon / wellness', 'Software / IT', 'Travel', 'Other'];

// WhatsApp number in E.164 form. A plain 10-digit Indian mobile (starts 6-9) gets +91; otherwise a country code is needed.
export function normWhatsApp(raw) {
  let s = String(raw ?? '').trim();
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (!plus) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return '+' + d;
    if (d.length === 10 && /^[6-9]/.test(d)) return '+91' + d;
    return '';
  }
  if (d.startsWith('91') && !(d.length === 12 && /^[6-9]/.test(d.slice(2)))) return '';
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? '+' + d : '';
}

export function validateEntry(b = {}) {
  const name = clean(b.name, 80), city = clean(b.city, 60), whatsapp = normWhatsApp(b.whatsapp);
  let business = clean(b.businessType || b.business, 60);
  const other = clean(b.businessOther, 60);
  if (business === 'Other' && other) business = 'Other: ' + other;
  const errs = {};
  if (name.length < 2) errs.name = 'Enter your name.';
  if (business.length < 2) errs.businessType = 'Choose your business type.';
  if (city.length < 2) errs.city = 'Enter your city.';
  if (!whatsapp) errs.whatsapp = 'Enter a WhatsApp number: 10 digits for India, or +country code and number.';
  if (b.consent !== true && b.consent !== 'on' && b.consent !== 'true') errs.consent = 'Tick the box so we can message you on WhatsApp.';
  return { ok: !Object.keys(errs).length, errs, entry: { name, businessType: business, city, whatsapp, email: clean(b.email, 120).toLowerCase(), note: clean(b.note, 300), source: clean(b.source || b.utm_source, 60) } };
}

const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^\+\d{8,15}$/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export async function listWaitlist(st) {
  const rows = (await st.listPrefix('as_wl:')).map((it) => parse(it && it.v, null)).filter(Boolean);
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

// public: POST /api/waitlist and GET /api/waitlist/options. Returns undefined when the path is not ours.
export async function waitlistPublic({ method, pathname, json, ip, st, throttle, noteAttempt, HttpError }) {
  if (pathname === '/api/waitlist/options' && method === 'GET') return { businessTypes: BUSINESS_TYPES };
  if (pathname !== '/api/waitlist' || method !== 'POST') return undefined;
  const b = json() || {};
  throttle('waitlist:' + ip, 10); noteAttempt('waitlist:' + ip);
  if (clean(b.website, 200)) return { ok: true }; // honeypot: bots fill the hidden field; pretend it worked
  const { ok, errs, entry } = validateEntry(b);
  if (!ok) throw new HttpError(400, 'bad_waitlist', Object.values(errs)[0], { fields: errs });
  if (entry.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry.email)) throw new HttpError(400, 'bad_waitlist', 'That email does not look right (it is optional).', { fields: { email: 'Check the email.' } });
  const k = 'as_wl:' + entry.whatsapp;
  let again = false;
  const save = (cur) => {
    const old = parse(cur, null);
    again = !!old;
    return JSON.stringify({ ...(old || {}), ...entry, at: old ? old.at : Date.now(), updated: Date.now(), n: ((old && old.n) || 0) + 1 });
  };
  if (st.update) await st.update(k, save); else await st.put(k, save((await st.get(k))?.v), Date.now());
  return { ok: true, again };
}

// admin only: GET /api/waitlist (JSON) or ?format=csv
export async function waitlistAdmin({ method, pathname, query, st, who, HttpError }) {
  if (pathname !== '/api/waitlist' || method !== 'GET') return undefined;
  if (who.role !== 'admin') throw new HttpError(403, 'admins_only');
  const rows = await listWaitlist(st);
  if (query && query.get('format') === 'csv') {
    const cols = ['at', 'name', 'businessType', 'city', 'whatsapp', 'email', 'note', 'source', 'n'];
    const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(',')));
    return { __bytes: Buffer.from(lines.join('\n') + '\n'), __type: 'text/csv; charset=utf-8' };
  }
  return { count: rows.length, entries: rows };
}
