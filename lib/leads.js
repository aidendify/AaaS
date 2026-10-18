// Single-lead API: add, list, read, change and delete CRM leads without rewriting the whole workspace.
//   POST   /api/leads          add one lead (409 duplicate on same email/phone unless "upsert": true)
//   GET    /api/leads          list (?status=&q=&source=&score=&limit=50&offset=0), newest first
//   GET    /api/leads/:id      one lead
//   PATCH  /api/leads/:id      change fields / status
//   DELETE /api/leads/:id      delete
// Leads live where the app's CRM keeps them: as_data:<email> → agents[kind=crm].db.lead[] (same shape as index.html's
// CRM_BP "lead" entity), so the web app shows them at once. Every write runs under the per-customer data lock and bumps
// the workspace "rev", so an open browser tab gets the usual "updated from another session" merge instead of
// overwriting. Writing leads never sends or posts anything; an optional followUp only schedules a one-off routine
// whose own actions still wait for approval.
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
export const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted', 'Archived'];
const SOURCES = ['Website', 'Referral', 'Google Ads', 'Facebook', 'Instagram', 'LinkedIn', 'Event', 'Cold outreach', 'Walk-in', 'Other'];
const PICK = { score: ['Hot', 'Warm', 'Cold'], consent: ['Given', 'Unknown', 'Opted out'], channel: ['Email', 'Phone', 'WhatsApp', 'SMS'] };
const TEXT = { first_name: 80, last_name: 80, company: 120, interest: 200, budget: 80, timeline: 80, score_reason: 1000, missing: 200, owner: 80, notes: 5000 };
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;
const pickOf = (list, v) => list.find((x) => x.toLowerCase() === String(v).trim().toLowerCase());
const title = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ');

// → { fields } or throws Error(message) (the route turns it into 400)
export function cleanLead(b, { partial = false } = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Send the lead as a JSON object.');
  const f = {};
  if (b.name != null && b.first_name == null && b.last_name == null) { const p = String(b.name).trim().split(/\s+/); f.first_name = p.shift() || ''; f.last_name = p.join(' '); }
  for (const [k, max] of Object.entries(TEXT)) if (b[k] != null) { const v = String(b[k]).trim(); if (v.length > max) throw new Error(`${k} is too long (max ${max} characters).`); f[k] = v; }
  if (b.email != null) { const e = String(b.email).trim().toLowerCase(); if (e && !okEmail(e)) throw new Error('email is not a valid email address.'); f.email = e; }
  if (b.phone != null) { const p = String(b.phone).trim(); if (p && !/^\+?[0-9 ()\-.]{6,24}$/.test(p)) throw new Error('phone should be digits, spaces, +, - or brackets (6-24 characters).'); f.phone = p; }
  if (b.source != null) f.source = pickOf(SOURCES, b.source) || String(b.source).trim().slice(0, 60);
  for (const [k, list] of Object.entries(PICK)) if (b[k] != null && b[k] !== '') { const v = pickOf(list, b[k]); if (!v) throw new Error(`${k} must be one of: ${list.join(', ')}.`); f[k] = v; }
  if (b.tags != null) { const t = Array.isArray(b.tags) ? b.tags : String(b.tags).split(','); f.tags = t.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 20); }
  if (b.last_contact != null && b.last_contact !== '') { const d = Date.parse(b.last_contact); if (!d) throw new Error('last_contact must be a date, e.g. 2026-10-19.'); f.last_contact = new Date(d).toISOString().slice(0, 10); }
  if (b.status != null) { const s = pickOf(LEAD_STATUSES, b.status); if (!s) throw new Error('status must be one of: ' + LEAD_STATUSES.join(', ') + '.'); f.status = s; }
  if (!partial) {
    if (!f.first_name) throw new Error('Give the lead a name (name, or first_name).');
    if (!f.email && !f.phone) throw new Error('Give an email or a phone number.');
  } else if ('first_name' in f && !f.first_name) throw new Error('first_name cannot be empty.');
  return f;
}

function crmOf(data, create) {
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  let a = data.agents.find((x) => x && x.kind === 'crm');
  if (!a && create) {
    a = { id: data.agents.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1, kind: 'crm', name: 'CRM Agent', label: 'CRM', recs: [], slips: [], n: 0, at: Date.now() };
    data.agents.push(a);
  }
  if (a) { a.db = a.db && typeof a.db === 'object' ? a.db : {}; a.db.lead = Array.isArray(a.db.lead) ? a.db.lead : []; }
  return a;
}
const dupeOf = (list, f, skipId) => list.find((l) => l.id !== skipId && ((f.email && l.email && l.email.toLowerCase() === f.email) || (f.phone && l.phone && l.phone.replace(/\D/g, '') === f.phone.replace(/\D/g, ''))));
const view = (l, a) => ({ ...l, name: title(l), agent_id: a.id });

