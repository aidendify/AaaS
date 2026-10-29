// Free channels (v2.5). Telegram and Slack are per account: the owner pastes a token, and a webhook
// is checked before any message is trusted. The owner's own messages go to Chief of Staff.
// Customers reach the front desk only when the owner turns that on, and those replies start as needs approval.
// WhatsApp QR is a separate beta and is owner-only. It never uses the front desk and never messages customers.
import crypto from 'node:crypto';
import { redactSecrets, withCreds, loadChannelCreds, readChannelIndex, writeChannelIndex, recordMessage, ingestInbound } from './channels.js';
import { waqrRuntime, waqrMaySend, routeWaqrSender, assertWaqrAvailable, startWaqr, stopWaqr, sendToLinkedOwner, setWaqrOwnerHandler, WAQR_WARNING } from './waqr.js';

const parse = (v, d) => { try { return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const digits = (s) => String(s || '').replace(/\D/g, '');
const last4 = (s) => { const t = String(s || ''); return t ? '••••' + t.slice(-4) : ''; };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const TG_HOOK = 'as_tghook:', TG_BOT = 'as_tgbot:', SL_HOOK = 'as_slhook:', SL_TEAM = 'as_slteam:';
const inflight = new Set();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function bad(status, code, message) { const e = new Error(message); e.status = status; e.code = code; throw e; }

export function slackSignature(secret, timestamp, raw) {
  return 'v0=' + crypto.createHmac('sha256', String(secret)).update('v0:' + timestamp + ':' + String(raw ?? '')).digest('hex');
}
export function slackSignatureOk({ secret, timestamp, signature, raw, now = Date.now() }) {
  const ts = String(timestamp || '');
  if (!/^\d{10}$/.test(ts)) return false;
  if (Math.abs(Math.floor(Number(now) / 1000) - Number(ts)) > 60 * 5) return false;
  if (!secret || String(secret).length < 8) return false;
  return safeEqual(String(signature || ''), slackSignature(secret, ts, raw));
}

// chief: the owner's own chat. desk: a customer, and only when that account allowed it.
// drop: everyone else, including every WhatsApp QR sender who is not the linked owner.
export function routeFreeInbound({ channel, sender, owner, customers }) {
  const who = String(sender || '');
  const mine = String(owner || '');
  if (channel === 'whatsapp_qr') return routeWaqrSender(who, mine) === 'chief' ? 'chief' : 'drop';
  if (channel !== 'telegram' && channel !== 'slack') return 'drop';
  if (mine && who === mine) return 'chief';
  if (customers === true) return 'desk';
  return 'drop';
}

export function freeHints(creds) {
  const rt = waqrRuntime();
  const tg = creds && creds.telegram;
  const sl = creds && creds.slack;
  const qr = creds && creds.waqr;
  return {
    telegram: tg && tg.bot_id ? {
      connected: true, bot_id: String(tg.bot_id), username: tg.username || '', hint: last4(tg.token),
      owner_linked: !!tg.owner_user_id, customers: !!tg.customers,
      webhook_path: '/api/channels/telegram/webhook/' + tg.hook_id,
    } : { connected: false },
    slack: sl && sl.hook_id ? {
      connected: true, team_id: sl.team_id || '', hint: last4(sl.bot_token),
      owner_linked: !!sl.owner_user_id, customers: !!sl.customers,
      webhook_path: '/api/channels/slack/webhook/' + sl.hook_id,
    } : { connected: false },
    whatsapp_qr: {
      beta: true, label: 'BETA', enabled: rt.enabled, persistent: rt.persistent, available: rt.available,
      reason: rt.reason, warning: rt.warning || WAQR_WARNING, owner_only: true,
      linked: !!(qr && qr.owner_phone), hint: qr && qr.owner_phone ? last4(qr.owner_phone) : '',
      status: qr && qr.owner_phone ? 'linked' : 'off',
    },
  };
}

function hookUrl(kind, id) {
  const path = '/api/channels/' + kind + '/webhook/' + id;
  const base = String(process.env.APP_URL || '').replace(/\/$/, '');
  return base ? base + path : path;
}
async function claim(st, key, email) {
  const cur = await readChannelIndex(st, key);
  if (cur && cur.email && cur.email !== email) bad(409, 'channel_taken', 'That connection is already used by another account.');
  await writeChannelIndex(st, key, { email });
}
function mockish(token) { return String(token || '').startsWith('mock_'); }
function mockTokensOn() { return String(process.env.CHANNELS_MOCK || '').toLowerCase() === 'on'; }
// A mock_ token never skips Telegram or Slack unless the test switch is on.
function useMock(token) {
  if (!mockish(token)) return false;
  if (!mockTokensOn()) bad(400, 'bad_channel', 'A mock_ token is only accepted when CHANNELS_MOCK is on.');
  return true;
}

function cleanTelegramToken(token) {
  const t = String(token || '').trim();
  if (useMock(t) && t.length >= 12 && t.length <= 120) return t;
  if (!/^\d{6,16}:[A-Za-z0-9_-]{30,}$/.test(t)) bad(400, 'bad_channel', 'Paste the bot token from BotFather.');
  return t;
}
function cleanSlackToken(token) {
  const t = String(token || '').trim();
  if (useMock(t) && t.length >= 12 && t.length <= 120) return t;
  if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(t)) bad(400, 'bad_channel', 'Paste the Slack bot token (it starts with xoxb-).');
  return t;
}
function cleanSigningSecret(secret) {
  const t = String(secret || '').trim();
  if (t.length < 8 || t.length > 200) bad(400, 'bad_channel', 'Paste the Slack signing secret.');
  return t;
}
function takeOwner(value, prev, kind) {
  if (value == null || String(value).trim() === '') return prev || '';
  const id = String(value).trim();
  if (kind === 'telegram' && !/^\d{5,16}$/.test(id)) bad(400, 'bad_channel', 'Your Telegram user id should be digits.');
  if (kind === 'slack' && !/^[UW][A-Z0-9]{6,20}$/.test(id)) bad(400, 'bad_channel', 'Your Slack member id looks like U0123456789.');
  return id;
}

async function telegramIdentity(token) {
  if (useMock(token)) return { id: String(parseInt(sha(token).slice(0, 8), 16)), username: 'mock_bot' };
  let j = {};
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(15000) });
    j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.result) bad(400, 'bad_channel', 'Telegram did not accept that bot token.');
  } catch (e) {
    if (e && e.status) throw e;
    console.error('Telegram: token check failed', redactSecrets(e && e.message));
    bad(400, 'bad_channel', 'Telegram did not accept that bot token.');
  }
  return { id: String(j.result.id), username: String(j.result.username || '') };
}
async function telegramSetWebhook(token, url, secretToken) {
  if (useMock(token) || !String(process.env.APP_URL || '').startsWith('http')) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message'] }),
    });
    const j = await r.json().catch(() => ({}));
    return !!(r.ok && j.ok);
  } catch (e) {
    console.error('Telegram: webhook was not set', redactSecrets(e && e.message));
    return false;
  }
}
async function slackIdentity(token) {
  if (useMock(token)) return { team_id: 'T' + sha(token).slice(0, 8).toUpperCase(), bot_user_id: 'B' + sha('b' + token).slice(0, 8).toUpperCase() };
  let j = {};
  try {
    const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    console.error('Slack: token check failed', redactSecrets(e && e.message));
    bad(400, 'bad_channel', 'Slack did not accept that bot token.');
  }
  if (!j.ok || !j.team_id) bad(400, 'bad_channel', 'Slack did not accept that bot token.');
  return { team_id: String(j.team_id), bot_user_id: String(j.user_id || '') };
}

