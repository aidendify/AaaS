// Password reset: "Forgot password?" → emailed link with a single-use token (30 min, only its SHA-256 hash is stored) → new password.
// Never says whether an email has an account. Without a mail sender the server logs the event (and, off Vercel, the link,
// like the sign-in code). Test hook: on a mock-AI server (AI_PROVIDER=mock + AI_MOCK=on, never prod) the reply carries the
// token for e2e-*@example.com throwaway accounts only, so the e2e suite can finish the flow.
import crypto from 'node:crypto';
import { sendSystemEmail, emailReadyEnv } from './mailer.js';
import { mockOn } from './llm.js';

export const RESET_TTL_MS = 30 * 60e3;
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const ON_VERCEL = !!process.env.VERCEL;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tokKey = (h) => 'as_pwreset:' + h, byKey = (e) => 'as_pwreset:by:' + e;
const isTestEmail = (e) => /^e2e-[a-z0-9-]+@example\.com$/.test(e);
function appUrl(headers) {
  const set = env('APP_URL'); if (set) return set.replace(/\/+$/, '');
  const host = headers.host || 'localhost:3000', proto = (headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https')).split(',')[0];
  return proto + '://' + host;
}
export const mailMode = () => (emailReadyEnv() ? 'mail' : ON_VERCEL ? 'off' : 'console');

// → the raw token (only ever emailed); stores just its hash and makes any earlier link for this email stop working
export async function issueResetToken(st, email, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url'), h = sha(token);
  const prev = JSON.parse((await st.get(byKey(email)))?.v || 'null');
  if (prev && prev.h) await st.put(tokKey(prev.h), null, now);
  await st.put(tokKey(h), JSON.stringify({ e: email, exp: now + RESET_TTL_MS }), now);
  await st.put(byKey(email), JSON.stringify({ h }), now);
  return token;
}
// → email if the token is valid (and consumes it), else '' ; consume=false only checks
export async function useResetToken(st, token, { consume = true, now = Date.now() } = {}) {
  token = String(token || ''); if (token.length < 20 || token.length > 100) return '';
  const h = sha(token), rec = JSON.parse((await st.get(tokKey(h)))?.v || 'null');
  if (!rec || !rec.e) return '';
  const cur = JSON.parse((await st.get(byKey(rec.e)))?.v || 'null');
  if (rec.exp < now || !cur || cur.h !== h) { await st.put(tokKey(h), null, now); return ''; }
  if (consume) { await st.put(tokKey(h), null, now); await st.put(byKey(rec.e), null, now); }
  return rec.e;
}

export async function resetRoutes({ method, pathname, headers, ip, st, json, getUsers, saveUsers, HttpError, throttle, noteAttempt, okEmail, weakPassword, hashPassword }) {
  if (pathname === '/api/auth/forgot' && method === 'POST') {
    const email = String(json().email || '').trim().toLowerCase();
    if (!okEmail(email)) throw new HttpError(400, 'bad_email', 'Enter a valid email address.');
    throttle('forgot:' + ip, 20); throttle('forgot:' + email, 3); noteAttempt('forgot:' + ip); noteAttempt('forgot:' + email);
    const mode = mailMode(), out = { ok: true, mail: mode,
      message: mode === 'off' ? 'Password reset emails aren’t switched on for this server yet, so no email was sent. Please contact support to reset your password.'
        : 'If an account uses ' + email + ', we’ve sent it a reset link. It works once and expires in 30 minutes.' };
    const u = (await getUsers(st))[email];
    if (!u || u.suspended) { console.log(`[auth] password reset requested for an unknown or suspended email (${mode})`); return out; }
    const token = await issueResetToken(st, email), link = appUrl(headers) + '/#as_reset=' + token;
    if (mode === 'mail') {
      try {
        const { emailCopy } = await import('./agency.js');
        const copy = await emailCopy(st, email, 'reset', { link });
        await sendSystemEmail({ to: email, subject: copy.subject, body: copy.body, fromName: copy.fromName });
      }
      catch (e) { console.error('[auth] reset email failed:', e.message); }
    } else if (mode === 'console') console.log(`\n*** Password reset link for ${email}: ${link}   (set GMAIL_USER + GMAIL_APP_PASSWORD to email it instead)\n`);
    else console.log(`[auth] password reset requested for ${email.replace(/^(.).*@/, '$1***@')}; no mail sender configured, nothing sent`);
    if (mockOn() && isTestEmail(email)) out.testToken = token; // staging/mock only, throwaway e2e accounts only
    return out;
  }
  if (pathname === '/api/auth/reset-password' && method === 'POST') {
    const b = json(), pw = String(b.password || '');
    throttle('resetpw:' + ip, 30); noteAttempt('resetpw:' + ip);
    const users = await getUsers(st), peek = await useResetToken(st, b.token, { consume: false });
    const bad = () => new HttpError(400, 'reset_invalid', 'This reset link has expired or was already used. Ask for a new one.');
    if (!peek || !users[peek]) throw bad();
    const staff = (users[peek].role || 'customer') !== 'customer';
    { const weak = weakPassword(pw, staff ? 12 : 8); if (weak) throw new HttpError(400, 'weak_password', weak); }
    const email = await useResetToken(st, b.token); if (!email) throw bad();
    const u = users[email]; u.hash = hashPassword(pw); u.sv = (u.sv || 1) + 1; u.pwAt = Date.now();
    await saveUsers(st, users);
    console.log(`[auth] password reset completed for ${email.replace(/^(.).*@/, '$1***@')}`);
    return { ok: true, message: 'Your password was changed. Sign in with the new one.' };
  }
  return undefined;
}