export async function leadRoutes({ method, pathname, query, b, st, email, withDataLock, HttpError, saveRoutine }) {
  const m = pathname.match(/^\/api\/leads(?:\/(\d+))?\/?$/); if (!m) return undefined;
  const id = m[1] ? Number(m[1]) : null;
  const key = 'as_data:' + email;
  const bad = (e) => { throw new HttpError(400, 'bad_lead', e.message); };
  const read = async () => parse((await st.get(key))?.v, null) || { agents: [] };

  if (method === 'GET') {
    const data = await read(), a = crmOf(data, false);
    const all = a ? a.db.lead : [];
    if (id != null) { const l = all.find((x) => x.id === id); if (!l) throw new HttpError(404, 'not_found', 'No lead with that id.'); return { lead: view(l, a) }; }
    const qs = (k) => String(query.get(k) || '').trim().toLowerCase(), q = qs('q');
    let list = all.filter((l) => (!qs('status') || String(l.status).toLowerCase() === qs('status')) && (!qs('source') || String(l.source || '').toLowerCase() === qs('source')) && (!qs('score') || String(l.score || '').toLowerCase() === qs('score'))
      && (!q || [title(l), l.email, l.phone, l.company, l.notes].some((v) => String(v || '').toLowerCase().includes(q))));
    list = list.sort((x, y) => (y.at || 0) - (x.at || 0));
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50)), offset = Math.max(0, Number(query.get('offset')) || 0);
    return { total: list.length, limit, offset, leads: list.slice(offset, offset + limit).map((l) => view(l, a)) };
  }
  if (method === 'POST' && id == null) {
    let f; try { f = cleanLead(b); } catch (e) { bad(e); }
    let fu = null;
    if (b.followUp != null) { // validate before writing anything
      const x = b.followUp; if (typeof x !== 'object') bad(new Error('followUp must be an object: { "in_days": 3, "message": "…" } or { "run_at": "2026-10-22T10:00:00+05:30" }.'));
      const at = x.run_at ? Date.parse(x.run_at) : (Number(x.in_days) > 0 ? Date.now() + Math.min(400, Number(x.in_days)) * 864e5 : NaN);
      if (!at) bad(new Error('followUp needs run_at (ISO date-time) or in_days (> 0).'));
      fu = { at, message: String(x.message || '').trim().slice(0, 2000) };
    }
    const out = await withDataLock(email, async () => {
      const data = await read(), a = crmOf(data, true), L = a.db.lead, now = Date.now();
      const dup = dupeOf(L, f);
      if (dup && b.upsert !== true) throw new HttpError(409, 'duplicate', `A lead with the same ${f.email && dup.email && dup.email.toLowerCase() === f.email ? 'email' : 'phone'} already exists (id ${dup.id}). Send "upsert": true to update it, or PATCH /api/leads/${dup.id}.`, { lead: view(dup, a) });
      let lead, created = false;
      if (dup) { Object.assign(dup, f); dup.upd = now; (dup.hist ||= []).push({ at: now, t: 'Updated via API' }); lead = dup; }
      else { lead = { id: (L.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1, ...f, status: f.status || 'New', at: now, upd: now, hist: [{ at: now, t: 'Created via API' + (f.source ? ' (' + f.source + ')' : '') }] }; L.unshift(lead); a.n = (a.n || 0) + 1; created = true; }
      data.rev = (Number(data.rev) || 0) + 1;
      await st.put(key, JSON.stringify(data), now);
      return { lead: view(lead, a), created, aid: a.id };
    });
    if (fu) {
      try {
        const r = await saveRoutine(st, email, { aid: out.aid, title: 'Follow up ' + out.lead.name, run_at: new Date(fu.at).toISOString(), prompt: (fu.message || `Follow up with the lead ${out.lead.name}`) + ` (lead #${out.lead.id}${out.lead.email ? ', ' + out.lead.email : ''}${out.lead.phone ? ', ' + out.lead.phone : ''}). Draft the message for the owner's approval; do not send it.` });
        out.followUp = { routine_id: r.id, next: r.next };
      } catch (e) { out.followUp = { error: e.message }; }
    }
    return out;
  }
  if (id == null) throw new HttpError(405, 'method_not_allowed', 'Use GET or POST on /api/leads.');
  if (method === 'PATCH') {
    let f; try { f = cleanLead(b, { partial: true }); } catch (e) { bad(e); }
    if (!Object.keys(f).length) bad(new Error('Nothing to change.'));
    return withDataLock(email, async () => {
      const data = await read(), a = crmOf(data, false), l = a && a.db.lead.find((x) => x.id === id);
      if (!l) throw new HttpError(404, 'not_found', 'No lead with that id.');
      const dup = dupeOf(a.db.lead, f, id); if (dup) throw new HttpError(409, 'duplicate', `Lead ${dup.id} already has that email/phone.`);
      const ch = Object.keys(f).filter((k) => JSON.stringify(l[k] ?? '') !== JSON.stringify(f[k]));
      if (ch.length) { const was = l.status; Object.assign(l, f); l.upd = Date.now(); (l.hist ||= []).push({ at: Date.now(), t: f.status && f.status !== was ? was + ' → ' + f.status : 'Updated ' + ch.join(', ') + ' via API' }); data.rev = (Number(data.rev) || 0) + 1; await st.put(key, JSON.stringify(data), Date.now()); }
      return { lead: view(l, a), changed: ch };
    });
  }
  if (method === 'DELETE') {
    return withDataLock(email, async () => {
      const data = await read(), a = crmOf(data, false), i = a ? a.db.lead.findIndex((x) => x.id === id) : -1;
      if (i < 0) throw new HttpError(404, 'not_found', 'No lead with that id.');
      a.db.lead.splice(i, 1); data.rev = (Number(data.rev) || 0) + 1; await st.put(key, JSON.stringify(data), Date.now());
      return { ok: true, deleted: id };
    });
  }
  throw new HttpError(405, 'method_not_allowed');
}