function publicTelegram(tg, extra = {}) {
  return {
    connected: true, bot_id: String(tg.bot_id), username: tg.username || '', hint: last4(tg.token),
    owner_linked: !!tg.owner_user_id, customers: !!tg.customers,
    webhook_url: hookUrl('telegram', tg.hook_id), webhook_set: !!extra.webhook_set,
    ...(extra.secret_token ? { secret_token: extra.secret_token } : {}),
    ...(tg.link_code ? { link_code: tg.link_code } : {}),
  };
}
function publicSlack(sl, extra = {}) {
  return {
    connected: true, team_id: sl.team_id || '', hint: last4(sl.bot_token),
    owner_linked: !!sl.owner_user_id, customers: !!sl.customers,
    webhook_url: hookUrl('slack', sl.hook_id),
    ...(sl.link_code ? { link_code: sl.link_code } : {}),
  };
}

export async function saveTelegram(st, email, secret, body) {
  const b = body || {};
  return withCreds(st, email, secret, async ({ creds, idx }) => {
    const prev = creds.telegram || null;
    const pasted = String(b.bot_token || '').trim();
    if (!pasted && !prev) bad(400, 'bad_channel', 'Paste the bot token from BotFather.');
    let tg = prev ? { ...prev } : null;
    let reveal = false;
    if (pasted) {
      const token = cleanTelegramToken(pasted);
      if (!prev || prev.token !== token) {
        const ident = await telegramIdentity(token);
        if (idx.tg_bot && idx.tg_bot !== ident.id) await writeChannelIndex(st, TG_BOT + idx.tg_bot, null);
        if (idx.tg_hook) await writeChannelIndex(st, TG_HOOK + idx.tg_hook, null);
        await claim(st, TG_BOT + ident.id, email);
        const hook_id = crypto.randomBytes(16).toString('hex');
        const secret_token = crypto.randomBytes(24).toString('hex');
        await claim(st, TG_HOOK + hook_id, email);
        tg = {
          token, bot_id: ident.id, username: ident.username, hook_id, secret_token,
          owner_user_id: takeOwner(b.owner_user_id, prev && prev.owner_user_id, 'telegram'),
          customers: b.customers === true, link_code: crypto.randomBytes(8).toString('hex'),
        };
        idx = { ...idx, tg_bot: ident.id, tg_hook: hook_id };
        reveal = true;
        tg.webhook_set = await telegramSetWebhook(token, hookUrl('telegram', hook_id), secret_token);
      } else {
        tg.owner_user_id = takeOwner(b.owner_user_id, tg.owner_user_id, 'telegram');
        if (b.customers != null) tg.customers = b.customers === true;
      }
    } else {
      tg.owner_user_id = takeOwner(b.owner_user_id, tg.owner_user_id, 'telegram');
      if (b.customers != null) tg.customers = b.customers === true;
    }
    return { creds: { ...creds, telegram: tg }, idx, public: { telegram: publicTelegram(tg, { secret_token: reveal ? tg.secret_token : '', webhook_set: !!tg.webhook_set }) } };
  });
}

