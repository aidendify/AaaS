// Public customer pages for the agents' apps — the links agents put in their messages.
//   /p/f/<token>  FormFirst lead form        → instant reply by name + the two qualifying questions
//   /p/q/<token>  FormFirst qualify page     → answers + AI lead summary (intent, urgency, Hot/Warm/Cold, next step)
//   /p/r/<token>  AfterJob rating page       → 1–5; happy → Google review link, unhappy → private comment
//   /p/v/<token>  OpenPing quote view        → records the first real open (link-preview bots ignored)
//   /p/t/<token>  PartPing status page       → milestone timeline
//   /p/c/<token>  ChangeSlip accept page     → accept (optionally typing their name) or decline
// Records live in the owner's workspace (as_data:<email>). Customer actions are queued in as_pub:<email>;
// the owner's page applies them to the records and acknowledges them (GET /api/pub/events, POST /api/pub/ack).
import crypto from 'node:crypto';
import { upsertPublicLead } from './leads.js';
import { utmOf, mergeUtm, safeRef, notePublicVisit, lastUtm } from './tracking.js';

const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const getJ = async (st, k, d) => parse((await st.get(k))?.v, d);
const putJ = (st, k, v) => st.put(k, JSON.stringify(v), Date.now());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fnm = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const TOKEN = /^[a-f0-9]{16,64}$/;
const MAX_EVENTS = 500;

// ---------- token index (built whenever the owner's workspace is saved) ----------
function tokensOf(data) {
  const out = [];
  for (const a of (data && data.agents) || []) {
    if (!a || a.id == null) continue;
    for (const it of a.recs || []) if (it && TOKEN.test(it.token || '')) out.push([it.token, { aid: a.id, kind: a.kind, type: 'rec' }]);
    for (const s of a.slips || []) if (s && TOKEN.test(s.token || '')) out.push([s.token, { aid: a.id, kind: 'changeslip', type: 'slip' }]);
    for (const f of a.forms || []) if (f && TOKEN.test(f.token || '')) out.push([f.token, { aid: a.id, kind: 'formfirst', type: 'form' }]);
  }
  return out;
}
export async function indexTokens(st, email, raw) {
  const data = parse(raw, null); if (!data) return;
  const seen = new Set(await getJ(st, 'as_toks:' + email, []));
  let added = 0;
  for (const [t, m] of tokensOf(data)) {
    if (seen.has(t)) continue;
    await putJ(st, 'as_tok:' + t, { email, ...m }); seen.add(t); added++;
  }
  if (added) await putJ(st, 'as_toks:' + email, [...seen].slice(-5000));
}

