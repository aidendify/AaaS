// WhatsApp QR (Baileys) — BETA, owner-only.
// The number that scans the QR is the only number that may talk to that account's Chief of Staff.
// Replies go only to that number's own chat. Customer chats, groups and broadcasts are ignored and never sent to.
// Off unless WHATSAPP_QR=on. A serverless host (Vercel) does not open a socket.
// Sessions are encrypted in the account's channel credentials. Nothing here is written to the log.
import QRCode from 'qrcode';
import pino from 'pino';
import { redactSecrets } from './channels.js';

export const WAQR_WARNING = 'BETA and unofficial. This is not the Meta WhatsApp Cloud API. WhatsApp can restrict or ban this number. Only the linked owner’s own number can talk to their Chief of Staff, in the chat with themselves. It never messages customers and it never broadcasts. It needs a server that stays running. It does not run on Vercel or other serverless hosts.';

const sessions = new Map();
const silent = pino({ level: 'silent' });
let ownerHandler = null;

export function setWaqrOwnerHandler(fn) { ownerHandler = fn; }

export function waqrRuntime() {
  const enabled = ['1', 'on', 'true'].includes(String(process.env.WHATSAPP_QR || '').toLowerCase());
  const serverless = !!(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);
  return {
    enabled, beta: true, persistent: !serverless, available: enabled && !serverless,
    warning: WAQR_WARNING,
    reason: !enabled ? 'flag_off' : serverless ? 'serverless' : '',
  };
}

const digits = (s) => String(s || '').replace(/\D/g, '');

export function waqrMaySend(to, owner) {
  const dest = String(to || '');
  if (/@g\.us|broadcast/i.test(dest)) return false;
  const a = digits(dest), b = digits(owner);
  return !!b && !!a && a === b;
}

export function routeWaqrSender(from, owner) {
  if (!waqrMaySend(from, owner)) return 'drop';
  return 'chief';
}

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code; return e;
}

export function assertWaqrAvailable() {
  const rt = waqrRuntime();
  if (!rt.enabled) throw fail(403, 'waqr_off', 'WhatsApp QR is off. Set WHATSAPP_QR=on on a server that stays running. ' + WAQR_WARNING);
  if (!rt.persistent) throw fail(503, 'waqr_serverless', 'WhatsApp QR needs a persistent server. It does not run on Vercel or other serverless hosts. ' + WAQR_WARNING);
  return rt;
}

export async function attachWaqrHint(hint, email) {
  const out = { ...(hint || {}), beta: true, owner_only: true, warning: (hint && hint.warning) || WAQR_WARNING };
  delete out.session;
  const live = sessions.get(email);
  if (live && live.qr) {
    out.status = 'qr';
    try { out.qr_image = await QRCode.toDataURL(live.qr, { margin: 1, width: 260 }); }
    catch { /* the owner can refresh; the QR string itself is not logged */ }
  } else if (live && live.status) out.status = live.status;
  return out;
}

async function saveWaqr(st, email, secret, patch) {
  const { withCreds } = await import('./channels.js');
  return withCreds(st, email, secret, async ({ creds, idx }) => {
    const prev = { ...(creds.waqr || {}) };
    const waqr = { ...prev, ...patch };
    if (patch.session === null) delete waqr.session;
    const next = { ...creds, waqr };
    const linked = !!waqr.owner_phone;
    return { creds: next, idx: { ...idx, waqr: linked }, public: { linked, hint: waqr.owner_phone ? String(waqr.owner_phone).slice(-4) : '' } };
  });
}

function messageText(m) {
  const msg = m && m.message;
  if (!msg) return '';
  if (typeof msg.conversation === 'string') return msg.conversation;
  if (msg.extendedTextMessage && typeof msg.extendedTextMessage.text === 'string') return msg.extendedTextMessage.text;
  return '';
}

