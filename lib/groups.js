// Groups, task boards and the worker loop.
//
// A group is a team of agents with a lead (it plans goals into tasks) and a limit on how many of its tasks run at once.
// Each group has a kanban board: todo → running → review → done, or blocked. Tasks can have a parent (the goal they
// came from) and run "after" another task. The worker loop picks up todo tasks, runs them through the normal agent
// orchestrator, and moves them to review. Nothing a task wants to send, post or publish happens until the owner
// approves the task in review (its approvals run then).
//
// Storage (server-only keys, per customer):
//   as_groups:<email>  [{id,name,desc,lead,members:[agentId],limit,over:[groupId]}]
//   as_board:<email>   [{id,gid,title,body,aid,status,parent,after,gate,result,err,approvals:[id],at,updated,by}]
import crypto from 'node:crypto';
import { runAgent, decideApproval } from './orchestrator.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const uid = () => crypto.randomBytes(5).toString('hex');
const clip = (s, n) => String(s ?? '').slice(0, n);
export const STATUSES = ['todo', 'running', 'review', 'done', 'blocked'];
const getJ = async (st, k, d) => parse((await st.get(k))?.v, d) ?? d;
const putJ = (st, k, v) => st.put(k, JSON.stringify(v), Date.now());

// listeners for board events (the Slack bot subscribes): fn({ email, task, group, kind: 'review'|'blocked'|'done' })
const listeners = new Set();
export function onBoardEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const notify = (ev) => emit(ev); // other modules (scheduled briefs) post through the same listeners
const emit = (ev) => { for (const fn of listeners) Promise.resolve().then(() => fn(ev)).catch((e) => console.error('board listener', e.message)); };

// one lock per customer so the worker, the API and Slack never overwrite each other's board changes
const locks = new Map();
async function withBoard(st, email, fn) {
  const prev = locks.get(email) || Promise.resolve();
  let release; const next = new Promise((r) => { release = r; });
  locks.set(email, prev.then(() => next));
  await prev;
  try { const board = await getJ(st, 'as_board:' + email, []); const out = await fn(board); await putJ(st, 'as_board:' + email, board); return out; }
  finally { release(); }
}

// ---------- groups ----------
// First use: build groups from the agents' stored `group` field (Desk, Factory, Growth, Orchestrator…).
export async function getGroups(st, email, data) {
  let groups = await getJ(st, 'as_groups:' + email, null);
  if (groups) return groups;
  const agents = ((data && data.agents) || []).filter((a) => a && a.group);
  const names = [...new Set(agents.map((a) => a.group))];
  groups = names.map((name) => { const m = agents.filter((a) => a.group === name); return { id: 'g' + uid(), name, desc: '', lead: m[0].id, members: m.map((a) => a.id), limit: 1, over: [] }; });
  await putJ(st, 'as_groups:' + email, groups);
  return groups;
}
export async function saveGroup(st, email, data, input) {
  const groups = await getGroups(st, email, data), ids = new Set(((data && data.agents) || []).map((a) => a.id));
  let g = groups.find((x) => x.id === input.id);
  if (!g) { if (!clip(input.name, 60).trim()) throw new Error('A group needs a name.'); g = { id: 'g' + uid(), name: '', desc: '', lead: null, members: [], limit: 1, over: [] }; groups.push(g); }
  if (input.name != null) g.name = clip(input.name, 60).trim() || g.name;
  if (input.desc != null) g.desc = clip(input.desc, 400);
  if (Array.isArray(input.members)) g.members = input.members.map(Number).filter((id) => ids.has(id));
  if (input.lead != null) g.lead = ids.has(Number(input.lead)) ? Number(input.lead) : g.lead;
  if (input.limit != null) g.limit = Math.max(1, Math.min(2, Number(input.limit) || 1)); // 1–2 tasks at once per group
  if (Array.isArray(input.over)) g.over = input.over.filter((id) => groups.some((x) => x.id === id && x.id !== g.id));
  if (g.lead != null && !g.members.includes(g.lead)) g.members.unshift(g.lead);
  await putJ(st, 'as_groups:' + email, groups);
  return g;
}
export async function deleteGroup(st, email, id) {
  const groups = await getJ(st, 'as_groups:' + email, []);
  await putJ(st, 'as_groups:' + email, groups.filter((g) => g.id !== id));
  await withBoard(st, email, (board) => { for (const t of board) if (t.gid === id && t.status !== 'done') { t.status = 'blocked'; t.err = 'Its group was deleted.'; } });
  return { ok: true };
}
// find a group by id or by name ("desk", "Factory")
export const findGroup = (groups, key) => groups.find((g) => g.id === key) || groups.find((g) => g.name.toLowerCase() === String(key || '').toLowerCase().trim());

