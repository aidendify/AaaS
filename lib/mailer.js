// Sends email from the user's connected Gmail. Three ways, whichever the user connected:
//   1. Gmail app password (Plugins → Gmail → Gmail address + app password): SMTP smtp.gmail.com:465
//   2. Google sign-in (GOOGLE_CLIENT_ID/SECRET, scope gmail.compose): Gmail API users.messages.send
//   3. Composio managed sign-in: the GMAIL_SEND_EMAIL tool
// Fallback for a whole server: GMAIL_USER + GMAIL_APP_PASSWORD in .env. SMTP_HOST/SMTP_PORT/SMTP_SECURE override the host (tests, other providers).
import { connectorCredentials } from './connectors.js';
import { composioAct } from './composio.js';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
export const emailReadyEnv = () => Boolean(env('GMAIL_USER') && env('GMAIL_APP_PASSWORD'));

async function smtpSend(user, pass, { to, subject, body, from }) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch { throw new Error('Email sending needs the nodemailer package: run npm install.'); }
  const port = Number(env('SMTP_PORT', '465')), secure = env('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true';
  const t = nodemailer.createTransport({ host: env('SMTP_HOST', 'smtp.gmail.com'), port, secure, auth: { user, pass }, ignoreTLS: env('SMTP_IGNORE_TLS') === 'true', connectionTimeout: 15000 });
  const info = await t.sendMail({ from: from || user, to, subject, text: body });
  return info.messageId || 'sent';
}
export async function smtpVerify(user, pass) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch { throw new Error('Email sending needs the nodemailer package: run npm install.'); }
  const port = Number(env('SMTP_PORT', '465')), secure = env('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true';
  const t = nodemailer.createTransport({ host: env('SMTP_HOST', 'smtp.gmail.com'), port, secure, auth: { user, pass }, ignoreTLS: env('SMTP_IGNORE_TLS') === 'true', connectionTimeout: 15000 });
  await t.verify();
}
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hdr = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=';