export async function saveSlack(st, email, secret, body) {
  const b = body || {};
  return withCreds(st, email, secret, async ({ creds, idx }) => {
    const prev = creds.slack || null;
    const pasted = String(b.bot_token || '').trim();
    const pastedSecret = String(b.signing_secret || '').trim();
    if ((!pasted || !pastedSecret) && !prev) bad(400, 'bad_channel', 'Paste the Slack bot token and the signing secret.');
    let sl = prev ? { ...prev } : null;
    if (pasted || pastedSecret) {
      const token = pasted ? cleanSlackToken(pasted) : prev.bot_token;
      const signing_secret = pastedSecret ? cleanSigningSecret(pastedSecret) : prev.signing_secret;
      if (!prev || prev.bot_token !== token || prev.signing_secret !== signing_secret) {
        const ident = await slackIdentity(token);
        if (idx.sl_team && idx.sl_team !== ident.team_id) await writeChannelIndex(st, SL_TEAM + idx.sl_team, null);
        if (idx.sl_hook) await writeChannelIndex(st, SL_HOOK + idx.sl_hook, null);
        await claim(st, SL_TEAM + ident.team_id, email);
        const hook_id = crypto.randomBytes(16).toString('hex');
        await claim(st, SL_HOOK + hook_id, email);
        sl = {
          bot_token: token, signing_secret, team_id: ident.team_id, bot_user_id: ident.bot_user_id, hook_id,
          owner_user_id: takeOwner(b.owner_user_id, prev && prev.owner_user_id, 'slack'),
          customers: b.customers === true, link_code: crypto.randomBytes(8).toString('hex'),
        };
        idx = { ...idx, sl_team: ident.team_id, sl_hook: hook_id };
      } else {
        sl.owner_user_id = takeOwner(b.owner_user_id, sl.owner_user_id, 'slack');
        if (b.customers != null) sl.customers = b.customers === true;
      }
    } else {
      sl.owner_user_id = takeOwner(b.owner_user_id, sl.owner_user_id, 'slack');
      if (b.customers != null) sl.customers = b.customers === true;
    }
    return { creds: { ...creds, slack: sl }, idx, public: { slack: publicSlack(sl) } };
  });
}

