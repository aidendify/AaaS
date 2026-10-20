// Per-contact timeline (v2.0). One chronological list per lead, built for the signed-in account only.
// It joins what is already stored — lead history, notes, stage changes, tasks, activities, emails,
// drafts and approvals — with tracking and agent-run events kept in as_tl:<email>.
// Nothing here sends, posts or pays. Notes and tasks are records. Email still waits for approval.
import { DEFAULT_STAGES } from './leads.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').slice(0, n);
const nameOf = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
const low = (s) => String(s || '').toLowerCase();

export function classifyHist(t) {
  const s = String(t || '');
  if (/^note:/i.test(s)) return 'note';
  if (/^visited\b/i.test(s)) return 'visit';
  if (/^form\b/i.test(s)) return 'form';
  if (/→/.test(s)) return 'stage';
  return 'history';
}

function crmAgent(data) {
  return ((data && data.agents) || []).find((a) => a && a.kind === 'crm') || null;
}
async function readData(st, email) {
  return parse((await st.get('as_data:' + email))?.v, null) || { agents: [] };
}
function leadById(data, id) {
  const a = crmAgent(data);
  const lead = a && a.db && Array.isArray(a.db.lead) ? a.db.lead.find((l) => l && l.id === id) : null;
  return { agent: a, lead: lead || null };
}

function touches(lead, rec) {
  if (!rec) return false;
  if (rec.lead_id != null && Number(rec.lead_id) === Number(lead.id)) return true;
  const blob = low([rec.related, rec.summary, rec.title, rec.to, rec.body, rec.request, rec.subject].filter(Boolean).join(' '));
  const em = low(lead.email);
  if (em && blob.includes(em)) return true;
  if (blob.includes('lead #' + lead.id) || blob.includes('#' + lead.id)) return true;
  const nm = low(nameOf(lead));
  if (nm.length > 3 && blob.includes(nm)) return true;
  return false;
}
function approvalTouches(lead, a) {
  if (!a) return false;
  if (a.lead_id != null && Number(a.lead_id) === Number(lead.id)) return true;
  const em = low(lead.email);
  if (em && low(a.to).split(',').map((s) => s.trim()).includes(em)) return true;
  const blob = low([a.summary, a.request, a.body, a.subject].filter(Boolean).join(' '));
  if (em && blob.includes(em)) return true;
  if (blob.includes('lead #' + lead.id)) return true;
  return false;
}

const ACT_KIND = { note: 'note', email: 'email', 'follow-up draft': 'draft' };
function activityKind(rec) {
  const t = low(rec && rec.type);
  return ACT_KIND[t] || (t.includes('draft') ? 'draft' : t.includes('email') ? 'email' : 'history');
}

// Pure join, so tests can check the order and the kinds without a server.
export function assembleTimeline(lead, { tasks = [], activities = [], approvals = [], tracked = [], order = 'desc' } = {}) {
  const events = [];
  (lead.hist || []).forEach((h, i) => {
    if (!h || h.at == null) return;
    const kind = classifyHist(h.t);
    events.push({ id: 'h' + lead.id + '-' + i, at: h.at, kind, title: clip(h.t, 300), detail: '', source: 'history' });
  });
  for (const t of tasks) {
    if (!touches(lead, t)) continue;
    events.push({ id: 'task-' + t.id, at: t.at || t.upd || 0, kind: 'task', title: clip(t.title || 'Task', 200), detail: [t.status, t.priority, t.due ? 'due ' + t.due : ''].filter(Boolean).join(' · '), source: 'task' });
  }
  for (const rec of activities) {
    if (!touches(lead, rec)) continue;
    events.push({ id: 'act-' + rec.id, at: rec.at || rec.upd || 0, kind: activityKind(rec), title: clip(rec.summary || rec.type || 'Activity', 200), detail: clip(rec.body || rec.status || '', 300), source: 'activity' });
  }
  for (const a of approvals) {
    if (!approvalTouches(lead, a)) continue;
    const kind = a.kind === 'email' ? 'email' : a.kind === 'draft' ? 'draft' : 'approval';
    const state = a.status === 'pending' ? 'Waiting for approval' : a.status === 'done' ? 'Approved' : a.status === 'declined' ? 'Declined' : (a.status || '');
    const title = kind === 'email' ? (a.subject || a.summary || 'Email') : (a.summary || a.app || 'Approval');
    events.push({ id: 'appr-' + a.id, at: a.done || a.at || 0, kind, title: clip(title, 200), detail: clip([state, a.note, a.result].filter(Boolean).join(' · '), 300), source: 'approval', status: a.status || '' });
  }
  for (const e of tracked) {
    if (!e || Number(e.lead_id) !== Number(lead.id)) continue;
    events.push({ id: e.id, at: e.at || 0, kind: e.kind, title: clip(e.title, 200), detail: clip(e.detail, 500), source: e.kind === 'agent' ? 'agent' : 'tracking' });
  }
  events.sort((x, y) => (y.at - x.at) || String(y.id).localeCompare(String(x.id)));
  if (order === 'asc') events.reverse();
  return events;
}

