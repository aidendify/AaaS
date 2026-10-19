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
async function emitLeadEvents(st, email, events) {
  if (!events || !events.length) return;
  const { emitCrmEvent } = await import('./workflows.js');
  for (const ev of events.slice(0, 100)) await emitCrmEvent(st, email, ev);
}

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
  const ex = await crmExtras({ method, pathname, query, b, st, email, withDataLock, HttpError }); if (ex !== undefined) return ex;
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
    const tg = qs('tag'), sg = qs('stage');
    let list = all.filter((l) => (!tg || (l.tags || []).some((t) => t.toLowerCase() === tg)) && (!sg || String(l.stage || '').toLowerCase() === sg) && (!qs('status') || String(l.status).toLowerCase() === qs('status')) && (!qs('source') || String(l.source || '').toLowerCase() === qs('source')) && (!qs('score') || String(l.score || '').toLowerCase() === qs('score'))
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
      try { applyCustom(f, b, a.db, { isNew: true }); } catch (e) { bad(e); }
      const dup = dupeOf(L, f);
      if (dup && b.upsert !== true) throw new HttpError(409, 'duplicate', `A lead with the same ${f.email && dup.email && dup.email.toLowerCase() === f.email ? 'email' : 'phone'} already exists (id ${dup.id}). Send "upsert": true to update it, or PATCH /api/leads/${dup.id}.`, { lead: view(dup, a) });
      const events = [];
      let lead, created = false;
      if (dup) {
        const wasStage = dup.stage, wasTags = new Set((dup.tags || []).map((t) => String(t).toLowerCase()));
        Object.assign(dup, f); dup.upd = now; (dup.hist ||= []).push({ at: now, t: 'Updated via API' }); lead = dup;
        if (f.stage && f.stage !== wasStage) events.push({ type: 'stage.changed', lead_id: lead.id, from: wasStage || '', to: f.stage, source: lead.source || '' });
        for (const t of lead.tags || []) if (!wasTags.has(String(t).toLowerCase())) events.push({ type: 'tag.added', lead_id: lead.id, tag: t, source: lead.source || '' });
      }
      else { lead = { id: (L.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1, ...f, status: f.status || 'New', at: now, upd: now, hist: [{ at: now, t: 'Created via API' + (f.source ? ' (' + f.source + ')' : '') }] }; L.unshift(lead); a.n = (a.n || 0) + 1; created = true; events.push({ type: 'lead.created', lead_id: lead.id, source: lead.source || '', stage: lead.stage || '' }); }
      data.rev = (Number(data.rev) || 0) + 1;
      await st.put(key, JSON.stringify(data), now);
      return { lead: view(lead, a), created, aid: a.id, _events: events };
    });
    await emitLeadEvents(st, email, out._events);
    delete out._events;
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
    if (!Object.keys(f).length && b.stage == null && b.fields == null) bad(new Error('Nothing to change.'));
    const out = await withDataLock(email, async () => {
      const data = await read(), a = crmOf(data, false), l = a && a.db.lead.find((x) => x.id === id);
      if (!l) throw new HttpError(404, 'not_found', 'No lead with that id.');
      try { applyCustom(f, b, a.db, { cur: l }); } catch (e) { bad(e); }
      const dup = dupeOf(a.db.lead, f, id); if (dup) throw new HttpError(409, 'duplicate', `Lead ${dup.id} already has that email/phone.`);
      const ch = Object.keys(f).filter((k) => JSON.stringify(l[k] ?? '') !== JSON.stringify(f[k]));
      const events = [];
      if (ch.length) {
        const was = l.status, wasStage = l.stage, wasTags = new Set((l.tags || []).map((t) => String(t).toLowerCase()));
        Object.assign(l, f); l.upd = Date.now();
        const bits = [];
        if (f.stage && f.stage !== wasStage) { bits.push((wasStage || 'No stage') + ' → ' + f.stage); events.push({ type: 'stage.changed', lead_id: l.id, from: wasStage || '', to: f.stage, source: l.source || '' }); }
        if (f.status && f.status !== was) bits.push((was || 'No status') + ' → ' + f.status);
        const others = ch.filter((k) => k !== 'stage' && k !== 'status');
        let t = bits.join('; ');
        if (others.length) t = (t ? t + '; ' : '') + 'Updated ' + others.join(', ') + ' via API';
        (l.hist ||= []).push({ at: Date.now(), t: t || 'Updated via API' });
        for (const tag of l.tags || []) if (!wasTags.has(String(tag).toLowerCase())) events.push({ type: 'tag.added', lead_id: l.id, tag, source: l.source || '' });
        data.rev = (Number(data.rev) || 0) + 1; await st.put(key, JSON.stringify(data), Date.now());
      }
      return { lead: view(l, a), changed: ch, _events: events };
    });
    await emitLeadEvents(st, email, out._events);
    delete out._events;
    return out;
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