export async function disconnectFree(st, email, secret, which) {
  if (which === 'whatsapp_qr') {
    await stopWaqr(st, email, secret, { wipe: true });
    return { ok: true };
  }
  return withCreds(st, email, secret, async ({ creds, idx }) => {
    const next = { ...creds };
    const i = { ...idx };
    if (which === 'telegram') {
      if (i.tg_bot) await writeChannelIndex(st, TG_BOT + i.tg_bot, null);
      if (i.tg_hook) await writeChannelIndex(st, TG_HOOK + i.tg_hook, null);
      delete next.telegram; delete i.tg_bot; delete i.tg_hook;
    } else if (which === 'slack') {
      if (i.sl_team) await writeChannelIndex(st, SL_TEAM + i.sl_team, null);
      if (i.sl_hook) await writeChannelIndex(st, SL_HOOK + i.sl_hook, null);
      delete next.slack; delete i.sl_team; delete i.sl_hook;
    } else bad(400, 'bad_channel', 'Say which channel to disconnect.');
    return { creds: next, idx: i, public: { ok: true } };
  });
}

async function askChief(st, email, { text, channel, peer, secret }) {
  const { runAgent } = await import('./orchestrator.js');
  const { helpers } = await import('./backend.js');
  const key = 'as_fch:' + email;
  const all = parse((await st.get(key))?.v, {}) || {};
  const k = channel + ':' + peer;
  const history = Array.isArray(all[k]) ? all[k] : [];
  const users = parse((await st.get('as_users'))?.v, {}) || {};
  const data = parse((await st.get('as_data:' + email))?.v, null) || { agents: [] };
  const out = await runAgent({
    st, email, userName: (users[email] && users[email].name) || '', data, agent: null,
    message: text, history, tz: process.env.APP_TIMEZONE || 'Asia/Kolkata', mode: 'chat',
    secret: secret || helpers.secret, wpSearch: helpers.wpSearch, wpChunks: helpers.wpChunks,
  });
  const answer = String(out.answer || '').trim() || 'Done.';
  const note = out.approvals && out.approvals.length ? `\n\n${out.approvals.length} action(s) wait for your approval in AaaS.` : '';
  const full = clip(answer + note, 3500);
  all[k] = [...history, { r: 'u', t: clip(text, 2000) }, { r: 'a', t: full }].slice(-20);
  const keys = Object.keys(all);
  if (keys.length > 40) for (const x of keys.slice(0, keys.length - 40)) delete all[x];
  await st.put(key, JSON.stringify(all), Date.now());
  return full;
}

