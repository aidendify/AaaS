// Extra sign-in methods for customers: "Continue with Google" (OAuth / OpenID Connect) and "Email me a code".
// Both end in the same session token as the password sign-in. Staff accounts keep password sign-in only.
import crypto from 'node:crypto';
import { sendSystemEmail, emailReadyEnv } from './mailer.js';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const ON_VERCEL = !!process.env.VERCEL;
const googleReady = () => Boolean(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
const b64u = (s) => Buffer.from(s).toString('base64url');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
function safeEq(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
function appUrl(headers) {
  const set = env('APP_URL'); if (set) return set.replace(/\/+$/, '');
  const host = headers.host || 'localhost:3000', proto = (headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https')).split(',')[0];
  return proto + '://' + host;
}
const nameFromEmail = (e) => e.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60) || 'New user';

export async function authxRoutes({ method, pathname, query, headers, ip, st, json, secret, getUsers, saveUsers, signToken, publicUser, HttpError, throttle, noteAttempt, okEmail }) {
  if (!pathname.startsWith('/api/auth/')) return undefined;

  if (pathname === '/api/auth/providers' && method === 'GET')
    return { google: googleReady(), email: emailReadyEnv() || !ON_VERCEL, emailVia: emailReadyEnv() ? 'mail' : (ON_VERCEL ? 'off' : 'console') };

  // a customer account for this email, created on first use; staff accounts must use their password
  async function signInAs(email, name, extra = {}) {
    const users = await getUsers(st); let u = users[email];
    if (u && (u.role || 'customer') !== 'customer') throw new HttpError(403, 'staff', 'Staff accounts sign in with email and password.');
    if (u && u.suspended) throw new HttpError(403, 'suspended', 'This account is suspended. Please contact support.');
    if (!u) u = users[email] = { name: String(name || nameFromEmail(email)).slice(0, 120), role: 'customer', hash: '', joined: Date.now() };
    Object.assign(u, extra); u.last = Date.now(); await saveUsers(st, users);
    const { brandForAccount } = await import('./agency.js');
    const brand = await brandForAccount(st, email);
    const user = { email, ...publicUser(u) };
    if (brand) user.brand = brand;
    return { token: await signToken(email, 'customer', u.sv || 1), user, created: !u.hash && u.joined > Date.now() - 5000 };
  }

  /* ----- Continue with Google ----- */
  if (pathname === '/api/auth/google/start' && method === 'GET') {
    if (!googleReady()) return { __redirect: '/#as_autherr=' + encodeURIComponent('Google sign-in isn’t set up on this server yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).') };
    const next = query.get('next') === 'clinic' ? 'clinic' : '';
    const key = await secret(), payload = b64u(JSON.stringify({ n: crypto.randomBytes(8).toString('hex'), t: Date.now(), r: query.get('rem') === '0' ? 0 : 1, next }));
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: appUrl(headers) + '/api/auth/google/callback', response_type: 'code', scope: 'openid email profile', prompt: 'select_account', state: payload + '.' + hmac(key, payload) }).toString();
    return { __redirect: u.toString() };
  }
  if (pathname === '/api/auth/google/callback' && method === 'GET') {
    const fail = (m) => ({ __redirect: '/#as_autherr=' + encodeURIComponent(m) });
    try {
      if (query.get('error')) return fail('Google sign-in was cancelled.');
      const [payload, sig] = String(query.get('state') || '').split('.'), key = await secret();
      if (!payload || !sig || !safeEq(hmac(key, payload), sig)) return fail('Sign-in link expired. Try again.');
      const st8 = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (Date.now() - st8.t > 10 * 60000) return fail('Sign-in took too long. Try again.');
      const tr = await fetch(env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: String(query.get('code') || ''), client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: appUrl(headers) + '/api/auth/google/callback', grant_type: 'authorization_code' }) });
      const tj = await tr.json().catch(() => ({})); if (!tr.ok || !tj.access_token) return fail('Google didn’t accept the sign-in (' + (tj.error_description || tj.error || tr.status) + ').');
      const ur = await fetch(env('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'), { signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + tj.access_token } });
      const g = await ur.json().catch(() => ({})); const email = String(g.email || '').toLowerCase();
      if (!email || g.email_verified === false) return fail('Your Google account has no verified email.');
      const r = await signInAs(email, g.name, { google: String(g.sub || '') });
      const home = st8.next === 'clinic' ? '/clinic' : '/';
      return { __redirect: home + '#as_auth=' + encodeURIComponent(r.token) + '&em=' + encodeURIComponent(email) + '&rem=' + (st8.r ? 1 : 0) };
    } catch (e) { return fail(e instanceof HttpError ? e.message : 'Google sign-in failed: ' + e.message); }
  }

  /* ----- Email me a code ----- */
  const otpKey = (e) => 'as_otp:' + e, codeHash = async (c) => hmac(await secret(), 'otp:' + c);
  if (pathname === '/api/auth/email/start' && method === 'POST') {
    const email = String(json().email || '').trim().toLowerCase();
    if (!okEmail(email)) throw new HttpError(400, 'bad_email', 'Enter a valid email address.');
    throttle('otp:' + ip, 30); throttle('otp:' + email, 5); noteAttempt('otp:' + ip); noteAttempt('otp:' + email);
    const users = await getUsers(st), u = users[email];
    if (u && (u.role || 'customer') !== 'customer') throw new HttpError(403, 'staff', 'Staff accounts sign in with email and password.');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await st.put(otpKey(email), JSON.stringify({ h: await codeHash(code), exp: Date.now() + 10 * 60000, tries: 0 }), Date.now());
    const { emailCopy } = await import('./agency.js');
    const copy = await emailCopy(st, email, 'code', { code });
    if (emailReadyEnv()) {
      try { await sendSystemEmail({ to: email, subject: copy.subject, body: copy.body, fromName: copy.fromName }); return { sent: true, via: 'mail', isNew: !u }; }
      catch (e) { if (ON_VERCEL) throw new HttpError(502, 'mail_failed', 'Couldn’t send the code: ' + e.message); console.error('Sign-in code email failed:', e.message); }
    }
    if (ON_VERCEL) throw new HttpError(503, 'no_mail', 'Email codes need GMAIL_USER and GMAIL_APP_PASSWORD set on the server.');
    console.log(`\n*** Sign-in code for ${email}: ${code}   (set GMAIL_USER + GMAIL_APP_PASSWORD in .env to email it instead)\n`);
    return { sent: true, via: 'console', isNew: !u };
  }
  if (pathname === '/api/auth/email/verify' && method === 'POST') {
    const b = json(), email = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').replace(/\D/g, '');
    const rec = JSON.parse((await st.get(otpKey(email)))?.v || 'null');
    if (!rec || rec.exp < Date.now()) throw new HttpError(400, 'code_expired', 'That code has expired. Send a new one.');
    if (rec.tries >= 5) throw new HttpError(429, 'too_many', 'Too many wrong codes. Send a new one.');
    if (code.length !== 6 || !safeEq(await codeHash(code), rec.h)) { rec.tries++; await st.put(otpKey(email), JSON.stringify(rec), Date.now()); throw new HttpError(401, 'bad_code', 'That code isn’t right. Check the email and try again.'); }
    await st.put(otpKey(email), null, Date.now());
    return signInAs(email, String(b.name || '').trim());
  }
  return undefined;
}