// ---------- tasks ----------
export async function addTask(st, email, t) {
  return withBoard(st, email, (board) => {
    const task = { id: 't' + uid(), gid: t.gid, title: clip(t.title, 200), body: clip(t.body, 4000), aid: t.aid == null ? null : Number(t.aid),
      status: STATUSES.includes(t.status) ? t.status : 'todo', parent: t.parent || null, after: t.after || null, gate: !!t.gate, research: t.research !== false, ...(t.send ? { send: t.send } : {}),
      result: '', err: clip(t.err, 300), approvals: [], at: Date.now(), updated: Date.now(), by: clip(t.by || 'owner', 60), note: clip(t.note, 300) };
    board.push(task); return task;
  });
}
export async function updateTask(st, email, id, patch) {
  return withBoard(st, email, (board) => {
    const t = board.find((x) => x.id === id); if (!t) throw new Error('No such task.');
    if (patch.title != null) t.title = clip(patch.title, 200);
    if (patch.body != null) t.body = clip(patch.body, 4000);
    if (patch.aid !== undefined) t.aid = patch.aid == null ? null : Number(patch.aid);
    if (patch.status && STATUSES.includes(patch.status) && patch.status !== 'running') { t.status = patch.status; if (patch.status === 'todo') t.err = ''; }
    t.updated = Date.now(); return t;
  });
}
export async function deleteTask(st, email, id) {
  return withBoard(st, email, (board) => { const i = board.findIndex((x) => x.id === id); if (i >= 0) board.splice(i, 1); return { ok: true }; });
}
// Approve or reject a task in review. Approving runs the task's pending approvals (posts, publishing, commands).
export async function decideTask(st, email, id, approve, secret, note = '') {
  const board = await getJ(st, 'as_board:' + email, []), t0 = board.find((x) => x.id === id);
  if (!t0) throw new Error('No such task.');
  if (t0.status !== 'review') throw new Error('Only tasks in review can be approved or rejected.');
  const results = [];
  for (const aid of t0.approvals || []) { const r = await decideApproval({ st, email, id: aid, approve, secret }); if (r.approval) results.push(r.approval); }
  const failed = results.filter((a) => a.status === 'failed');
  const task = await withBoard(st, email, (b) => {
    const t = b.find((x) => x.id === id); if (!t) return null;
    t.status = !approve ? 'blocked' : failed.length ? 'blocked' : 'done';
    t.err = !approve ? clip('Rejected' + (note ? ': ' + note : ''), 300) : failed.length ? clip('Approved, but ' + failed.map((a) => a.summary + ': ' + a.result).join('; '), 300) : '';
    if (results.length) t.result += '\n\n' + results.map((a) => `${a.summary} → ${a.status}${a.result ? ': ' + a.result : ''}`).join('\n');
    t.updated = Date.now(); return t;
  });
  if (task) { emit({ email, task, kind: task.status }); await rollUp(st, email, task.parent); }
  return { task, approvals: results };
}
// a goal task moves to review once all of its child tasks are in review or done
async function rollUp(st, email, parentId) {
  if (!parentId) return;
  let ev = null;
  await withBoard(st, email, (board) => {
    const p = board.find((x) => x.id === parentId), kids = board.filter((x) => x.parent === parentId);
    if (!p || !kids.length || p.status === 'done') return;
    if (kids.every((k) => k.status === 'done')) { p.status = 'done'; p.updated = Date.now(); }
    else if (kids.every((k) => ['review', 'done'].includes(k.status)) && p.status !== 'review') {
      p.status = 'review'; p.updated = Date.now();
      p.result = kids.map((k) => `### ${k.title}\n${clip(k.result, 1500)}`).join('\n\n');
      ev = { email, task: p, kind: 'review' };
    }
  });
  if (ev) emit(ev);
}