export function optedOut(lead) { return String(lead && lead.consent || '') === 'Opted out'; }

export function summarizeDashboard(leads, stages, { tracked = [], pageViews = 0 } = {}) {
  const list = Array.isArray(leads) ? leads : [];
  const stageList = Array.isArray(stages) && stages.length ? stages : DEFAULT_STAGES.slice();
  const first = stageList[0];
  const src = new Map();
  for (const l of list) {
    const u = l.first_touch && l.first_touch.utm && l.first_touch.utm.utm_source;
    const s = String(u || l.source || 'Unknown').slice(0, 60) || 'Unknown';
    src.set(s, (src.get(s) || 0) + 1);
  }
  const total = list.length;
  const by_stage = stageList.map((stage) => {
    const count = list.filter((l) => (l.stage || first) === stage).length;
    return { stage, count, share: total ? Math.round(count / total * 1000) / 1000 : 0 };
  });
  const won = list.filter((l) => /^(won|converted)$/i.test(l.stage || '') || l.status === 'Converted').length;
  const left = list.filter((l) => (l.stage || first) !== first).length;
  const kinds = (k) => tracked.filter((e) => e && e.kind === k).length;
  return {
    leads: total,
    opted_out: list.filter(optedOut).length,
    by_source: [...src.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    by_stage,
    conversion: {
      total, won, rate: total ? Math.round(won / total * 1000) / 1000 : 0,
      left_first_stage: left, left_first_rate: total ? Math.round(left / total * 1000) / 1000 : 0,
    },
    tracking: { opens: kinds('open'), clicks: kinds('click'), page_views: pageViews },
  };
}

async function readTl(st, email) { return parse((await st.get('as_tl:' + email))?.v, []) || []; }
async function readApprovals(st, email) { return parse((await st.get('as_appr:' + email))?.v, []) || []; }

export async function appendTl(st, email, ev) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const all = await readTl(st, email);
    if (ev.dedupeToken && ev.dedupeMs && all.some((e) => e && e.kind === ev.kind && e.lead_id === ev.lead_id && e.token === ev.dedupeToken && Date.now() - (e.at || 0) < ev.dedupeMs)) return null;
    const row = { id: 'e' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), at: ev.at || Date.now(), lead_id: ev.lead_id, kind: ev.kind, title: clip(ev.title, 200), detail: clip(ev.detail, 500), ...(ev.dedupeToken ? { token: ev.dedupeToken } : {}) };
    all.push(row);
    await st.put('as_tl:' + email, JSON.stringify(all.slice(-2000)), Date.now());
    return row;
  });
}

// A chat that names a lead's email is recorded on that contact. The prompt itself is not stored.
export async function noteAgentMentions(st, email, { text, agent, run_id } = {}) {
  const data = await readData(st, email);
  const leads = (crmAgent(data) && crmAgent(data).db && crmAgent(data).db.lead) || [];
  const blob = low(text);
  const hits = leads.filter((l) => l && l.email && blob.includes(low(l.email))).slice(0, 5);
  for (const l of hits) {
    await appendTl(st, email, { lead_id: l.id, kind: 'agent', title: (agent || 'Agent') + ' worked on this contact', detail: run_id ? 'Run ' + clip(run_id, 40) : 'Chat' });
  }
  return hits.length;
}

function viewLead(l, a) {
  return { id: l.id, name: nameOf(l), first_name: l.first_name || '', last_name: l.last_name || '', email: l.email || '', phone: l.phone || '', company: l.company || '', source: l.source || '', stage: l.stage || '', status: l.status || '', consent: l.consent || '', score: l.score || '', tags: l.tags || [], notes: l.notes || '', first_touch: l.first_touch || null, last_touch: l.last_touch || null, agent_id: a ? a.id : null };
}

async function timelineFor(st, email, id, order) {
  const data = await readData(st, email);
  const { agent, lead } = leadById(data, id);
  if (!lead) return null;
  const db = (agent && agent.db) || {};
  const [tracked, approvals] = await Promise.all([readTl(st, email), readApprovals(st, email)]);
  const events = assembleTimeline(lead, { tasks: db.task || [], activities: db.activity || [], approvals, tracked, order });
  return { lead, agent, events };
}

