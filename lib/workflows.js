// Plain-English workflows (v2.1, pillar 3). A customer describes a workflow in a sentence.
// The existing AI path (OpenRouter, or mock when AI_PROVIDER=mock and AI_MOCK=on) turns it into a
// trigger plus steps. The customer reads that back in plain words, then enables it.
// Runs are queued when something happens and are carried out by the routines tick (/api/cron/tick
// and the local every-minute loop). Send, post and pay steps start in Approvals. A payment is never
// taken. A post in this version waits as a draft. An email is sent only when the customer has set
// that step to auto (or auto within limits) and Gmail is connected.
import crypto from 'node:crypto';
import { runWithTools } from './llm.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const WF = 'as_wf:', RUN = 'as_wfr:';
const DAY = 864e5;

export const TRIGGERS = ['lead.created', 'stage.changed', 'tag.added', 'email.opened', 'email.clicked', 'form.submitted', 'schedule'];
export const STEP_TYPES = ['tag', 'draft_email', 'send_email', 'social_post', 'pay', 'remind', 'wait', 'note', 'task', 'stage'];
export const AUTONOMY = ['needs_approval', 'auto_within_limits', 'auto'];
const OUTBOUND = new Set(['draft_email', 'send_email', 'social_post', 'pay']);
const TRIGGER_ALIAS = {
  'lead.created': 'lead.created', lead_created: 'lead.created', new_lead: 'lead.created',
  'stage.changed': 'stage.changed', stage_changed: 'stage.changed', stage_change: 'stage.changed',
  'tag.added': 'tag.added', tag_added: 'tag.added',
  'email.opened': 'email.opened', email_opened: 'email.opened', email_open: 'email.opened',
  'email.clicked': 'email.clicked', email_clicked: 'email.clicked', email_click: 'email.clicked',
  'form.submitted': 'form.submitted', form_submitted: 'form.submitted', form_submit: 'form.submitted',
  schedule: 'schedule',
};
const STEP_ALIAS = {
  tag: 'tag', add_tag: 'tag', draft_email: 'draft_email', draft: 'draft_email', email_draft: 'draft_email',
  send_email: 'send_email', email: 'send_email', send: 'send_email', social_post: 'social_post', post: 'social_post', social: 'social_post',
  pay: 'pay', payment: 'pay', remind: 'remind', reminder: 'remind', notify: 'remind', wait: 'wait', note: 'note', task: 'task', stage: 'stage', set_stage: 'stage',
};

const COMPILE_SYSTEM = `AIDENTIFY_WORKFLOW_JSON
You compile one plain-English workflow for an agency or email marketer into JSON only. No markdown.
Shape: {"name":"short name","trigger":{"type":"lead.created|stage.changed|tag.added|email.opened|email.clicked|form.submitted|schedule","source":"","stage":"","tag":"","every_days":1,"morning":false},"steps":[{"type":"tag|draft_email|send_email|social_post|pay|remind|wait|note|task|stage","autonomy":"needs_approval|auto_within_limits|auto","tag":"","subject":"","body":"","message":"","days":0,"hours":0,"until":"","stage":"","title":"","text":"","limits":{"daily_cap":10,"allowed_recipients":["lead"]}}]}
Rules:
- trigger.type is one of the listed types. "a new lead" is lead.created. Put a source such as LinkedIn in trigger.source when they name one.
- "in N days if no reply" is a wait step (days, until "no_reply") followed by a remind step. A reminder is to the account owner, not an email to the contact.
- draft_email writes a draft. send_email is only when they said send. social_post is a post. pay is a payment.
- Any step that sends, posts or pays uses autonomy "needs_approval".
- Use {{first_name}}, {{name}} and {{source}} in email and reminder text.
- If you cannot tell when it starts, return {"error":"Say when this should start: a new lead, a stage change, a tag, an email open or click, a form, or a schedule."}`;

const chains = new Map();
function withWf(email, fn) {
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

async function readWfs(st, email) { return parse((await st.get(WF + email))?.v, []) || []; }
async function readRuns(st, email) { return parse((await st.get(RUN + email))?.v, []) || []; }
async function writeWfs(st, email, list) { await st.put(WF + email, JSON.stringify(list.slice(-50)), Date.now()); }
async function writeRuns(st, email, list) { await st.put(RUN + email, JSON.stringify(list.slice(-500)), Date.now()); }

function sourceOf(text) {
  const m = String(text).match(/\b(?:from|via)\s+([A-Z][\w.+-]*(?:\s+[A-Z][\w.+-]*){0,2})/);
  if (!m) return '';
  return m[1].replace(/\b(And|Then|Tag|Draft|Send|Remind|Post|Pay|When)\b.*$/, '').replace(/[,.].*$/, '').trim();
}
function clauseAt(text, index) {
  const low = text.toLowerCase();
  let start = 0;
  for (const mark of [',', ' and ', ' then ']) {
    const at = low.lastIndexOf(mark, index);
    if (at > start) start = at + mark.length;
  }
  let end = text.length;
  for (const mark of [',', ' and ', ' then ']) {
    const at = low.indexOf(mark, index + 1);
    if (at >= 0 && at < end) end = at;
  }
  return low.slice(start, end);
}
function wantedAutonomy(clause) {
  if (/within limits|only to|allowed recipient|up to \d+|a day|per day/.test(clause)) return 'auto_within_limits';
  if (/automatically|on its own|without asking|auto\b/.test(clause)) return 'auto';
  if (/needs approval|ask me|wait for me|approve first/.test(clause)) return 'needs_approval';
  return '';
}
function limitsFrom(clause) {
  const cap = clause.match(/up to (\d+)|(\d+) a day|(\d+) per day/);
  const daily = cap ? Number(cap[1] || cap[2] || cap[3]) : 10;
  const only = clause.match(/only to\s+([^,.]+)/);
  const allowed = only ? only[1].split(/\s+or\s+| and /).map((s) => s.trim()).filter(Boolean) : ['lead'];
  return cleanLimits({ daily_cap: daily, allowed_recipients: allowed });
}
export function cleanLimits(l) {
  const raw = l && l.daily_cap != null ? Number(l.daily_cap) : 10;
  const daily_cap = Math.max(0, Math.min(500, Number.isFinite(raw) ? raw : 10));
  let rec = l && l.allowed_recipients;
  if (typeof rec === 'string') rec = rec.split(/[,;\n]/);
  rec = (Array.isArray(rec) ? rec : ['lead']).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 20);
  if (!rec.length) rec = ['lead'];
  return { daily_cap, allowed_recipients: rec };
}

