// India-first channels (v2.3, pillar 7). One inbox per account for WhatsApp, SMS and email.
// WhatsApp uses the Cloud API. SMS uses a provider adapter (Twilio, MSG91, or mock).
// Email inbound uses the Gmail connection this account already has.
// Credentials are AES-256-GCM encrypted, same idea as a bring-your-own AI key. They never go out through /api/kv.
// A webhook is routed by the phone number id or the SMS number that THIS account saved, and only after the
// signature matches THAT account's secret. A body cannot name another account and land there.
// Anything that sends starts as needs approval. STOP (and the usual opt-out words) sets consent to Opted out.
import crypto from 'node:crypto';
import { DEFAULT_STAGES } from './leads.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const CRED = 'as_chcred:', IDX = 'as_chidx:', CONV = 'as_conv:';
const WA_ID = 'as_waid:', WA_VT = 'as_wavt:', SMS_ID = 'as_smsid:';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const STOP_WORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit']);

const chains = new Map();
function withCh(email, fn) {
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

async function encKey(secret) { return crypto.createHash('sha256').update(String(await secret()) + ':channels').digest(); }
async function seal(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
async function open(s, secret) {
  const [iv, tag, ct] = String(s || '').split('.').map((x) => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(secret), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const signSha256 = (secret, raw) => 'sha256=' + crypto.createHmac('sha256', String(secret)).update(String(raw)).digest('hex');
export function signTwilio(authToken, url, params) {
  const data = String(url) + Object.keys(params || {}).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', String(authToken)).update(data).digest('base64');
}
const last4 = (s) => { const t = String(s || ''); return t ? '••••' + t.slice(-4) : ''; };
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(/bot\d{5,}:[A-Za-z0-9_-]+/gi, 'bot[redacted]')
    .replace(/xox[baprs]-[A-Za-z0-9-]+/gi, 'xox[redacted]')
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s"']+/gi, 'https://api.telegram.org/bot[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}
const digits = (s) => String(s || '').replace(/\D/g, '');
export const channelsMock = () => String(process.env.CHANNELS_MOCK || '').toLowerCase() === 'on' && String(process.env.AI_MOCK || '').toLowerCase() === 'on';

export function isStop(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return STOP_WORDS.has(t);
}
export function looksLikeInjection(text) {
  return /ignore (all |any |the )?(previous |prior |above )?instructions|disregard (the |your )?rules|system prompt|you are now|new instructions|autonomy\s*[:=]|set (the )?(autonomy|approval)|needs_approval|auto_within_limits|without (my )?approval|do not ask for approval|developer mode|jailbreak|reveal (the )?(secret|prompt|system)|other account'?s|act as (a |an )?(admin|system)/i.test(String(text || ''));
}

async function readCreds(st, email, secret) {
  const row = parse((await st.get(CRED + email))?.v, null);
  if (!row || !row.sealed) return null;
  try { return await open(row.sealed, secret); }
  catch { return null; }
}
export async function loadChannelCreds(st, email, secret) { return readCreds(st, email, secret); }
export async function readChannelIndex(st, key) { return parse((await st.get(key))?.v, null); }
export async function writeChannelIndex(st, key, value) { await st.put(key, value == null ? null : JSON.stringify(value), Date.now()); }
const credKept = (c) => !!(c && (c.whatsapp || c.sms || c.telegram || c.slack || c.waqr));
export async function withCreds(st, email, secret, fn) {
  return withCh(email, async () => {
    const prev = (await readCreds(st, email, secret)) || {};
    const idx = await readIdx(st, email);
    const out = await fn({ creds: prev, idx });
    if (!out) return null;
    const next = out.creds == null ? prev : out.creds;
    if (credKept(next)) await st.put(CRED + email, JSON.stringify({ sealed: await seal(next, secret), at: Date.now() }), Date.now());
    else await st.put(CRED + email, null, Date.now());
    if (out.idx) await writeIdx(st, email, out.idx);
    return out.public;
  });
}
async function readIdx(st, email) { return parse((await st.get(IDX + email))?.v, null) || {}; }
async function writeIdx(st, email, idx) { await st.put(IDX + email, JSON.stringify(idx), Date.now()); }
async function readConv(st, email) { return parse((await st.get(CONV + email))?.v, []) || []; }
async function writeConv(st, email, list) { await st.put(CONV + email, JSON.stringify(list.slice(-100)), Date.now()); }

function hintOf(creds) {
  const wa = creds && creds.whatsapp;
  const sms = creds && creds.sms;
  return {
    whatsapp: wa && wa.phone_number_id ? { connected: true, phone_number_id: wa.phone_number_id, hint: last4(wa.access_token), verify_hint: last4(wa.verify_token), mock: !!wa.mock } : { connected: false },
    sms: sms && sms.from ? { connected: true, provider: sms.provider, from: sms.from, hint: last4(sms.auth_token || sms.auth_key), mock: sms.provider === 'mock' } : { connected: false },
    email: { via: 'gmail' },
  };
}

function cleanWhatsApp(b) {
  const phone_number_id = String(b.phone_number_id || '').trim();
  const access_token = String(b.access_token || '').trim();
  const app_secret = String(b.app_secret || '').trim();
  let verify_token = String(b.verify_token || '').trim();
  if (!/^\d{6,20}$/.test(phone_number_id)) { const e = new Error('WhatsApp phone number id should be 6 to 20 digits from the Meta app.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  if (access_token.length < 8 || access_token.length > 400) { const e = new Error('Paste the WhatsApp access token from Meta.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  if (app_secret.length < 8 || app_secret.length > 200) { const e = new Error('Paste the Meta app secret. Webhooks are checked with it.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  if (!verify_token) verify_token = crypto.randomBytes(24).toString('hex');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(verify_token)) { const e = new Error('The verify token must be 16 to 128 letters, numbers, _ or -.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  return { phone_number_id, access_token, app_secret, verify_token, waba_id: clip(b.waba_id || '', 32), mock: access_token.startsWith('mock_') };
}
function cleanSms(b) {
  const provider = String(b.provider || '').toLowerCase();
  if (!['twilio', 'msg91', 'mock'].includes(provider)) { const e = new Error('SMS provider must be twilio, msg91 or mock.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  const from = String(b.from || '').trim();
  if (!/^\+?[0-9]{8,16}$/.test(from)) { const e = new Error('The SMS from-number should be digits, with an optional +.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  const secret = String(b.auth_token || b.auth_key || '').trim();
  if (secret.length < 8 || secret.length > 200) { const e = new Error('Paste the SMS auth token (Twilio) or auth key (MSG91). The mock provider uses a test secret of your own.'); e.status = 400; e.code = 'bad_channel'; throw e; }
  return {
    provider, from, auth_token: provider === 'msg91' ? '' : secret, auth_key: provider === 'msg91' ? secret : '',
    account_sid: clip(b.account_sid || '', 64), sender_id: clip(b.sender_id || '', 12), dlt_template_id: clip(b.dlt_template_id || '', 40),
  };
}

async function claimIndex(st, key, email) {
  const cur = parse((await st.get(key))?.v, null);
  if (cur && cur.email && cur.email !== email) { const e = new Error('That number is already connected to another account.'); e.status = 409; e.code = 'channel_taken'; throw e; }
  await st.put(key, JSON.stringify({ email }), Date.now());
}

export async function saveWhatsApp(st, email, secret, body) {
  const wa = cleanWhatsApp(body || {});
  return withCh(email, async () => {
    const idx = await readIdx(st, email);
    if (idx.wa_phone_id && idx.wa_phone_id !== wa.phone_number_id) await st.put(WA_ID + idx.wa_phone_id, null, Date.now());
    if (idx.wa_verify_hash) await st.put(WA_VT + idx.wa_verify_hash, null, Date.now());
    await claimIndex(st, WA_ID + wa.phone_number_id, email);
    const verifyHash = sha(wa.verify_token);
    await st.put(WA_VT + verifyHash, JSON.stringify({ email }), Date.now());
    const prev = (await readCreds(st, email, secret)) || {};
    const next = { ...prev, whatsapp: wa };
    await st.put(CRED + email, JSON.stringify({ sealed: await seal(next, secret), at: Date.now() }), Date.now());
    idx.wa_phone_id = wa.phone_number_id; idx.wa_verify_hash = verifyHash;
    await writeIdx(st, email, idx);
    return { whatsapp: { connected: true, phone_number_id: wa.phone_number_id, hint: last4(wa.access_token), verify_token: wa.verify_token, mock: wa.mock } };
  });
}
export async function saveSms(st, email, secret, body) {
  const sms = cleanSms(body || {});
  const id = digits(sms.from);
  return withCh(email, async () => {
    const idx = await readIdx(st, email);
    if (idx.sms_digits && idx.sms_digits !== id) await st.put(SMS_ID + idx.sms_digits, null, Date.now());
    await claimIndex(st, SMS_ID + id, email);
    const prev = (await readCreds(st, email, secret)) || {};
    const next = { ...prev, sms };
    await st.put(CRED + email, JSON.stringify({ sealed: await seal(next, secret), at: Date.now() }), Date.now());
    idx.sms_digits = id;
    await writeIdx(st, email, idx);
    return { sms: { connected: true, provider: sms.provider, from: sms.from, hint: last4(sms.auth_token || sms.auth_key), mock: sms.provider === 'mock' } };
  });
}
export async function disconnectChannel(st, email, secret, which) {
  return withCh(email, async () => {
    const idx = await readIdx(st, email);
    const prev = (await readCreds(st, email, secret)) || {};
    if (which === 'whatsapp') {
      if (idx.wa_phone_id) await st.put(WA_ID + idx.wa_phone_id, null, Date.now());
      if (idx.wa_verify_hash) await st.put(WA_VT + idx.wa_verify_hash, null, Date.now());
      delete prev.whatsapp; delete idx.wa_phone_id; delete idx.wa_verify_hash;
    } else if (which === 'sms') {
      if (idx.sms_digits) await st.put(SMS_ID + idx.sms_digits, null, Date.now());
      delete prev.sms; delete idx.sms_digits;
    }
    if (prev.whatsapp || prev.sms) await st.put(CRED + email, JSON.stringify({ sealed: await seal(prev, secret), at: Date.now() }), Date.now());
    else await st.put(CRED + email, null, Date.now());
    await writeIdx(st, email, idx);
    return { ok: true };
  });
}

export async function rememberWidget(st, email, token) {
  return withCh(email, async () => {
    const idx = await readIdx(st, email);
    const prev = (idx.widgets || []).filter((t) => t !== token);
    for (const old of prev) if (/^[a-f0-9]{32}$/.test(old)) await st.put('as_wgt:' + old, null, Date.now());
    idx.widgets = [token];
    await writeIdx(st, email, idx);
    await st.put('as_wgt:' + token, JSON.stringify({ email }), Date.now());
    return token;
  });
}
export async function forgetChannels(st, email) {
  const idx = await readIdx(st, email);
  const keys = [CRED + email, IDX + email, CONV + email, 'as_fd:' + email, 'as_book:' + email];
  if (idx.wa_phone_id) keys.push(WA_ID + idx.wa_phone_id);
  if (idx.wa_verify_hash) keys.push(WA_VT + idx.wa_verify_hash);
  if (idx.sms_digits) keys.push(SMS_ID + idx.sms_digits);
  if (idx.tg_hook && /^[a-f0-9]{32}$/.test(idx.tg_hook)) keys.push('as_tghook:' + idx.tg_hook);
  if (idx.tg_bot) keys.push('as_tgbot:' + idx.tg_bot);
  if (idx.sl_hook && /^[a-f0-9]{32}$/.test(idx.sl_hook)) keys.push('as_slhook:' + idx.sl_hook);
  if (idx.sl_team) keys.push('as_slteam:' + idx.sl_team);
  keys.push('as_fch:' + email, 'as_fseen:' + email);
  for (const t of idx.widgets || []) if (/^[a-f0-9]{32}$/.test(t)) keys.push('as_wgt:' + t);
  if (st.delMany) await st.delMany(keys); else for (const k of keys) await st.put(k, null, Date.now());
}

function viewConv(c) {
  return {
    id: c.id, channel: c.channel, peer: c.peer, lead_id: c.lead_id || null, name: c.name || '',
    last_at: c.last_at || 0, last_preview: c.last_preview || '', unread: c.unread || 0,
    last_inbound_at: c.last_inbound_at || 0, opted_out: !!c.opted_out,
    window_open: c.channel === 'whatsapp' ? !!(c.last_inbound_at && Date.now() - c.last_inbound_at < WINDOW_MS) : true,
    offered_slots: c.offered_slots || [],
    messages: (c.messages || []).slice(-50).map((m) => ({ id: m.id, dir: m.dir, body: m.body, at: m.at, status: m.status, template: m.template || '', provider_id: m.provider_id || '', approval_id: m.approval_id || '', slot_start: m.slot_start || 0 })),
  };
}
export async function listConversations(st, email) {
  const all = await readConv(st, email);
  return all.slice().sort((a, b) => (b.last_at || 0) - (a.last_at || 0)).map(viewConv);
}
export async function getConversation(st, email, id) {
  const all = await readConv(st, email);
  const c = all.find((x) => x.id === id);
  return c ? viewConv(c) : null;
}

function crmAgent(data, create) {
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  let a = data.agents.find((x) => x && x.kind === 'crm');
  if (!a && create) {
    a = { id: data.agents.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1, kind: 'crm', name: 'CRM Agent', label: 'CRM', recs: [], slips: [], n: 0, at: Date.now() };
    data.agents.push(a);
  }
  if (a) { a.db = a.db && typeof a.db === 'object' ? a.db : {}; a.db.lead = Array.isArray(a.db.lead) ? a.db.lead : []; }
  return a;
}
function findLead(list, { phone, email, visitor }) {
  const d = digits(phone), em = String(email || '').trim().toLowerCase();
  return list.find((l) => l && ((d && digits(l.phone) === d) || (em && String(l.email || '').toLowerCase() === em) || (visitor && l.web_visitor && l.web_visitor === visitor))) || null;
}
export async function matchOrCreateContact(st, email, info) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const key = 'as_data:' + email;
    const data = parse((await st.get(key))?.v, null) || { agents: [] };
    const a = crmAgent(data, true);
    const now = info.at || Date.now();
    let lead = findLead(a.db.lead, info);
    let created = false;
    if (!lead) {
      const { roomFor } = await import('./agency.js');
      if (!info.optOut && !(await roomFor(st, email, 'leads'))) {
        return { lead: { id: null, first_name: 'Lead', last_name: '', email: String(info.email || ''), phone: info.phone || '', consent: 'Unknown', source: info.source || '', company: '', interest: '', budget: '', web_visitor: info.visitor || '' }, created: false, limited: true };
      }
      const parts = String(info.name || '').trim().split(/\s+/).filter(Boolean);
      const first_name = clip(parts.shift() || (info.channel === 'webchat' ? 'Website visitor' : 'Lead'), 80);
      const last_name = clip(parts.join(' '), 80);
      const id = (a.db.lead.reduce((mx, x) => Math.max(mx, Number(x.id) || 0), 0) || 0) + 1;
      const stages = Array.isArray(a.db.stages) && a.db.stages.length ? a.db.stages : DEFAULT_STAGES;
      lead = {
        id, first_name, last_name, email: String(info.email || '').trim().toLowerCase(), phone: info.phone || '',
        source: clip(info.source || 'WhatsApp', 60), status: 'New', stage: stages[0], consent: 'Unknown',
        channel: info.channelLabel || '', company: '', notes: '', tags: [], at: now, upd: now, hist: [],
        ...(info.visitor ? { web_visitor: info.visitor } : {}),
      };
      a.db.lead.unshift(lead); a.n = (a.n || 0) + 1; created = true;
      lead.hist.push({ at: now, t: 'Created from ' + (info.source || 'a channel') });
    } else {
      if (info.name && (!lead.first_name || lead.first_name === 'Lead' || lead.first_name === 'Website visitor')) {
        const parts = String(info.name).trim().split(/\s+/).filter(Boolean);
        lead.first_name = clip(parts.shift() || lead.first_name, 80);
        if (parts.length) lead.last_name = clip(parts.join(' '), 80);
      }
      if (info.email && !lead.email) lead.email = String(info.email).trim().toLowerCase();
      if (info.phone && !lead.phone) lead.phone = info.phone;
      if (info.visitor && !lead.web_visitor) lead.web_visitor = info.visitor;
      lead.upd = now;
    }
    if (info.hist) lead.hist.push({ at: now, t: clip(info.hist, 300) });
    if (info.optOut) { lead.consent = 'Opted out'; lead.hist.push({ at: now + 1, t: 'Consent: Opted out (STOP)' }); }
    data.rev = (Number(data.rev) || 0) + 1;
    await st.put(key, JSON.stringify(data), Date.now());
    if (created) {
      const { noteUsage } = await import('./agency.js');
      await noteUsage(st, email, { leads: 1 });
    }
    return { lead: { id: lead.id, first_name: lead.first_name, last_name: lead.last_name, email: lead.email || '', phone: lead.phone || '', consent: lead.consent || '', source: lead.source || '', company: lead.company || '', interest: lead.interest || '', budget: lead.budget || '', web_visitor: lead.web_visitor || '' }, created };
  });
}
export async function patchLead(st, email, leadId, fields, hist) {
  const { withDataLock } = await import('./backend.js');
  return withDataLock(email, async () => {
    const key = 'as_data:' + email;
    const data = parse((await st.get(key))?.v, null) || { agents: [] };
    const a = crmAgent(data, false);
    const lead = a && a.db.lead.find((l) => l && Number(l.id) === Number(leadId));
    if (!lead) return null;
    const now = Date.now();
    for (const [k, v] of Object.entries(fields || {})) {
      if (v == null || v === '') continue;
      if (k === 'email') {
        const em = String(v).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) continue;
        const other = a.db.lead.find((l) => l && l.id !== lead.id && String(l.email || '').toLowerCase() === em);
        if (other) return { switched: other.id };
        lead.email = em;
      } else if (['interest', 'budget', 'timeline', 'company', 'phone'].includes(k)) lead[k] = clip(v, k === 'company' ? 120 : 80);
      else if (k === 'notes') lead.notes = clip((lead.notes ? lead.notes + '\n' : '') + v, 5000);
      else if (k === 'status') lead.status = clip(v, 40);
      else if (k === 'score') lead.score = clip(v, 20);
    }
    if (hist) (lead.hist ||= []).push({ at: now, t: clip(hist, 300) });
    lead.upd = now;
    data.rev = (Number(data.rev) || 0) + 1;
    await st.put(key, JSON.stringify(data), Date.now());
    return { id: lead.id, email: lead.email || '', phone: lead.phone || '', interest: lead.interest || '', budget: lead.budget || '', consent: lead.consent || '' };
  });
}

async function noteTimeline(st, email, leadId, kind, title, detail) {
  if (leadId == null) return;
  const { appendTl } = await import('./timeline.js');
  await appendTl(st, email, { lead_id: leadId, kind, title: clip(title, 200), detail: clip(detail, 500) });
}

function ensureConv(list, { channel, peer, lead, name }) {
  let c = list.find((x) => x.channel === channel && x.peer === peer);
  if (!c) {
    c = { id: 'cv' + uid(), channel, peer, lead_id: lead && lead.id, name: name || '', last_at: 0, last_preview: '', unread: 0, last_inbound_at: 0, opted_out: false, offered_slots: [], messages: [] };
    list.unshift(c);
  }
  if (lead && lead.id) c.lead_id = lead.id;
  if (name) c.name = name;
  return c;
}
export async function recordMessage(st, email, { channel, peer, lead, name, dir, body, at, status, template, providerId, approvalId, slotStart, fromDesk }) {
  return withCh(email, async () => {
    const list = await readConv(st, email);
    const c = ensureConv(list, { channel, peer, lead, name });
    if (providerId && (c.messages || []).some((m) => m.provider_id && m.provider_id === providerId)) return { conversation: viewConv(c), duplicate: true };
    const msg = { id: 'm' + uid(), dir, body: clip(body, 2000), at: at || Date.now(), status: status || (dir === 'in' ? 'received' : 'draft'), template: template || '', provider_id: providerId || '', approval_id: approvalId || '', ...(slotStart ? { slot_start: slotStart } : {}), ...(fromDesk ? { from_desk: true } : {}) };
    c.messages = [...(c.messages || []), msg].slice(-50);
    c.last_at = msg.at; c.last_preview = clip(body, 180);
    if (dir === 'in') { c.last_inbound_at = msg.at; c.unread = (c.unread || 0) + 1; }
    if (lead && String(lead.consent || '') === 'Opted out') c.opted_out = true;
    await writeConv(st, email, list);
    return { conversation: viewConv(c), message: msg, duplicate: false }; // view includes offered_slots so the desk can book "1"
  });
}
export async function setOfferedSlots(st, email, convId, slots) {
  return withCh(email, async () => {
    const list = await readConv(st, email);
    const c = list.find((x) => x.id === convId);
    if (!c) return;
    c.offered_slots = (slots || []).slice(0, 5);
    await writeConv(st, email, list);
  });
}
export async function markMessage(st, email, { approvalId, messageId, status, providerId }) {
  return withCh(email, async () => {
    const list = await readConv(st, email);
    for (const c of list) for (const m of c.messages || []) {
      if ((approvalId && m.approval_id === approvalId) || (messageId && m.id === messageId)) {
        m.status = status;
        if (providerId) m.provider_id = providerId;
        await writeConv(st, email, list);
        return { conversation: c, message: m };
      }
    }
    return null;
  });
}
export function windowOpen(conv, now = Date.now()) {
  if (!conv || conv.channel !== 'whatsapp') return true;
  return !!(conv.last_inbound_at && now - conv.last_inbound_at < WINDOW_MS);
}
export async function whatsappWindowOpen(st, email, phone, now = Date.now()) {
  const peer = digits(phone);
  const list = await readConv(st, email);
  const c = list.find((x) => x.channel === 'whatsapp' && digits(x.peer) === peer);
  return windowOpen(c, now);
}

async function queueApproval(st, email, item) {
  const key = 'as_appr:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  all.unshift(item);
  await st.put(key, JSON.stringify(all.slice(0, 200)), Date.now());
  return item;
}
export function refuseCustomerChannel(channel) {
  if (channel === 'whatsapp_qr' || channel === 'waqr') {
    const e = new Error('WhatsApp QR is owner-only. It cannot message customers or send a broadcast.');
    e.status = 400; e.code = 'owner_only'; throw e;
  }
}
export async function holdOutbound(st, email, { channel, to, body, template, templateLang, leadId, conversationId, summary, slotStart, booking }) {
  refuseCustomerChannel(channel);
  const kind = channel === 'webchat' ? 'webchat' : channel === 'sms' ? 'sms' : channel === 'telegram' ? 'telegram' : channel === 'slack' ? 'slack' : 'whatsapp';
  const item = {
    id: 'a' + uid(), aid: 'channels', status: 'pending', at: Date.now(), app: kind, kind,
    to: to || '', body: clip(body, 2000), template: template || '', template_lang: templateLang || '',
    lead_id: leadId || null, conversation_id: conversationId || '', slot_start: slotStart || 0, booking: booking || null,
    summary: clip(summary || (kind + ': ' + body), 200), request: clip(body, 2000),
  };
  await queueApproval(st, email, item);
  return item;
}

async function postJson(url, headers, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && (j.error.message || j.error)) || j.message || ('Provider answered ' + r.status)); e.status = 502; throw e; }
  return j;
}
async function providerSend(creds, { channel, to, body, template, templateLang }) {
  refuseCustomerChannel(channel);
  if (channel === 'webchat') return { id: 'web-' + uid(), mode: 'session', via: 'webchat' };
  if (channel === 'telegram' || channel === 'slack') {
    const { sendCustomerReply } = await import('./freech.js');
    return sendCustomerReply(creds, { channel, to, body });
  }
  if (channel === 'whatsapp') {
    const wa = creds && creds.whatsapp;
    if (!wa || !wa.access_token) { const e = new Error('WhatsApp is not connected. Nothing was sent.'); e.code = 'not_connected'; throw e; }
    const mode = template ? 'template' : 'session';
    if (wa.mock || String(wa.access_token).startsWith('mock_')) return { id: 'mock-wa-' + uid(), mode, via: 'mock', template: template || '' };
    const base = (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
    const payload = template
      ? { messaging_product: 'whatsapp', to: digits(to), type: 'template', template: { name: template, language: { code: templateLang || 'en' } } }
      : { messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body } };
    const j = await postJson(base + '/' + wa.phone_number_id + '/messages', { Authorization: 'Bearer ' + wa.access_token }, payload);
    return { id: (j.messages && j.messages[0] && j.messages[0].id) || 'sent', mode, via: 'whatsapp' };
  }
  const sms = creds && creds.sms;
  if (!sms) { const e = new Error('SMS is not connected. Nothing was sent.'); e.code = 'not_connected'; throw e; }
  if (sms.provider === 'mock') return { id: 'mock-sms-' + uid(), mode: 'sms', via: 'mock' };
  if (sms.provider === 'twilio') {
    const base = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    const sid = sms.account_sid;
    if (!sid) { const e = new Error('Twilio needs an account SID. Nothing was sent.'); e.code = 'not_connected'; throw e; }
    const form = new URLSearchParams({ To: to, From: sms.from, Body: body });
    const r = await fetch(base + '/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + sms.auth_token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || ('Twilio answered ' + r.status)); e.status = 502; throw e; }
    return { id: j.sid || 'sent', mode: 'sms', via: 'twilio' };
  }
  const base = (process.env.MSG91_API_BASE || 'https://control.msg91.com/api/v5/sms').replace(/\/$/, '');
  const j = await postJson(base + '/send', { authkey: sms.auth_key }, {
    sender: sms.sender_id || sms.from, route: '4', DLT_TE_ID: sms.dlt_template_id || undefined,
    sms: [{ message: body, to: [digits(to)] }],
  });
  return { id: j.request_id || j.message || 'sent', mode: 'sms', via: 'msg91' };
}

const LABEL = { whatsapp: 'WhatsApp', sms: 'SMS', webchat: 'Web chat', telegram: 'Telegram', slack: 'Slack', email: 'Email' };
export async function deliverOutbound(st, email, secret, { channel, to, body, template, templateLang, lead, now, conversationId, slotStart, approvalId, messageId, fromDesk }) {
  refuseCustomerChannel(channel);
  const { assertRoom, noteUsage } = await import('./agency.js');
  await assertRoom(st, email, 'messages');
  const creds = channel === 'webchat' ? {} : await readCreds(st, email, secret);
  if (lead && String(lead.consent || '') === 'Opted out') { const e = new Error('This contact opted out. Nothing was sent.'); e.code = 'opted_out'; throw e; }
  if (channel === 'whatsapp' && !template) {
    const openNow = conversationId
      ? windowOpen((await readConv(st, email)).find((c) => c.id === conversationId), now || Date.now())
      : await whatsappWindowOpen(st, email, to, now || Date.now());
    if (!openNow) { const e = new Error('WhatsApp is outside the 24 hour window. Use a template. Nothing was sent.'); e.code = 'outside_window'; throw e; }
  }
  const sent = await providerSend(creds, { channel, to, body, template, templateLang });
  let conv = conversationId;
  if (messageId || approvalId) {
    const marked = await markMessage(st, email, { messageId, approvalId, status: 'sent', providerId: sent.id });
    if (marked) conv = marked.conversation.id;
  }
  if (!messageId && !approvalId) {
    const rec = await recordMessage(st, email, { channel, peer: peerOf(channel, to), lead, dir: 'out', body, at: now, status: 'sent', template, providerId: sent.id, slotStart, fromDesk });
    conv = rec.conversation.id;
  }
  if (lead && lead.id) await noteTimeline(st, email, lead.id, channel === 'webchat' ? 'webchat' : channel, (LABEL[channel] || 'Message') + ' sent', template ? 'Template ' + template : clip(body, 180));
  if (slotStart) {
    const { commitBooking } = await import('./frontdesk.js');
    await commitBooking(st, email, secret, { lead, start: slotStart, channel, conversationId: conv });
  }
  await noteUsage(st, email, { messages: 1 });
  return { ...sent, conversation_id: conv };
}

function peerOf(channel, from) { return channel === 'webchat' || channel === 'telegram' || channel === 'slack' ? String(from) : digits(from); }
const SOURCE = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', webchat: 'Web chat', telegram: 'Telegram', slack: 'Slack' };

export async function ingestInbound(st, email, { channel, from, name, body, at, providerId, subject, visitor, secret }) {
  const text = clip(body, 2000);
  const stop = isStop(text);
  const chat = channel === 'telegram' || channel === 'slack';
  const phone = channel === 'whatsapp' || channel === 'sms' ? (String(from).startsWith('+') ? String(from) : '+' + digits(from)) : '';
  const source = SOURCE[channel] || 'Channel';
  const info = {
    phone: channel === 'whatsapp' || channel === 'sms' ? phone : '',
    email: channel === 'email' ? String(from || '').trim().toLowerCase() : '',
    visitor: visitor || (channel === 'telegram' ? 'tg:' + from : channel === 'slack' ? 'sl:' + from : ''),
    name: name || '',
    source,
    channel, channelLabel: channel === 'webchat' ? '' : source,
    at: at || Date.now(), optOut: stop,
    hist: source + ': ' + clip(subject ? subject + ' — ' + text : text, 240),
  };
  const { lead, created } = await matchOrCreateContact(st, email, info);
  const peer = channel === 'email' ? info.email : channel === 'webchat' ? (visitor || from) : chat ? String(from) : digits(from);
  const rec = await recordMessage(st, email, { channel, peer, lead, name: name || [lead.first_name, lead.last_name].filter(Boolean).join(' '), dir: 'in', body: subject ? (subject + '\n' + text) : text, at: info.at, status: 'received', providerId });
  if (!rec.duplicate && lead.id) await noteTimeline(st, email, lead.id, channel === 'webchat' ? 'webchat' : channel, info.source + ' message', clip(subject || text, 180));
  if (created && !rec.duplicate) {
    const { emitCrmEvent } = await import('./workflows.js');
    await emitCrmEvent(st, email, { type: 'lead.created', lead_id: lead.id, source: lead.source || info.source, stage: '' });
  }
  let desk = null;
  if (!rec.duplicate && !stop && channel !== 'whatsapp_qr') {
    try {
      const { onInbound } = await import('./frontdesk.js');
      desk = await onInbound(st, email, { channel, text, lead, conversation: rec.conversation, name, at: info.at, subject, secret });
    } catch (e) { console.error('frontdesk', e.message); }
  }
  return { lead_id: lead.id, created, stopped: stop, duplicate: !!rec.duplicate, conversation_id: rec.conversation.id, desk };
}

function waMessages(payload) {
  const ids = new Set(); const msgs = [];
  for (const entry of payload.entry || []) for (const ch of (entry && entry.changes) || []) {
    const value = ch && ch.value || {};
    const id = value.metadata && value.metadata.phone_number_id;
    if (id) ids.add(String(id));
    for (const m of value.messages || []) msgs.push({
      from: String(m.from || ''),
      id: String(m.id || ''),
      body: m.type === 'text' && m.text ? m.text.body : m.type === 'button' && m.button ? m.button.text : '',
      name: ((value.contacts || []).find((c) => c.wa_id === m.from) || {}).profile?.name || '',
      at: Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now(),
    });
  }
  return { ids: [...ids], msgs };
}
function verifyHeader(header, expected) {
  const got = String(header || '').trim();
  return got && safeEqual(got, expected);
}

export async function publicWebhook({ method, pathname, body, headers, query, st, secret, now }) {
  if (pathname === '/api/channels/whatsapp/webhook' && method === 'GET') {
    const mode = query.get('hub.mode'), token = query.get('hub.verify_token') || '', challenge = query.get('hub.challenge') || '';
    if (mode !== 'subscribe' || !/^[A-Za-z0-9._-]{1,128}$/.test(challenge)) { const e = new Error('Webhook verification failed.'); e.status = 403; e.code = 'bad_signature'; throw e; }
    const row = parse((await st.get(WA_VT + sha(token)))?.v, null);
    const creds = row && row.email ? await readCreds(st, row.email, secret) : null;
    if (!creds || !creds.whatsapp || !safeEqual(creds.whatsapp.verify_token, token)) { const e = new Error('Webhook verification failed.'); e.status = 403; e.code = 'bad_signature'; throw e; }
    return { __text: challenge };
  }
  if (pathname === '/api/channels/whatsapp/webhook' && method === 'POST') {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
    if (raw.length > 200000) { const e = new Error('Payload is too large.'); e.status = 413; e.code = 'too_large'; throw e; }
    let payload; try { payload = JSON.parse(raw); } catch { const e = new Error('WhatsApp payload must be JSON.'); e.status = 400; e.code = 'bad_channel'; throw e; }
    const { ids, msgs } = waMessages(payload);
    if (ids.length !== 1) { const e = new Error('A webhook must be for one WhatsApp number.'); e.status = 400; e.code = 'bad_channel'; throw e; }
    const owner = parse((await st.get(WA_ID + ids[0]))?.v, null);
    if (!owner || !owner.email) { const e = new Error('Unknown WhatsApp number.'); e.status = 404; e.code = 'not_found'; throw e; }
    const creds = await readCreds(st, owner.email, secret);
    const expect = creds && creds.whatsapp ? signSha256(creds.whatsapp.app_secret, raw) : '';
    if (!verifyHeader(headers['x-hub-signature-256'], expect)) { const e = new Error('WhatsApp signature did not match.'); e.status = 401; e.code = 'bad_signature'; throw e; }
    let n = 0;
    for (const m of msgs) {
      if (!m.from || !m.body) continue;
      await ingestInbound(st, owner.email, { channel: 'whatsapp', from: m.from, name: m.name, body: m.body, at: now && m.at > now ? now : (m.at || now), providerId: m.id, secret });
      n++;
    }
    return { ok: true, received: n };
  }
  if (pathname === '/api/channels/sms/webhook' && method === 'POST') {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
    if (raw.length > 200000) { const e = new Error('Payload is too large.'); e.status = 413; e.code = 'too_large'; throw e; }
    const ctype = String(headers['content-type'] || '');
    const form = !ctype.includes('json') && raw.includes('=');
    const params = form ? Object.fromEntries(new URLSearchParams(raw)) : (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (!params || typeof params !== 'object') { const e = new Error('SMS payload was not understood.'); e.status = 400; e.code = 'bad_channel'; throw e; }
    const to = String(params.to || params.To || '');
    const from = String(params.from || params.From || '');
    const text = String(params.body || params.Body || params.message || '');
    const id = String(params.id || params.MessageSid || params.request_id || '');
    const owner = parse((await st.get(SMS_ID + digits(to)))?.v, null);
    if (!owner || !owner.email) { const e = new Error('Unknown SMS number.'); e.status = 404; e.code = 'not_found'; throw e; }
    const creds = await readCreds(st, owner.email, secret);
    const sms = creds && creds.sms;
    if (!sms) { const e = new Error('SMS signature did not match.'); e.status = 401; e.code = 'bad_signature'; throw e; }
    let ok = false;
    if (sms.provider === 'twilio') {
      const proto = headers['x-forwarded-proto'] || 'http';
      const url = proto + '://' + (headers['x-forwarded-host'] || headers.host || '') + pathname;
      ok = verifyHeader(headers['x-twilio-signature'], signTwilio(sms.auth_token, url, params));
    } else {
      const secretKey = sms.provider === 'msg91' ? sms.auth_key : sms.auth_token;
      const header = sms.provider === 'msg91' ? headers['x-msg91-signature'] : headers['x-mock-signature'];
      ok = verifyHeader(header, signSha256(secretKey, raw));
    }
    if (!ok) { const e = new Error('SMS signature did not match.'); e.status = 401; e.code = 'bad_signature'; throw e; }
    if (from && text) await ingestInbound(st, owner.email, { channel: 'sms', from, name: '', body: text, at: now, providerId: id, secret });
    return { ok: true };
  }
  return undefined;
}

function parseEmailRow(row) {
  const text = String(row && (row.text || row.title) || '');
  const m = text.match(/Email from (.+?) <([^>]+)>.*?Subject: (.*?)\. Preview: (.*)$/);
  if (!m) return null;
  return { name: m[1].trim(), from: m[2].trim().toLowerCase(), subject: m[3].trim(), body: m[4].trim(), id: 'gm' + sha(m[2] + '|' + m[3] + '|' + (row.at || '')).slice(0, 16), at: row.at || Date.now() };
}
export async function syncGmail(st, email, secret) {
  const { connectorCredentials } = await import('./connectors.js');
  const cr = await connectorCredentials(st, email, 'gmail', secret).catch(() => null);
  if (!cr) { const e = new Error('Gmail is not connected. Open Plugins and connect Gmail, then sync again.'); e.status = 400; e.code = 'not_connected'; throw e; }
  let rows = [];
  if (cr.via === 'smtp') {
    const { imapRecent } = await import('./mailer.js');
    rows = (await imapRecent(cr, '', { limit: 15 })).map(parseEmailRow).filter(Boolean);
  } else if (cr.access_token) {
    const base = process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com';
    const list = await fetch(base + '/gmail/v1/users/me/messages?maxResults=10&q=newer_than:7d', { headers: { Authorization: 'Bearer ' + cr.access_token }, signal: AbortSignal.timeout(20000) });
    const j = await list.json().catch(() => ({}));
    if (!list.ok) { const e = new Error('Gmail refused the inbox read. Reconnect Gmail.'); e.status = 400; e.code = 'not_connected'; throw e; }
    for (const m of (j.messages || []).slice(0, 10)) {
      const one = await fetch(base + '/gmail/v1/users/me/messages/' + encodeURIComponent(m.id) + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject', { headers: { Authorization: 'Bearer ' + cr.access_token }, signal: AbortSignal.timeout(20000) });
      const d = await one.json().catch(() => ({}));
      const headers = (d.payload && d.payload.headers) || [];
      const h = (n) => (headers.find((x) => String(x.name).toLowerCase() === n) || {}).value || '';
      const from = h('from');
      const addr = (from.match(/<([^>]+)>/) || [null, from])[1] || '';
      if (!addr.includes('@')) continue;
      rows.push({ name: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim(), from: addr.trim().toLowerCase(), subject: h('subject'), body: clip(d.snippet || '', 500), id: 'gm' + m.id, at: Number(d.internalDate) || Date.now() });
    }
  }
  let n = 0;
  for (const row of rows) { const r = await ingestInbound(st, email, { channel: 'email', from: row.from, name: row.name, body: row.body, subject: row.subject, at: row.at, providerId: row.id, secret }); if (!r.duplicate) n++; }
  return { ok: true, imported: n };
}

export async function channelRoutes({ method, pathname, b, st, email, secret, HttpError, now }) {
  const bad = (e) => { throw new HttpError(e.status || 400, e.code || 'bad_channel', e.message || 'Check that and try again.'); };
  if (pathname === '/api/channels' && method === 'GET') {
    const creds = await readCreds(st, email, secret);
    const { freeHints } = await import('./freech.js');
    const { attachWaqrHint } = await import('./waqr.js');
    const channels = { ...hintOf(creds), ...freeHints(creds) };
    channels.whatsapp_qr = await attachWaqrHint(channels.whatsapp_qr, email);
    return { channels, conversations: await listConversations(st, email) };
  }
  if (pathname === '/api/channels/whatsapp' && method === 'POST') { try { return await saveWhatsApp(st, email, secret, b); } catch (e) { bad(e); } }
  if (pathname === '/api/channels/sms' && method === 'POST') { try { return await saveSms(st, email, secret, b); } catch (e) { bad(e); } }
  if (pathname === '/api/channels/disconnect' && method === 'POST') {
    const which = String(b.which || '');
    if (!['whatsapp', 'sms', 'telegram', 'slack', 'whatsapp_qr'].includes(which)) throw new HttpError(400, 'bad_channel', 'Say which channel to disconnect.');
    if (which === 'telegram' || which === 'slack' || which === 'whatsapp_qr') {
      const { disconnectFree } = await import('./freech.js');
      return disconnectFree(st, email, secret, which);
    }
    return disconnectChannel(st, email, secret, which);
  }
  if (pathname === '/api/channels/email/sync' && method === 'POST') { try { return await syncGmail(st, email, secret); } catch (e) { bad(e); } }
  if (pathname === '/api/channels/email/mock' && method === 'POST') {
    if (!channelsMock()) throw new HttpError(404, 'not_found');
    const from = String(b.from || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) throw new HttpError(400, 'bad_channel', 'Give the sender email.');
    return ingestInbound(st, email, { channel: 'email', from, name: b.name || '', body: b.body || '', subject: b.subject || '', at: now, providerId: 'mock-' + sha(from + '|' + (b.subject || '') + '|' + (b.body || '')).slice(0, 12), secret });
  }
  const one = pathname.match(/^\/api\/channels\/conversations\/(cv[a-z0-9]+)$/);
  if (one && method === 'GET') {
    const c = await getConversation(st, email, one[1]);
    if (!c) throw new HttpError(404, 'not_found', 'No conversation with that id.');
    return { conversation: c };
  }
  if (pathname === '/api/channels/send' && method === 'POST') {
    const channel = String(b.channel || '');
    if (channel === 'whatsapp_qr' || channel === 'waqr') throw new HttpError(400, 'owner_only', 'WhatsApp QR is owner-only. It cannot message customers or send a broadcast.');
    if (!['whatsapp', 'sms', 'webchat', 'telegram', 'slack'].includes(channel)) throw new HttpError(400, 'bad_channel', 'Choose WhatsApp, SMS, Telegram, Slack or web chat.');
    const body = clip(b.body || '', 2000);
    const template = clip(b.template || '', 80);
    if (!body && !template) throw new HttpError(400, 'bad_channel', 'Write a message, or name a WhatsApp template.');
    const conv = b.conversation_id ? (await readConv(st, email)).find((c) => c.id === b.conversation_id) : null;
    if (b.conversation_id && !conv) throw new HttpError(404, 'not_found', 'No conversation with that id.');
    const to = conv ? conv.peer : (channel === 'webchat' || channel === 'slack' || channel === 'telegram' ? String(b.to || '') : digits(b.to || ''));
    if (!to) throw new HttpError(400, 'bad_channel', 'Say who this is to.');
    const leadId = conv ? conv.lead_id : (b.lead_id || null);
    let lead = null;
    if (leadId != null) {
      const data = parse((await st.get('as_data:' + email))?.v, null) || {};
      const a = crmAgent(data, false);
      const found = a && a.db.lead.find((l) => Number(l.id) === Number(leadId));
      if (found) lead = found;
    }
    if (lead && String(lead.consent || '') === 'Opted out') throw new HttpError(400, 'opted_out', 'This contact opted out. Nothing was sent.');
    if (channel === 'whatsapp' && !template && conv && !windowOpen(conv, now || Date.now())) throw new HttpError(400, 'outside_window', 'Outside the 24 hour window. Name a template. Nothing was sent.');
    if (b.confirm !== true) {
      const approval = await holdOutbound(st, email, { channel, to, body: body || ('Template ' + template), template, templateLang: b.template_lang || 'en', leadId, conversationId: conv && conv.id, summary: (LABEL[channel] || 'Message') + ': ' + (body || template) });
      if (conv) await recordMessage(st, email, { channel, peer: conv.peer, lead, dir: 'out', body: body || ('Template ' + template), at: now, status: 'draft', template, approvalId: approval.id });
      return { approval, sent: false };
    }
    try {
      const sent = await deliverOutbound(st, email, secret, { channel, to, body: body || ('Template ' + template), template, templateLang: b.template_lang || 'en', lead, now, conversationId: conv && conv.id });
      return { sent: true, id: sent.id, mode: sent.mode, via: sent.via };
    } catch (e) { bad(e); }
  }
  const { freeAuthed } = await import('./freech.js');
  const freed = await freeAuthed({ method, pathname, b, st, email, secret, HttpError, now });
  if (freed !== undefined) return freed;
  throw new HttpError(404, 'not_found');
}
