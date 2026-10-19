// Approvals (v1.14): history, approve / edit / reject inline, batch decisions, clear history. Per account only
// (as_appr:<email>). Nothing is sent, posted or paid unless the owner approves that exact item; editing an item
// changes what will be sent, and the edited text is what runs.
const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').slice(0, n);
const EDITABLE = { email: { to: 300, subject: 300, body: 20000 }, social: { text: 5000 }, draft: { summary: 300, request: 5000 } };
const BATCH_MAX = 25;

export async function approvalRoutes({ method, pathname, query, json, st, email, secret, decideApproval, HttpError }) {
  const key = 'as_appr:' + email;
  const all = async () => parse((await st.get(key))?.v, []) || [];
  const view = (a) => ({ id: a.id, aid: a.aid, kind: a.kind || 'action', app: a.app || '', summary: a.summary || '', status: a.status, at: a.at || null, done: a.done || null, result: a.result || '', edited: !!a.edited, note: a.note || '',
    ...(a.lead_id != null ? { lead_id: a.lead_id } : {}), ...(a.workflow_id ? { workflow_id: a.workflow_id } : {}),
    ...(a.kind === 'email' ? { to: a.to, subject: a.subject, body: a.body } : a.kind === 'social' ? { text: a.text, when: a.when } : a.kind === 'draft' ? { request: a.request, ...(a.subject ? { subject: a.subject } : {}) } : {}) });

  if (pathname === '/api/agents/approvals' && method === 'GET') {
    const s = String(query.get('status') || ''), list = (await all()).filter((a) => !s || a.status === s).sort((x, y) => (y.at || 0) - (x.at || 0));
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50));
    return { total: list.length, pending: list.filter((a) => a.status === 'pending').length, items: list.slice(0, limit).map(view) };
  }
  // change a pending item before deciding (email to/subject/body, post text, draft text)
  if (pathname === '/api/agents/approval/edit' && method === 'POST') {
    const b = json(), list = await all(), a = list.find((x) => x.id === String(b.id || ''));
    if (!a) throw new HttpError(404, 'not_found', 'That approval no longer exists.');
    if (a.status !== 'pending') throw new HttpError(409, 'decided', 'This one was already decided, so it can’t be edited.');
    const allow = EDITABLE[a.kind]; if (!allow) throw new HttpError(400, 'not_editable', 'This kind of approval can only be approved or rejected.');
    const ch = [];
    for (const [f, max] of Object.entries(allow)) if (b[f] != null) { const v = String(b[f]); if (v.length > max) throw new HttpError(400, 'too_long', `${f} is too long.`); if (v !== a[f]) { a[f] = v; ch.push(f); } }
    if (a.kind === 'email' && ch.includes('to') && !/^[^@\s]+@[^@\s]+\.[^@\s]+(\s*,\s*[^@\s]+@[^@\s]+\.[^@\s]+)*$/.test(a.to)) throw new HttpError(400, 'bad_to', 'Enter a valid email address.');
    if (ch.length) { a.edited = true; (a.edits ||= []).push({ at: Date.now(), f: ch }); await st.put(key, JSON.stringify(list), Date.now()); }
    return { approval: view(a), changed: ch };
  }
  // decide several at once: the owner ticks the exact items; each runs as if approved one by one
  if (pathname === '/api/agents/approvals/batch' && method === 'POST') {
    const b = json(), ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))];
    if (!ids.length) throw new HttpError(400, 'no_ids', 'Pick at least one item.');
    if (ids.length > BATCH_MAX) throw new HttpError(400, 'too_many', `Up to ${BATCH_MAX} at a time.`);
    if (!['approve', 'reject'].includes(b.decision)) throw new HttpError(400, 'bad_decision', 'decision must be approve or reject.');
    const results = [];
    for (const id of ids) { // one after another: each decision reads and writes the list
      const out = await decideApproval({ st, email, id, approve: b.decision === 'approve', secret });
      results.push(out.error ? { id, error: 'not_found' } : { id, status: out.approval.status, result: out.approval.result || '' });
    }
    if (b.note && b.decision === 'reject') await noteOn(st, key, ids, clip(b.note, 300));
    return { results };
  }
  if (pathname === '/api/agents/approvals/clear' && method === 'POST') {
    const b = json(), before = Date.now() - Math.max(0, Number(b.older_than_days) || 0) * 864e5;
    const list = await all(), keep = list.filter((a) => a.status === 'pending' || (a.done || a.at || 0) > before);
    await st.put(key, keep.length ? JSON.stringify(keep) : null, Date.now());
    return { cleared: list.length - keep.length, kept: keep.length };
  }
  return undefined;
}
async function noteOn(st, key, ids, note) {
  const list = parse((await st.get(key))?.v, []) || [];
  for (const a of list) if (ids.includes(a.id) && a.status === 'declined') a.note = note;
  await st.put(key, JSON.stringify(list), Date.now());
}
export const _test = { EDITABLE, BATCH_MAX };