// Deterministic reading of a sentence. The mock AI path returns this as JSON; a real model is checked by the same normaliser.
export function interpret(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const low = s.toLowerCase();
  if (!s) return { error: 'Describe the workflow in a sentence.' };
  const trigger = pickTrigger(s, low);
  if (trigger.error) return trigger;
  const steps = pickSteps(s, low, trigger);
  if (!steps.length) return { error: 'Say what should happen: tag the contact, draft an email, remind you, or another step.' };
  return { name: nameFor(trigger, steps), trigger, steps };
}
function pickTrigger(s, low) {
  if (/\bevery (?:day|morning|weekday|week|monday)\b|\beach morning\b|\bon a schedule\b/.test(low)) {
    const every_days = /\b(?:week|monday)\b/.test(low) ? 7 : 1;
    return { type: 'schedule', every_days, morning: /\bmorning\b/.test(low) };
  }
  if (/\b(?:opens?|opened) (?:an |the |your )?email\b|\bemail (?:is )?opened\b|\bemail open\b/.test(low)) return { type: 'email.opened' };
  if (/\bclicks? (?:a |the )?link\b|\bclicked (?:a |the )?link\b|\bemail click\b/.test(low)) return { type: 'email.clicked' };
  if (/\bform (?:is )?submit|\bsubmits? (?:a |the )?form\b|\bfills? (?:in |out )?(?:a |the )?form\b/.test(low)) return { type: 'form.submitted' };
  if (/\btag (?:["'][^"']+["']|[a-z0-9][\w-]*) is added\b|\bgets tagged\b|\btagged with\b/.test(low)) {
    const m = low.match(/tag ["']([^"']+)["']|tagged with ["']?([a-z0-9][\w-]*)|tag ([a-z0-9][\w-]*) is added/);
    return { type: 'tag.added', tag: (m && (m[1] || m[2] || m[3])) || '' };
  }
  if (/\bstage (?:change|changes|changed|move|moves|moved)\b|\bmoves to (?:the )?stage\b/.test(low)) {
    const m = s.match(/(?:to|into) (?:stage )?["']?([A-Za-z][^,.]{0,40})/);
    const stage = m ? m[1].replace(/\s+(and|then)\b.*$/i, '').trim() : '';
    return { type: 'stage.changed', stage };
  }
  if (/\bnew lead\b|\blead comes\b|\ba lead\b|\bwhen a lead\b|\bleads?\b/.test(low)) {
    const source = sourceOf(s);
    return { type: 'lead.created', ...(source ? { source } : {}) };
  }
  return { error: 'Say when this should start: a new lead, a stage change, a tag, an email open or click, a form, or a schedule.' };
}
function pickSteps(s, low, trigger) {
  const hits = [];
  const push = (at, ord, step) => { if (step) hits.push({ at, ord, step }); };
  for (const m of low.matchAll(/remind me(?: to ([^,.]+))?(?: in (\d+) (days|day|hours|hour))?(?: if (?:there is )?no reply| if they (?:do not|don't|haven't|havent) repl(?:y|ied))?/g)) {
    if (m[2]) push(m.index, 0, waitStep(Number(m[2]), m[3], /no reply|not reply|haven't replied|havent replied/.test(m[0]) ? 'no_reply' : ''));
    const message = m[1] ? capSentence(m[1]) : (/no reply/.test(m[0]) ? 'No reply yet from {{name}} ({{email}}).' : 'Workflow reminder');
    push(m.index, 1, { type: 'remind', message: clip(message, 300), autonomy: 'auto' });
  }
  for (const m of low.matchAll(/wait (\d+) (days|day|hours|hour)/g)) push(m.index, 0, waitStep(Number(m[1]), m[2], /no reply/.test(clauseAt(s, m.index)) ? 'no_reply' : ''));
  for (const m of low.matchAll(/tag them(?: as| with)?(?: ["“']([^"”']+)["”']| ([a-z0-9][\w-]{0,30}))?/g)) {
    const tag = (m[1] || m[2] || trigger.source || 'new').trim();
    push(m.index, 0, { type: 'tag', tag: clip(tag, 40), autonomy: autonomyFor('tag', clauseAt(s, m.index)) });
  }
  for (const m of s.matchAll(/draft (?:a |an )?(welcome |follow-up |follow up |nurture )?email/gi)) {
    push(m.index, 0, emailStep('draft_email', m[1] || '', clauseAt(s, m.index), quotedNear(s, m.index)));
  }
  for (const m of s.matchAll(/send (?:them |the contact |a |an |the )*(welcome |follow-up |follow up |nurture )?email|email them/gi)) {
    push(m.index, 0, emailStep('send_email', m[1] || '', clauseAt(s, m.index), quotedNear(s, m.index)));
  }
  for (const m of low.matchAll(/post (?:it |this )?(?:to |on )?(linkedin|facebook|instagram|x|twitter)?|\btweet\b|share (?:it )?on (?:social|linkedin)/g)) {
    const where = m[1] || (m[0].includes('linkedin') ? 'linkedin' : 'social');
    push(m.index, 0, { type: 'social_post', text: `Update for {{name}}, from {{source}}.`, where, autonomy: 'needs_approval', ...suggest('social_post', clauseAt(s, m.index)) });
  }
  for (const m of low.matchAll(/\bpay\b|\bcharge\b|take payment|\binvoice\b/g)) {
    push(m.index, 0, { type: 'pay', message: 'Payment from this workflow. Nothing is charged from here.', autonomy: 'needs_approval', ...suggest('pay', clauseAt(s, m.index)) });
  }
  for (const m of s.matchAll(/(?:add|create) a task(?: to)? ([^,.]+)/gi)) push(m.index, 0, { type: 'task', title: clip(m[1], 160), autonomy: autonomyFor('task', clauseAt(s, m.index)) });
  for (const m of s.matchAll(/add a note(?: that)? ([^,.]+)/gi)) push(m.index, 0, { type: 'note', message: clip(m[1], 300), autonomy: autonomyFor('note', clauseAt(s, m.index)) });
  for (const m of s.matchAll(/move (?:them |the lead |the contact )?to (?:the )?(?:stage )?["']?([A-Za-z][^,.]{1,40})/g)) {
    push(m.index, 0, { type: 'stage', stage: clip(m[1], 40), autonomy: autonomyFor('stage', clauseAt(s, m.index)) });
  }
  hits.sort((a, b) => a.at - b.at || a.ord - b.ord);
  const steps = [];
  for (const h of hits) {
    if (steps.some((prev) => prev.type === h.step.type && prev.type !== 'wait' && JSON.stringify(prev) === JSON.stringify(h.step))) continue;
    steps.push(h.step);
  }
  return steps.slice(0, 12);
}
function waitStep(n, unit, until) {
  const days = /hour/.test(unit) ? 0 : Math.min(400, n);
  const hours = /hour/.test(unit) ? Math.min(168, n) : 0;
  return { type: 'wait', days, hours, ...(until ? { until } : {}), autonomy: 'auto' };
}
function quotedNear(text, index) {
  const slice = String(text).slice(Math.max(0, index), index + 800);
  const grab = (label) => {
    const m = slice.match(new RegExp('\\b' + label + '\\s+["“]([^"”]{1,500})["”]', 'i'));
    return m ? m[1].trim() : '';
  };
  return { subject: grab('subject'), body: grab('body') };
}
function emailStep(type, kind, clause, extra) {
  const welcome = /welcome/i.test(kind);
  const follow = /follow/i.test(kind);
  let subject = welcome ? 'Welcome' : follow ? 'Following up' : 'A note for you';
  let body = welcome
    ? 'Hi {{first_name}}, thanks for connecting from {{source}}. We help agencies and marketing teams follow up with the right people. Reply here and we will take it from there.'
    : 'Hi {{first_name}}, following up from {{source}}. Reply here if you would like the next step.';
  if (extra && extra.subject) subject = clip(extra.subject, 200);
  if (extra && extra.body) body = clip(extra.body, 4000);
  return { type, subject, body, autonomy: 'needs_approval', ...suggest(type, clause) };
}
function suggest(type, clause) {
  const want = wantedAutonomy(clause);
  const out = {};
  if (want && want !== 'needs_approval') out.suggested_autonomy = want;
  if (want === 'auto_within_limits') out.limits = limitsFrom(clause);
  if (!OUTBOUND.has(type) && want) out.autonomy = want === 'auto_within_limits' ? 'auto_within_limits' : want;
  return out;
}
function autonomyFor(type, clause) {
  const extra = suggest(type, clause);
  return extra.autonomy || 'auto';
}
function capSentence(s) { const t = clip(s, 180); return t.charAt(0).toUpperCase() + t.slice(1); }
function nameFor(trigger, steps) {
  const head = trigger.source ? trigger.source + ' lead' : {
    'lead.created': 'New lead', 'stage.changed': trigger.stage ? 'Stage ' + trigger.stage : 'Stage change',
    'tag.added': trigger.tag ? 'Tag ' + trigger.tag : 'Tag added', 'email.opened': 'Email opened',
    'email.clicked': 'Link clicked', 'form.submitted': 'Form submitted', schedule: trigger.morning ? 'Each morning' : 'Scheduled',
  }[trigger.type] || 'Workflow';
  const what = steps.map((s) => ({ tag: 'tag', draft_email: 'email draft', send_email: 'email', social_post: 'post', pay: 'payment', remind: 'reminder', wait: 'wait', note: 'note', task: 'task', stage: 'stage' }[s.type] || s.type)).slice(0, 3).join(', ');
  return clip(head + (what ? ' → ' + what : ''), 80);
}

export function matchTrigger(trigger, event) {
  if (!trigger || !event || trigger.type !== event.type) return false;
  const a = (x) => String(x || '').trim().toLowerCase();
  if (trigger.source) {
    if (!a(event.source) || !a(event.source).includes(a(trigger.source))) return false;
  }
  if (trigger.type === 'stage.changed' && trigger.stage && a(trigger.stage) !== a(event.to)) return false;
  if (trigger.type === 'tag.added' && trigger.tag && a(trigger.tag) !== a(event.tag)) return false;
  return true;
}
export function recipientAllowed(limits, email) {
  const list = (limits && limits.allowed_recipients) || [];
  const em = String(email || '').trim().toLowerCase();
  return list.some((r) => r === 'lead' || r === '*' ? !!em : r.startsWith('@') ? em.endsWith(r) : em === r);
}
// account-wide ceiling for emails workflows send on their own in one day (all workflows together)
export const accountDailyMax = () => {
  const raw = process.env.WORKFLOW_SEND_DAILY_MAX;
  if (raw == null || String(raw).trim() === '') return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(500, n));
};
export function decideOutbound(step, { recipient, leadEmail = recipient, sentToday = 0, sentTodayAll = 0, optedOut = false } = {}) {
  if (optedOut && (step.type === 'send_email' || step.type === 'draft_email' || step.type === 'social_post')) return { action: 'skip', reason: 'opted_out' };
  if (step.type === 'pay' || step.type === 'social_post' || step.type === 'draft_email') return { action: 'queue', reason: step.type === 'pay' ? 'pay' : 'approval' };
  const autonomy = AUTONOMY.includes(step.autonomy) ? step.autonomy : 'needs_approval';
  if (step.type !== 'send_email' || autonomy === 'needs_approval') return { action: 'queue', reason: 'approval' };
  if (autonomy === 'auto_within_limits') {
    const limits = step.limits || cleanLimits({});
    if (!recipientAllowed(limits, recipient)) return { action: 'queue', reason: 'recipient' };
    if (sentToday >= limits.daily_cap || sentTodayAll >= accountDailyMax()) return { action: 'queue', reason: 'cap' };
    return { action: 'send', reason: 'within_limits' };
  }
  // "auto" still has limits: only the contact's own address, the step's daily cap (default 25) and the account ceiling
  const em = String(recipient || '').trim().toLowerCase();
  if (!em || em !== String(leadEmail || '').trim().toLowerCase()) return { action: 'queue', reason: 'recipient' };
  const cap = step.limits && step.limits.daily_cap != null ? cleanLimits(step.limits).daily_cap : 25;
  if (sentToday >= cap || sentTodayAll >= accountDailyMax()) return { action: 'queue', reason: 'cap' };
  return { action: 'send', reason: 'auto' };
}

function autonomySentence(step) {
  if (step.type === 'pay') {
    return step.suggested_autonomy && step.suggested_autonomy !== 'needs_approval'
      ? 'You asked for this to run on its own. Payments still wait in Approvals. Nothing is charged.'
      : 'This needs your approval. Nothing is charged.';
  }
  if (step.type === 'social_post') {
    if (step.autonomy !== 'needs_approval') return 'You turned this to run on its own. Posts in this version still wait in Approvals, and nothing is posted.';
    return step.suggested_autonomy && step.suggested_autonomy !== 'needs_approval'
      ? 'You asked for this to post on its own. It still waits in Approvals, and nothing is posted.'
      : 'This needs your approval. Nothing is posted.';
  }
  if (step.type === 'draft_email') return 'This needs your approval. Approving the draft does not send it.';
  if (step.type === 'send_email') {
    if (step.autonomy === 'auto_within_limits') {
      const lim = step.limits || cleanLimits({});
      return `This can send on its own, up to ${lim.daily_cap} a day, only to ${(lim.allowed_recipients || []).join(', ')}. Anyone else waits in Approvals.`;
    }
    if (step.autonomy === 'auto') return 'This sends on its own, because you turned that on. If email is not connected, it waits in Approvals and nothing is sent.';
    if (step.suggested_autonomy && step.suggested_autonomy !== 'needs_approval') return 'You asked for this to run on its own. It still needs your approval until you change it here. Nothing is sent until you approve it.';
    return 'This needs your approval. Nothing is sent until you approve it.';
  }
  if (step.autonomy === 'needs_approval') return 'This needs your approval before it runs.';
  if (step.autonomy === 'auto_within_limits') return 'This runs on its own within the limits you set.';
  return 'This runs on its own.';
}
export function describeStep(step) {
  const tail = autonomySentence(step);
  switch (step.type) {
    case 'tag': return `Tag them “${step.tag || 'new'}”. ${tail}`;
    case 'draft_email': return `Draft an email${step.subject ? ` (“${step.subject}”)` : ''} to the contact and put it in Approvals. ${tail}`;
    case 'send_email': return `Email the contact${step.subject ? ` (“${step.subject}”)` : ''}. ${tail}`;
    case 'social_post': return `Prepare a post${step.where ? ' for ' + step.where : ''}. ${tail}`;
    case 'pay': return `Record a payment step. ${tail}`;
    case 'wait': {
      const how = step.hours ? `${step.hours} hour${step.hours === 1 ? '' : 's'}` : `${step.days || 0} day${step.days === 1 ? '' : 's'}`;
      const gate = step.until === 'no_reply' ? ' If they have replied, the rest of this run stops. If they have not, it continues.' : '';
      return `Wait ${how}.${gate} ${tail}`;
    }
    case 'remind': return `Remind you in the app: ${String(step.message || 'Workflow reminder').replace(/[. ]+$/, '')}. This is not an email to the contact. ${tail}`;
    case 'note': return `Add a note: ${step.message || 'Noted by a workflow'}. ${tail}`;
    case 'task': return `Add a task: ${step.title || 'Follow up'}. ${tail}`;
    case 'stage': return `Move them to ${step.stage || 'the next stage'}. ${tail}`;
    default: return tail;
  }
}
export function describeTrigger(t) {
  if (!t) return 'When this starts';
  switch (t.type) {
    case 'lead.created': return t.source ? `When a new lead comes from ${t.source}` : 'When a new lead comes in';
    case 'stage.changed': return t.stage ? `When a contact moves to ${t.stage}` : 'When a contact’s stage changes';
    case 'tag.added': return t.tag ? `When the tag “${t.tag}” is added` : 'When a tag is added';
    case 'email.opened': return 'When a contact opens an email';
    case 'email.clicked': return 'When a contact clicks a link in an email';
    case 'form.submitted': return 'When someone submits a form';
    case 'schedule': {
      if (t.weekday != null && t.weekday !== '' && Number(t.weekday) >= 0 && Number(t.weekday) <= 6) {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return `Every ${days[Number(t.weekday)]}`;
      }
      return t.morning && (t.every_days || 1) === 1 ? 'Every morning' : (t.every_days || 1) === 7 ? 'Every week' : (t.every_days || 1) === 1 ? 'Every day' : `Every ${t.every_days} days`;
    }
    default: return 'When this starts';
  }
}
export function describeWorkflow(wf) {
  const lines = (wf.steps || []).map((s, i) => `${i + 1}. ${s.plain || describeStep(s)}`);
  const sendAuto = (wf.steps || []).some((s) => s.type === 'send_email' && s.autonomy && s.autonomy !== 'needs_approval');
  const foot = sendAuto
    ? 'One email step can send without a fresh approval, within the limits you set. Posts and payments still wait in Approvals. Nothing is posted or charged from here.'
    : 'Anything that sends, posts or pays waits in Approvals. Nothing goes out until you approve that item.';
  return `${describeTrigger(wf.trigger)}:\n\n${lines.join('\n')}\n\n${foot}`;
}

function refreshPlain(wf) {
  for (const s of wf.steps) s.plain = describeStep(s);
  wf.plain = describeWorkflow(wf);
  return wf;
}
// A draft from a suggestion or a playbook. Send, post and pay go back to needs approval. Nothing is enabled.
export function lockOutbound(wf) {
  wf.status = 'draft';
  for (const s of wf.steps || []) {
    if (!OUTBOUND.has(s.type)) continue;
    if (s.autonomy && s.autonomy !== 'needs_approval') s.suggested_autonomy = s.suggested_autonomy || s.autonomy;
    s.autonomy = 'needs_approval';
  }
  return refreshPlain(wf);
}
// A suggestion or a playbook adds a workflow as a draft. Send, post and pay go back to needs approval.
// Enabling it is a separate step. This does not send anything.
export async function insertDraftWorkflow(st, email, wf) {
  const row = lockOutbound({
    ...wf,
    steps: (wf.steps || []).map((s) => ({ ...s, ...(s.limits ? { limits: { ...s.limits } } : {}) })),
    trigger: { ...(wf.trigger || {}) },
  });
  return withWf(email, async () => {
    const all = await readWfs(st, email);
    if (all.length >= 50) {
      const err = new Error('You have 50 workflows. Pause or delete one first.');
      err.status = 400; err.code = 'bad_workflow';
      throw err;
    }
    const now = Date.now();
    const saved = { ...row, id: 'w' + uid(), status: 'draft', created: now, updated: now };
    if (saved.trigger && saved.trigger.weekday != null) saved.trigger.next = 1;
    all.unshift(saved);
    await writeWfs(st, email, all);
    return saved;
  });
}
// Copies a winning subject and body onto an email step. Autonomy, limits and who set them stay as they were.
// Nothing is sent, and the account ceiling, step cap and contact-only rule are not changed.
export async function updateWorkflowStepCopy(st, email, workflowId, stepId, { subject, body } = {}) {
  return withWf(email, async () => {
    const all = await readWfs(st, email);
    const wf = all.find((w) => w.id === workflowId);
    if (!wf) return null;
    const step = (wf.steps || []).find((s) => s.id === stepId);
    if (!step || (step.type !== 'draft_email' && step.type !== 'send_email')) return null;
    const autonomy = step.autonomy;
    const limits = step.limits ? JSON.parse(JSON.stringify(step.limits)) : undefined;
    const setBy = step.autonomy_set_by;
    if (subject != null) step.subject = clip(subject, 200);
    if (body != null) step.body = clip(body, 4000);
    step.autonomy = autonomy;
    if (limits) step.limits = limits; else delete step.limits;
    if (setBy) step.autonomy_set_by = setBy; else delete step.autonomy_set_by;
    wf.updated = Date.now();
    refreshPlain(wf);
    await writeWfs(st, email, all);
    return wf;
  });
}
export function normalizeCompiled(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('I could not turn that into a workflow. Say when it starts and what should happen.');
  if (raw.error) throw new Error(clip(raw.error, 300));
  const trigger = normalizeTrigger(raw.trigger);
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 12).map((s, i) => normalizeStep(s, i));
  if (!steps.length) throw new Error('Say what should happen: tag the contact, draft an email, remind you, or another step.');
  const wf = { name: clip(raw.name || nameFor(trigger, steps), 80), trigger, steps };
  return refreshPlain(wf);
}
function normalizeTrigger(t) {
  const src = t && typeof t === 'object' ? t : {};
  const type = TRIGGER_ALIAS[String(src.type || '').toLowerCase()] || TRIGGER_ALIAS[String(src.type || '')] || '';
  if (!TRIGGERS.includes(type)) throw new Error('Say when this should start: a new lead, a stage change, a tag, an email open or click, a form, or a schedule.');
  const out = { type };
  if (src.source) out.source = clip(src.source, 60);
  if (src.stage) out.stage = clip(src.stage, 40);
  if (src.tag) out.tag = clip(src.tag, 40);
  if (type === 'schedule') {
    out.every_days = Math.min(366, Math.max(1, Number(src.every_days) || 1));
    if (src.morning) out.morning = true;
    if (src.hour != null) out.hour = Math.min(23, Math.max(0, Number(src.hour) || 0));
    if (src.weekday != null && src.weekday !== '') {
      const d = Number(src.weekday);
      if (Number.isInteger(d) && d >= 0 && d <= 6) out.weekday = d;
    }
  }
  return out;
}
function normalizeStep(s, i) {
  if (!s || typeof s !== 'object') throw new Error('A step was missing.');
  const type = STEP_ALIAS[String(s.type || s.action || '').toLowerCase()] || '';
  if (!STEP_TYPES.includes(type)) throw new Error('A step used an unknown action.');
  let autonomy = AUTONOMY.includes(s.autonomy) ? s.autonomy : (OUTBOUND.has(type) ? 'needs_approval' : 'auto');
  const step = {
    id: 's' + (i + 1), type, autonomy,
    ...(s.tag ? { tag: clip(s.tag, 40) } : {}),
    ...(s.subject ? { subject: clip(s.subject, 200) } : {}),
    ...(s.body ? { body: clip(s.body, 4000) } : {}),
    ...(s.message ? { message: clip(s.message, 500) } : {}),
    ...(s.title ? { title: clip(s.title, 160) } : {}),
    ...(s.text ? { text: clip(s.text, 500) } : {}),
    ...(s.stage ? { stage: clip(s.stage, 40) } : {}),
    ...(s.where ? { where: clip(s.where, 40) } : {}),
  };
  if (type === 'wait') {
    step.days = Math.min(400, Math.max(0, Number(s.days) || 0));
    step.hours = Math.min(168, Math.max(0, Number(s.hours) || 0));
    if (s.until === 'no_reply') step.until = 'no_reply';
    if (!step.days && !step.hours) step.days = 1;
  }
  if (type === 'tag' && !step.tag) step.tag = 'new';
  if (type === 'task' && !step.title) step.title = 'Follow up';
  if ((type === 'draft_email' || type === 'send_email') && !step.subject) step.subject = type === 'draft_email' ? 'Welcome' : 'Hello';
  if ((type === 'draft_email' || type === 'send_email') && !step.body) step.body = 'Hi {{first_name}}, following up from {{source}}.';
  if (type === 'remind' && !step.message) step.message = 'Workflow reminder';
  if (OUTBOUND.has(type)) {
    const want = AUTONOMY.includes(s.suggested_autonomy) ? s.suggested_autonomy : autonomy;
    if (want !== 'needs_approval') step.suggested_autonomy = want;
    step.autonomy = 'needs_approval';
    if (s.limits) step.limits = cleanLimits(s.limits);
    else if (step.suggested_autonomy === 'auto_within_limits') step.limits = cleanLimits({});
  } else if (autonomy === 'auto_within_limits') step.limits = cleanLimits(s.limits || {});
  return step;
}

export function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('I could not turn that into a workflow. Say when it starts and what should happen.');
  try { return JSON.parse(body.slice(start, end + 1)); }
  catch { throw new Error('I could not turn that into a workflow. Say when it starts and what should happen.'); }
}
export function mockWorkflowJson(userText) {
  return JSON.stringify(interpret(userText));
}

function viewWorkflow(wf, runs) {
  const mine = (runs || []).filter((r) => r.workflow_id === wf.id);
  return { ...wf, run_count: mine.length };
}
function viewRun(r) {
  return { id: r.id, workflow_id: r.workflow_id, name: r.name, lead_id: r.lead_id, status: r.status, step: r.step, due: r.due, at: r.at, updated: r.updated, event: r.event, log: r.log || [] };
}

export async function workflowRoutes({ method, pathname, b, st, email, HttpError }) {
  if (pathname !== '/api/workflows' && !pathname.startsWith('/api/workflows/')) return undefined;
  const bad = (e) => { throw new HttpError(e.status || 400, e.code || 'bad_workflow', e.message || 'Check that workflow and try again.'); };
  if (pathname === '/api/workflows/compile' && method === 'POST') {
    const text = clip(b.text || b.prompt || '', 2000);
    if (text.length < 8) throw new HttpError(400, 'bad_workflow', 'Describe the workflow in a sentence.');
    let compiled;
    try { compiled = await runWithTools({ system: COMPILE_SYSTEM, history: [{ role: 'user', text }], tools: [], maxSteps: 2, meta: { agent: 'workflows' } }); }
    catch (e) {
      const down = e.status === 503 || e.message === 'no_key';
      throw new HttpError(down ? 503 : 400, 'bad_workflow', down ? 'Add an AI key before turning a sentence into a workflow.' : 'The AI could not read that sentence. Try again in a moment.');
    }
    let norm;
    try { norm = normalizeCompiled(parseModelJson(compiled.text)); }
    catch (e) { bad(e); }
    try {
      const { shapeEmailSteps } = await import('./cos.js');
      await shapeEmailSteps(st, email, norm);
      refreshPlain(norm);
    } catch (e) { console.error('cos', e.message); }
    norm.compiled_by = compiled.provider || '';
    const saved = await withWf(email, async () => {
      const all = await readWfs(st, email);
      if (all.length >= 50) throw new HttpError(400, 'bad_workflow', 'You have 50 workflows. Pause or delete one first.');
      const now = Date.now();
      const wf = { id: 'w' + uid(), status: 'draft', prompt: text, ...norm, created: now, updated: now };
      all.unshift(wf); await writeWfs(st, email, all); return wf;
    });
    return { workflow: saved };
  }
  if (pathname === '/api/workflows/update' && method === 'POST') {
    const id = String(b.id || '');
    const wf = await withWf(email, async () => {
      const all = await readWfs(st, email);
      const cur = all.find((w) => w.id === id);
      if (!cur) throw new HttpError(404, 'not_found', 'No workflow with that id.');
      if (b.status != null) {
        const status = String(b.status);
        if (!['draft', 'enabled', 'paused'].includes(status)) throw new HttpError(400, 'bad_workflow', 'Status must be draft, enabled or paused.');
        cur.status = status;
        if (status === 'enabled' && cur.trigger && cur.trigger.type === 'schedule' && !cur.trigger.next) {
          cur.trigger.next = Date.now() + (Math.min(366, Math.max(1, Number(cur.trigger.every_days) || 1)) * DAY);
        }
      }
      if (b.step && typeof b.step === 'object') applyStepEdit(cur, b.step, HttpError);
      if (b.name) cur.name = clip(b.name, 80);
      cur.updated = Date.now();
      refreshPlain(cur);
      await writeWfs(st, email, all);
      return cur;
    });
    return { workflow: wf };
  }
  if (pathname === '/api/workflows/delete' && method === 'POST') {
    const id = String(b.id || '');
    const ok = await withWf(email, async () => {
      const all = await readWfs(st, email);
      const left = all.filter((w) => w.id !== id);
      if (left.length === all.length) return false;
      await writeWfs(st, email, left);
      const runs = (await readRuns(st, email)).filter((r) => r.workflow_id !== id);
      await writeRuns(st, email, runs);
      return true;
    });
    if (!ok) throw new HttpError(404, 'not_found', 'No workflow with that id.');
    return { ok: true, deleted: id };
  }
  if (method === 'GET' && pathname === '/api/workflows') {
    const [all, runs] = await Promise.all([readWfs(st, email), readRuns(st, email)]);
    return { workflows: all.map((w) => viewWorkflow(w, runs)) };
  }
  const one = pathname.match(/^\/api\/workflows\/(w[a-z0-9]+)$/);
  if (one && method === 'GET') {
    const [all, runs] = await Promise.all([readWfs(st, email), readRuns(st, email)]);
    const wf = all.find((w) => w.id === one[1]);
    if (!wf) throw new HttpError(404, 'not_found', 'No workflow with that id.');
    const mine = runs.filter((r) => r.workflow_id === wf.id).slice(-30).reverse();
    return { workflow: viewWorkflow(wf, runs), runs: mine.map(viewRun) };
  }
  throw new HttpError(404, 'not_found');
}
function applyStepEdit(wf, edit, HttpError) {
  const step = (wf.steps || []).find((s) => s.id === edit.id);
  if (!step) throw new HttpError(400, 'bad_workflow', 'That step is not on this workflow.');
  if (edit.autonomy != null) {
    if (!AUTONOMY.includes(edit.autonomy)) throw new HttpError(400, 'bad_workflow', 'Choose needs approval, auto within limits, or auto.');
    step.autonomy = edit.autonomy;
    step.autonomy_set_by = 'customer';
  }
  if (edit.limits && (step.autonomy === 'auto_within_limits' || edit.autonomy === 'auto_within_limits')) step.limits = cleanLimits(edit.limits);
  else if (step.autonomy === 'auto_within_limits' && !step.limits) step.limits = cleanLimits({ daily_cap: 10, allowed_recipients: ['lead'] });
  if (edit.tag != null && step.type === 'tag') step.tag = clip(edit.tag, 40);
  if (edit.subject != null && (step.type === 'draft_email' || step.type === 'send_email')) step.subject = clip(edit.subject, 200);
  if (edit.body != null && (step.type === 'draft_email' || step.type === 'send_email')) step.body = clip(edit.body, 4000);
  if (edit.message != null && (step.type === 'remind' || step.type === 'note' || step.type === 'pay')) step.message = clip(edit.message, 500);
  if (edit.title != null && step.type === 'task') step.title = clip(edit.title, 160);
  if (edit.stage != null && step.type === 'stage') step.stage = clip(edit.stage, 40);
}

export async function emitCrmEvent(st, email, event) {
  if (!st || !email || !event || !event.type) return { queued: 0 };
  if ((event.depth || 0) > 3) return { queued: 0 };
  try {
    return await withWf(email, async () => {
      const wfs = await readWfs(st, email);
      const runs = await readRuns(st, email);
      let n = 0;
      for (const w of wfs) {
        if (w.status !== 'enabled' || (event.cause_workflow && w.id === event.cause_workflow)) continue;
        if (!matchTrigger(w.trigger, event)) continue;
        const leadId = event.lead_id ?? null;
        if (runs.some((r) => r.workflow_id === w.id && r.lead_id === leadId && !['done', 'failed', 'skipped'].includes(r.status))) continue;
        const dedupe = w.id + ':' + (leadId ?? '') + ':' + event.type + ':' + (event.token || '');
        if (event.token && runs.some((r) => r.dedupe === dedupe)) continue;
        const now = Date.now();
        runs.push({ id: 'wr' + uid(), workflow_id: w.id, name: w.name, lead_id: leadId, status: 'queued', step: 0, due: now, at: now, updated: now, dedupe, log: [], event: event.type });
        n++;
        if (n >= 20) break;
      }
      if (n) await writeRuns(st, email, runs);
      return { queued: n };
    });
  } catch (e) { console.error('workflow', e.message); return { queued: 0 }; }
}

function fill(tmpl, lead) {
  const first = (lead && lead.first_name) || 'there';
  const name = lead ? ([lead.first_name, lead.last_name].filter(Boolean).join(' ') || first) : 'there';
  return String(tmpl || '')
    .replaceAll('{{first_name}}', first)
    .replaceAll('{{name}}', name)
    .replaceAll('{{email}}', (lead && lead.email) || '')
    .replaceAll('{{source}}', (lead && lead.source) || '')
    .replaceAll('{{company}}', (lead && lead.company) || '');
}
function replied(lead, since) {
  return (lead.hist || []).some((h) => h && (h.at || 0) >= (since || 0) && /repl(y|ied)|inbound/i.test(h.t || ''));
}
async function readData(st, email) { return parse((await st.get('as_data:' + email))?.v, null) || { agents: [] }; }
function crmLead(data, id) {
  const agent = ((data && data.agents) || []).find((a) => a && a.kind === 'crm');
  const lead = agent && agent.db && Array.isArray(agent.db.lead) ? agent.db.lead.find((l) => l && Number(l.id) === Number(id)) : null;
  return { agent, lead };
}
async function withLead(st, email, leadId, fn) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const key = 'as_data:' + email;
    const data = await readData(st, email);
    const { agent, lead } = crmLead(data, leadId);
    if (!lead || !agent) return null;
    const out = await fn(data, agent, lead);
    data.rev = (Number(data.rev) || 0) + 1;
    await st.put(key, JSON.stringify(data), Date.now());
    return out === undefined ? true : out;
  });
}
async function noteTimeline(st, email, leadId, title, detail) {
  if (leadId == null) return;
  const { appendTl } = await import('./timeline.js');
  await appendTl(st, email, { lead_id: leadId, kind: 'workflow', title: clip(title, 200), detail: clip(detail, 500) });
}
async function noteActivity(st, email, { status, steps }) {
  const key = 'as_act:' + email;
  const all = parse((await st.get(key))?.v, {}) || {};
  const a = all.workflows || { runs: [], errors: [] };
  const at = Date.now();
  a.runs = [{ at, ms: 0, status, steps: (steps || []).slice(0, 12) }, ...(a.runs || [])].slice(0, 10);
  if (status === 'error') a.errors = [{ at, msg: 'A workflow step failed' }, ...(a.errors || [])].slice(0, 5);
  all.workflows = a;
  await st.put(key, JSON.stringify(all), at);
}
async function queueApproval(st, email, item) {
  const key = 'as_appr:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  if (item.step_key) {
    const prev = all.find((a) => a && a.step_key === item.step_key);
    if (prev) return prev;
  }
  all.unshift(item);
  await st.put(key, JSON.stringify(all.slice(0, 200)), Date.now());
  return item;
}
function approvalBase(job, extra) {
  return {
    id: 'a' + uid(), aid: 'workflows', status: 'pending', at: Date.now(), step_key: job.run.id + ':' + job.run.step,
    workflow_id: job.wf.id, lead_id: job.run.lead_id, ...extra,
  };
}
async function pushInbox(st, email, item) {
  const key = 'as_inbox:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  if (item.id && all.some((x) => x && x.id === item.id)) return;
  all.push(item);
  await st.put(key, JSON.stringify(all.slice(-100)), Date.now());
}
function sentOnDay(runs, workflowId, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  let n = 0;
  for (const r of runs) if (workflowId == null || r.workflow_id === workflowId) for (const line of r.log || []) {
    if (line.result === 'sent' && line.at && new Date(line.at).toISOString().slice(0, 10) === day) n++;
  }
  return n;
}

async function enqueueSchedules(st, email, now) {
  await withWf(email, async () => {
    const wfs = await readWfs(st, email);
    const runs = await readRuns(st, email);
    let changed = false;
    for (const w of wfs) {
      if (w.status !== 'enabled' || !w.trigger || w.trigger.type !== 'schedule') continue;
      const every = Math.min(366, Math.max(1, Number(w.trigger.every_days) || 1));
      if (w.trigger.weekday != null && w.trigger.weekday !== '' && new Date(now).getUTCDay() !== Number(w.trigger.weekday)) continue;
      if (!w.trigger.next) { w.trigger.next = now + every * DAY; changed = true; continue; }
      if (w.trigger.next > now) continue;
      const open = runs.some((r) => r.workflow_id === w.id && !['done', 'failed', 'skipped'].includes(r.status));
      if (!open) {
        runs.push({ id: 'wr' + uid(), workflow_id: w.id, name: w.name, lead_id: null, status: 'queued', step: 0, due: now, at: now, updated: now, dedupe: w.id + ':schedule:' + w.trigger.next, log: [], event: 'schedule' });
      }
      w.trigger.next = now + every * DAY;
      changed = true;
    }
    if (changed) { await writeWfs(st, email, wfs); await writeRuns(st, email, runs); }
  });
}
async function claimNext(st, email, now) {
  return withWf(email, async () => {
    const wfs = await readWfs(st, email);
    const runs = await readRuns(st, email);
    const due = runs.filter((r) => {
      const wf = wfs.find((w) => w.id === r.workflow_id);
      if (!wf || wf.status !== 'enabled') return false;
      const dueAt = r.due || 0;
      // A test clock set in the past still runs work that is already due on the wall clock, and the run is
      // stamped with that test day. A clock in the future only runs work that is due at that future time.
      const ready = dueAt <= now || (now < Date.now() && dueAt <= Date.now());
      if ((r.status === 'queued' || r.status === 'waiting') && ready) return true;
      if (r.status === 'running' && ((r.claim_until || 0) <= now || (now < Date.now() && (r.claim_until || 0) <= Date.now()))) return true;
      return false;
    }).sort((a, b) => (a.due || 0) - (b.due || 0));
    const run = due[0];
    if (!run) return null;
    const wf = wfs.find((w) => w.id === run.workflow_id);
    const step = (wf.steps || [])[run.step];
    if (!step) { run.status = 'done'; run.updated = now; await writeRuns(st, email, runs); return null; }
    run.status = 'running';
    run.claim_until = now + 2 * 60e3;
    run.updated = now;
    await writeRuns(st, email, runs);
    return { run: JSON.parse(JSON.stringify(run)), wf: JSON.parse(JSON.stringify(wf)), step, sentToday: sentOnDay(runs, wf.id, now), sentTodayAll: sentOnDay(runs, null, now) };
  });
}
async function finish(st, email, job, result, now) {
  await withWf(email, async () => {
    const runs = await readRuns(st, email);
    const run = runs.find((r) => r.id === job.run.id);
    if (!run || run.status === 'done' || run.status === 'failed') return;
    const wf = job.wf;
    const line = { at: now, step: run.step, type: job.step.type, result: result.error ? 'error' : (result.result || 'ok'), detail: clip(result.detail || result.error || '', 300) };
    run.log = [...(run.log || []), line].slice(-40);
    if (result.arm) { run.status = 'waiting'; run.due = result.due; run.wait_armed = true; }
    else if (result.skip_rest) { run.status = 'done'; run.step = (wf.steps || []).length; }
    else if (result.error) run.status = 'failed';
    else {
      run.step += 1;
      if (run.step >= (wf.steps || []).length) run.status = 'done';
      else { run.status = 'queued'; run.due = now; }
    }
    run.updated = now;
    delete run.claim_until;
    await writeRuns(st, email, runs);
    const steps = (run.log || []).slice(-6).map((l) => ({ k: 'workflow', t: clip((job.wf.name || 'Workflow') + ': ' + (l.detail || l.result), 120) }));
    const status = result.error ? 'error' : (run.log || []).some((l) => l.result === 'queued_approval') ? 'waiting' : 'ok';
    await noteActivity(st, email, { status, steps });
  });
}

async function perform(st, email, job, now) {
  const step = job.step;
  const leadId = job.run.lead_id;
  if (step.type === 'wait') {
    if (!job.run.wait_armed) {
      const ms = (Number(step.days) || 0) * DAY + (Number(step.hours) || 0) * 3600e3;
      return { arm: true, due: now + ms, result: 'waiting', detail: describeStep(step) };
    }
    if (step.until === 'no_reply' && leadId != null) {
      const { lead } = crmLead(await readData(st, email), leadId);
      if (lead && replied(lead, job.run.at)) {
        await noteTimeline(st, email, leadId, 'Workflow skipped', job.wf.name + ': they replied, so no reminder was sent.');
        return { skip_rest: true, result: 'skipped_replied', detail: 'They replied, so the rest of this run was skipped.' };
      }
    }
    return { result: 'ok', detail: 'Wait finished.' };
  }
  if (step.autonomy === 'needs_approval' && !OUTBOUND.has(step.type)) {
    const item = approvalBase(job, { app: 'draft', kind: 'draft', summary: clip(job.wf.name + ': ' + describeStep(step), 200), request: describeStep(step) });
    await queueApproval(st, email, item);
    await noteTimeline(st, email, leadId, 'Workflow waiting', 'Waiting for approval: ' + describeStep(step));
    return { result: 'queued_approval', detail: 'Waiting for your approval. Nothing ran yet.' };
  }
  if (['tag', 'stage', 'note', 'task', 'draft_email', 'send_email', 'social_post'].includes(step.type) && leadId == null) {
    return { result: 'skipped', detail: 'No contact for this step.' };
  }
  if (step.type === 'remind') {
    const data = await readData(st, email);
    const lead = leadId != null ? crmLead(data, leadId).lead : null;
    const message = fill(step.message || 'Workflow reminder', lead);
    await pushInbox(st, email, { id: 'wf-' + job.run.id + '-' + job.run.step, aid: 'workflows', at: now, t: clip(job.wf.name + ': ' + message, 400), routine: job.wf.name });
    await noteTimeline(st, email, leadId, 'Reminder', message);
    return { result: 'ok', detail: 'Reminder: ' + message };
  }
  if (step.type === 'tag' || step.type === 'stage' || step.type === 'note' || step.type === 'task') {
    const changed = await withLead(st, email, leadId, (data, agent, lead) => {
      const t = Date.now();
      if (step.type === 'tag') {
        const tag = step.tag || 'new';
        const tags = Array.isArray(lead.tags) ? lead.tags.slice() : [];
        if (!tags.some((x) => String(x).toLowerCase() === tag.toLowerCase())) tags.push(tag);
        lead.tags = tags.slice(0, 20);
        (lead.hist ||= []).push({ at: t, t: 'Tags: ' + (lead.tags.join(', ') || 'none') });
        return { emit: { type: 'tag.added', lead_id: lead.id, tag, source: lead.source || '', cause_workflow: job.wf.id, depth: 1 }, detail: 'Tagged ' + tag };
      }
      if (step.type === 'stage') {
        const from = lead.stage || '';
        lead.stage = step.stage || lead.stage;
        (lead.hist ||= []).push({ at: t, t: (from || 'No stage') + ' → ' + lead.stage });
        return { emit: { type: 'stage.changed', lead_id: lead.id, from, to: lead.stage, source: lead.source || '', cause_workflow: job.wf.id, depth: 1 }, detail: 'Moved to ' + lead.stage };
      }
      if (step.type === 'note') {
        const text = fill(step.message || 'Noted by a workflow', lead);
        lead.notes = clip((lead.notes ? lead.notes + '\n' : '') + text, 5000);
        (lead.hist ||= []).push({ at: t, t: 'Note: ' + text });
        return { detail: 'Note added' };
      }
      agent.db.task = Array.isArray(agent.db.task) ? agent.db.task : [];
      const title = fill(step.title || 'Follow up', lead);
      const task = { id: (agent.db.task.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1, title, due: '', priority: 'Normal', related: lead.email || ('#' + lead.id), lead_id: lead.id, owner: '', status: 'Open', at: t, upd: t, hist: [{ at: t, t: 'Created by workflow' }] };
      agent.db.task.unshift(task);
      return { detail: 'Task: ' + title };
    });
    if (!changed) return { result: 'skipped', detail: 'No contact for this step.' };
    await noteTimeline(st, email, leadId, job.wf.name, changed.detail);
    if (changed.emit) await emitCrmEvent(st, email, changed.emit);
    return { result: 'ok', detail: changed.detail };
  }
  const data = await readData(st, email);
  const lead = leadId != null ? crmLead(data, leadId).lead : null;
  const opted = String(lead && lead.consent || '') === 'Opted out';
  const decision = decideOutbound(step, { recipient: lead && lead.email, leadEmail: lead && lead.email, sentToday: job.sentToday, sentTodayAll: job.sentTodayAll || 0, optedOut: opted });
  if (decision.action === 'skip') {
    await noteTimeline(st, email, leadId, job.wf.name, 'Skipped. This contact opted out, so nothing was drafted or sent.');
    return { result: 'skipped', detail: 'This contact opted out, so nothing was drafted or sent.' };
  }
  let subject = fill(step.subject || (step.type === 'social_post' ? 'Post' : 'Hello'), lead);
  let body = fill(step.body || step.text || step.message || '', lead);
  let ab = null;
  if ((step.type === 'send_email' || step.type === 'draft_email') && lead) {
    try {
      const { variantForRun, trackVariant } = await import('./cos.js');
      const picked = await variantForRun(st, email, job.wf.id, step.id, lead.id);
      if (picked) {
        subject = fill(picked.subject, lead);
        body = fill(picked.body, lead);
        ab = picked;
        body = await trackVariant(st, email, lead, body, ab);
      }
    } catch (e) { console.error('cos', e.message); }
  }
  const to = (lead && lead.email) || '';
  const expose = async () => {
    if (!ab) return;
    try {
      const { noteVariantUsed } = await import('./cos.js');
      await noteVariantUsed(st, email, ab.test_id, ab.key, lead.id);
    } catch (e) { console.error('cos', e.message); }
  };
  if (decision.action === 'send' && step.type === 'send_email') {
    if (!to) return { result: 'skipped', detail: 'This contact has no email address. Nothing was sent.' };
    try {
      const { helpers } = await import('./backend.js');
      const { sendEmail } = await import('./mailer.js');
      await sendEmail({ st, email, secret: helpers.secret, to, subject, body, ownOnly: true }); // never from the platform's own mailbox
      await noteTimeline(st, email, leadId, 'Email sent by workflow', subject);
      await expose();
      return { result: 'sent', detail: 'Sent to ' + to + '. ' + subject };
    } catch (e) {
      const item = approvalBase(job, { app: 'draft', kind: 'draft', to, subject, body, summary: clip('Email draft: ' + subject, 200), request: body, ...(ab ? { ab_test: ab.test_id, ab_variant: ab.key } : {}) });
      await queueApproval(st, email, item);
      await expose();
      await noteTimeline(st, email, leadId, 'Email waiting', 'Could not send (' + clip(e.message, 160) + '). Nothing was sent. It is waiting in Approvals.');
      return { result: 'queued_approval', detail: 'Could not send. Nothing was sent. It is waiting in Approvals.' };
    }
  }
  const why = {
    recipient: 'Outside your allowed recipients, so it is waiting for approval. Nothing was sent.',
    cap: 'Today’s limit is reached, so it is waiting for approval. Nothing was sent.',
    pay: 'Waiting for approval. Nothing was charged.',
    approval: step.type === 'social_post' ? 'Waiting for approval. Nothing was posted.' : step.type === 'draft_email' ? 'Draft waiting for approval. Nothing was sent.' : 'Waiting for approval. Nothing was sent.',
  }[decision.reason] || 'Waiting for approval.';
  const kind = step.type === 'send_email' ? 'email' : 'draft';
  const item = approvalBase(job, {
    app: kind === 'email' ? 'gmail' : 'draft', kind, to, subject, body,
    summary: clip((step.type === 'pay' ? 'Payment: ' : step.type === 'social_post' ? 'Post: ' : 'Email: ') + (subject || body || job.wf.name), 200),
    request: step.type === 'pay' ? (body || 'Nothing is charged from this account.') : body,
    ...(ab ? { ab_test: ab.test_id, ab_variant: ab.key } : {}),
  });
  await queueApproval(st, email, item);
  await expose();
  await noteTimeline(st, email, leadId, step.type === 'pay' ? 'Payment waiting' : step.type === 'social_post' ? 'Post waiting' : 'Email waiting', why);
  return { result: 'queued_approval', detail: why };
}

export async function runDueWorkflows({ st, now = Date.now() }) {
  const rows = typeof st.listPrefix === 'function'
    ? (await st.listPrefix(WF)).filter((it) => it && it.v)
    : (await st.all()).filter((it) => it.k && it.k.startsWith(WF) && it.v);
  let ran = 0;
  for (const row of rows) {
    const email = row.k.slice(WF.length);
    if (!email) continue;
    await enqueueSchedules(st, email, now);
    for (let n = 0; n < 40; n++) {
      const job = await claimNext(st, email, now);
      if (!job) break;
      let result;
      try { result = await perform(st, email, job, now); }
      catch (e) { result = { error: clip(e.message || e, 300) }; }
      await finish(st, email, job, result, now);
      ran++;
    }
  }
  return { ran };
}