// ---------- owner side: queued customer actions, also written into the workspace immediately ----------
export function applyPubToWorkspace(data, ev) {
  if (!data || typeof data !== 'object' || !ev) return false;
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  data.pubIds = Array.isArray(data.pubIds) ? data.pubIds : [];
  if (ev.id && data.pubIds.includes(ev.id)) { ev.applied = true; return false; }
  const a = data.agents.find((x) => x && x.id === ev.aid);
  if (!a) return false;
  a.recs = a.recs || []; a.slips = a.slips || [];
  const L = a.kind === 'changeslip' ? a.slips : a.recs;
  const it = L.find((x) => x && x.token === ev.token);
  const pushEv = (rec, row) => { rec.ev = rec.ev || []; rec.ev.push(row); };
  if (ev.kind === 'lead') {
    if (!it && a.kind === 'formfirst') {
      const d = ev.data || {};
      a.recs.unshift({ name: d.name, email: d.email, phone: d.phone || '', message: d.message || '', source: d.source || 'Lead form', biz: ev.biz || a.biz || '', from: a.from || '', q1: ev.q1, q2: ev.q2, status: 'sent', reply: d.reply || '', id: Date.now() * 10 + Math.floor(Math.random() * 9), token: ev.token, at: ev.at, ev: [{ k: 'created', at: ev.at, note: 'From your lead form' }, { k: 'reply sent', at: ev.at, note: 'Instant reply shown on the form' }] });
      a.n = (a.n || 0) + 1;
    }
    try {
      const d = ev.data || {};
      if (ev.over_lead_limit) { ev.crm_created = false; }
      else {
        const lead = upsertPublicLead(data, { name: d.name, email: d.email, phone: d.phone, message: d.message, formTitle: ev.formTitle || d.source, utm: ev.utm || null, ref: ev.ref || '', at: ev.at || Date.now() });
        if (lead) { ev.crm_lead_id = lead.id; ev.crm_created = !!lead._justCreated; ev.crm_source = lead.source || ''; delete lead._justCreated; }
      }
    } catch { /* the public form still succeeds if the CRM copy cannot be written */ }
  } else if (!it) return false;
  else if (ev.kind === 'qualify' && it.status !== 'qualified') {
    it.q1a = ev.q1a; it.q2a = ev.q2a; it.sum = ev.sum || null; it.status = 'qualified'; it.qualified = ev.at;
    pushEv(it, { k: 'qualified', at: ev.at, note: 'Answered on the qualify page' + (it.sum && it.sum.score ? ' · ' + it.sum.score : '') });
  } else if (ev.kind === 'rate' && !['happy', 'unhappy'].includes(it.status)) {
    const n = Math.round(Number(ev.score));
    if (n >= 1 && n <= 5) {
      const thr = Number(it.thr) || 4;
      it.score = n; it.status = n >= thr ? 'happy' : 'unhappy'; it.responded = ev.at;
      pushEv(it, { k: it.status === 'happy' ? 'happy' : 'complaint', at: ev.at, note: 'Score ' + n + ' of 5' });
    }
  } else if (ev.kind === 'comment' && it.status === 'unhappy' && !it.comment && ev.comment) {
    it.comment = ev.comment; pushEv(it, { k: 'comment added', at: ev.at, note: ev.comment });
  } else if (ev.kind === 'open') {
    it.opens = (it.opens || 0) + 1;
    if (['link_ready', 'sent'].includes(it.status)) {
      it.opened = ev.at;
      const n = String(it.name || '').trim().split(/\s+/)[0] || 'there';
      it.fu = { subject: 'Quick thought on the ' + (it.title || 'quote') + ' quote, ' + n, body: 'Hi ' + n + ',\n\nI noticed you opened the ' + (it.title || 'quote') + ' quote. Reply if you want to walk through it.\n\nThanks,\n' + (it.from || '') + '\n', status: 'queued' };
      it.status = 'followup_queued';
      pushEv(it, { k: 'first open', at: ev.at, note: 'Real visitor.' });
      pushEv(it, { k: 'follow-up drafted', at: ev.at });
    } else pushEv(it, { k: 'open', at: ev.at, note: 'Another open' });
  } else if ((ev.kind === 'accept' || ev.kind === 'decline') && it.status === 'pending') {
    const to = ev.kind === 'accept' ? 'accepted' : 'declined';
    it.status = to; it[to] = ev.at; pushEv(it, { k: to, at: ev.at, typed: ev.typed || '' });
  }
  if (ev.id) data.pubIds.push(ev.id);
  if (data.pubIds.length > 2000) data.pubIds = data.pubIds.slice(-2000);
  ev.applied = true;
  data.rev = (Number(data.rev) || 0) + 1;
  return true;
}
export async function pubEvents(st, email) { return (await getJ(st, 'as_pub:' + email, [])).filter((e) => !e.ack); }
export async function pubAck(st, email, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const all = await getJ(st, 'as_pub:' + email, []);
  const left = all.filter((e) => !want.has(String(e.id)));
  if (left.length !== all.length) await putJ(st, 'as_pub:' + email, left);
  return { ok: true, left: left.length };
}
async function addEvent(st, email, ev) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const all = await getJ(st, 'as_pub:' + email, []);
    ev.id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); ev.at = Date.now();
    const row = await st.get('as_data:' + email);
    const data = parse(row && row.v, null);
    if (ev.kind === 'lead') {
      const { roomFor } = await import('./agency.js');
      if (!(await roomFor(st, email, 'leads'))) ev.over_lead_limit = true;
    }
    if (data && typeof data === 'object') {
      applyPubToWorkspace(data, ev);
      const raw = JSON.stringify(data);
      await st.put('as_data:' + email, raw, Date.now());
      await indexTokens(st, email, raw).catch(() => {});
    }
    all.push(ev); await putJ(st, 'as_pub:' + email, all.slice(-MAX_EVENTS));
    if (ev.crm_created) { const { noteUsage } = await import('./agency.js'); await noteUsage(st, email, { leads: 1 }); }
    return ev;
  });
}