// ---------- goals: the group's lead plans the work ----------
export async function planGoal({ st, email, data, groups, gid, goal, ai, by = 'owner' }) {
  const g = findGroup(groups, gid); if (!g) throw new Error('No such group.');
  const agents = ((data && data.agents) || []).filter((a) => a && g.members.includes(a.id));
  const lead = agents.find((a) => a.id === g.lead) || agents[0];
  if (!lead) throw new Error('This group has no agents.');
  const roster = agents.map((a) => `${a.id} = ${a.name}: ${clip(a.d, 160)}`).join('\n');
  const prompt = `You are ${lead.name}, lead of the ${g.name} group. ${clip(lead.d, 400)}
Break the owner's goal into 2 to 5 concrete tasks for your group, chained in order: every task after the first sets "after" to the index of the task whose result it builds on. Assign each to the best member by id.${chainHint(g)} Set "gate": true when the next step must wait for the owner's approval (for example before a build starts or before publishing).
Rules: nothing gets sent, posted, published or bought without approval; keep it small and cheap; no invented facts.
Members:
${roster}

Goal: ${clip(goal, 2000)}

Reply with JSON only, no prose: {"tasks":[{"title":"...","body":"what to do and what to deliver","assignee_id":0,"after":null,"research":true,"gate":false}]}
Set "research": true for tasks that need web lookups.`;
  let plan = [];
  try {
    const txt = (await ai(prompt, 'planner', { long: true, max: 2500 })).text || '';
    const j = parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0], {});
    plan = (Array.isArray(j.tasks) ? j.tasks : []).slice(0, 5);
  } catch (e) { console.error('plan goal', e.message); }
  plan = ensureChain(plan, goal, agents, lead);
  const parent = await addTask(st, email, { gid: g.id, title: 'Goal: ' + clip(goal, 180), body: goal, aid: lead.id, status: 'running', by, note: 'Planned by ' + lead.name });
  const made = [];
  for (const p of plan) {
    const aid = agents.some((a) => a.id === Number(p.assignee_id)) ? Number(p.assignee_id) : lead.id;
    const after = Number.isInteger(p.after) && made[p.after] ? made[p.after].id : null;
    made.push(await addTask(st, email, { gid: g.id, title: p.title || 'Task', body: p.body || '', aid, parent: parent.id, after, gate: !!p.gate, research: p.research !== false, by: lead.name }));
  }
  return { parent, tasks: made, lead: lead.name };
}

// Group-specific chain advice for the planner (Factory: Scout researches, Spec turns it into a brief).
function chainHint(g) {
  if (/factory/i.test(g.name)) return '\nFactory works as a chain: Scout researches and shortlists first, then Spec (or the best fit) turns that into a short, sourced brief; Builder/Verifier/Publisher only when the goal asks for a build or launch.';
  return '';
}
// A plan must have at least 2 tasks, each one chained to the task before it.
function ensureChain(plan, goal, agents, lead) {
  plan = plan.filter((p) => p && (p.title || p.body));
  if (plan.length < 2) {
    const second = agents.find((a) => a.id !== lead.id && /spec|writer|chief|copy/i.test(a.name)) || lead;
    plan = [
      plan[0] || { title: 'Research: ' + clip(goal, 160), body: 'Research this goal and collect sourced findings: ' + goal, assignee_id: lead.id, research: true },
      { title: 'Write up: ' + clip(goal, 160), body: 'Turn the earlier findings into the finished deliverable for this goal, with sources, marking anything unknown: ' + goal, assignee_id: second.id, research: false },
    ];
  }
  return plan.map((p, i) => ({ ...p, after: i === 0 ? null : (Number.isInteger(p.after) && p.after < i ? p.after : i - 1) }));
}