// → { id, via } or throws with a message fit for the user
export async function sendEmail({ st, email, secret, to, subject, body }) {
  to = String(to || '').trim(); subject = String(subject || '').trim().slice(0, 300); body = String(body || '').trim().slice(0, 20000);
  if (!okEmail(to)) throw new Error('“' + to + '” isn’t a valid email address.');
  if (!subject || !body) throw new Error('An email needs a subject and a body.');
  const cr = await connectorCredentials(st, email, 'gmail', secret).catch(() => null);
  if (cr && cr.via === 'smtp') return { id: await smtpSend(cr.user, cr.pass, { to, subject, body }), via: 'Gmail (' + cr.user + ')' };
  if (cr && cr.via === 'composio') {
    const r = await composioAct({ id: 'gmail', ca: cr.ca, email, request: `Send an email to ${to} with subject "${subject}" and this exact body:\n\n${body}` });
    return { id: (r.data && (r.data.id || r.data.messageId)) || 'sent', via: 'Gmail (Composio)' };
  }
  if (cr && cr.access_token) {
    const raw = [`To: ${to}`, `Subject: ${hdr(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + cr.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ raw: b64url(raw) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Gmail refused: ' + ((j.error && j.error.message) || r.status) + (r.status === 403 ? ' (reconnect Gmail and allow sending)' : ''));
    return { id: j.id, via: 'Gmail' + (cr.acct ? ' (' + cr.acct + ')' : '') };
  }
  if (emailReadyEnv()) return { id: await smtpSend(env('GMAIL_USER'), env('GMAIL_APP_PASSWORD'), { to, subject, body }), via: 'Gmail (' + env('GMAIL_USER') + ')' };
  throw new Error('Gmail isn’t connected. Open Plugins → Connectors → Gmail and connect it (Gmail address + app password).');
}

// system mail (sign-in codes): the server's own Gmail from .env
export async function sendSystemEmail({ to, subject, body }) {
  if (!emailReadyEnv()) throw new Error('no_system_mail');
  return smtpSend(env('GMAIL_USER'), env('GMAIL_APP_PASSWORD'), { to, subject, body });
}

// ---------- reading Gmail with the same app password (IMAP, imap.gmail.com:993) ----------
// IMAP_HOST / IMAP_PORT / IMAP_SECURE override the server (tests, other providers).
const decodeQP = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
function snippetOf(src) {
  let s = String(src || ''); const i = s.search(/\r?\n\r?\n/); if (i > 0) s = s.slice(i);
  const b64 = /content-transfer-encoding:\s*base64/i.test(String(src).slice(0, i > 0 ? i : 2000));
  if (b64) { try { s = Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'); } catch {} } else s = decodeQP(s);
  return s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/^--.*$/gm, ' ').replace(/^[A-Za-z-]+:.*$/gm, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}
export async function imapRecent(cr, q = '', { limit = 8 } = {}) {
  let ImapFlow;
  try { ({ ImapFlow } = await import('imapflow')); } catch { throw new Error('Reading Gmail needs the imapflow package: run npm install.'); }
  const host = env('IMAP_HOST', 'imap.gmail.com'), gmail = /gmail\.com$/i.test(host);
  const c = new ImapFlow({ host, port: Number(env('IMAP_PORT', '993')), secure: env('IMAP_SECURE', 'true') !== 'false', auth: { user: cr.user, pass: cr.pass }, logger: false, socketTimeout: 20000, greetingTimeout: 15000 });
  c.on('error', () => {});
  try { await c.connect(); } catch (e) { throw new Error(/auth|credentials|invalid/i.test(e.message + (e.responseText || '')) ? 'Gmail rejected the app password — reconnect Gmail in Plugins.' : 'Couldn’t reach Gmail: ' + e.message); }
  const out = [];
  try {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const unread = /\bunread\b/i.test(q), from = (String(q).match(/\bfrom\s+([\w.@+-]+)/i) || [])[1];
      const kw = (String(q).toLowerCase().match(/[a-z0-9@.]{4,}/g) || []).filter((w) => !/^(email|emails|mail|mails|gmail|inbox|recent|latest|unread|show|give|what|which|from|about|last|today|this|that|have|with|there|please|check|read|tell|messages?)$/.test(w));
      let uids = [];
      if (gmail) { // Gmail understands its own search syntax over IMAP
        const raw = [unread ? 'is:unread' : '', from ? 'from:' + from : '', kw.length && !unread && !from ? kw.slice(0, 4).join(' ') : '', 'newer_than:30d'].filter(Boolean).join(' ');
        uids = (await c.search({ gmraw: raw }, { uid: true })) || [];
        if (!uids.length && kw.length) uids = (await c.search({ gmraw: 'newer_than:14d' }, { uid: true })) || [];
      } else {
        const crit = { since: new Date(Date.now() - 30 * 864e5) }; if (unread) crit.seen = false; if (from) crit.from = from;
        uids = (await c.search(crit, { uid: true })) || [];
      }
      uids = uids.slice(-limit).reverse();
      if (uids.length) for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, source: { maxLength: 6000 } }, { uid: true })) {
        const e = m.envelope || {}, f = (e.from || [])[0] || {}, who = f.name ? `${f.name} <${f.address}>` : f.address || 'unknown';
        const at = (m.internalDate && new Date(m.internalDate).getTime()) || (e.date && new Date(e.date).getTime()) || null;
        const unseen = !(m.flags && (m.flags.has ? m.flags.has('\\Seen') : [...m.flags].includes('\\Seen')));
        out.push({ title: e.subject || '(no subject)', at, url: 'https://mail.google.com/mail/u/0/#inbox', text: `Email from ${who} on ${e.date ? new Date(e.date).toUTCString() : ''}${unseen ? ' (unread)' : ''}. Subject: ${e.subject || ''}. Preview: ${snippetOf(m.source)}` });
      }
    } finally { lock.release(); }
  } finally { try { await c.logout(); } catch {} }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