async function loadAuth(st, email, secret, baileys) {
  const { loadChannelCreds } = await import('./channels.js');
  const creds = await loadChannelCreds(st, email, secret);
  const raw = creds && creds.waqr && typeof creds.waqr.session === 'string' ? creds.waqr.session : '';
  let stored = null;
  if (raw) { try { stored = JSON.parse(raw, baileys.BufferJSON.reviver); } catch { stored = null; } }
  const state = {
    creds: (stored && stored.creds) || baileys.initAuthCreds(),
    keys: (stored && stored.keys) || {},
  };
  const persist = async () => {
    const session = JSON.stringify({ creds: state.creds, keys: state.keys }, baileys.BufferJSON.replacer);
    await saveWaqr(st, email, secret, { session });
  };
  return {
    state: {
      creds: state.creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = state.keys[type + ':' + id];
            if (type === 'app-state-sync-key' && value) {
              try { value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value); } catch { /* keep the stored value */ }
            }
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const key = category + ':' + id;
              if (value) state.keys[key] = value;
              else delete state.keys[key];
            }
          }
          await persist();
        },
      },
    },
    saveCreds: persist,
  };
}

export async function sendToLinkedOwner(email, text) {
  const live = sessions.get(email);
  if (!live || !live.sock || !live.owner) {
    const e = new Error('WhatsApp QR is not linked on this server. Nothing was sent.');
    e.status = 400; e.code = 'not_connected'; throw e;
  }
  if (!waqrMaySend(live.owner, live.owner)) throw fail(400, 'owner_only', 'WhatsApp QR can only message the linked owner.');
  const jid = digits(live.owner) + '@s.whatsapp.net';
  const sent = await live.sock.sendMessage(jid, { text: String(text || '').slice(0, 3500) });
  const id = sent && sent.key && sent.key.id;
  if (id) live.sent.add(id);
  live.echo.add(String(text || '').slice(0, 500));
  if (live.echo.size > 30) live.echo.delete(live.echo.values().next().value);
  return { id: id || 'sent' };
}

function watchSocket(sock, live, st, email, secret) {
  sock.ev.on('creds.update', () => { live.saveCreds().catch((e) => console.error('WhatsApp QR: session save failed', redactSecrets(e && e.message))); });
  sock.ev.on('connection.update', (update) => {
    const qr = update && update.qr, connection = update && update.connection;
    if (qr && live.gen === sessions.get(email)?.gen) { live.qr = qr; live.status = 'qr'; }
    if (connection === 'open') {
      live.qr = '';
      live.status = 'linked';
      const jid = (sock.user && sock.user.id) || '';
      const owner = digits(String(jid).split('@')[0].split(':')[0]);
      if (owner) {
        live.owner = owner;
        saveWaqr(st, email, secret, { owner_phone: owner, status: 'linked' }).catch((e) => console.error('WhatsApp QR: could not store the linked number', redactSecrets(e && e.message)));
      }
      console.log('WhatsApp QR: owner linked');
    }
    if (connection === 'close') {
      live.status = 'closed';
      const code = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode;
      console.log('WhatsApp QR: connection closed (' + (code || 'unknown') + ')');
      if (sessions.get(email) === live) sessions.delete(email);
    }
  });
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      if (!m || !m.key) continue;
      if (live.sent.has(m.key.id)) continue;
      const jid = String(m.key.remoteJid || '');
      if (/@g\.us|broadcast/i.test(jid)) { console.log('WhatsApp QR: ignored a group or broadcast'); continue; }
      const from = digits(jid.split('@')[0].split(':')[0]);
      const owner = digits(live.owner);
      if (!owner || from !== owner) { console.log('WhatsApp QR: ignored a message that was not from the linked owner'); continue; }
      const text = String(messageText(m) || '').trim();
      if (!text || live.echo.has(text)) continue;
      if (typeof ownerHandler !== 'function') continue;
      ownerHandler({ st, email, secret, from, text, id: String(m.key.id || '') }).catch((e) => console.error('WhatsApp QR: chief reply failed', redactSecrets(e && e.message)));
    }
  });
}