// ---------- flexible CRM (v1.14): custom fields, stages, tags, CSV import/export ----------
// Per account, kept on the CRM agent: db.leadFields = [{ key, label, type: text|number|date|select|checkbox, options }],
// db.stages = ['New lead', …]. A lead keeps custom values in lead.fields and its pipeline stage in lead.stage.
// Every change is written to lead.hist, which the v2 contact timeline builds on.
export const DEFAULT_STAGES = ['New lead', 'Contacted', 'Proposal sent', 'Won', 'Lost'];
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];
const MAX_FIELDS = 30, MAX_STAGES = 15, MAX_ROWS = 2000;
const STD = ['id', 'first_name', 'last_name', 'email', 'phone', 'company', 'source', 'status', 'stage', 'score', 'tags', 'interest', 'budget', 'timeline', 'owner', 'consent', 'channel', 'last_contact', 'notes'];
const stagesOf = (db) => Array.isArray(db && db.stages) && db.stages.length ? db.stages : DEFAULT_STAGES;
const fieldsOf = (db) => Array.isArray(db && db.leadFields) ? db.leadFields : [];
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

export function cleanFieldDefs(list) {
  if (!Array.isArray(list)) throw new Error('fields must be a list.');
  if (list.length > MAX_FIELDS) throw new Error(`Up to ${MAX_FIELDS} custom fields.`);
  const seen = new Set();
  return list.map((x) => {
    const label = String(x && x.label || '').trim().slice(0, 60); if (!label) throw new Error('Each field needs a label.');
    const key = slug(x.key || label); if (!key || STD.includes(key) || key === 'name' || key === 'fields') throw new Error(`"${label}" clashes with a built-in field; pick another name.`);
    if (seen.has(key)) throw new Error(`Two fields are called "${label}".`); seen.add(key);
    const type = FIELD_TYPES.includes(x.type) ? x.type : 'text';
    const out = { key, label, type };
    if (type === 'select') { out.options = [...new Set((Array.isArray(x.options) ? x.options : String(x.options || '').split(',')).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, 30); if (!out.options.length) throw new Error(`"${label}" needs at least one option.`); }
    return out;
  });
}
export function cleanStages(list) {
  if (!Array.isArray(list)) throw new Error('stages must be a list.');
  const out = [...new Set(list.map((x) => String(x).trim().slice(0, 40)).filter(Boolean))];
  if (!out.length) throw new Error('Keep at least one stage.'); if (out.length > MAX_STAGES) throw new Error(`Up to ${MAX_STAGES} stages.`);
  return out;
}
function customValue(def, v) {
  if (v == null || v === '') return undefined;
  if (def.type === 'number') { const n = Number(String(v).replace(/[, ]/g, '')); if (!Number.isFinite(n)) throw new Error(`${def.label} must be a number.`); return n; }
  if (def.type === 'date') { const d = Date.parse(v); if (!d) throw new Error(`${def.label} must be a date, e.g. 2026-10-19.`); return new Date(d).toISOString().slice(0, 10); }
  if (def.type === 'checkbox') return v === true || /^(true|yes|y|1|on)$/i.test(String(v));
  if (def.type === 'select') { const o = def.options.find((x) => x.toLowerCase() === String(v).trim().toLowerCase()); if (!o) throw new Error(`${def.label} must be one of: ${def.options.join(', ')}.`); return o; }
  return String(v).trim().slice(0, 1000);
}
// adds f.stage / f.fields from the request, checked against this account's stages and field list
export function applyCustom(f, b, db, { isNew = false, cur = null } = {}) {
  const stages = stagesOf(db);
  if (b.stage != null && b.stage !== '') { const s = stages.find((x) => x.toLowerCase() === String(b.stage).trim().toLowerCase()); if (!s) throw new Error('stage must be one of: ' + stages.join(', ') + '.'); f.stage = s; }
  else if (isNew && !f.stage) f.stage = stages[0];
  if (b.fields != null) {
    if (typeof b.fields !== 'object' || Array.isArray(b.fields)) throw new Error('fields must be an object: { "field_key": value }.');
    const defs = fieldsOf(db), next = { ...((cur && cur.fields) || {}) };
    for (const [k, v] of Object.entries(b.fields)) {
      const def = defs.find((d) => d.key === k || d.label.toLowerCase() === String(k).toLowerCase()); if (!def) throw new Error(`Unknown field "${k}". Add it under custom fields first.`);
      const val = customValue(def, v); if (val === undefined) delete next[def.key]; else next[def.key] = val;
    }
    f.fields = next;
  }
}

// CSV (RFC 4180): quotes, commas and new lines inside quotes
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const t = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; } else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
// spreadsheet-safe: a cell starting with = + - @ is prefixed with ' so it is never run as a formula
const csvCell = (v) => { let s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function crmExtras({ method, pathname, query, b, st, email, withDataLock, HttpError }) {
  const m = pathname.match(/^\/api\/leads\/(fields|stages|export\.csv|import|tags)\/?$/); if (!m) return undefined;
  const key = 'as_data:' + email, what = m[1];
  const bad = (e) => { throw new HttpError(400, 'bad_crm', e.message); };
  const read = async () => parse((await st.get(key))?.v, null) || { agents: [] };
  const write = async (fn) => {
    const out = await withDataLock(email, async () => { const data = await read(), a = crmOf(data, true); const res = await fn(a, data); data.rev = (Number(data.rev) || 0) + 1; await st.put(key, JSON.stringify(data), Date.now()); return res; });
    await emitLeadEvents(st, email, out && out._events);
    if (out && out._events) delete out._events;
    return out;
  };

  if ((what === 'fields' || what === 'stages') && method === 'GET') { const a = crmOf(await read(), false); return what === 'fields' ? { fields: fieldsOf(a && a.db) } : { stages: stagesOf(a && a.db), default: !(a && a.db && a.db.stages) }; }
  if (what === 'fields' && (method === 'PUT' || method === 'POST')) { let defs; try { defs = cleanFieldDefs(b.fields); } catch (e) { bad(e); } return write((a) => { a.db.leadFields = defs; return { fields: defs }; }); }
  if (what === 'stages' && (method === 'PUT' || method === 'POST')) {
    let list; try { list = cleanStages(b.stages); } catch (e) { bad(e); }
    return write((a) => { // leads on a removed stage move to the first stage (or to "move_to")
      const to = list.find((x) => x === b.move_to) || list[0]; let moved = 0; const events = [];
      for (const l of a.db.lead) if (l.stage && !list.includes(l.stage)) { const from = l.stage; (l.hist ||= []).push({ at: Date.now(), t: from + ' → ' + to + ' (stage removed)' }); l.stage = to; moved++; events.push({ type: 'stage.changed', lead_id: l.id, from, to, source: l.source || '' }); }
      a.db.stages = list; return { stages: list, moved, _events: events };
    });
  }
  if (what === 'tags' && method === 'POST') {
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(Number)); if (!ids.size) bad(new Error('Pick at least one lead (ids).'));
    const norm = (x) => (Array.isArray(x) ? x : String(x || '').split(',')).map((t) => String(t).trim().slice(0, 40)).filter(Boolean);
    const add = norm(b.add), rem = new Set(norm(b.remove).map((t) => t.toLowerCase())); if (!add.length && !rem.size) bad(new Error('Give tags to add or remove.'));
    return write((a) => { let n = 0; const events = [];
      for (const l of a.db.lead) if (ids.has(l.id)) { const before = new Set((l.tags || []).map((x) => String(x).toLowerCase())); const was = JSON.stringify(l.tags || []); let t = (l.tags || []).filter((x) => !rem.has(x.toLowerCase())); for (const x of add) if (!t.some((y) => y.toLowerCase() === x.toLowerCase())) t.push(x); l.tags = t.slice(0, 20); if (JSON.stringify(l.tags) !== was) { n++; l.upd = Date.now(); (l.hist ||= []).push({ at: Date.now(), t: 'Tags: ' + (l.tags.join(', ') || 'none') }); for (const x of l.tags) if (!before.has(String(x).toLowerCase())) events.push({ type: 'tag.added', lead_id: l.id, tag: x, source: l.source || '' }); } }
      return { updated: n, _events: events }; });
  }
  if (what === 'export.csv' && method === 'GET') {
    const a = crmOf(await read(), false), defs = fieldsOf(a && a.db), L = a ? a.db.lead : [];
    const head = [...STD, ...defs.map((d) => d.label)];
    const lines = [head.map(csvCell).join(','), ...L.map((l) => [...STD.map((k) => l[k]), ...defs.map((d) => (l.fields || {})[d.key])].map(csvCell).join(','))];
    return { __bytes: Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8'), __type: 'text/csv; charset=utf-8', __name: 'leads.csv' };
  }
  if (what === 'import' && method === 'POST') {
    const text = String(b.csv || ''); if (!text.trim()) bad(new Error('Paste or upload a CSV file (csv).')); if (text.length > 3_000_000) bad(new Error('The file is too big (max about 3 MB).'));
    const rows = parseCsv(text); if (rows.length < 2) bad(new Error('The CSV needs a header row and at least one lead.'));
    if (rows.length - 1 > MAX_ROWS) bad(new Error(`Up to ${MAX_ROWS} leads per import.`));
    const dry = b.dry_run === true;
    const out = await withDataLock(email, async () => {
      const data = await read(), a = crmOf(data, true), defs = fieldsOf(a.db);
      const head = rows[0].map((h) => String(h).trim()), res = { created: 0, updated: 0, skipped: 0, errors: [] };
      const col = head.map((h) => { const k = slug(h); if (k === 'name' || k === 'full_name') return { std: 'name' }; if (STD.includes(k) && k !== 'id') return { std: k }; const d = defs.find((x) => x.key === k || x.label.toLowerCase() === h.toLowerCase()); return d ? { custom: d.key } : null; });
      if (!col.some((c) => c && ['name', 'first_name'].includes(c.std))) bad(new Error('The CSV needs a name or first_name column.'));
      const now = Date.now(), L = a.db.lead, events = [];
      let next = (L.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i], raw = {}, fields = {};
        col.forEach((c, j) => { const v = (r[j] ?? '').trim(); if (!c || v === '') return; if (c.custom) fields[c.custom] = v; else raw[c.std] = c.std === 'tags' ? v.split(/[;,]/) : v.replace(/^'(?=[=+\-@])/, ''); });
        if (Object.keys(fields).length) raw.fields = fields;
        try {
          const f = cleanLead(raw); applyCustom(f, raw, a.db, { isNew: true });
          const dup = dupeOf(L, f);
          if (dup) { if (b.upsert !== true) { res.skipped++; continue; } if (!dry) { Object.assign(dup, f, { fields: { ...(dup.fields || {}), ...(f.fields || {}) } }); dup.upd = now; (dup.hist ||= []).push({ at: now, t: 'Updated by CSV import' }); } res.updated++; }
          else { const id = next++; if (!dry) { L.unshift({ id, ...f, status: f.status || 'New', at: now, upd: now, hist: [{ at: now, t: 'Imported from CSV' }] }); events.push({ type: 'lead.created', lead_id: id, source: f.source || '' }); } res.created++; }
        } catch (e) { if (res.errors.length < 50) res.errors.push({ row: i + 1, error: e.message }); }
      }
      if (!dry && (res.created || res.updated)) { data.rev = (Number(data.rev) || 0) + 1; await st.put(key, JSON.stringify(data), now); }
      return { ...res, dry_run: dry, _events: dry ? [] : events };
    });
    await emitLeadEvents(st, email, out._events);
    delete out._events;
    return out;
  }
  throw new HttpError(405, 'method_not_allowed');
}

// A public form fills the same CRM lead the contact timeline reads. It never sends a message.
// Called while the account's workspace lock is already held.
export function upsertPublicLead(data, info) {
  const email = String(info.email || '').trim().toLowerCase();
  if (!okEmail(email)) return null;
  const a = crmOf(data, true);
  const now = info.at || Date.now();
  const parts = String(info.name || '').trim().split(/\s+/).filter(Boolean);
  const first_name = (parts.shift() || 'Lead').slice(0, 80);
  const last_name = parts.join(' ').slice(0, 80);
  let phone = String(info.phone || '').trim();
  if (phone && !/^\+?[0-9 ()\-.]{6,24}$/.test(phone)) phone = '';
  const utm = info.utm && typeof info.utm === 'object' ? info.utm : null;
  const source = String((utm && utm.utm_source) || info.source || 'Website').trim().slice(0, 60) || 'Website';
  const touch = { at: now, source, ...(utm ? { utm } : {}), ...(info.ref ? { ref: String(info.ref).slice(0, 300) } : {}) };
  const L = a.db.lead;
  let lead = dupeOf(L, { email, phone });
  const created = !lead;
  const visitLine = utm ? 'Visited from ' + [utm.utm_source, utm.utm_medium, utm.utm_campaign].filter(Boolean).join(' / ') : '';
  const formLine = 'Form submitted' + (info.formTitle ? ': ' + String(info.formTitle).slice(0, 80) : '');
  if (!lead) {
    const id = (L.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1;
    lead = { id, first_name, last_name, email, phone, source, status: 'New', stage: stagesOf(a.db)[0], consent: 'Unknown', at: now, upd: now, first_touch: touch, last_touch: touch, notes: String(info.message || '').slice(0, 2000), hist: [] };
    L.unshift(lead); a.n = (a.n || 0) + 1;
  } else {
    if (!lead.first_touch) lead.first_touch = touch;
    lead.last_touch = touch;
    if (!lead.source) lead.source = source;
    lead.upd = now;
  }
  const hist = lead.hist ||= [];
  if (visitLine) hist.push({ at: now, t: visitLine });
  hist.push({ at: now + 1, t: formLine });
  Object.defineProperty(lead, '_justCreated', { value: created, enumerable: false, configurable: true });
  return lead;
}
