// Per-account catalogue. The front desk answers “is the 3BHK still available?” from these rows.
// A listing is not a secret and it never sends a message. Replies that use it still wait in Approvals.
import crypto from 'node:crypto';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const KEY = 'as_list:';
const STATUSES = ['available', 'sold'];

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'bad_listing';
  throw e;
}
function cleanStatus(v, fallback = 'available') {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'available' || s === 'free' || s === 'open') return 'available';
  if (s === 'sold' || s === 'unavailable' || s === 'gone') return 'sold';
  return '';
}
// Spreadsheet formulas and control characters stay as text. Nothing here is evaluated.
function plainCell(s, n) {
  let t = clip(s, n).replace(/[\u0000-\u001f]/g, ' ');
  if (/^[=+\-@]/.test(t)) t = "'" + t;
  return t;
}
export function cleanListing(b, cur) {
  const src = b && typeof b === 'object' ? b : {};
  const base = cur || {};
  const title = plainCell(src.title != null ? src.title : base.title, 160);
  const type = plainCell(src.type != null ? src.type : base.type, 60);
  if (!title) bad('A listing needs a title.');
  if (!type) bad('A listing needs a type, such as 3BHK.');
  const status = cleanStatus(src.status != null ? src.status : base.status, 'available');
  if (!STATUSES.includes(status)) bad('Status is available or sold.');
  return {
    title,
    type,
    location: plainCell(src.location != null ? src.location : base.location, 160),
    price: plainCell(src.price != null ? src.price : base.price, 80),
    status,
    notes: plainCell(src.notes != null ? src.notes : base.notes, 500),
  };
}
async function readAll(st, email) {
  const rows = parse((await st.get(KEY + email))?.v, []) || [];
  return Array.isArray(rows) ? rows : [];
}
async function writeAll(st, email, rows) {
  await st.put(KEY + email, JSON.stringify(rows.slice(0, 200)), Date.now());
}
export function viewListing(row) {
  return {
    id: row.id, title: row.title, type: row.type, location: row.location || '',
    price: row.price || '', status: row.status === 'sold' ? 'sold' : 'available', notes: row.notes || '', at: row.at || null,
  };
}
export async function readListings(st, email) {
  return (await readAll(st, email)).map(viewListing);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export function matchListings(listings, text) {
  const raw = String(text || '').toLowerCase();
  const compact = norm(raw);
  const typeHit = raw.match(/\b(\d\s*bhk|villa|plot|office|studio|shop|flat|apartment)\b/i);
  const want = typeHit ? norm(typeHit[1]) : '';
  const hits = [];
  for (const row of listings || []) {
    const type = norm(row.type);
    const title = String(row.title || '').toLowerCase();
    const titleHit = title.length >= 4 && raw.includes(title);
    if ((want && type.includes(want)) || titleHit) hits.push(row);
  }
  return hits.slice(0, 8);
}
export function listingAnswer(hits) {
  if (!hits || !hits.length) return '';
  const lines = hits.slice(0, 5).map((l) => {
    const state = l.status === 'sold' ? 'sold' : 'available';
    const head = [l.title, l.type && norm(l.type) !== norm(l.title) ? '(' + l.type + ')' : ''].filter(Boolean).join(' ');
    const where = l.location ? ' in ' + l.location : '';
    const price = l.price ? ' at ' + l.price : '';
    const note = l.notes ? ' ' + l.notes + '.' : '';
    return head + where + ' is ' + state + price + '.' + note;
  });
  const anyFree = hits.some((l) => l.status !== 'sold');
  const lead = anyFree ? 'Yes. ' : 'No. ';
  return lead + lines.join(' ') + (anyFree ? ' Reply book a slot if you want a visit.' : '');
}

function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
export function parseListingCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (raw.length > 64 * 1024) bad('That CSV is too large. Keep it under 64 KB.');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) bad('Paste a CSV with a header row: title, type, location, price, status, notes.');
  const head = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const col = (name) => head.indexOf(name);
  if (col('title') < 0 || col('type') < 0) bad('The CSV header needs title and type columns.');
  const rows = [];
  for (const line of lines.slice(1, 201)) {
    const cells = splitCsv(line);
    const pick = (name) => cells[col(name)] || '';
    if (!pick('title') && !pick('type')) continue;
    rows.push(cleanListing({
      title: pick('title'), type: pick('type'), location: col('location') >= 0 ? pick('location') : '',
      price: col('price') >= 0 ? pick('price') : '', status: col('status') >= 0 ? pick('status') : 'available',
      notes: col('notes') >= 0 ? pick('notes') : '',
    }));
  }
  if (lines.length > 201) bad('Import up to 200 listings at a time.');
  if (!rows.length) bad('No listing rows were found under the header.');
  return rows;
}

export async function listingRoutes({ method, pathname, b, st, email, HttpError }) {
  if (pathname !== '/api/listings' && !pathname.startsWith('/api/listings/')) return undefined;
  const fail = (e) => { throw new HttpError(e.status || 400, e.code || 'bad_listing', e.message || 'Check that listing and try again.'); };
  if (pathname === '/api/listings' && method === 'GET') return { listings: await readListings(st, email) };
  if (pathname === '/api/listings' && method === 'POST') {
    let row;
    try { row = cleanListing(b); } catch (e) { fail(e); }
    const all = await readAll(st, email);
    if (all.length >= 200) throw new HttpError(400, 'bad_listing', 'This account already has 200 listings.');
    const saved = { id: 'ls' + uid(), ...row, at: Date.now() };
    all.unshift(saved);
    await writeAll(st, email, all);
    return { listing: viewListing(saved) };
  }
  if (pathname === '/api/listings/update' && method === 'POST') {
    const id = String(b.id || '');
    const all = await readAll(st, email);
    const cur = all.find((r) => r.id === id);
    if (!cur) throw new HttpError(404, 'not_found', 'No listing with that id.');
    let next;
    try { next = cleanListing(b, cur); } catch (e) { fail(e); }
    Object.assign(cur, next);
    await writeAll(st, email, all);
    return { listing: viewListing(cur) };
  }
  if (pathname === '/api/listings/delete' && method === 'POST') {
    const id = String(b.id || '');
    const all = await readAll(st, email);
    const left = all.filter((r) => r.id !== id);
    if (left.length === all.length) throw new HttpError(404, 'not_found', 'No listing with that id.');
    await writeAll(st, email, left);
    return { ok: true, deleted: id };
  }
  if (pathname === '/api/listings/import' && method === 'POST') {
    let rows;
    try { rows = parseListingCsv(b.csv || b.text || ''); } catch (e) { fail(e); }
    const all = await readAll(st, email);
    if (all.length + rows.length > 200) throw new HttpError(400, 'bad_listing', 'This account can hold 200 listings. Delete some before importing.');
    const now = Date.now();
    const saved = rows.map((row, i) => ({ id: 'ls' + uid() + i.toString(36), ...row, at: now }));
    await writeAll(st, email, [...saved.reverse(), ...all]);
    return { imported: saved.length, listings: (await readListings(st, email)) };
  }
  throw new HttpError(404, 'not_found');
}