export async function startWaqr(st, email, secret) {
  assertWaqrAvailable();
  const existing = sessions.get(email);
  if (existing && (existing.status === 'qr' || existing.status === 'linked' || existing.status === 'starting')) {
    return { status: existing.status, linked: existing.status === 'linked', beta: true, warning: WAQR_WARNING };
  }
  let baileys;
  try { baileys = await import('@whiskeysockets/baileys'); }
  catch (e) {
    console.error('WhatsApp QR: connector unavailable', redactSecrets(e && e.message));
    throw fail(503, 'waqr_unavailable', 'WhatsApp QR could not start on this server. ' + WAQR_WARNING);
  }
  const makeWASocket = baileys.default;
  const auth = await loadAuth(st, email, secret, baileys);
  const live = { gen: Date.now(), sock: null, qr: '', status: 'starting', owner: '', sent: new Set(), echo: new Set(), saveCreds: auth.saveCreds };
  const { loadChannelCreds } = await import('./channels.js');
  const creds = await loadChannelCreds(st, email, secret);
  if (creds && creds.waqr && creds.waqr.owner_phone) live.owner = digits(creds.waqr.owner_phone);
  sessions.set(email, live);
  try {
    const sock = makeWASocket({
      auth: auth.state,
      logger: silent,
      printQRInTerminal: false,
      browser: baileys.Browsers.ubuntu('AIdentify'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    live.sock = sock;
    watchSocket(sock, live, st, email, secret);
  } catch (e) {
    sessions.delete(email);
    console.error('WhatsApp QR: connector unavailable', redactSecrets(e && e.message));
    throw fail(503, 'waqr_unavailable', 'WhatsApp QR could not start on this server. ' + WAQR_WARNING);
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && live.status === 'starting') await new Promise((r) => setTimeout(r, 200));
  return { status: live.status, linked: live.status === 'linked', beta: true, warning: WAQR_WARNING, owner_only: true };
}

export async function stopWaqr(st, email, secret, { wipe = true } = {}) {
  const live = sessions.get(email);
  if (live) {
    sessions.delete(email);
    try { live.sock && live.sock.end(undefined); } catch { /* already closed */ }
  }
  if (wipe && st && email && secret) {
    const { withCreds } = await import('./channels.js');
    await withCreds(st, email, secret, async ({ creds, idx }) => {
      const next = { ...creds };
      delete next.waqr;
      const i = { ...idx };
      delete i.waqr;
      return { creds: next, idx: i, public: { ok: true } };
    });
  }
  return { ok: true };
}

export async function stopAllWaqr() {
  for (const email of [...sessions.keys()]) {
    const live = sessions.get(email);
    sessions.delete(email);
    try { live && live.sock && live.sock.end(undefined); } catch { /* shutting down */ }
  }
}

export async function resumeLinkedSessions(st, secret) {
  const rt = waqrRuntime();
  if (!rt.available || !st) return { skipped: rt.reason || 'off' };
  let rows = [];
  try { rows = typeof st.listPrefix === 'function' ? await st.listPrefix('as_chidx:') : []; }
  catch (e) { console.error('WhatsApp QR: could not look for linked owners', redactSecrets(e && e.message)); return { skipped: 'list' }; }
  let n = 0;
  for (const row of rows) {
    let idx = null;
    try { idx = JSON.parse(row.v); } catch { idx = null; }
    if (!idx || !idx.waqr) continue;
    const email = String(row.k || '').slice('as_chidx:'.length);
    if (!email) continue;
    try { await startWaqr(st, email, secret); n++; }
    catch (e) { console.error('WhatsApp QR: could not resume a linked owner', redactSecrets(e && e.message)); }
  }
  return { resumed: n };
}