async function seen(st, email, id) {
  if (!id) return false;
  const key = 'as_fseen:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  return all.includes(id);
}
async function markSeen(st, email, id) {
  if (!id) return;
  const key = 'as_fseen:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  if (!all.includes(id)) all.push(id);
  await st.put(key, JSON.stringify(all.slice(-400)), Date.now());
}

async function deliverOwner(st, email, secret, creds, { channel, peer, text, id }) {
  let providerId = id ? 'out-' + id : '';
  if (channel === 'telegram' && creds.telegram && !useMock(creds.telegram.token)) providerId = (await telegramSend(creds.telegram.token, peer, text)).id;
  if (channel === 'slack' && creds.slack && !useMock(creds.slack.bot_token)) providerId = (await slackSend(creds.slack.bot_token, peer, text)).id;
  if (channel === 'whatsapp_qr') {
    const owner = creds.waqr && creds.waqr.owner_phone;
    if (!waqrMaySend(owner, owner)) bad(400, 'owner_only', 'WhatsApp QR can only message the linked owner.');
    try { providerId = (await sendToLinkedOwner(email, text)).id || providerId; }
    catch (e) { if (!e || e.code !== 'not_connected') throw e; }
  }
  await recordMessage(st, email, { channel, peer: String(peer), name: 'You', dir: 'out', body: text, status: 'sent', providerId });
}

async function telegramSend(token, chatId, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ chat_id: chatId, text: clip(text, 3500) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) bad(502, 'provider', 'Telegram did not accept the message. Nothing else was sent.');
    return { id: String(j.result && j.result.message_id || 'sent'), mode: 'session', via: 'telegram' };
  } catch (e) {
    if (e && e.code === 'provider') throw e;
    console.error('Telegram: send failed', redactSecrets(e && e.message));
    bad(502, 'provider', 'Telegram did not accept the message. Nothing else was sent.');
  }
}
async function slackSend(token, channel, text) {
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ channel, text: clip(text, 3500) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) bad(502, 'provider', 'Slack did not accept the message. Nothing else was sent.');
    return { id: String(j.ts || 'sent'), mode: 'session', via: 'slack' };
  } catch (e) {
    if (e && e.code === 'provider') throw e;
    console.error('Slack: send failed', redactSecrets(e && e.message));
    bad(502, 'provider', 'Slack did not accept the message. Nothing else was sent.');
  }
}

export async function sendCustomerReply(creds, { channel, to, body }) {
  if (channel === 'whatsapp_qr' || channel === 'waqr') bad(400, 'owner_only', 'WhatsApp QR is owner-only. It cannot message customers or send a broadcast.');
  if (channel === 'telegram') {
    const tg = creds && creds.telegram;
    if (!tg || !tg.token) bad(400, 'not_connected', 'Telegram is not connected. Nothing was sent.');
    if (useMock(tg.token)) return { id: 'mock-tg-' + crypto.randomBytes(3).toString('hex'), mode: 'session', via: 'mock' };
    return telegramSend(tg.token, to, body);
  }
  if (channel === 'slack') {
    const sl = creds && creds.slack;
    if (!sl || !sl.bot_token) bad(400, 'not_connected', 'Slack is not connected. Nothing was sent.');
    if (useMock(sl.bot_token)) return { id: 'mock-sl-' + crypto.randomBytes(3).toString('hex'), mode: 'session', via: 'mock' };
    return slackSend(sl.bot_token, to, body);
  }
  bad(400, 'bad_channel', 'That channel cannot send this reply.');
}

function linkCommand(text) {
  const m = String(text || '').trim().match(/^(?:\/link|link)\s+([A-Za-z0-9_-]{8,64})$/i);
  return m ? m[1] : '';
}

