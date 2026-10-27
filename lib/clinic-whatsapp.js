// Official WhatsApp for clinic drafts. Two providers behind one adapter: Meta Cloud API and Gupshup.
// Keys stay in the environment. Nothing in this file sends unless the caller has already approved the draft.
// With no provider key, callers keep the wa.me link and send nothing.
import crypto from 'node:crypto';

const META_BASE = 'https://graph.facebook.com/v21.0';
const GUP_URL = 'https://api.gupshup.io/wa/api/v1/template/msg';
const digits = (p) => String(p || '').replace(/\D/g, '');

export function waEnv(env = process.env) {
  const pick = String(env.CLINIC_WA_PROVIDER || '').trim().toLowerCase();
  const metaToken = String(env.CLINIC_WA_META_TOKEN || '').trim();
  const metaPhone = String(env.CLINIC_WA_META_PHONE_ID || '').trim();
  const gupKey = String(env.CLINIC_WA_GUPSHUP_API_KEY || '').trim();
  const gupSource = digits(env.CLINIC_WA_GUPSHUP_SOURCE);
  const gupApp = String(env.CLINIC_WA_GUPSHUP_APP_NAME || '').trim();
  const metaReady = !!(metaToken && metaPhone);
  const gupReady = !!(gupKey && gupSource && gupApp);
  let id = '';
  if (pick === 'meta' && metaReady) id = 'meta';
  else if (pick === 'gupshup' && gupReady) id = 'gupshup';
  else if (!pick && metaReady && !gupReady) id = 'meta';
  else if (!pick && gupReady && !metaReady) id = 'gupshup';
  return {
    id, configured: !!id,
    template: String(env.CLINIC_WA_TEMPLATE || 'aaas_note').replace(/[^a-z0-9_]/gi, '').slice(0, 64) || 'aaas_note',
    lang: String(env.CLINIC_WA_TEMPLATE_LANG || 'en').slice(0, 12) || 'en',
    metaToken, metaPhone, metaSecret: String(env.CLINIC_WA_META_APP_SECRET || '').trim(),
    metaVerify: String(env.CLINIC_WA_META_VERIFY_TOKEN || '').trim(),
    gupKey, gupSource, gupApp, webhookSecret: String(env.CLINIC_WA_WEBHOOK_SECRET || '').trim(),
  };
}

export function waPublic(env = process.env) {
  const cfg = waEnv(env);
  return { configured: cfg.configured, provider: cfg.id || '', template: cfg.configured ? cfg.template : '' };
}

export function waMockOn(env = process.env) {
  const mock = String(env.AI_PROVIDER || '').toLowerCase() === 'mock' && String(env.AI_MOCK || '').toLowerCase() === 'on';
  return mock && String(env.CLINIC_WA_MOCK || '').toLowerCase() === 'on';
}

export function sendDecision({ configured, demo, opt, to, owner }) {
  if (!digits(to)) return { send: false, reason: 'no_phone' };
  if (demo) return { send: false, reason: 'sample' };
  if (!configured) return { send: false, reason: 'unconfigured' };
  if (owner) return { send: true, reason: 'owner' };
  if (opt === 'out') return { send: false, reason: 'opt_out' };
  if (opt !== 'in') return { send: false, reason: 'no_opt_in' };
  return { send: true, reason: 'opt_in' };
}

const STOP = /^(stop|stopall|unsubscribe|cancel|optout|opt-out)$/i;
const START = /^(start|unstop|optin|opt-in)$/i;
export function optWord(text) {
  const t = String(text || '').trim();
  if (STOP.test(t)) return 'out';
  if (START.test(t)) return 'in';
  return '';
}

function templateText(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 900);
}

