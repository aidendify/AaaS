// Agent Playbooks (v2.2, pillar 5). A playbook is a snapshot of workflows, agent prompts,
// pipeline stages, custom fields and email templates. It never includes contacts or secrets.
// Installing shows a preview first. Nothing is enabled, sent, posted or paid.
import crypto from 'node:crypto';
import { cleanFieldDefs, cleanStages } from './leads.js';
import { interpret, normalizeCompiled, lockOutbound, insertDraftWorkflow } from './workflows.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const PB = 'as_pb:', TPL = 'as_tpl:';
const SECRET_RE = /(?:sk-(?:or-v1-|ant-|proj-)?[a-zA-Z0-9_\-]{8,}|ghp_[a-zA-Z0-9]{8,}|github_pat_[a-zA-Z0-9_]{8,}|xox[baprs]-[a-zA-Z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[a-zA-Z0-9._\-]{8,})/g;
const DROP_KEY = /password|secret|api[_-]?key|token|app_password|authorization|session/i;

function redact(v, stat) {
  if (typeof v === 'string') {
    const n = v.replace(SECRET_RE, '[removed]');
    if (n !== v) stat.n++;
    return n;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, stat));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEY.test(k)) { stat.n++; continue; }
      o[k] = redact(val, stat);
    }
    return o;
  }
  return v;
}

function workflowFromSentence(text, name) {
  const wf = lockOutbound(normalizeCompiled(interpret(text)));
  wf.prompt = text;
  if (name) wf.name = clip(name, 80);
  wf.status = 'draft';
  return wf;
}