async function linkOwner(st, email, secret, kind, sender, code) {
  return withCreds(st, email, secret, async ({ creds, idx }) => {
    const row = creds[kind];
    if (!row || !row.link_code || !safeEqual(row.link_code, code)) return { creds, idx, public: { linked: false } };
    const next = { ...row, owner_user_id: String(sender), link_code: '' };
    return { creds: { ...creds, [kind]: next }, idx, public: { linked: true } };
  });
}

async function runRouted(st, email, secret, creds, { channel, sender, name, text, peer, id, customers, owner }) {
  const route = routeFreeInbound({ channel, sender, owner, customers });
  if (route === 'drop') return { ok: true, route: 'drop' };
  if (await seen(st, email, id)) return { ok: true, route, duplicate: true };
  if (route === 'chief') {
    await recordMessage(st, email, { channel, peer: String(peer), name: 'You', dir: 'in', body: text, status: 'received', providerId: id });
    const answer = await askChief(st, email, { text, channel, peer, secret });
    await deliverOwner(st, email, secret, creds, { channel, peer, text: answer, id });
    await markSeen(st, email, id);
    console.log('Free channel: chief on ' + channel);
    return { ok: true, route: 'chief' };
  }
  const rec = await ingestInbound(st, email, {
    channel, from: String(peer), name, body: text, providerId: id, secret,
    visitor: channel === 'telegram' ? 'tg:' + sender : channel === 'slack' ? 'sl:' + sender : '',
  });
  await markSeen(st, email, id);
  console.log('Free channel: front desk on ' + channel);
  return { ok: true, route: 'desk', conversation_id: rec.conversation_id, sent: false };
}

export async function routeOwnerWhatsApp(st, email, secret, { from, text, id }) {
  const creds = await loadChannelCreds(st, email, secret);
  const owner = creds && creds.waqr && creds.waqr.owner_phone;
  const route = routeFreeInbound({ channel: 'whatsapp_qr', sender: from, owner, customers: false });
  if (route !== 'chief') {
    console.log('WhatsApp QR: ignored a message that was not from the linked owner');
    return { ok: true, route: 'drop' };
  }
  return runRouted(st, email, secret, creds, { channel: 'whatsapp_qr', sender: digits(from), name: 'You', text, peer: digits(owner), id: id || ('waqr-' + sha(text).slice(0, 12)), customers: false, owner: digits(owner) });
}

async function once(key, fn) {
  if (inflight.has(key)) return { ok: true, duplicate: true };
  inflight.add(key);
  try { return await fn(); }
  finally { inflight.delete(key); }
}

export async function publicFreeWebhook({ method, pathname, body, headers, st, secret }) {
  const tg = String(pathname || '').match(/^\/api\/channels\/telegram\/webhook\/([a-f0-9]{32})$/);
  const sl = String(pathname || '').match(/^\/api\/channels\/slack\/webhook\/([a-f0-9]{32})$/);
  if (!tg && !sl) return undefined;
  if (method !== 'POST') bad(405, 'bad_channel', 'This webhook accepts POST only.');
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (raw.length > 200000) bad(413, 'too_large', 'Payload is too large.');
  if (tg) return telegramWebhook(st, secret, tg[1], raw, headers);
  return slackWebhook(st, secret, sl[1], raw, headers);
}

