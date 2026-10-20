// Learning Chief of Staff (v2.2, pillar 4). Once a week, on the same routines tick as workflows,
// each account's own timeline, tracking, workflow runs and approvals are read and turned into
// 3–5 plain-English suggestions. Apply creates a draft workflow, or a change that still needs a
// separate confirm. Nothing is sent from here. Send, post and pay stay on needs approval.
// A/B tests pick a subject/body variant per contact. Auto-pick may copy the winning words onto a
// step the customer already set to auto, and it never sends, never changes the approval setting,
// and never lifts the contact, step or account send caps.
import crypto from 'node:crypto';
import { interpret, normalizeCompiled, lockOutbound, insertDraftWorkflow, updateWorkflowStepCopy } from './workflows.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const DAY = 864e5;
const WEEK = 7 * DAY;
const COS = 'as_cos:', AB = 'as_abt:';
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const chains = new Map();
function withCos(email, fn) {
  const prev = chains.get(email) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = prev.catch(() => {}).then(() => gate);
  chains.set(email, tail);
  return prev.catch(() => {}).then(async () => {
    try { return await fn(); }
    finally { release(); if (chains.get(email) === tail) chains.delete(email); }
  });
}

function blank() {
  return { next_at: 0, last_at: 0, suggestions: [], changes: [], learned: [], prefs: { subject_style: '', short_votes: 0, greeting: '', greet_votes: {}, avoid: [], no_posts: false, post_rejects: 0, hold_email: false } };
}
async function readState(st, email) {
  const row = parse((await st.get(COS + email))?.v, null);
  const b = blank();
  if (!row || typeof row !== 'object') return b;
  return { ...b, ...row, prefs: { ...b.prefs, ...(row.prefs || {}) }, suggestions: row.suggestions || [], changes: row.changes || [], learned: row.learned || [] };
}
async function writeState(st, email, state) {
  state.suggestions = (state.suggestions || []).slice(-40);
  state.changes = (state.changes || []).slice(-40);
  state.learned = (state.learned || []).slice(-400);
  state.prefs.avoid = (state.prefs.avoid || []).slice(-20);
  await st.put(COS + email, JSON.stringify(state), Date.now());
}
async function readTests(st, email) { return parse((await st.get(AB + email))?.v, []) || []; }
async function writeTests(st, email, list) { await st.put(AB + email, JSON.stringify(list.slice(-20)), Date.now()); }

export function shapeDraft(subject, body, prefs) {
  const p = prefs || {};
  let sub = String(subject || '');
  let text = String(body || '');
  for (const phrase of p.avoid || []) {
    const raw = String(phrase || '').trim();
    if (raw.length < 3 || raw.length > 80) continue;
    const re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    sub = sub.replace(re, ' ');
    text = text.replace(re, ' ');
  }
  sub = sub.replace(/\s{2,}/g, ' ').trim();
  text = text.replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (p.greeting && !text.toLowerCase().startsWith(String(p.greeting).toLowerCase())) text = String(p.greeting).replace(/\s+$/, '') + '\n\n' + text;
  if (p.subject_style === 'short' && sub.length > 42) {
    const cut = sub.slice(0, 42);
    const sp = cut.lastIndexOf(' ');
    sub = (sp > 16 ? cut.slice(0, sp) : cut).trim();
  }
  return { subject: sub.slice(0, 200), body: text.slice(0, 4000) };
}

export async function shapeEmailSteps(st, email, wf) {
  const state = await readState(st, email);
  const prefs = state.prefs || {};
  for (const s of wf.steps || []) {
    if (s.type !== 'draft_email' && s.type !== 'send_email') continue;
    const shaped = shapeDraft(s.subject, s.body, prefs);
    s.subject = shaped.subject;
    s.body = shaped.body;
    if (prefs.hold_email) delete s.suggested_autonomy;
  }
  return wf;
}

function prefsView(p = {}) {
  return { subject_style: p.subject_style || '', greeting: p.greeting || '', avoid: p.avoid || [], no_posts: !!p.no_posts, hold_email: !!p.hold_email };
}