const AGENCY = {
  id: 'pb_agency', source: 'starter', for: 'agency',
  name: 'Agency client intake',
  summary: 'For an agency. New enquiries are tagged, a welcome email is drafted for your approval, and a proposal stage adds a task. Nothing is sent until you turn the workflow on and approve the email.',
  stages: ['New enquiry', 'Discovery booked', 'Proposal sent', 'Won', 'Lost'],
  fields: [{ label: 'Retainer', type: 'select', options: ['Project', 'Monthly'] }, { label: 'Website', type: 'text' }],
  agents: [
    { kind: 'crm', name: 'CRM Agent', description: 'Qualifies agency enquiries and keeps the pipeline moving. Drafts stay in Approvals.', prompts: [{ title: 'How to qualify an enquiry', text: 'Ask what the client sells, who they want to reach, and whether they want a project or a monthly retainer. Write a short summary. Do not email the contact.' }] },
    { kind: 'nudge', name: 'Follow-up Agent', description: 'Drafts polite follow-ups for agency enquiries. The owner approves every email.', prompts: [{ title: 'Follow-up voice', text: 'Write a short, plain follow-up. No pressure. Never send it. The owner approves every email.' }] },
  ],
  templates: [
    { name: 'Agency welcome', subject: 'Welcome', body: 'Hi {{first_name}}, thanks for getting in touch. We help agencies and marketing teams follow up with the right people. Reply here and we will take it from there.' },
    { name: 'Proposal check-in', subject: 'Your proposal', body: 'Hi {{first_name}}, checking you had a chance to read the proposal. Reply here if you want to walk through it.' },
  ],
  sentences: [
    ['New enquiry welcome', 'When a new lead comes in, tag them inbound, draft a welcome email, and remind me in 2 days if no reply'],
    ['Proposal task', "When a lead's stage changes to Proposal sent, add a task to send the nurture plan"],
  ],
};
const DIGITAL = {
  id: 'pb_digital', source: 'starter', for: 'digital',
  name: 'Digital marketing campaigns',
  summary: 'For a digital marketing business. LinkedIn leads get a drafted welcome, and an open tags them interested. Posts and emails stay in Approvals.',
  stages: ['New lead', 'Qualified', 'Campaign live', 'Won', 'Lost'],
  fields: [{ label: 'Channel', type: 'select', options: ['Google', 'Meta', 'LinkedIn', 'Organic'] }, { label: 'Monthly budget', type: 'number' }],
  agents: [
    { kind: 'social', name: 'Social Agent', description: 'Drafts campaign posts for the owner to approve. Nothing is posted on its own.', prompts: [{ title: 'Post drafts', text: 'Draft one short post about the offer. Do not publish it. The owner approves every post.' }] },
    { kind: 'nudge', name: 'Follow-up Agent', description: 'Drafts the first email for a new campaign lead.', prompts: [{ title: 'Campaign welcome', text: 'Thank them for the enquiry and name the channel they came from. Keep it short. Do not send it.' }] },
  ],
  templates: [
    { name: 'Campaign intro', subject: 'Your campaign', body: 'Hi {{first_name}}, thanks for connecting from {{source}}. Reply here and we will suggest a simple first campaign.' },
  ],
  sentences: [
    ['LinkedIn welcome', 'When a new lead comes from LinkedIn, tag them and draft a welcome email'],
    ['Opened, tag interested', 'When someone opens an email, tag them interested'],
  ],
};
const EMAIL = {
  id: 'pb_email', source: 'starter', for: 'email',
  name: 'Email marketing nurture',
  summary: 'For an email marketing business. A form tags a subscriber and drafts a welcome. A click tags them engaged. A weekly reminder stays in the app. Nothing is sent on its own.',
  stages: ['Subscriber', 'Engaged', 'Customer', 'Unsubscribed'],
  fields: [{ label: 'List', type: 'text' }, { label: 'Cadence', type: 'select', options: ['Weekly', 'Monthly'] }],
  agents: [
    { kind: 'nudge', name: 'Nurture Agent', description: 'Drafts nurture emails. Every send waits for approval, and opted-out contacts are skipped.', prompts: [{ title: 'Nurture voice', text: 'Write a short note with one next step. Do not send it. Skip anyone who has opted out.' }] },
  ],
  templates: [
    { name: 'List welcome', subject: 'You are on the list', body: 'Hi {{first_name}}, you are on the list. Reply here if you would like the next note, or say if you would rather not hear from us.' },
    { name: 'Still useful?', subject: 'Still useful?', body: 'Hi {{first_name}}, a short note in case the last one was useful. Reply here and we will send the next step.' },
  ],
  sentences: [
    ['Form subscriber', 'When a form is submitted, tag them subscriber and draft a welcome email'],
    ['Click engaged', 'When a contact clicks a link, tag them engaged'],
    ['Weekly reminder', 'Every week, remind me to check who has not opened'],
  ],
};

function materialise(def) {
  const workflows = def.sentences.map(([name, text]) => workflowFromSentence(text, name));
  return {
    format: 'aidentify-playbook', version: 1, id: def.id, source: 'starter', for: def.for, name: def.name, summary: def.summary,
    stages: def.stages, fields: def.fields, agents: def.agents, templates: def.templates, workflows,
  };
}
export const STARTERS = [materialise(AGENCY), materialise(DIGITAL), materialise(EMAIL)];
const starterById = (id) => STARTERS.find((p) => p.id === id) || null;

function summary(p) {
  return {
    id: p.id, name: p.name, summary: p.summary || '', for: p.for || 'custom', source: p.source || 'yours',
    counts: { workflows: (p.workflows || []).length, agents: (p.agents || []).length, templates: (p.templates || []).length, stages: (p.stages || []).length, fields: (p.fields || []).length },
  };
}