async function telegramWebhook(st, secret, hook, raw, headers) {
  const ownerRow = await readChannelIndex(st, TG_HOOK + hook);
  if (!ownerRow || !ownerRow.email) bad(404, 'not_found', 'Unknown Telegram webhook.');
  const email = ownerRow.email;
  const creds = await loadChannelCreds(st, email, secret);
  const tg = creds && creds.telegram;
  const header = headers['x-telegram-bot-api-secret-token'] || headers['X-Telegram-Bot-Api-Secret-Token'];
  if (!tg || !safeEqual(header, tg.secret_token)) {
    console.log('Telegram webhook: signature did not match');
    bad(401, 'bad_signature', 'Telegram secret did not match.');
  }
  let update;
  try { update = JSON.parse(raw); } catch { bad(400, 'bad_channel', 'Telegram payload must be JSON.'); }
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return { ok: true, route: 'drop' };
  const from = msg.from || {};
  if (from.is_bot) return { ok: true, route: 'drop' };
  const sender = String(from.id || '');
  const text = clip(msg.text || '', 2000);
  if (!sender || !text) return { ok: true, route: 'drop' };
  const id = 'tg:' + (msg.chat && msg.chat.id) + ':' + msg.message_id;
  const code = linkCommand(text);
  if (code) {
    const linked = await linkOwner(st, email, secret, 'telegram', sender, code);
    if (linked && linked.linked) {
      await recordMessage(st, email, { channel: 'telegram', peer: String(msg.chat.id), name: 'You', dir: 'in', body: 'Linked this Telegram account.', status: 'received', providerId: id });
      await deliverOwner(st, email, secret, await loadChannelCreds(st, email, secret), { channel: 'telegram', peer: String(msg.chat.id), text: 'Linked. Your messages here go to your Chief of Staff. Anything that messages a customer still waits for approval.', id });
      return { ok: true, route: 'linked' };
    }
    return { ok: true, route: 'drop' };
  }
  return once(email + ':' + id, () => runRouted(st, email, secret, creds, {
    channel: 'telegram', sender, name: [from.first_name, from.last_name].filter(Boolean).join(' '),
    text, peer: String(msg.chat.id), id, customers: !!tg.customers, owner: String(tg.owner_user_id || ''),
  }));
}