// One edit or rejection updates this account's preferences. The same approval is counted once.
export async function learnApproval(st, email, approval, { kind } = {}) {
  if (!approval || !approval.id) return;
  return withCos(email, async () => {
    const state = await readState(st, email);
    const mark = approval.id + ':' + (kind || 'edit') + ':' + ((approval.edits || []).length);
    if (state.learned.includes(mark)) return prefsView(state.prefs);
    state.learned.push(mark);
    const prefs = state.prefs;
    const last = (approval.edits || [])[(approval.edits || []).length - 1] || {};
    const from = last.from || {};
    const to = last.to || {};
    if (kind !== 'reject' && from.subject && to.subject && String(to.subject).length < String(from.subject).length && String(to.subject).length <= String(from.subject).length * 0.85) {
      prefs.short_votes = (prefs.short_votes || 0) + 1;
      if (prefs.short_votes >= 2) prefs.subject_style = 'short';
    }
    if (kind !== 'reject' && to.body) {
      const line = String(to.body).split('\n')[0].trim();
      if (line.length >= 8 && line.length <= 40 && !String(from.body || '').startsWith(line)) {
        prefs.greet_votes = prefs.greet_votes || {};
        prefs.greet_votes[line] = (prefs.greet_votes[line] || 0) + 1;
        if (prefs.greet_votes[line] >= 2) prefs.greeting = line;
      }
    }
    if (kind === 'reject') {
      const note = clip(approval.note || '', 80);
      if (note.length >= 3 && !(prefs.avoid || []).some((x) => x.toLowerCase() === note.toLowerCase())) prefs.avoid = [...(prefs.avoid || []), note];
      if (/^post\b/i.test(approval.summary || '')) {
        prefs.post_rejects = (prefs.post_rejects || 0) + 1;
        if (prefs.post_rejects >= 2) prefs.no_posts = true;
      }
    }
    await writeState(st, email, state);
    return prefsView(prefs);
  });
}