// ---------- page shell ----------
function page(title, body, biz) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}${biz ? ' · ' + esc(biz) : ''}</title><style>
:root{--ink:#f4f4f5;--mute:#a1a1aa;--line:rgba(255,255,255,.12);--soft:#111;--acc:#f4f4f5;--ok:#4ade80;--bad:#f87171;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 Geist,Inter,system-ui,sans-serif;color:var(--ink);background:#000}
main{max-width:560px;margin:0 auto;padding:28px 16px 48px}.card{background:#0c0c0c;border:1px solid var(--line);border-radius:20px;padding:22px}
.biz{font-size:12px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:0 0 10px}h1{font-size:26px;font-weight:500;letter-spacing:-.03em;margin:0 0 8px;line-height:1.2}p{margin:0 0 12px}.mute{color:var(--mute)}
label{display:block;font-size:13px;font-weight:500;margin:14px 0 6px}input,textarea{width:100%;font:inherit;color:inherit;background:#000;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
textarea{min-height:84px;resize:vertical}button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border-radius:999px;border:0;background:var(--acc);color:#0a0a0a;font:500 15px Geist,Inter,system-ui,sans-serif;cursor:pointer;text-decoration:none;margin-top:16px}
.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}.row{display:flex;flex-wrap:wrap;gap:8px}.row button{flex:1;min-width:52px}
.reply{white-space:pre-wrap;background:transparent;border-left:1px solid var(--acc);padding:2px 0 2px 12px;margin:12px 0}
.ok{color:var(--ok);font-weight:600}.err{color:var(--bad);font-weight:600}ul.tl{list-style:none;padding:0;margin:14px 0 0}ul.tl li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
.dot{width:22px;height:22px;flex:none;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:12px}.dot.done{background:var(--ok);border-color:var(--ok);color:#04120a}.dot.now{border-color:var(--acc);color:var(--acc)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px;margin:12px 0}.kv span{color:var(--mute)}.amt{font-size:28px;font-weight:500;letter-spacing:-.03em;margin:6px 0}
iframe{width:100%;height:70vh;border:1px solid var(--line);border-radius:12px;background:#111}footer{text-align:center;font-size:12px;color:var(--mute);margin-top:18px}
</style></head><body><main>${body}<footer>Sent with AIdentify</footer></main></body></html>`;
}
const notFound = () => ({ __html: page('Link not found', '<div class="card"><h1>This link isn’t active</h1><p class="mute">It may have expired or been removed. Please contact the business that sent it.</p></div>') });

// ---------- AI helpers (optional: templates are used when no AI key is set) ----------
// Public visitors never wait long on the AI: after PUBLIC_AI_TIMEOUT_MS (default 8 s) the page answers with the
// built-in reply / rule-based lead score instead.
const publicAiMs = () => Math.max(1000, Number(process.env.PUBLIC_AI_TIMEOUT_MS) || 8000);
async function aiText(ai, prompt, json = false) {
  try {
    let timer; const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('slow')), publicAiMs()); });
    const t = String((await Promise.race([ai(prompt, 'public'), late]).finally(() => clearTimeout(timer))).text || '').trim(); if (!json && (/^[\[{]/.test(t) || t.length > 900)) return ''; return t; } catch { return ''; }
}
function heuristic(q1a, q2a) {
  const t = (q1a + ' ' + q2a).toLowerCase();
  const hot = /\b(asap|urgent|today|tomorrow|this week|next week|immediately|right away|within (a|one|1|2|two) weeks?|\d+\s*days?)\b/.test(t);
  const warm = /\b(month|weeks|soon|next month|quarter|\d+\s*weeks?)\b/.test(t);
  const urgency = hot ? 'High' : warm ? 'Medium' : 'Low', score = hot ? 'Hot' : warm ? 'Warm' : 'Cold';
  return { intent: q1a.slice(0, 140), urgency, score, next: hot ? 'Call today and offer a visit slot' : warm ? 'Send details and book a call this week' : 'Add to follow-up sequence' };
}
async function summarise(ai, lead, q1, q2, q1a, q2a) {
  const out = await aiText(ai, `You qualify website leads for a small business. Return ONLY JSON: {"intent":"what they want, one line","urgency":"High|Medium|Low","score":"Hot|Warm|Cold","next":"the owner's next step, one line"}.
Scoring: Hot = needs it within 2 weeks or clear budget; Warm = 1-3 months; Cold = just browsing.
Lead: ${lead.name} <${lead.email}>. Their message: ${String(lead.message || '').slice(0, 800)}
Q1 ${q1}: ${q1a.slice(0, 600)}
Q2 ${q2}: ${q2a.slice(0, 600)}`, true);
  const m = out.match(/\{[\s\S]*\}/); const j = m ? parse(m[0], null) : null;
  const h = heuristic(q1a, q2a);
  if (!j) return h;
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return { intent: String(j.intent || h.intent).slice(0, 200), urgency: pick(j.urgency, ['High', 'Medium', 'Low'], h.urgency), score: pick(j.score, ['Hot', 'Warm', 'Cold'], h.score), next: String(j.next || h.next).slice(0, 200) };
}

// ---------- lookup ----------
async function load(st, token) {
  if (!TOKEN.test(token)) return null;
  const ix = await getJ(st, 'as_tok:' + token, null); if (!ix) return null;
  const data = await getJ(st, 'as_data:' + ix.email, null);
  const agent = ((data && data.agents) || []).find((a) => a && a.id === ix.aid) || null;
  const list = !agent ? [] : ix.type === 'slip' ? agent.slips || [] : ix.type === 'form' ? agent.forms || [] : agent.recs || [];
  let rec = list.find((x) => x && x.token === token) || null;
  const evs = (await getJ(st, 'as_pub:' + ix.email, [])).filter((e) => e.token === token);
  if (!rec && ix.pending) { const lead = evs.find((e) => e.kind === 'lead'); if (lead) rec = { ...lead.data, token, status: 'sent', q1: lead.q1, q2: lead.q2, biz: lead.biz }; }
  if (!rec) return null;
  return { ix, email: ix.email, agent: agent || { id: ix.aid, kind: ix.kind }, rec, evs, user: data && data.user };
}
function readForm(body) {
  if (body && typeof body === 'object') return body;
  const s = String(body || ''); const j = parse(s, null); if (j && typeof j === 'object') return j;
  return Object.fromEntries(new URLSearchParams(s));
}
const field = (o, k, n = 2000) => String(o[k] ?? '').trim().slice(0, n);
const BOT = /(whatsapp|facebookexternalhit|facebot|slackbot|twitterbot|telegrambot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview)/i;
const hits = new Map();
function limit(ip) { const now = Date.now(), l = (hits.get(ip) || []).filter((t) => now - t < 60000); l.push(now); hits.set(ip, l); return l.length > 30; }

// ---------- pages ----------
export async function publicRoute({ method, pathname, body, headers = {}, ip = '', query, st, ai }) {
  const m = pathname.match(/^\/p\/([fqrvtc])\/([A-Za-z0-9]+)\/?$/); if (!m) return notFound();
  const [, kind, token] = m, post = method === 'POST';
  if (post && limit('pub:' + ip)) return { __html: page('Slow down', '<div class="card"><h1>Too many tries</h1><p class="mute">Please wait a minute and try again.</p></div>') };
  const L = await load(st, token); if (!L) return notFound();
  const { rec: it, agent: a, email, evs } = L, biz = it.biz || a.biz || a.cs_biz || 'Our team';
  const f = post ? readForm(body) : {};
  const head = `<p class="biz">${esc(biz)}</p>`;
  const utmNow = utmOf(query), ref = safeRef(headers);
  const ua = String(headers['user-agent'] || headers['User-Agent'] || '');
  if (!post && !BOT.test(ua)) await notePublicVisit(st, email, { token, page: kind, utm: utmNow, ref, ip }).catch(() => {});

  // ----- FormFirst: lead form -----
  if (kind === 'f') {
    if (L.ix.type !== 'form') return notFound();
    const fields = (it.fields || ['Name', 'Email', 'Phone', 'How can we help?']).slice(0, 12);
    const kindOf = (l) => (/e-?mail/i.test(l) ? 'email' : /phone|mobile|whats/i.test(l) ? 'phone' : /\bname\b/i.test(l) ? 'name' : 'msg');
    if (post) {
      const lead = { name: '', email: '', phone: '', message: '' }, extra = [];
      fields.forEach((l, i) => { const v = field(f, 'f' + i); if (!v) return; const k = kindOf(l); if (k === 'msg') extra.push(fields.length > 4 ? l + ': ' + v : v); else if (!lead[k]) lead[k] = v; });
      lead.message = extra.join('\n').slice(0, 3000);
      if (!lead.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) return { __html: page(it.title, `${head}<div class="card"><h1>${esc(it.title)}</h1><p class="err">Please enter your name and a valid email.</p><p><a class="btn ghost" href="">Back</a></p></div>`, biz) };
      const nt = crypto.randomBytes(32).toString('hex'), q1 = it.q1 || 'What are you looking for help with?', q2 = it.q2 || 'When do you need this done?';
      await putJ(st, 'as_tok:' + nt, { email, aid: L.ix.aid, kind: 'formfirst', type: 'rec', pending: true });
      let reply = await aiText(ai, `Write the first reply from ${biz} to a new website lead, 2-3 short friendly sentences, addressed to ${fnm(lead.name)} by first name. Acknowledge exactly what they asked for, say we'll help, and say we have two quick questions below. No questions in the text, no sign-off, no placeholders, no prices.\nTheir message: ${lead.message.slice(0, 800) || '(no message)'}`);
      if (!reply) reply = `Hi ${fnm(lead.name)}, thanks for reaching out to ${biz}. We got your note${lead.message ? ' about ' + lead.message.split('\n')[0].slice(0, 80).replace(/[.!?]+$/, '') : ''} and we're on it. Two quick questions so we can help faster:`;
      const utm = mergeUtm(utmNow, await lastUtm(st, email, token).catch(() => null));
      const ev = await addEvent(st, email, { kind: 'lead', token: nt, aid: L.ix.aid, form: token, formTitle: it.title || 'Lead form', utm, ref, data: { ...lead, source: 'Form: ' + (it.title || 'Lead form'), reply }, q1, q2, biz });
      if (ev && ev.crm_lead_id) {
        try {
          const { emitCrmEvent } = await import('./workflows.js');
          const source = String(ev.crm_source || '').slice(0, 60);
          await emitCrmEvent(st, email, { type: 'form.submitted', lead_id: ev.crm_lead_id, source });
          if (ev.crm_created) await emitCrmEvent(st, email, { type: 'lead.created', lead_id: ev.crm_lead_id, source });
        } catch (e) { console.error('workflow', e.message); }
      }
      return { __html: page('Thanks', `${head}<div class="card"><h1>Thanks, ${esc(fnm(lead.name))}!</h1><p class="reply">${esc(reply)}</p>
<form method="post" action="/p/q/${nt}"><label>1. ${esc(q1)}</label><textarea name="q1a" required></textarea><label>2. ${esc(q2)}</label><textarea name="q2a" required></textarea><button>Send answers</button></form></div>`, biz) };
    }
    return { __html: page(it.title, `${head}<div class="card"><h1>${esc(it.title || 'Contact us')}</h1><p class="mute">We reply within minutes.</p><form method="post">
${fields.map((l, i) => { const k = kindOf(l); return `<label for="f${i}">${esc(l)}</label>${k === 'msg' ? `<textarea id="f${i}" name="f${i}"></textarea>` : `<input id="f${i}" name="f${i}" type="${k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'}" ${k === 'name' || k === 'email' ? 'required' : ''} autocomplete="${k === 'email' ? 'email' : k === 'phone' ? 'tel' : k === 'name' ? 'name' : 'off'}">`}`; }).join('\n')}
<button>Send</button></form></div>`, biz) };
  }

  // ----- FormFirst: qualify -----
  if (kind === 'q') {
    if (a.kind !== 'formfirst') return notFound();
    const q1 = it.q1 || 'What are you looking for help with?', q2 = it.q2 || 'When do you need this done?';
    const done = it.status === 'qualified' || evs.some((e) => e.kind === 'qualify');
    if (done) return { __html: page('Thanks', `${head}<div class="card"><h1>Thank you${it.name ? ', ' + esc(fnm(it.name)) : ''}</h1><p>${esc(biz)} has your answers and will be in touch shortly.</p></div>`, biz) };
    if (post) {
      const q1a = field(f, 'q1a'), q2a = field(f, 'q2a');
      if (!q1a || !q2a) return { __html: page('Two quick questions', `${head}<div class="card"><p class="err">Please answer both questions.</p><a class="btn ghost" href="">Back</a></div>`, biz) };
      const sum = await summarise(ai, it, q1, q2, q1a, q2a);
      await addEvent(st, email, { kind: 'qualify', token, aid: a.id, q1a, q2a, sum });
      return { __html: page('Thanks', `${head}<div class="card"><h1>Thank you, ${esc(fnm(it.name))}</h1><p>${esc(biz)} has your answers and will be in touch shortly.</p></div>`, biz) };
    }
    return { __html: page('Two quick questions', `${head}<div class="card"><h1>Hi ${esc(fnm(it.name))}, two quick questions</h1><p class="mute">So we can help you faster.</p>
<form method="post"><label>1. ${esc(q1)}</label><textarea name="q1a" required></textarea><label>2. ${esc(q2)}</label><textarea name="q2a" required></textarea><button>Send answers</button></form></div>`, biz) };
  }

  // ----- AfterJob: rating -----
  if (kind === 'r') {
    if (a.kind !== 'afterjob') return notFound();
    const rate = evs.find((e) => e.kind === 'rate'), score = rate ? rate.score : it.score, thr = it.thr || 4;
    const commented = it.comment || evs.some((e) => e.kind === 'comment');
    const happyHtml = `<h1>Thank you!</h1><p>We’re glad the job went well. If you have a minute, a public review helps neighbours find ${esc(biz)}.</p>${it.google ? `<a class="btn" href="${esc(it.google)}" rel="noopener">Leave a Google review</a>` : ''}`;
    const sadHtml = (c) => c ? `<h1>Thank you for telling us</h1><p>This stays private. ${esc(biz)} will follow up personally.</p>` : `<h1>Sorry we missed the mark</h1><p class="mute">This stays private — it won’t be posted anywhere.</p><form method="post"><input type="hidden" name="op" value="comment"><label>What should we have done better?</label><textarea name="comment" required></textarea><button>Send privately</button></form>`;
    if (post && field(f, 'op') === 'comment') {
      const c = field(f, 'comment'); if (c && score && score < thr && !commented) await addEvent(st, email, { kind: 'comment', token, aid: a.id, comment: c });
      return { __html: page('Thank you', `${head}<div class="card">${sadHtml(true)}</div>`, biz) };
    }
    if (post && !score) {
      const n = Math.round(+field(f, 'score'));
      if (n >= 1 && n <= 5) { await addEvent(st, email, { kind: 'rate', token, aid: a.id, score: n }); return { __html: page('Thank you', `${head}<div class="card">${n >= thr ? happyHtml : sadHtml(false)}</div>`, biz) }; }
    }
    if (score) return { __html: page('Thank you', `${head}<div class="card">${score >= thr ? happyHtml : sadHtml(commented)}</div>`, biz) };
    return { __html: page('How did we do?', `${head}<div class="card"><h1>How did we do, ${esc(fnm(it.name))}?</h1><p class="mute">One tap. It takes ten seconds.</p><form method="post"><div class="row">${[1, 2, 3, 4, 5].map((n) => `<button name="score" value="${n}" aria-label="${n} out of 5">${n}</button>`).join('')}</div></form><p class="mute" style="margin-top:10px">1 = poor · 5 = excellent</p></div>`, biz) };
  }

  // ----- OpenPing: quote view -----
  if (kind === 'v') {
    if (a.kind !== 'openping') return notFound();
    if (method === 'GET' && !BOT.test(ua) && it.status !== 'skipped') {
      const recent = evs.some((e) => e.kind === 'open' && Date.now() - (e.at || 0) < 10 * 60e3);
      if (!recent) await addEvent(st, email, { kind: 'open', token, aid: a.id });
    }
    const file = it.file || {};
    const view = file.kind === 'html' && it.html ? `<iframe sandbox="" srcdoc="${esc(it.html)}" title="${esc(it.title)}"></iframe>` : `<p class="mute">${esc(file.name || 'Quote')} — ${esc(biz)} will send the PDF file with this link.</p>`;
    return { __html: page(it.title || 'Quote', `${head}<div class="card"><h1>${esc(it.title || 'Your quote')}</h1><p class="mute">Prepared for ${esc(it.name)}</p>${view}<p class="mute" style="margin-top:12px">Questions? Just reply to the email this link came in.</p></div>`, biz) };
  }

  // ----- PartPing: status page -----
  if (kind === 't') {
    if (a.kind !== 'partping') return notFound();
    const LBL = { ordered: 'Part ordered', shipped: 'Part shipped / in transit', arrived: 'Part in house / received', ready: 'Ready to schedule / install', closed: 'Job moved on', cancelled: 'Cancelled' };
    const flow = ['ordered', 'shipped', 'arrived', 'ready'], idx = flow.indexOf(it.milestone);
    const eta = it.eta ? 'Estimated arrival: ' + new Date(it.eta + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Arrival date not confirmed yet';
    const notes = (it.ev || []).filter((e) => e && e.note && e.k !== 'created').slice(-3);
    return { __html: page('Part status', `${head}<div class="card"><h1>${esc(it.part)}</h1><p class="mute">For ${esc(it.name)}${it.job ? ' · ' + esc(it.job) : ''}</p><p><b>${esc(eta)}</b></p>
${['closed', 'cancelled'].includes(it.milestone) ? `<p><b>${esc(LBL[it.milestone])}</b></p>` : ''}<ul class="tl">${flow.map((s, i) => `<li><span class="dot ${idx >= 0 && i < idx ? 'done' : i === idx ? 'now' : ''}">${idx >= 0 && i < idx ? '✓' : i === idx ? '•' : ''}</span><span>${esc(LBL[s])}${i === idx ? ' <b>— now</b>' : ''}</span></li>`).join('')}</ul>
${notes.map((e) => `<p class="mute" style="margin:10px 0 0">${esc(new Date(e.at).toLocaleDateString('en-GB'))} · ${esc(e.note)}</p>`).join('')}</div>`, biz) };
  }

  // ----- ChangeSlip: accept / decline -----
  if (kind === 'c') {
    if (L.ix.type !== 'slip') return notFound();
    const money = (() => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: it.cur || 'USD' }).format((it.cents || 0) / 100); } catch { return ((it.cents || 0) / 100).toFixed(2) + ' ' + (it.cur || ''); } })();
    const decided = evs.find((e) => e.kind === 'accept' || e.kind === 'decline');
    const status = decided ? (decided.kind === 'accept' ? 'accepted' : 'declined') : it.status;
    const info = `<h1>Change to your job</h1><p class="mute">From ${esc(biz)} for ${esc(it.name)}${it.job ? ' · ' + esc(it.job) : ''}</p><p><b>${esc(it.summary)}</b></p><p class="amt">${esc(money)}</p>${it.details ? `<p>${esc(it.details)}</p>` : ''}`;
    if (status !== 'pending') return { __html: page('Change slip', `${head}<div class="card">${info}<p class="${status === 'accepted' ? 'ok' : 'err'}">${status === 'accepted' ? 'Accepted. Thank you — ' + esc(biz) + ' has been notified.' : status === 'declined' ? 'You declined this change. ' + esc(biz) + ' has been notified.' : 'This change slip is no longer active.'}</p></div>`, biz) };
    let err = '';
    if (post) {
      const op = field(f, 'op'), typed = field(f, 'typed', 200);
      if (op === 'accept' && it.typed && typed.toLowerCase() !== String(it.name || '').trim().toLowerCase()) err = 'Please type your full name exactly as shown to accept.';
      else if (op === 'accept' || op === 'decline') {
        await addEvent(st, email, { kind: op, token, aid: a.id, typed: op === 'accept' ? typed : '' });
        return { __html: page('Change slip', `${head}<div class="card">${info}<p class="${op === 'accept' ? 'ok' : 'err'}">${op === 'accept' ? 'Accepted. Thank you — ' + esc(biz) + ' has been notified.' : 'You declined this change. ' + esc(biz) + ' has been notified.'}</p></div>`, biz) };
      }
    }
    return { __html: page('Change slip', `${head}<div class="card">${info}${err ? `<p class="err">${esc(err)}</p>` : ''}<form method="post">${it.typed ? `<label>Type your full name to accept</label><input name="typed" placeholder="${esc(it.name)}" autocomplete="name">` : ''}<div class="row"><button name="op" value="accept">Accept</button><button class="ghost" name="op" value="decline">Decline</button></div></form></div>`, biz) };
  }
  return notFound();
}