export async function timelineRoutes({ method, pathname, query, b, st, email, withDataLock, HttpError }) {
  const dash = pathname === '/api/crm/dashboard';
  const m = pathname.match(/^\/api\/leads\/(\d+)\/(timeline|notes|tasks)\/?$/);
  if (!dash && !m) return undefined;
  if (dash) {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const data = await readData(st, email);
    const a = crmAgent(data);
    const db = (a && a.db) || {};
    const leads = db.lead || [];
    const stages = Array.isArray(db.stages) && db.stages.length ? db.stages : DEFAULT_STAGES.slice();
    const [tracked, visRow] = await Promise.all([readTl(st, email), st.get('as_vis:' + email)]);
    const visits = parse(visRow && visRow.v, []) || [];
    return summarizeDashboard(leads, stages, { tracked, pageViews: visits.length });
  }
  const id = Number(m[1]), what = m[2];
  const key = 'as_data:' + email;
  if (what === 'timeline' && method === 'GET') {
    const order = String(query.get('order') || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const built = await timelineFor(st, email, id, order);
    if (!built) throw new HttpError(404, 'not_found', 'No lead with that id.');
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 100));
    const { visitPath } = await import('./tracking.js');
    const path = await visitPath(st, email, id);
    return { lead: viewLead(built.lead, built.agent), total: built.events.length, events: built.events.slice(0, limit), tracking: { visit_path: path, opted_out: optedOut(built.lead) } };
  }
  if (what === 'notes' && method === 'POST') {
    const text = String(b.text || '').trim();
    if (!text) throw new HttpError(400, 'bad_note', 'Write the note first.');
    if (text.length > 2000) throw new HttpError(400, 'bad_note', 'Keep the note under 2,000 characters.');
    return withDataLock(email, async () => {
      const data = await readData(st, email);
      const { agent, lead } = leadById(data, id);
      if (!lead) throw new HttpError(404, 'not_found', 'No lead with that id.');
      const next = (lead.notes ? lead.notes + '\n' : '') + text;
      if (next.length > 5000) throw new HttpError(400, 'bad_note', 'This contact’s notes are full (5,000 characters).');
      lead.notes = next; lead.upd = Date.now();
      (lead.hist ||= []).push({ at: Date.now(), t: 'Note: ' + text });
      data.rev = (Number(data.rev) || 0) + 1;
      await st.put(key, JSON.stringify(data), Date.now());
      return { ok: true, lead: viewLead(lead, agent) };
    });
  }
  if (what === 'tasks' && method === 'POST') {
    const title = String(b.title || '').trim();
    if (!title) throw new HttpError(400, 'bad_task', 'Give the task a title.');
    if (title.length > 200) throw new HttpError(400, 'bad_task', 'Keep the title under 200 characters.');
    let due = '';
    if (b.due != null && b.due !== '') {
      const d = Date.parse(b.due);
      if (!d) throw new HttpError(400, 'bad_task', 'Due date should look like 2026-10-22.');
      due = new Date(d).toISOString().slice(0, 10);
    }
    const prios = ['High', 'Normal', 'Low'];
    const priority = b.priority ? (prios.find((p) => p.toLowerCase() === String(b.priority).toLowerCase()) || null) : 'Normal';
    if (!priority) throw new HttpError(400, 'bad_task', 'Priority must be High, Normal or Low.');
    return withDataLock(email, async () => {
      const data = await readData(st, email);
      const { agent, lead } = leadById(data, id);
      if (!lead || !agent) throw new HttpError(404, 'not_found', 'No lead with that id.');
      agent.db.task = Array.isArray(agent.db.task) ? agent.db.task : [];
      const now = Date.now();
      const task = { id: (agent.db.task.reduce((mx, t) => Math.max(mx, Number(t.id) || 0), 0) || 0) + 1, title, due, priority, related: nameOf(lead) || lead.email || ('#' + lead.id), lead_id: lead.id, owner: '', status: 'Open', at: now, upd: now, hist: [{ at: now, t: 'Created' }] };
      agent.db.task.unshift(task);
      data.rev = (Number(data.rev) || 0) + 1;
      await st.put(key, JSON.stringify(data), Date.now());
      return { ok: true, task: { id: task.id, title: task.title, due: task.due, priority: task.priority, status: task.status, lead_id: lead.id } };
    });
  }
  throw new HttpError(405, 'method_not_allowed');
}