function won(l) { return /^(won|converted)$/i.test(l.stage || '') || /^(won|converted)$/i.test(l.status || ''); }
function ratioOf(best, rest) {
  if (!best || !rest || best.sent < 4 || rest.sent < 4) return null;
  const br = best.hit / best.sent, rr = rest.hit / rest.sent;
  if (rr > 0 && br < rr * 1.8) return null;
  if (rr === 0 && br < 0.5) return null;
  let phrase = '';
  if (rr > 0) {
    const m = br / rr;
    const rounded = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
    phrase = (Number.isInteger(rounded) ? String(rounded) : String(rounded)) + '×';
  }
  const score = (rr > 0 ? br / rr : br + 2) * Math.log(best.sent + rest.sent);
  return { phrase, best, rest, score };
}
function attribute(sends, events) {
  return sends.map((s) => {
    const hit = events.some((e) => String(e.lead_id) === String(s.lead_id) && e.at >= s.at && e.at <= s.at + 14 * DAY && !sends.some((o) => String(o.lead_id) === String(s.lead_id) && o.at > s.at && o.at <= e.at));
    return { ...s, hit };
  });
}
function bestDay(rows) {
  const days = WEEKDAYS.map(() => ({ sent: 0, hit: 0 }));
  for (const r of rows) { const d = new Date(r.at).getUTCDay(); days[d].sent++; if (r.hit) days[d].hit++; }
  let pick = null;
  days.forEach((g, i) => {
    const rest = { sent: 0, hit: 0 };
    days.forEach((o, j) => { if (j !== i) { rest.sent += o.sent; rest.hit += o.hit; } });
    const stat = ratioOf(g, rest);
    if (stat && (!pick || stat.score > pick.score)) pick = { ...stat, weekday: i, day: WEEKDAYS[i] };
  });
  return pick;
}
function bestSource(groups) {
  let pick = null;
  for (const g of groups) {
    const rest = { sent: 0, hit: 0 };
    for (const o of groups) if (o !== g) { rest.sent += o.n; rest.hit += o.hit; }
    const stat = ratioOf({ sent: g.n, hit: g.hit }, rest);
    if (stat && (!pick || stat.score > pick.score)) pick = { ...stat, source: g.source };
  }
  return pick;
}
export function suggestFromFacts({ leads = [], sends = [], opens = [], clicks = [], approvals = [] } = {}) {
  const out = [];
  const openRows = attribute(sends, opens);
  const clickRows = attribute(sends, clicks);
  const dayOpens = bestDay(openRows);
  if (dayOpens) {
    const tail = dayOpens.phrase
      ? `Emails sent on ${dayOpens.day} get about ${dayOpens.phrase} the opens of other days (${dayOpens.best.hit} of ${dayOpens.best.sent} opened, against ${dayOpens.rest.hit} of ${dayOpens.rest.sent}).`
      : `Emails sent on ${dayOpens.day} were opened far more often than on other days (${dayOpens.best.hit} of ${dayOpens.best.sent} opened, against ${dayOpens.rest.hit} of ${dayOpens.rest.sent}).`;
    out.push({ key: 'weekday_opens:' + dayOpens.weekday, kind: 'weekday_opens', action: 'workflow', weekday: dayOpens.weekday, day: dayOpens.day, score: dayOpens.score, text: tail + ' Apply this to draft a reminder for ' + dayOpens.day + '. It does not send an email.' });
  }
  const dayClicks = bestDay(clickRows);
  if (dayClicks && (!dayOpens || dayClicks.weekday !== dayOpens.weekday || dayClicks.phrase !== dayOpens.phrase)) {
    const tail = dayClicks.phrase
      ? `Emails sent on ${dayClicks.day} get about ${dayClicks.phrase} the clicks of other days (${dayClicks.best.hit} of ${dayClicks.best.sent} clicked, against ${dayClicks.rest.hit} of ${dayClicks.rest.sent}).`
      : `Emails sent on ${dayClicks.day} were clicked far more often than on other days (${dayClicks.best.hit} of ${dayClicks.best.sent} clicked, against ${dayClicks.rest.hit} of ${dayClicks.rest.sent}).`;
    out.push({ key: 'weekday_clicks:' + dayClicks.weekday, kind: 'weekday_clicks', action: 'workflow', weekday: dayClicks.weekday, day: dayClicks.day, score: dayClicks.score, text: tail + ' Apply this to draft a reminder. It does not send an email.' });
  }
  const bySource = new Map();
  for (const l of leads) {
    const raw = String(l.source || 'Unknown').trim() || 'Unknown';
    const k = raw.toLowerCase();
    if (!bySource.has(k)) bySource.set(k, { source: raw, n: 0, hit: 0 });
    const g = bySource.get(k); g.n++; if (won(l)) g.hit++;
  }
  const conv = bestSource([...bySource.values()]);
  if (conv) {
    out.push({
      key: 'source_wins:' + conv.source.toLowerCase(), kind: 'source_wins', action: 'workflow', source: conv.source, score: conv.score + 0.5,
      text: `Leads from ${conv.source} convert best (${conv.best.hit} of ${conv.best.sent} won, against ${conv.rest.hit} of ${conv.rest.sent} from other sources). Apply this to draft a welcome email for that source. The email waits for your approval. Nothing is sent.`,
    });
  }
  const sendSource = new Map();
  for (const s of openRows) {
    const raw = String(s.source || 'Unknown').trim() || 'Unknown';
    const k = raw.toLowerCase();
    if (!sendSource.has(k)) sendSource.set(k, { source: raw, n: 0, hit: 0 });
    const g = sendSource.get(k); g.n++; if (s.hit) g.hit++;
  }
  const srcOpens = bestSource([...sendSource.values()]);
  if (srcOpens) {
    const tail = srcOpens.phrase
      ? `Emails to leads from ${srcOpens.source} get about ${srcOpens.phrase} the opens of other sources (${srcOpens.best.hit} of ${srcOpens.best.sent} opened, against ${srcOpens.rest.hit} of ${srcOpens.rest.sent}).`
      : `Emails to leads from ${srcOpens.source} were opened far more often than other sources (${srcOpens.best.hit} of ${srcOpens.best.sent} opened, against ${srcOpens.rest.hit} of ${srcOpens.rest.sent}).`;
    out.push({ key: 'source_opens:' + srcOpens.source.toLowerCase(), kind: 'source_opens', action: 'workflow', source: srcOpens.source, score: srcOpens.score, text: tail + ' Apply this to draft a welcome email. It waits for your approval. Nothing is sent.' });
  }
  const postNo = (approvals || []).filter((a) => a && a.status === 'declined' && /^post\b/i.test(a.summary || '')).length;
  if (postNo >= 2) out.push({ key: 'rejected_posts', kind: 'rejected_posts', action: 'workflow', score: 1, text: 'You rejected posts from workflows. Apply this to draft a reminder instead of a post. Nothing is posted.' });
  const touched = (approvals || []).filter((a) => a && (a.kind === 'email' || /^email\b/i.test(a.summary || '')) && (a.status === 'declined' || a.edited)).length;
  if (touched >= 3) out.push({ key: 'hold_email', kind: 'hold_email', action: 'change', score: 0.5, text: 'You edit or reject most email drafts. Apply this to remember that new email steps stay on needs approval until you change them yourself. Nothing is sent.' });
  out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return out.slice(0, 5).map(({ score, ...rest }) => rest);
}

