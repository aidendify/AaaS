// Connectors: real sign-in with each provider's official OAuth page, or an API key for services without OAuth.
// Tokens and keys are encrypted (AES-256-GCM, key derived from SESSION_SECRET) and stored server-side under
// "as_conn:<email>". They are never sent to the browser, not even to admins.
//
// Each provider needs an app registered with that company. Put its credentials in .env:
//   <GROUP>_CLIENT_ID and <GROUP>_CLIENT_SECRET   (e.g. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
// and register this redirect URL in the provider's console:
//   <APP_URL>/api/connectors/callback
import crypto from 'node:crypto';
import { composioOn, TOOLKIT, composioLink, composioConfirm, composioDelete } from './composio.js';

const env = (k) => (process.env[k] ?? '').toString().trim();

// group → OAuth endpoints. {sub} is replaced by the customer's store / subdomain where a service needs one.
const GROUPS = {
  GOOGLE: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }, base: 'openid email' },
  MICROSOFT: { auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', base: 'openid email offline_access User.Read' },
  GITHUB: { auth: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token' },
  SLACK: { auth: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', scopeParam: 'user_scope' },
  NOTION: { auth: 'https://api.notion.com/v1/oauth/authorize', token: 'https://api.notion.com/v1/oauth/token', extra: { owner: 'user' }, basic: true, json: true },
  DROPBOX: { auth: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', extra: { token_access_type: 'offline' } },
  BOX: { auth: 'https://account.box.com/api/oauth2/authorize', token: 'https://api.box.com/oauth2/token' },
  ZOOM: { auth: 'https://zoom.us/oauth/authorize', token: 'https://zoom.us/oauth/token', basic: true },
  HUBSPOT: { auth: 'https://app.hubspot.com/oauth/authorize', token: 'https://api.hubapi.com/oauth/v1/token' },
  SALESFORCE: { auth: 'https://login.salesforce.com/services/oauth2/authorize', token: 'https://login.salesforce.com/services/oauth2/token' },
  ASANA: { auth: 'https://app.asana.com/-/oauth_authorize', token: 'https://app.asana.com/-/oauth_token' },
  ATLASSIAN: { auth: 'https://auth.atlassian.com/authorize', token: 'https://auth.atlassian.com/oauth/token', extra: { audience: 'api.atlassian.com', prompt: 'consent' }, json: true },
  LINEAR: { auth: 'https://linear.app/oauth/authorize', token: 'https://api.linear.app/oauth/token', scopeSep: ',' },
  FIGMA: { auth: 'https://www.figma.com/oauth', token: 'https://api.figma.com/v1/oauth/token', basic: true },
  CANVA: { auth: 'https://www.canva.com/api/oauth/authorize', token: 'https://api.canva.com/rest/v1/oauth/token', basic: true, pkce: true },
  CALENDLY: { auth: 'https://auth.calendly.com/oauth/authorize', token: 'https://auth.calendly.com/oauth/token' },
  AIRTABLE: { auth: 'https://airtable.com/oauth2/v1/authorize', token: 'https://airtable.com/oauth2/v1/token', basic: true, pkce: true },
  INTUIT: { auth: 'https://appcenter.intuit.com/connect/oauth2', token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', basic: true },
  MAILCHIMP: { auth: 'https://login.mailchimp.com/oauth2/authorize', token: 'https://login.mailchimp.com/oauth2/token' },
  XERO: { auth: 'https://login.xero.com/identity/connect/authorize', token: 'https://identity.xero.com/connect/token', basic: true },
  DOCUSIGN: { auth: 'https://account.docusign.com/oauth/auth', token: 'https://account.docusign.com/oauth/token', basic: true },
  ZENDESK: { auth: 'https://{sub}.zendesk.com/oauth/authorizations/new', token: 'https://{sub}.zendesk.com/oauth/tokens', sub: 'Zendesk subdomain', subRe: /^[a-z0-9][a-z0-9-]{0,62}$/ },
  SHOPIFY: { auth: 'https://{sub}.myshopify.com/admin/oauth/authorize', token: 'https://{sub}.myshopify.com/admin/oauth/access_token', sub: 'Store name', subRe: /^[a-z0-9][a-z0-9-]{0,62}$/, scopeSep: ',', noRespType: true },
  INTERCOM: { auth: 'https://app.intercom.com/oauth', token: 'https://api.intercom.io/auth/eagle/token', noScope: true },
  STRIPE: { auth: 'https://connect.stripe.com/oauth/authorize', token: 'https://connect.stripe.com/oauth/token' },
};

// connector id → how it connects
export const CONNECTORS = {
  gmail: { g: 'GOOGLE', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' },
  gcal: { g: 'GOOGLE', scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events' },
  gdrive: { g: 'GOOGLE', scope: 'https://www.googleapis.com/auth/drive.readonly' },
  gsheets: { g: 'GOOGLE', scope: 'https://www.googleapis.com/auth/spreadsheets' },
  m365: { g: 'MICROSOFT', scope: 'Mail.Read Calendars.Read Files.Read.All Sites.Read.All' },
  outlook: { g: 'MICROSOFT', scope: 'Mail.ReadWrite Mail.Send Calendars.ReadWrite' },
  teams: { g: 'MICROSOFT', scope: 'Chat.Read ChannelMessage.Send Team.ReadBasic.All' },
  github: { g: 'GITHUB', scope: 'repo read:user' },
  slack: { g: 'SLACK', scope: 'channels:read channels:history chat:write search:read' },
  notion: { g: 'NOTION', scope: '' },
  dropbox: { g: 'DROPBOX', scope: 'files.metadata.read files.content.read' },
  box: { g: 'BOX', scope: '' },
  zoom: { g: 'ZOOM', scope: '' },
  hubspot: { g: 'HUBSPOT', scope: 'oauth crm.objects.contacts.read crm.objects.deals.read' },
  salesforce: { g: 'SALESFORCE', scope: 'api refresh_token' },
  asana: { g: 'ASANA', scope: 'default' },
  jira: { g: 'ATLASSIAN', scope: 'read:jira-work write:jira-work read:jira-user offline_access' },
  confluence: { g: 'ATLASSIAN', scope: 'read:confluence-content.all search:confluence offline_access' },
  linear: { g: 'LINEAR', scope: 'read' },
  figma: { g: 'FIGMA', scope: 'file_content:read' },
  canva: { g: 'CANVA', scope: 'design:meta:read design:content:read design:content:write asset:read' },
  calendly: { g: 'CALENDLY', scope: '' },
  airtable: { g: 'AIRTABLE', scope: 'data.records:read data.records:write schema.bases:read' },
  quickbooks: { g: 'INTUIT', scope: 'com.intuit.quickbooks.accounting' },
  mailchimp: { g: 'MAILCHIMP', scope: '' },
  xero: { g: 'XERO', scope: 'openid profile email offline_access accounting.transactions.read accounting.contacts.read' },
  docusign: { g: 'DOCUSIGN', scope: 'signature' },
  zendesk: { g: 'ZENDESK', scope: 'read write' },
  shopify: { g: 'SHOPIFY', scope: 'read_orders,read_products,read_customers' },
  intercom: { g: 'INTERCOM', scope: '' },
  // services that use an API key or token instead of a sign-in page
  // Stripe: the customer pastes a restricted (read-only) key from dashboard.stripe.com/apikeys; no app registration needed
  stripe: { key: [['key', 'Restricted or secret key (rk_… / sk_…)']], check: 'stripe' },
  finance: { key: [['client_id', 'Plaid client ID'], ['secret', 'Plaid secret']] },
  vercel: { key: [['token', 'Access token']] },
  wix: { key: [['api_key', 'API key'], ['site_id', 'Site ID']] },
  trello: { key: [['api_key', 'API key'], ['token', 'Token']] },
  twilio: { key: [['sid', 'Account SID'], ['token', 'Auth token']] },
  whatsapp: { key: [['token', 'Access token'], ['phone_id', 'Phone number ID']] },
  postgres: { key: [['url', 'Connection string (postgres://…)']] },
  granola: { key: [['api_key', 'API key']] },
  // Buffer: one API key (publish.buffer.com/settings/api) posts to every social account connected in Buffer
  buffer: { key: [['key', 'Buffer API key']], check: 'buffer' },
};

const ownApp = (id) => { const c = CONNECTORS[id]; return !!c && !c.key && !!(env(c.g + '_CLIENT_ID') && env(c.g + '_CLIENT_SECRET')); };
// a connector without its own OAuth app signs in through Composio when COMPOSIO_API_KEY is set
const viaComposio = (id) => { const c = CONNECTORS[id]; return !!c && !c.key && !ownApp(id) && composioOn() && !!TOOLKIT[id]; };
const configured = (id) => { const c = CONNECTORS[id]; return !!c && (c.key ? true : ownApp(id) || viaComposio(id)); };

// Gmail without a Google OAuth app: Gmail address + app password (sending via SMTP)
const GMAIL_KEY = [['user', 'Gmail address'], ['pass', 'App password (16 letters, from myaccount.google.com/apppasswords)']];
const keyOf = (id) => CONNECTORS[id] && (CONNECTORS[id].key || (id === 'gmail' && !configured('gmail') ? GMAIL_KEY : null));
/* ----- encryption ----- */
async function encKey(secret) { return crypto.createHash('sha256').update(String(await secret()) + ':connectors').digest(); }
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

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const appUrl = (headers) => {
  const u = env('APP_URL'); if (u) return u.replace(/\/+$/, '');
  const host = headers['x-forwarded-host'] || headers.host || 'localhost:3000';
  const proto = (headers['x-forwarded-proto'] || '').split(',')[0] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return proto + '://' + host;
};
const sub = (u, s) => u.replace('{sub}', s || '');

async function loadConns(st, email, secret) { const row = await st.get('as_conn:' + email); return parse(row?.v, {}) || {}; }
async function saveConns(st, email, all) { await st.put('as_conn:' + email, Object.keys(all).length ? JSON.stringify(all) : null, Date.now()); }

const page = (origin, msg) => `<!doctype html><meta charset="utf-8"><title>AIdentify</title>
<body style="font:15px system-ui;padding:32px;color:#333">${msg.ok ? 'Connected. You can close this window.' : 'Couldn’t connect: ' + String(msg.error || 'unknown error').replace(/[<>&]/g, '')}
<script>const m=${JSON.stringify({ type: 'as-conn', ...msg })};
// sign-in pages often cut the link to the opener (COOP), so also tell the app over a same-origin channel
try{new BroadcastChannel('as-conn').postMessage(m)}catch(e){}try{opener&&opener.postMessage(m,${JSON.stringify(origin)})}catch(e){}setTimeout(()=>window.close(),${msg.ok ? 600 : 4000})</script>`;

// Routes. Returns undefined when the path isn't a connectors route.
export async function connectorRoutes({ method, pathname, query, headers, st, secret, who, HttpError, json }) {
  if (!pathname.startsWith('/api/connectors')) return undefined;
  const origin = appUrl(headers), redirect = origin + '/api/connectors/callback';

  // the provider sends the browser back here (no session header: the encrypted state identifies the user)
  if (pathname === '/api/connectors/callback' && method === 'GET') {
    let s;
    try { s = await open(query.get('state'), secret); } catch { return { __html: page(origin, { ok: false, error: 'This sign-in link is invalid. Start again from AIdentify.' }) }; }
    if (!s.x || s.x < Date.now()) return { __html: page(origin, { ok: false, c: s.c, error: 'The sign-in took too long. Try again.' }) };
    if (query.get('error')) return { __html: page(origin, { ok: false, c: s.c, error: query.get('error') === 'access_denied' ? 'You cancelled the sign-in.' : (query.get('error_description') || query.get('error')) }) };
    const code = query.get('code'); if (!code) return { __html: page(origin, { ok: false, c: s.c, error: 'No authorization code was returned.' }) };
    const c = CONNECTORS[s.c], G = GROUPS[c.g], id = env(c.g + '_CLIENT_ID'), sec = env(c.g + '_CLIENT_SECRET');
    const p = { grant_type: 'authorization_code', code, redirect_uri: redirect };
    if (!G.basic) { p.client_id = id; p.client_secret = sec; }
    if (G.pkce) p.code_verifier = s.v;
    const h = { Accept: 'application/json', 'Content-Type': G.json ? 'application/json' : 'application/x-www-form-urlencoded' };
    if (G.basic) h.Authorization = 'Basic ' + Buffer.from(id + ':' + sec).toString('base64');
    let tok;
    try {
      const r = await fetch(sub(G.token, s.sub), { method: 'POST', headers: h, body: G.json ? JSON.stringify(p) : new URLSearchParams(p) });
      tok = await r.json().catch(() => ({}));
      if (!r.ok || tok.ok === false || tok.error || !(tok.access_token || tok.authed_user?.access_token)) throw new Error(tok.error_description || tok.error || 'token exchange failed (' + r.status + ')');
    } catch (e) { return { __html: page(origin, { ok: false, c: s.c, error: e.message === 'fetch failed' ? 'Couldn’t reach the provider to finish signing in. Try again.' : e.message }) }; }
    let acct = '';
    if (tok.id_token) { try { acct = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email || ''; } catch {} }
    if (!acct && tok.workspace_name) acct = tok.workspace_name; // Notion
    if (!acct && tok.team?.name) acct = tok.team.name;          // Slack
    if (!acct && s.sub) acct = s.sub;
    const all = await loadConns(st, s.e);
    all[s.c] = { at: Date.now(), acct, sub: s.sub || '', t: await seal({ ...tok, got: Date.now() }, secret) };
    await saveConns(st, s.e, all);
    return { __html: page(origin, { ok: true, c: s.c, acct }) };
  }

  // Composio sends the browser back here after its hosted sign-in
  if (pathname === '/api/connectors/composio' && method === 'GET') {
    let s;
    try { s = await open(query.get('state'), secret); } catch { return { __html: page(origin, { ok: false, error: 'This sign-in link is invalid. Start again from AIdentify.' }) }; }
      if (s.x < Date.now()) return { __html: page(origin, { ok: false, c: s.c, error: 'The sign-in took too long. Try again.' }) };
    const pend = parse((await st.get('as_connp:' + s.e))?.v, {}) || {};
    const ca = pend[s.c];
    if (!ca) return { __html: page(origin, { ok: false, c: s.c, error: 'This sign-in was already used. Start again from AIdentify.' }) };
    if (/fail|error|cancel/i.test(query.get('status') || '')) return { __html: page(origin, { ok: false, c: s.c, error: 'You cancelled the sign-in.' }) };
    let acct = '';
    try { acct = (await composioConfirm({ ca, email: s.e })).acct; }
    catch (e) { return { __html: page(origin, { ok: false, c: s.c, error: e.message }) }; }
    delete pend[s.c]; await st.put('as_connp:' + s.e, Object.keys(pend).length ? JSON.stringify(pend) : null, Date.now());
    const all = await loadConns(st, s.e);
    all[s.c] = { at: Date.now(), acct, via: 'composio', t: await seal({ via: 'composio', ca }, secret) };
    await saveConns(st, s.e, all);
    return { __html: page(origin, { ok: true, c: s.c, acct }) };
  }

  if (!who) throw new HttpError(401, 'signed_out');
  if (who.role === 'admin' || who.role === 'pricing') throw new HttpError(403, 'customers_only', 'Connectors are for customer accounts.');

  if (pathname === '/api/connectors' && method === 'GET') {
    const all = await loadConns(st, who.email);
    return { items: Object.entries(all).map(([id, x]) => ({ id, at: x.at, acct: x.acct || '' })),
      setup: Object.fromEntries(Object.keys(CONNECTORS).map((id) => [id, keyOf(id) ? { key: keyOf(id).map(([n, l]) => ({ n, l })), ...(id === 'gmail' && !CONNECTORS[id].key ? { help: 'Google Account → Security → 2-Step Verification on → App passwords → create one for “AIdentify”. Your agents send follow-ups from this Gmail after you approve each one.' } : {}) } : { ready: configured(id), sub: viaComposio(id) ? '' : GROUPS[CONNECTORS[id].g].sub || '', via: viaComposio(id) ? 'composio' : '' }])) };
  }
  if (pathname === '/api/connectors/start' && method === 'POST') {
    const b = json(), c = CONNECTORS[b.c];
    if (!c || c.key) throw new HttpError(400, 'bad_connector');
    const G = GROUPS[c.g];
    if (!configured(b.c)) throw new HttpError(409, 'not_configured', `This connector isn’t set up on the server yet. Add COMPOSIO_API_KEY (managed sign-in for every app), or ${c.g}_CLIENT_ID and ${c.g}_CLIENT_SECRET and register ${redirect} with the provider.`);
    if (viaComposio(b.c)) {
      const state = await seal({ e: who.email, c: b.c, x: Date.now() + 15 * 60e3, n: crypto.randomBytes(6).toString('hex') }, secret);
      let r;
      try { r = await composioLink({ id: b.c, email: who.email, st, callbackUrl: origin + '/api/connectors/composio?state=' + encodeURIComponent(state) }); }
      catch (e) { throw new HttpError(502, 'composio', 'Couldn’t start the sign-in: ' + e.message); }
      const pend = parse((await st.get('as_connp:' + who.email))?.v, {}) || {};
      pend[b.c] = r.ca; await st.put('as_connp:' + who.email, JSON.stringify(pend), Date.now());
      return { url: r.url };
    }
    const subv = G.sub ? String(b.sub || '').trim().toLowerCase().replace(/\.(myshopify|zendesk)\.com.*$/, '').replace(/^https?:\/\//, '') : '';
    if (G.sub && !G.subRe.test(subv)) throw new HttpError(400, 'bad_sub', `Enter your ${G.sub.toLowerCase()}.`);
    const v = G.pkce ? crypto.randomBytes(48).toString('base64url') : '';
    const state = await seal({ e: who.email, c: b.c, x: Date.now() + 10 * 60e3, v, sub: subv, n: crypto.randomBytes(6).toString('hex') }, secret);
    const scope = [G.base, c.scope].filter(Boolean).join(' ').split(' ').filter(Boolean).join(G.scopeSep || ' ');
    const q = new URLSearchParams({ client_id: env(c.g + '_CLIENT_ID'), redirect_uri: redirect, state, ...(G.noRespType ? {} : { response_type: 'code' }), ...(G.extra || {}) });
    if (scope && !G.noScope) q.set(G.scopeParam || 'scope', scope);
    if (G.pkce) { q.set('code_challenge', crypto.createHash('sha256').update(v).digest('base64url')); q.set('code_challenge_method', 'S256'); }
    return { url: sub(G.auth, subv) + '?' + q.toString() };
  }
  if (pathname === '/api/connectors/key' && method === 'POST') {
    const b = json(), c = CONNECTORS[b.c], KEY = keyOf(b.c);
    if (!c || !KEY) throw new HttpError(400, 'bad_connector');
    const f = {};
    for (const [n, l] of KEY) { const v = String((b.fields || {})[n] || '').trim(); if (!v || v.length > 2000) throw new HttpError(400, 'missing', `Enter the ${l}.`); f[n] = v; }
    let acct = '';
    if (c.check === 'stripe') { // prove the key works before saving it
      if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(f.key)) throw new HttpError(400, 'bad_key', 'That doesn’t look like a Stripe key. It starts with rk_ or sk_.');
      let r;
      try { r = await fetch('https://api.stripe.com/v1/account', { headers: { Authorization: 'Bearer ' + f.key } }); }
      catch { throw new HttpError(502, 'unreachable', 'Couldn’t reach Stripe. Try again.'); }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw new HttpError(400, 'bad_key', 'Stripe rejected that key. Copy it again from dashboard.stripe.com/apikeys.');
      if (r.ok) acct = (j.settings?.dashboard?.display_name || j.business_profile?.name || j.email || j.id || '') + (f.key.includes('_test_') ? ' (test mode)' : '');
      else acct = f.key.includes('_test_') ? 'Stripe test mode' : 'Stripe'; // restricted keys may not read the account; the key is still valid
    }
    if (c.check === 'buffer') { // prove the key works and list the social accounts it reaches
      try { const { bufferChannels } = await import('./buffer.js'); const ch = await bufferChannels(f.key); acct = ch.length ? ch.length + ' social account' + (ch.length === 1 ? '' : 's') + ': ' + ch.map((x) => x.service + (x.name ? ' (' + x.name + ')' : '')).join(', ').slice(0, 160) : 'Buffer (no social accounts connected yet)'; }
      catch (e) { throw new HttpError(400, 'bad_key', e.message); }
    }
    let via = '';
    if (b.c === 'gmail' && !c.key) { // prove the app password works before saving it
      f.user = f.user.toLowerCase(); f.pass = f.pass.replace(/\s+/g, '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.user)) throw new HttpError(400, 'bad_email', 'Enter your full Gmail address.');
      try { const { smtpVerify } = await import('./mailer.js'); await smtpVerify(f.user, f.pass); }
      catch (e) { throw new HttpError(400, 'bad_login', /auth|535|534|Username|credentials/i.test(e.message) ? 'Gmail rejected that app password. Create a new one at myaccount.google.com/apppasswords (2-Step Verification must be on) and paste it without spaces.' : 'Couldn’t reach Gmail: ' + e.message); }
      acct = f.user; via = 'smtp';
    }
    const all = await loadConns(st, who.email);
    all[b.c] = { at: Date.now(), acct, ...(via ? { via } : {}), t: await seal(f, secret) };
    await saveConns(st, who.email, all);
    return { ok: true };
  }
  if (pathname === '/api/connectors/disconnect' && method === 'POST') {
    const b = json(), all = await loadConns(st, who.email);
    const x = all[String(b.c || '')];
    if (x && x.via === 'composio') { try { const cr = await open(x.t, secret); if (cr.ca) await composioDelete(cr.ca); } catch {} }
    delete all[String(b.c || '')]; await saveConns(st, who.email, all);
    return { ok: true };
  }
  throw new HttpError(404, 'not_found');
}

// For agents/tools on the server: the decrypted credentials of one of a user's connectors (or null).
// OAuth access tokens are refreshed automatically when they are about to expire.
export async function connectorCredentials(st, email, id, secret) {
  const all = await loadConns(st, email), x = all[id];
  if (!x) return null;
  let cr = await open(x.t, secret);
  const c = CONNECTORS[id];
  if (c && !c.key && cr.refresh_token && cr.expires_in && cr.got + (Number(cr.expires_in) - 60) * 1000 < Date.now()) {
    const G = GROUPS[c.g], cid = env(c.g + '_CLIENT_ID'), sec = env(c.g + '_CLIENT_SECRET');
    const p = { grant_type: 'refresh_token', refresh_token: cr.refresh_token };
    if (!G.basic) { p.client_id = cid; p.client_secret = sec; }
    const h = { Accept: 'application/json', 'Content-Type': G.json ? 'application/json' : 'application/x-www-form-urlencoded' };
    if (G.basic) h.Authorization = 'Basic ' + Buffer.from(cid + ':' + sec).toString('base64');
    try {
      const r = await fetch(sub(G.token, x.sub), { method: 'POST', headers: h, body: G.json ? JSON.stringify(p) : new URLSearchParams(p) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) {
        cr = { ...cr, ...j, refresh_token: j.refresh_token || cr.refresh_token, got: Date.now() };
        all[id] = { ...x, t: await seal(cr, secret) }; await saveConns(st, email, all);
      }
    } catch { /* keep the old token; the call will report the error */ }
  }
  return { ...cr, acct: x.acct, sub: x.sub, ...(x.via ? { via: x.via } : {}) };
}
export async function connectedIds(st, email) { return Object.keys(await loadConns(st, email)); }
export async function connectedList(st, email) { return Object.entries(await loadConns(st, email)).map(([id, x]) => ({ id, via: x.via || '' })); }