export function prepareInstall(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Send the playbook as a JSON object.');
  const stat = { n: 0 };
  const b = redact(raw, stat);
  if (b.format && b.format !== 'aidentify-playbook') throw new Error('This file is not an AIdentify playbook.');
  const workflows = (Array.isArray(b.workflows) ? b.workflows : []).slice(0, 20).map((w) => {
    const norm = lockOutbound(normalizeCompiled({ name: w.name, trigger: w.trigger, steps: w.steps }));
    norm.prompt = clip(w.prompt || w.name || 'Playbook workflow', 500);
    norm.status = 'draft';
    return norm;
  });
  const agents = (Array.isArray(b.agents) ? b.agents : []).slice(0, 15).map((a) => ({
    kind: clip(a.kind || 'nudge', 40),
    name: clip(a.name || 'Agent', 80),
    description: clip(a.description || a.d || '', 400),
    prompts: (Array.isArray(a.prompts) ? a.prompts : []).slice(0, 20).map((p) => ({ title: clip(p.title || 'Notes', 80), text: clip(p.text || '', 4000) })).filter((p) => p.text),
  })).filter((a) => a.kind && a.name);
  let stages = [];
  if (Array.isArray(b.stages) && b.stages.length) stages = cleanStages(b.stages);
  let fields = [];
  if (Array.isArray(b.fields) && b.fields.length) fields = cleanFieldDefs(b.fields);
  const templates = (Array.isArray(b.templates) ? b.templates : []).slice(0, 30).map((t) => ({ name: clip(t.name || 'Template', 80), subject: clip(t.subject || '', 200), body: clip(t.body || '', 4000) })).filter((t) => t.subject && t.body);
  if (!workflows.length && !agents.length && !stages.length && !fields.length && !templates.length) throw new Error('This playbook has nothing to install.');
  return { format: 'aidentify-playbook', version: 1, id: clip(b.id || '', 40), name: clip(b.name || 'Playbook', 80), summary: clip(b.summary || '', 400), for: clip(b.for || 'custom', 40), workflows, agents, stages, fields, templates, redacted: stat.n };
}

async function readData(st, email) { return parse((await st.get('as_data:' + email))?.v, null) || { agents: [] }; }
async function readTemplates(st, email) { return parse((await st.get(TPL + email))?.v, []) || []; }
async function readSaved(st, email) { return parse((await st.get(PB + email))?.v, []) || []; }

function bundleFromAccount(data, workflows, templates) {
  const agents = [];
  for (const a of data.agents || []) {
    if (!a || !a.kind) continue;
    const prompts = (Array.isArray(a.kb) ? a.kb : []).slice(0, 20).map((k) => ({ title: clip(k.title || 'Notes', 80), text: clip(k.text || '', 4000) })).filter((k) => k.text);
    if (!prompts.length && !a.d) continue;
    agents.push({ kind: clip(a.kind, 40), name: clip(a.name || a.kind, 80), description: clip(a.d || '', 400), prompts });
  }
  const crm = (data.agents || []).find((a) => a && a.kind === 'crm');
  const db = (crm && crm.db) || {};
  const stages = Array.isArray(db.stages) ? db.stages : [];
  const fields = Array.isArray(db.leadFields) ? db.leadFields.map((f) => ({ label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}) })) : [];
  const wfs = (workflows || []).slice(0, 20).map((w) => ({ name: w.name, prompt: w.prompt || '', trigger: w.trigger, steps: (w.steps || []).map((s) => ({ ...s })) }));
  const tpls = [];
  const seen = new Set();
  for (const t of templates || []) {
    const name = clip(t.name || t.subject || 'Template', 80);
    if (!t.subject || !t.body || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    tpls.push({ name, subject: clip(t.subject, 200), body: clip(t.body, 4000) });
  }
  for (const w of wfs) for (const s of w.steps || []) {
    if ((s.type === 'draft_email' || s.type === 'send_email') && s.subject && s.body) {
      const name = clip(s.subject, 80);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      tpls.push({ name, subject: clip(s.subject, 200), body: clip(s.body, 4000) });
    }
  }
  return { format: 'aidentify-playbook', version: 1, for: 'custom', name: 'Exported setup', summary: 'Workflows, agent prompts, stages, fields and email templates from this account. No contacts and no secrets.', workflows: wfs, agents, stages, fields, templates: tpls.slice(0, 30) };
}