export function draftFromSuggestion(suggestion, prefs) {
  if (!suggestion || suggestion.action !== 'workflow') return null;
  let raw;
  if (suggestion.kind === 'weekday_opens' || suggestion.kind === 'weekday_clicks') {
    raw = normalizeCompiled(interpret('Every week, remind me to send follow-ups'));
    raw.trigger.weekday = suggestion.weekday;
    raw.trigger.every_days = 7;
    raw.name = 'Follow up on ' + (suggestion.day || 'that day');
  } else if (suggestion.kind === 'source_wins' || suggestion.kind === 'source_opens') {
    const source = clip(suggestion.source || 'that source', 60);
    raw = normalizeCompiled(interpret('When a new lead comes from ' + source + ', tag them and draft a welcome email'));
  } else if (suggestion.kind === 'rejected_posts') {
    raw = normalizeCompiled(interpret('Every week, remind me to review posts'));
    raw.steps = (raw.steps || []).filter((s) => s.type !== 'social_post');
  } else return null;
  for (const s of raw.steps || []) {
    if (s.type === 'draft_email' || s.type === 'send_email') {
      const shaped = shapeDraft(s.subject, s.body, prefs);
      s.subject = shaped.subject;
      s.body = shaped.body;
    }
  }
  raw.prompt = clip(suggestion.text || '', 500);
  raw.status = 'draft';
  if (suggestion.weekday != null) raw.trigger.next = 1;
  return lockOutbound(raw);
}

// Auto-pick never sends and never changes the approval setting. Copy is applied only when the
// customer already turned that email step to auto or auto within limits. Otherwise it waits.
export function autoPickDecision(step, test) {
  const customerAuto = step && step.type === 'send_email' && step.autonomy_set_by === 'customer' && (step.autonomy === 'auto' || step.autonomy === 'auto_within_limits');
  if (test && test.auto_pick && customerAuto) return { apply_copy: true, send: false, needs_confirmation: false };
  return { apply_copy: false, send: false, needs_confirmation: true };
}

async function loadFacts(st, email) {
  const data = parse((await st.get('as_data:' + email))?.v, null) || { agents: [] };
  const crm = (data.agents || []).find((a) => a && a.kind === 'crm');
  const leads = (crm && crm.db && crm.db.lead) || [];
  const runs = parse((await st.get('as_wfr:' + email))?.v, []) || [];
  const tracked = parse((await st.get('as_tl:' + email))?.v, []) || [];
  const approvals = parse((await st.get('as_appr:' + email))?.v, []) || [];
  const leadOf = (id) => leads.find((l) => l && Number(l.id) === Number(id));
  const sends = [];
  for (const r of runs) for (const line of r.log || []) {
    if ((line.type === 'send_email' || line.type === 'draft_email') && (line.result === 'sent' || line.result === 'queued_approval') && line.at && r.lead_id != null) {
      const lead = leadOf(r.lead_id);
      sends.push({ at: line.at, lead_id: r.lead_id, source: (lead && lead.source) || '' });
    }
  }
  return {
    leads: leads.map((l) => ({ id: l.id, source: l.source || '', stage: l.stage || '', status: l.status || '' })),
    sends, opens: tracked.filter((e) => e && e.kind === 'open').map((e) => ({ at: e.at, lead_id: e.lead_id })),
    clicks: tracked.filter((e) => e && e.kind === 'click').map((e) => ({ at: e.at, lead_id: e.lead_id })),
    approvals,
  };
}