export async function sendTemplate({ to, body, env = process.env, fetchImpl } = {}) {
  const cfg = waEnv(env);
  const dest = digits(to);
  if (!cfg.configured) return { sent: false, reason: 'unconfigured' };
  if (dest.length < 11 || dest.length > 15) return { sent: false, reason: 'bad_phone' };
  const text = templateText(body);
  if (!text) return { sent: false, reason: 'empty' };
  if (waMockOn(env)) {
    const id = 'wamid.mock' + crypto.createHash('sha256').update(cfg.id + ':' + dest + ':' + text).digest('hex').slice(0, 16);
    return { sent: true, id, provider: cfg.id, mocked: true };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw Object.assign(new Error('This server cannot call WhatsApp.'), { status: 500 });
  if (cfg.id === 'meta') return sendMeta({ cfg, dest, text, fetchFn });
  return sendGupshup({ cfg, dest, text, fetchFn });
}

async function sendMeta({ cfg, dest, text, fetchFn }) {
  const url = META_BASE + '/' + encodeURIComponent(cfg.metaPhone) + '/messages';
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.metaToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: dest, type: 'template',
        template: {
          name: cfg.template, language: { code: cfg.lang },
          components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
        },
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch { throw Object.assign(new Error('WhatsApp did not answer.'), { status: 502 }); }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  const id = data.messages && data.messages[0] && data.messages[0].id;
  if (!res.ok || !id) throw Object.assign(new Error('WhatsApp did not accept the template.'), { status: 502 });
  return { sent: true, id: String(id), provider: 'meta' };
}

async function sendGupshup({ cfg, dest, text, fetchFn }) {
  const form = new URLSearchParams();
  form.set('channel', 'whatsapp');
  form.set('source', cfg.gupSource);
  form.set('destination', dest);
  form.set('src.name', cfg.gupApp);
  form.set('template', JSON.stringify({ id: cfg.template, params: [text] }));
  let res;
  try {
    res = await fetchFn(GUP_URL, {
      method: 'POST',
      headers: { apikey: cfg.gupKey, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(12000),
    });
  } catch { throw Object.assign(new Error('WhatsApp did not answer.'), { status: 502 }); }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  const id = data.messageId || data.message_id || data.id;
  if (!res.ok || !id) throw Object.assign(new Error('WhatsApp did not accept the template.'), { status: 502 });
  return { sent: true, id: String(id), provider: 'gupshup' };
}

export function parseWaWebhook(provider, event) {
  const statuses = [], inbound = [];
  if (provider === 'gupshup') {
    const type = String(event && event.type || '');
    const payload = (event && event.payload) || {};
    if (type === 'message-event') {
      const status = String(payload.type || '').toLowerCase();
      if (payload.id && status) statuses.push({ id: String(payload.id), status, to: digits(payload.destination) });
    } else if (type === 'message') {
      const text = payload.type === 'text' ? (payload.payload && payload.payload.text) : '';
      if (payload.source) inbound.push({ from: digits(payload.source), text: String(text || ''), id: String(payload.id || '') });
    }
    return { statuses, inbound };
  }
  const entries = (event && event.entry) || [];
  for (const ent of entries) {
    for (const change of (ent && ent.changes) || []) {
      const value = (change && change.value) || {};
      for (const st of value.statuses || []) {
        if (st && st.id) statuses.push({ id: String(st.id), status: String(st.status || '').toLowerCase(), to: digits(st.recipient_id) });
      }
      for (const msg of value.messages || []) {
        const text = msg && msg.type === 'text' && msg.text ? msg.text.body : '';
        if (msg && msg.from) inbound.push({ from: digits(msg.from), text: String(text || ''), id: String(msg.id || '') });
      }
    }
  }
  return { statuses, inbound };
}

const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
export function nextWaStatus(prev, incoming) {
  const status = incoming === 'enqueued' ? 'sent' : incoming;
  if (!RANK[status]) return prev || '';
  if (status === 'failed') return 'failed';
  if ((RANK[prev] || 0) > RANK[status]) return prev;
  return status;
}

export function safeEqual(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!want || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function metaSignature(raw, secret) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')).digest('hex');
}