function previewOf(plan, { moved = 0 } = {}) {
  return {
    playbook: { id: plan.id || '', name: plan.name, summary: plan.summary, for: plan.for },
    creates: {
      workflows: plan.workflows.map((w) => ({ name: w.name, status: 'draft', plain: w.plain, approval: 'Send, post and pay stay on needs approval until you change them.' })),
      agents: plan.agents.map((a) => ({ name: a.name, kind: a.kind, prompts: (a.prompts || []).length })),
      stages: plan.stages,
      fields: plan.fields.map((f) => ({ label: f.label, type: f.type })),
      templates: plan.templates.map((t) => ({ name: t.name, subject: t.subject })),
    },
    moves: moved,
    keeps: ['contacts', 'approvals', 'connected apps', 'secrets'],
    redacted: plan.redacted || 0,
    installed: false,
    needs_confirmation: true,
    sent: false,
  };
}

async function movedCount(st, email, stages) {
  if (!stages.length) return 0;
  const data = await readData(st, email);
  const crm = (data.agents || []).find((a) => a && a.kind === 'crm');
  const leads = (crm && crm.db && crm.db.lead) || [];
  return leads.filter((l) => l && l.stage && !stages.includes(l.stage)).length;
}

async function resolve(st, email, b) {
  if (b && b.bundle && typeof b.bundle === 'object') return prepareInstall(b.bundle);
  const id = String((b && b.id) || '');
  const starter = starterById(id);
  if (starter) return prepareInstall(starter);
  const mine = (await readSaved(st, email)).find((p) => p && p.id === id);
  if (!mine) { const err = new Error('No playbook with that id.'); err.status = 404; throw err; }
  return prepareInstall(mine.bundle || mine);
}

async function writeSetup(st, email, plan) {
  const { withDataLock } = await import('./backend.js');
  const crm = await withDataLock(email, async () => {
    const key = 'as_data:' + email;
    const data = await readData(st, email);
    data.agents = Array.isArray(data.agents) ? data.agents : [];
    const nextId = () => data.agents.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1;
    let created = 0, prompts = 0;
    for (const ag of plan.agents) {
      let a = data.agents.find((x) => x && x.kind === ag.kind);
      if (!a) {
        a = { id: nextId(), kind: ag.kind, name: ag.name, d: ag.description || '', status: 'active', kb: [] };
        data.agents.push(a);
        created++;
      }
      a.kb = Array.isArray(a.kb) ? a.kb : [];
      if (ag.description && !a.d) a.d = ag.description;
      for (const p of ag.prompts || []) {
        if (a.kb.some((k) => k && k.title === p.title)) continue;
        a.kb.push({ title: p.title, text: p.text, at: Date.now() });
        prompts++;
      }
    }
    let a = data.agents.find((x) => x && x.kind === 'crm');
    if ((plan.stages.length || plan.fields.length) && !a) {
      a = { id: nextId(), kind: 'crm', name: 'CRM Agent', d: '', status: 'active', kb: [], db: { lead: [] } };
      data.agents.push(a);
      created++;
    }
    let moved = 0;
    if (a) {
      a.db = a.db && typeof a.db === 'object' ? a.db : {};
      a.db.lead = Array.isArray(a.db.lead) ? a.db.lead : [];
      if (plan.stages.length) {
        for (const l of a.db.lead) if (l && l.stage && !plan.stages.includes(l.stage)) {
          const from = l.stage;
          l.stage = plan.stages[0];
          (l.hist ||= []).push({ at: Date.now(), t: from + ' → ' + plan.stages[0] + ' (playbook)' });
          moved++;
        }
        a.db.stages = plan.stages;
      }
      if (plan.fields.length) {
        const have = Array.isArray(a.db.leadFields) ? a.db.leadFields : [];
        const keys = new Set(have.map((f) => f.key));
        for (const d of plan.fields) if (!keys.has(d.key)) have.push(d);
        a.db.leadFields = have;
      }
    }
    data.rev = (Number(data.rev) || 0) + 1;
    await st.put(key, JSON.stringify(data), Date.now());
    return { created, prompts, moved };
  });
  const workflows = [];
  for (const w of plan.workflows) workflows.push(await insertDraftWorkflow(st, email, w));
  if (plan.templates.length) {
    const all = await readTemplates(st, email);
    for (const t of plan.templates) {
      if (all.some((x) => x && String(x.name).toLowerCase() === t.name.toLowerCase())) continue;
      all.push({ id: 'tp' + uid(), ...t });
    }
    await st.put(TPL + email, JSON.stringify(all.slice(-30)), Date.now());
  }
  return { ...crm, workflows };
}