// ---------- worker loop ----------
const runningNow = new Set();
// Run what can run: per group, up to its limit; a task with "after" waits until that task is in review (or done when gated).
export async function workerTick({ st, secret, wpSearch, wpChunks, getName }) {
  const rows = typeof st.listPrefix === 'function' ? await st.listPrefix('as_board:') : (await st.all()).filter((it) => it.k.startsWith('as_board:'));
  let started = 0;
  for (const row of rows) {
    if (!row || !row.v) continue;
    const email = row.k.slice(9);
    const data = parse((await st.get('as_data:' + email))?.v, null);
    const groups = await getJ(st, 'as_groups:' + email, []);
    const picks = await withBoard(st, email, (board) => {
      const out = [];
      for (const g of groups) {
        let busy = board.filter((t) => t.gid === g.id && t.status === 'running' && !isGoal(board, t)).length;
        const ready = board.filter((t) => t.gid === g.id && t.status === 'todo' && depOk(board, t)).sort((a, b) => a.at - b.at);
        for (const t of ready) { if (busy >= (g.limit || 1)) break; t.status = 'running'; t.started = Date.now(); t.updated = Date.now(); busy++; out.push(t.id); }
      }
      return out;
    });
    for (const id of picks) { started++; runTask({ st, email, id, data, secret, wpSearch, wpChunks, getName }).catch((e) => console.error('task', id, e.message)); }
  }
  return { started };
}
const isGoal = (board, t) => board.some((x) => x.parent === t.id);
function depOk(board, t) {
  if (!t.after) return true;
  const d = board.find((x) => x.id === t.after);
  if (!d) return true;
  return d.gate ? d.status === 'done' : ['review', 'done'].includes(d.status);
}
async function runTask({ st, email, id, data, secret, wpSearch, wpChunks, getName }) {
  if (runningNow.has(id)) return; runningNow.add(id);
  try {
    const board = await getJ(st, 'as_board:' + email, []), t = board.find((x) => x.id === id); if (!t) return;
    const agent = ((data && data.agents) || []).find((a) => a.id === t.aid) || null;
    const dep = t.after ? board.find((x) => x.id === t.after) : null;
    const goal = t.parent ? board.find((x) => x.id === t.parent) : null;
    const message = `Board task "${t.title}"${goal ? ` (part of the goal: ${clip(goal.body, 600)})` : ''}.\n${t.body}\n${dep ? `\nResult of the earlier task "${dep.title}":\n${clip(dep.result, 3000)}\n` : ''}
Do the task now and reply with the finished deliverable. Anything that would send, post, publish or spend must be proposed for approval, never done directly. Your result goes to the owner for review.`;
    const sendMsg = t.send && `Send an APPROVED reply. The owner approved this exact text; post it word for word, change nothing.
Where: ${t.send.url} (${t.send.platform})${t.send.to ? '\nTo: ' + t.send.to : ''}
Text:
${t.send.text}
Steps: open the link with browser_open, find the reply / comment / message box, type the text, press the send / reply button, then read the page to confirm it appears.
If you are not signed in, the page is gone, or anything differs from what was approved, do NOT improvise: stop.
Start your answer with exactly "SENT" or "NOT SENT", then one line on what happened.`;
    let out, err = '';
    try { out = await runAgent({ st, email, userName: getName ? await getName(email) : '', data, agent, message: sendMsg || message, history: [], tz: 'Asia/Kolkata', mode: 'routine', secret, wpSearch, wpChunks, maxSteps: t.send ? 15 : t.research === false ? 12 : 25, ...(t.send ? { approvedSend: t.send } : {}) }); }
    catch (e) { err = clip(e.message, 300); }
    const task = await withBoard(st, email, (b) => {
      const x = b.find((y) => y.id === id); if (!x) return null;
      if (x.status === 'blocked' && String(x.err || '').startsWith('Cancelled')) return null; // cancelled while running: keep it cancelled
      if (!err && x.send && !/^\W*SENT\b/.test(String(out.answer || ''))) err = clip('Not sent: ' + String(out.answer || '').replace(/^\W*NOT SENT\W*/, ''), 300);
      if (err) { x.status = 'blocked'; x.err = err; }
      else { x.status = x.send ? 'done' : 'review'; x.result = clip(out.answer, 12000); x.approvals = (out.approvals || []).map((a) => a.id); x.outbound = x.approvals.length > 0; }
      x.updated = Date.now(); return x;
    });
    if (task) { emit({ email, task, kind: task.status }); await rollUp(st, email, task.parent); }
  } finally { runningNow.delete(id); }
}
// after a restart nothing is really running: put interrupted tasks back in todo
export async function resetInterrupted(st) {
  const rows = typeof st.listPrefix === 'function' ? await st.listPrefix('as_board:') : (await st.all()).filter((it) => it.k.startsWith('as_board:'));
  for (const row of rows) if (row && row.v) await withBoard(st, row.k.slice(9), (board) => { for (const t of board) if (t.status === 'running' && !isGoal(board, t)) { t.status = 'todo'; t.note = 'Restarted after a server restart.'; } });
}