async function reviewUnlocked(st, email, now) {
  const state = await readState(st, email);
  if (!state.next_at) { state.next_at = now + WEEK; await writeState(st, email, state); return false; }
  if (state.next_at > now) return false;
  const facts = await loadFacts(st, email);
  const fresh = suggestFromFacts(facts);
  const have = new Map((state.suggestions || []).map((s) => [s.key, s]));
  for (const s of fresh) {
    if (have.has(s.key)) {
      const old = have.get(s.key);
      if (old.status === 'open') old.text = s.text;
      continue;
    }
    if ((state.suggestions || []).filter((x) => x.status === 'open').length >= 5) continue;
    state.suggestions.push({ id: 'sg' + uid(), status: 'open', at: now, ...s });
  }
  state.last_at = now;
  state.next_at = now + WEEK;
  await writeState(st, email, state);
  await settleAllUnlocked(st, email, now);
  return true;
}

function testView(t) {
  return {
    id: t.id, workflow_id: t.workflow_id, step_id: t.step_id, status: t.status, metric: t.metric,
    min_sample: t.min_sample, auto_pick: !!t.auto_pick, winner: t.winner || '',
    variants: (t.variants || []).map((v) => ({ key: v.key, subject: v.subject, body: v.body, used: v.used || 0, opens: v.opens || 0, clicks: v.clicks || 0 })),
  };
}
function sugView(s) {
  return { id: s.id, key: s.key, kind: s.kind, text: s.text, action: s.action, status: s.status, at: s.at, workflow_id: s.workflow_id || '', change_id: s.change_id || '' };
}

async function readWf(st, email, id) {
  const all = parse((await st.get('as_wf:' + email))?.v, []) || [];
  return all.find((w) => w && w.id === id) || null;
}

function rates(test) {
  const metric = test.metric === 'clicks' ? 'clicks' : 'opens';
  return (test.variants || []).map((v) => ({ v, rate: v.used ? (v[metric] || 0) / v.used : 0 }));
}
function winnerPair(test) {
  const rows = rates(test);
  if (rows.length < 2) return null;
  if (rows.some((r) => (r.v.used || 0) < test.min_sample)) return null;
  if (rows[0].rate === rows[1].rate) return null;
  const [win, lose] = rows[0].rate > rows[1].rate ? [rows[0], rows[1]] : [rows[1], rows[0]];
  return { win: win.v, lose: lose.v, phrase: lose.rate > 0 ? (Math.round((win.rate / lose.rate) * 10) / 10) : 0 };
}