async function slackWebhook(st, secret, hook, raw, headers) {
  const ownerRow = await readChannelIndex(st, SL_HOOK + hook);
  if (!ownerRow || !ownerRow.email) bad(404, 'not_found', 'Unknown Slack webhook.');
  const email = ownerRow.email;
  const creds = await loadChannelCreds(st, email, secret);
  const sl = creds && creds.slack;
  if (!sl || !slackSignatureOk({ secret: sl.signing_secret, timestamp: headers['x-slack-request-timestamp'], signature: headers['x-slack-signature'], raw })) {
    console.log('Slack webhook: signature did not match');
    bad(401, 'bad_signature', 'Slack signature did not match.');
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { bad(400, 'bad_channel', 'Slack payload must be JSON.'); }
  if (payload && payload.team_id && sl.team_id && String(payload.team_id) !== String(sl.team_id)) bad(401, 'bad_signature', 'Slack signature did not match.');
  if (payload && payload.type === 'url_verification') return { challenge: String(payload.challenge || '') };
  const ev = payload && payload.event;
  if (!ev || ev.bot_id || ev.subtype) return { ok: true, route: 'drop' };
  const mention = ev.type === 'app_mention';
  const dm = ev.type === 'message' && ev.channel_type === 'im';
  if (!mention && !dm) return { ok: true, route: 'drop' };
  const sender = String(ev.user || '');
  const text = clip(ev.text || '', 2000);
  if (!sender || !text) return { ok: true, route: 'drop' };
  if (sl.bot_user_id && sender === sl.bot_user_id) return { ok: true, route: 'drop' };
  const id = 'sl:' + (payload.event_id || ev.ts || sha(text));
  const peer = String(ev.channel || '');
  const code = linkCommand(text);
  if (code && dm) {
    const linked = await linkOwner(st, email, secret, 'slack', sender, code);
    if (linked && linked.linked) {
      await deliverOwner(st, email, secret, await loadChannelCreds(st, email, secret), { channel: 'slack', peer, text: 'Linked. Your DMs and mentions go to your Chief of Staff. Customer messages reach the front desk only if you turned that on, and those replies wait for approval.', id });
      return { ok: true, route: 'linked' };
    }
    return { ok: true, route: 'drop' };
  }
  return once(email + ':' + id, () => runRouted(st, email, secret, creds, {
    channel: 'slack', sender, name: '', text, peer, id, customers: !!sl.customers, owner: String(sl.owner_user_id || ''),
  }));
}

export async function freeAuthed({ method, pathname, b, st, email, secret, HttpError }) {
  const wrap = (fn) => fn().catch((e) => { throw new HttpError(e.status || 400, e.code || 'bad_channel', redactSecrets(e.message || 'Check that and try again.')); });
  if (pathname === '/api/channels/telegram' && method === 'POST') return wrap(() => saveTelegram(st, email, secret, b));
  if (pathname === '/api/channels/slack' && method === 'POST') return wrap(() => saveSlack(st, email, secret, b));
  if (pathname === '/api/channels/whatsapp-qr' && method === 'GET') {
    const { attachWaqrHint } = await import('./waqr.js');
    const creds = await loadChannelCreds(st, email, secret);
    return { whatsapp_qr: await attachWaqrHint(freeHints(creds).whatsapp_qr, email) };
  }
  if (pathname === '/api/channels/whatsapp-qr/start' && method === 'POST') return wrap(async () => {
    assertWaqrAvailable();
    if (!b || b.ack_ban_risk !== true) bad(400, 'ack_required', 'Tick the box to confirm you understand WhatsApp QR is unofficial and WhatsApp can ban this number.');
    const started = await startWaqr(st, email, secret);
    const { attachWaqrHint } = await import('./waqr.js');
    const creds = await loadChannelCreds(st, email, secret);
    return { whatsapp_qr: { ...await attachWaqrHint(freeHints(creds).whatsapp_qr, email), ...started } };
  });
  if (pathname === '/api/channels/whatsapp-qr/mock' && method === 'POST') return wrap(async () => {
    const { channelsMock } = await import('./channels.js');
    if (!channelsMock()) bad(404, 'not_found', 'Not found.');
    const rt = waqrRuntime();
    if (!rt.enabled) bad(403, 'waqr_off', 'WhatsApp QR is off. Set WHATSAPP_QR=on. ' + WAQR_WARNING);
    const action = String(b.action || '');
    if (action === 'link') {
      const owner = digits(b.owner || '');
      if (owner.length < 8 || owner.length > 15) bad(400, 'bad_channel', 'Give the owner number as digits.');
      await withCreds(st, email, secret, async ({ creds, idx }) => ({
        creds: { ...creds, waqr: { owner_phone: owner, status: 'linked', mock: true } },
        idx: { ...idx, waqr: true },
        public: { linked: true },
      }));
      return { ok: true, linked: true, beta: true, owner_only: true, warning: WAQR_WARNING };
    }
    if (action === 'send') {
      const creds = await loadChannelCreds(st, email, secret);
      const owner = creds && creds.waqr && creds.waqr.owner_phone;
      if (!waqrMaySend(b.to, owner)) bad(400, 'owner_only', 'WhatsApp QR is owner-only. It cannot message customers or send a broadcast.');
      bad(400, 'owner_only', 'WhatsApp QR does not send through this route. The Chief replies only in the linked owner chat.');
    }
    if (action === 'inbound') return routeOwnerWhatsApp(st, email, secret, { from: b.from, text: b.body || b.text || '', id: b.id || '' });
    bad(400, 'bad_channel', 'Use link, inbound, or send.');
  });
  return undefined;
}

export async function bootFreeChannels() {
  setWaqrOwnerHandler((ctx) => routeOwnerWhatsApp(ctx.st, ctx.email, ctx.secret, ctx));
  const rt = waqrRuntime();
  if (!rt.enabled) return { skipped: 'off' };
  if (!rt.persistent) {
    console.log('WhatsApp QR: skipped (serverless). It needs a persistent server.');
    return { skipped: 'serverless' };
  }
  console.log('WhatsApp QR: beta, owner-only');
  const { store, helpers } = await import('./backend.js');
  const st = await store();
  const { resumeLinkedSessions } = await import('./waqr.js');
  return resumeLinkedSessions(st, helpers.secret);
}