// ---------- routines: pause / resume ----------
export async function setRoutinePaused(st, email, id, paused) {
  const all = await getJ(st, 'as_rt:' + email, []), r = all.find((x) => x.id === id);
  if (!r) throw new Error('No such routine.');
  r.paused = !!paused; r.on = true;
  if (!paused && r.next < Date.now()) r.next = r.hour != null ? nextAt(r.hour, r.minute || 0, r.tz) : Date.now() + 60e3; // resuming never fires a backlog
  await putJ(st, 'as_rt:' + email, all); return r;
}

// ---------- daily routines at a fixed local time ----------
// {id?, aid, title, prompt, hour, minute, tz, board?: gid, slack?: bool, paused?: bool}
export function nextAt(hour, minute, tz = 'Asia/Kolkata', from = Date.now()) {
  // offset of tz at "from" (no DST in Asia/Kolkata; good enough for others within a day)
  const part = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  const p = part(new Date(from)), asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second), off = asUtc - Math.floor(from / 1000) * 1000;
  let t = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute) - off;
  while (t <= from) t += 864e5;
  return t;
}
export async function saveRoutine(st, email, b) {
  const list = await getJ(st, 'as_rt:' + email, []);
  const hour = Math.min(23, Math.max(0, Math.floor(Number(b.hour)))), minute = Math.min(59, Math.max(0, Math.floor(Number(b.minute) || 0)));
  if (!Number.isFinite(hour)) throw new Error('Give the hour (0-23).');
  if (!b.title || !b.prompt) throw new Error('Give a title and the instructions.');
  const tz = b.tz || 'Asia/Kolkata';
  let r = b.id ? list.find((x) => x.id === b.id) : list.find((x) => x.on && x.title === b.title && x.aid === b.aid);
  if (!r) { r = { id: 'r_' + uid(), at: Date.now() }; list.push(r); }
  Object.assign(r, { aid: b.aid === 'assistant' ? 'assistant' : Number(b.aid), title: clip(b.title, 80), prompt: clip(b.prompt, 4000), every: 1, tz, hour, minute, on: true, paused: !!b.paused,
    board: b.board || null, slack: !!b.slack, next: nextAt(hour, minute, tz) });
  await putJ(st, 'as_rt:' + email, list);
  return r;
}

// Cancel an unfinished task: blocked + "Cancelled", pending approvals on it declined (nothing is sent).
export async function cancelTask(st, email, id, reason = '') {
  const t0 = (await getJ(st, 'as_board:' + email, [])).find((x) => x.id === id);
  if (!t0) throw new Error('No such task.');
  if (['done', 'blocked'].includes(t0.status)) throw new Error('That task is already ' + t0.status + '.');
  const all = await getJ(st, 'as_appr:' + email, []);
  for (const a of all) if ((t0.approvals || []).includes(a.id) && a.status === 'pending') { a.status = 'declined'; a.done = Date.now(); }
  await putJ(st, 'as_appr:' + email, all);
  const task = await withBoard(st, email, (b) => { const x = b.find((y) => y.id === id); if (!x) return null; x.status = 'blocked'; x.err = clip('Cancelled' + (reason ? ': ' + reason : ''), 300); x.updated = Date.now(); return x; });
  if (task) { emit({ email, task, kind: 'cancelled' }); await rollUp(st, email, task.parent); }
  return task;
}