async function settleOneUnlocked(st, email, test, now) {
  if (!test || test.status === 'done' || test.status === 'stopped' || test.status === 'winner_pending') return;
  const pair = winnerPair(test);
  if (!pair) return;
  const wf = await readWf(st, email, test.workflow_id);
  const step = wf && (wf.steps || []).find((s) => s.id === test.step_id);
  const decision = autoPickDecision(step, test);
  test.winner = pair.win.key;
  test.updated = now;
  const noun = test.metric === 'clicks' ? 'clicks' : 'opens';
  const times = pair.phrase ? `about ${pair.phrase}× the ${noun}` : `more ${noun}`;
  const text = `“${pair.win.subject}” got ${times} (${pair.win[noun] || 0} of ${pair.win.used}, against ${pair.lose[noun] || 0} of ${pair.lose.used}). Apply keeps those words. Nothing is sent, and the step keeps its approval setting and its send caps.`;
  if (decision.apply_copy && step) {
    await updateWorkflowStepCopy(st, email, wf.id, step.id, { subject: pair.win.subject, body: pair.win.body });
    test.status = 'done';
    const state = await readState(st, email);
    state.suggestions.push({ id: 'sg' + uid(), key: 'ab:' + test.id, kind: 'ab_winner', action: 'change', status: 'applied', at: now, text: text + ' The winning words are on the step. The next email still follows the approval setting, the daily cap and the account ceiling.' });
    await writeState(st, email, state);
    return;
  }
  test.status = 'winner_pending';
  const state = await readState(st, email);
  if (!(state.suggestions || []).some((s) => s.key === 'ab:' + test.id)) {
    state.suggestions.push({ id: 'sg' + uid(), key: 'ab:' + test.id, kind: 'ab_winner', action: 'change', status: 'open', at: now, text, workflow_id: test.workflow_id, step_id: test.step_id, subject: pair.win.subject, body: pair.win.body, test_id: test.id });
  }
  await writeState(st, email, state);
}
async function settleAllUnlocked(st, email, now) {
  const tests = await readTests(st, email);
  let changed = false;
  for (const t of tests) {
    const before = t.status;
    await settleOneUnlocked(st, email, t, now);
    if (t.status !== before) changed = true;
  }
  if (changed) await writeTests(st, email, tests);
}

export async function runDueCos({ st, now = Date.now() }) {
  const users = parse((await st.get('as_users'))?.v, {}) || {};
  let reviewed = 0;
  for (const [email, u] of Object.entries(users)) {
    if (!email || !u || (u.role && u.role !== 'customer') || u.suspended) continue;
    try {
      const did = await withCos(email, () => reviewUnlocked(st, email, now));
      if (did) reviewed++;
    } catch (e) { console.error('cos', e.message); }
  }
  return { reviewed };
}