export async function playbookRoutes({ method, pathname, b, st, email, HttpError }) {
  if (pathname !== '/api/playbooks' && !pathname.startsWith('/api/playbooks/')) return undefined;
  const fail = (e) => { throw new HttpError(e.status || 400, 'bad_playbook', e.message || 'Check that playbook and try again.'); };
  if (pathname === '/api/playbooks' && method === 'GET') {
    const mine = await readSaved(st, email);
    return { playbooks: [...STARTERS.map(summary), ...mine.map((p) => summary({ ...p.bundle, id: p.id, source: 'yours', name: p.name || (p.bundle && p.bundle.name) }))] };
  }
  if (pathname === '/api/playbooks/export' && method === 'POST') {
    const data = await readData(st, email);
    const workflows = parse((await st.get('as_wf:' + email))?.v, []) || [];
    const templates = await readTemplates(st, email);
    let plan;
    try { plan = prepareInstall({ ...bundleFromAccount(data, workflows, templates), name: clip(b.name || 'Exported setup', 80), summary: clip(b.summary || 'Workflows, agent prompts, stages, fields and email templates from this account. No contacts and no secrets.', 400) }); }
    catch (e) { fail(e); }
    const id = 'pb' + uid();
    plan.id = id;
    plan.source = 'yours';
    const mine = await readSaved(st, email);
    mine.unshift({ id, name: plan.name, at: Date.now(), bundle: plan });
    await st.put(PB + email, JSON.stringify(mine.slice(0, 20)), Date.now());
    return { playbook: plan, redacted: plan.redacted || 0 };
  }
  if (pathname === '/api/playbooks/preview' && method === 'POST') {
    let plan;
    try { plan = await resolve(st, email, b); }
    catch (e) { fail(e); }
    const moved = await movedCount(st, email, plan.stages);
    return previewOf(plan, { moved });
  }
  if (pathname === '/api/playbooks/install' && method === 'POST') {
    let plan;
    try { plan = await resolve(st, email, b); }
    catch (e) { fail(e); }
    const moved = await movedCount(st, email, plan.stages);
    const view = previewOf(plan, { moved });
    if (b.confirm !== true) return view;
    let wrote;
    try { wrote = await writeSetup(st, email, plan); }
    catch (e) { fail(e); }
    return { ...view, installed: true, needs_confirmation: false, sent: false, result: { workflows: wrote.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status })), agents_created: wrote.created, prompts_added: wrote.prompts, leads_moved: wrote.moved } };
  }
  const one = pathname.match(/^\/api\/playbooks\/(pb_[a-z0-9_]+|pb[a-z0-9]+)$/);
  if (one && method === 'GET') {
    const starter = starterById(one[1]);
    if (starter) return { playbook: starter };
    const mine = (await readSaved(st, email)).find((p) => p && p.id === one[1]);
    if (!mine) throw new HttpError(404, 'not_found', 'No playbook with that id.');
    return { playbook: { ...mine.bundle, id: mine.id, source: 'yours' } };
  }
  throw new HttpError(404, 'not_found');
}