export function variantKey(testId, leadId) {
  const h = crypto.createHash('sha256').update(String(testId) + '\n' + String(leadId)).digest();
  return h[0] % 2 === 0 ? 'A' : 'B';
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

export async function variantForRun(st, email, workflowId, stepId, leadId) {
  const tests = await readTests(st, email);
  const test = tests.find((t) => t && t.status === 'running' && t.workflow_id === workflowId && t.step_id === stepId);
  if (!test || leadId == null) return null;
  const key = variantKey(test.id, leadId);
  const v = (test.variants || []).find((x) => x.key === key) || test.variants[0];
  if (!v) return null;
  return { test_id: test.id, key: v.key, subject: v.subject, body: v.body };
}
export async function trackVariant(st, email, lead, body, ab) {
  const { buildTrackedEmail } = await import('./tracking.js');
  const html = /<[a-z!/]/i.test(body) ? body : '<p>' + esc(body) + '</p>';
  const out = await buildTrackedEmail(st, email, lead, html, '', { ab_test: ab.test_id, ab_variant: ab.key });
  return out && out.html ? out.html : html;
}
export async function noteVariantUsed(st, email, testId, variant, leadId) {
  return withCos(email, async () => {
    const tests = await readTests(st, email);
    const test = tests.find((t) => t.id === testId);
    if (!test || test.status !== 'running') return;
    test.seen = test.seen || {};
    const k = String(leadId);
    if (test.seen[k]) return;
    test.seen[k] = variant;
    const v = (test.variants || []).find((x) => x.key === variant);
    if (v) v.used = (v.used || 0) + 1;
    if (Object.keys(test.seen).length > 2000) test.seen = Object.fromEntries(Object.entries(test.seen).slice(-2000));
    await settleOneUnlocked(st, email, test, Date.now());
    await writeTests(st, email, tests);
  });
}
export async function noteVariantResult(st, email, { test_id, variant, kind } = {}) {
  if (!test_id || !variant) return;
  return withCos(email, async () => {
    const tests = await readTests(st, email);
    const test = tests.find((t) => t.id === test_id);
    if (!test || (test.status !== 'running' && test.status !== 'winner_pending')) return;
    const v = (test.variants || []).find((x) => x.key === variant);
    if (!v) return;
    if (kind === 'click') v.clicks = (v.clicks || 0) + 1;
    else v.opens = (v.opens || 0) + 1;
    if (test.status === 'running') await settleOneUnlocked(st, email, test, Date.now());
    await writeTests(st, email, tests);
  });
}

async function applyUnlocked(st, email, id, now) {
  const state = await readState(st, email);
  const s = (state.suggestions || []).find((x) => x.id === id);
  if (!s || s.status !== 'open') return null;
  if (s.action === 'workflow') {
    const draft = draftFromSuggestion(s, state.prefs);
    if (!draft) { const err = new Error('That suggestion cannot be applied.'); err.status = 400; throw err; }
    const saved = await insertDraftWorkflow(st, email, draft);
    s.status = 'applied';
    s.workflow_id = saved.id;
    s.applied_at = now;
    await writeState(st, email, state);
    return { suggestion: sugView(s), workflow: saved, needs_confirmation: true, sent: false, change: null };
  }
  if (s.kind === 'hold_email') {
    const change = { id: 'ch' + uid(), suggestion_id: s.id, kind: 'hold_email', status: 'pending', at: now };
    state.changes.push(change);
    s.status = 'applied';
    s.change_id = change.id;
    s.applied_at = now;
    await writeState(st, email, state);
    return { suggestion: sugView(s), change: { id: change.id, status: 'pending', kind: 'hold_email' }, needs_confirmation: true, sent: false, workflow: null };
  }
  if (s.kind === 'ab_winner') {
    const wf = await readWf(st, email, s.workflow_id);
    const step = wf && (wf.steps || []).find((x) => x.id === s.step_id);
    if (!wf || !step) { const err = new Error('That workflow step is no longer there.'); err.status = 404; throw err; }
    const change = {
      id: 'ch' + uid(), suggestion_id: s.id, kind: 'ab_winner', status: 'pending', at: now,
      workflow_id: wf.id, step_id: step.id, subject: clip(s.subject, 200), body: clip(s.body, 4000),
      autonomy: step.autonomy, limits: step.limits || null, test_id: s.test_id || '',
    };
    state.changes.push(change);
    s.status = 'applied';
    s.change_id = change.id;
    await writeState(st, email, state);
    return { suggestion: sugView(s), change: { id: change.id, status: 'pending', kind: 'ab_winner', workflow_id: wf.id, step_id: step.id }, needs_confirmation: true, sent: false, workflow: null };
  }
  const err = new Error('That suggestion cannot be applied.'); err.status = 400; throw err;
}

async function confirmUnlocked(st, email, id, now) {
  const state = await readState(st, email);
  const change = (state.changes || []).find((c) => c.id === id);
  if (!change || change.status !== 'pending') return null;
  if (change.kind === 'hold_email') {
    state.prefs.hold_email = true;
    change.status = 'confirmed';
    change.confirmed_at = now;
    await writeState(st, email, state);
    return { change: { id: change.id, status: 'confirmed', kind: 'hold_email' }, sent: false, needs_confirmation: false };
  }
  if (change.kind === 'ab_winner') {
    const before = await readWf(st, email, change.workflow_id);
    const step = before && (before.steps || []).find((s) => s.id === change.step_id);
    if (!step) { const err = new Error('That workflow step is no longer there.'); err.status = 404; throw err; }
    const saved = await updateWorkflowStepCopy(st, email, change.workflow_id, change.step_id, { subject: change.subject, body: change.body });
    const after = saved && (saved.steps || []).find((s) => s.id === change.step_id);
    if (!after || after.autonomy !== step.autonomy || JSON.stringify(after.limits || null) !== JSON.stringify(step.limits || null)) {
      const err = new Error('The approval setting could not be kept, so the words were not changed.'); err.status = 409; throw err;
    }
    change.status = 'confirmed';
    change.confirmed_at = now;
    const tests = await readTests(st, email);
    const test = tests.find((t) => t.id === change.test_id);
    if (test && test.status === 'winner_pending') { test.status = 'done'; test.updated = now; await writeTests(st, email, tests); }
    await writeState(st, email, state);
    return { change: { id: change.id, status: 'confirmed', kind: 'ab_winner', workflow_id: change.workflow_id }, workflow: saved, sent: false, needs_confirmation: false };
  }
  const err = new Error('That change cannot be confirmed.'); err.status = 400; throw err;
}

export async function cosRoutes({ method, pathname, b, st, email, HttpError }) {
  if (pathname !== '/api/cos' && !pathname.startsWith('/api/cos/')) return undefined;
  const bad = (e) => { throw new HttpError(e.status || 400, e.code || 'bad_suggestion', e.message || 'Check that and try again.'); };
  if (pathname === '/api/cos' && method === 'GET') {
    const [state, tests] = await Promise.all([readState(st, email), readTests(st, email)]);
    return { suggestions: (state.suggestions || []).slice().reverse().map(sugView), preferences: prefsView(state.prefs), tests: tests.map(testView), changes: (state.changes || []).filter((c) => c.status === 'pending').map((c) => ({ id: c.id, kind: c.kind, status: c.status, workflow_id: c.workflow_id || '', step_id: c.step_id || '' })), next_review_at: state.next_at || null, last_review_at: state.last_at || null };
  }
  if (pathname === '/api/cos/suggestions/apply' && method === 'POST') {
    try {
      const out = await withCos(email, () => applyUnlocked(st, email, String(b.id || ''), Date.now()));
      if (!out) throw new HttpError(404, 'not_found', 'No open suggestion with that id.');
      return out;
    } catch (e) { if (e.status) bad(e); throw e; }
  }
  if (pathname === '/api/cos/suggestions/dismiss' && method === 'POST') {
    const out = await withCos(email, async () => {
      const state = await readState(st, email);
      const s = (state.suggestions || []).find((x) => x.id === String(b.id || ''));
      if (!s || s.status !== 'open') return null;
      s.status = 'dismissed';
      await writeState(st, email, state);
      return { suggestion: sugView(s) };
    });
    if (!out) throw new HttpError(404, 'not_found', 'No open suggestion with that id.');
    return out;
  }
  if (pathname === '/api/cos/confirm' && method === 'POST') {
    try {
      const out = await withCos(email, () => confirmUnlocked(st, email, String(b.id || ''), Date.now()));
      if (!out) throw new HttpError(404, 'not_found', 'No change waiting for confirmation.');
      return out;
    } catch (e) { if (e.status) bad(e); throw e; }
  }
  if (pathname === '/api/cos/ab' && method === 'POST') {
    const workflowId = String(b.workflow_id || '');
    const stepId = String(b.step_id || '');
    const wf = await readWf(st, email, workflowId);
    const step = wf && (wf.steps || []).find((s) => s.id === stepId);
    if (!wf || !step) throw new HttpError(404, 'not_found', 'No workflow step with that id.');
    if (step.type !== 'send_email' && step.type !== 'draft_email') throw new HttpError(400, 'bad_test', 'An A/B test can only run on an email step.');
    const vars = Array.isArray(b.variants) ? b.variants : [];
    if (vars.length !== 2) throw new HttpError(400, 'bad_test', 'Give two variants, each with a subject and a body.');
    const variants = vars.map((v, i) => ({ key: i === 0 ? 'A' : 'B', subject: clip(v.subject, 200), body: clip(v.body, 4000), used: 0, opens: 0, clicks: 0 }));
    if (variants.some((v) => !v.subject || !v.body)) throw new HttpError(400, 'bad_test', 'Each variant needs a subject and a body.');
    const metric = b.metric === 'clicks' ? 'clicks' : 'opens';
    const min = Math.max(2, Math.min(200, Number(b.min_sample) || 10));
    const test = await withCos(email, async () => {
      const all = await readTests(st, email);
      if (all.some((t) => t.status === 'running' && t.workflow_id === workflowId && t.step_id === stepId)) {
        const err = new Error('That step already has a running test.'); err.status = 409; throw err;
      }
      const row = { id: 'ab' + uid(), workflow_id: workflowId, step_id: stepId, status: 'running', metric, min_sample: min, auto_pick: !!b.auto_pick, variants, seen: {}, winner: '', created: Date.now(), updated: Date.now() };
      all.unshift(row);
      await writeTests(st, email, all);
      return row;
    });
    return { test: testView(test), sent: false };
  }
  throw new HttpError(404, 'not_found');
}
