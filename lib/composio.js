// Composio managed sign-in and tool execution (https://composio.dev).
// With COMPOSIO_API_KEY set, connectors whose own OAuth app isn't configured sign in through Composio instead:
// Composio owns the OAuth apps (Google, Slack, GitHub, …), stores the tokens, and runs read-only tools for us.
// Each AIdentify customer maps to one Composio user id derived from their email (never the email itself).
import crypto from 'node:crypto';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
export const composioOn = () => Boolean(env('COMPOSIO_API_KEY'));
const BASE = () => (env('COMPOSIO_BASE_URL') || 'https://backend.composio.dev/api/v3.1').replace(/\/+$/, '');

// AIdentify connector id → Composio toolkit slug
export const TOOLKIT = {
  gmail: 'gmail', gcal: 'googlecalendar', gdrive: 'googledrive', gsheets: 'googlesheets',
  outlook: 'outlook', m365: 'one_drive', teams: 'microsoft_teams', github: 'github', slack: 'slack', notion: 'notion',
  dropbox: 'dropbox', box: 'box', zoom: 'zoom', hubspot: 'hubspot', salesforce: 'salesforce', asana: 'asana',
  jira: 'jira', confluence: 'confluence', linear: 'linear', figma: 'figma', canva: 'canva', calendly: 'calendly',
  airtable: 'airtable', quickbooks: 'quickbooks', mailchimp: 'mailchimp', xero: 'xero', docusign: 'docusign',
  zendesk: 'zendesk', shopify: 'shopify', intercom: 'intercom', trello: 'trello', wix: 'wix', vercel: 'vercel',
};
// read tools tried first for each toolkit (others are discovered from Composio's tool list); override with COMPOSIO_TOOLS_<TOOLKIT>=A,B
const READ_TOOLS = { gmail: ['GMAIL_FETCH_EMAILS'], googlecalendar: ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_EVENT'] };

// the 'agentsphere:' salt is kept so existing Composio connections keep their user id
export const composioUser = (email) => 'as_' + crypto.createHash('sha256').update('agentsphere:' + String(email).toLowerCase()).digest('hex').slice(0, 32);

export class ComposioError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function call(method, path, body, ms = 15000) {
  const r = await fetch(BASE() + path, {
    method, signal: AbortSignal.timeout(ms),
    headers: { 'x-api-key': env('COMPOSIO_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ComposioError(j.error?.message || j.message || 'Composio error ' + r.status, r.status);
  return j;
}

// one Composio-managed auth config per toolkit, created on first use and cached (memory + store)
const acCache = new Map();
async function authConfigFor(slug, st) {
  const fixed = env('COMPOSIO_AUTH_CONFIG_' + slug.toUpperCase());
  if (fixed) return fixed;
  if (acCache.has(slug)) return acCache.get(slug);
  const key = 'as_sys_composio_ac:' + slug, row = await st.get(key);
  if (row && row.v) { acCache.set(slug, row.v); return row.v; }
  const j = await call('POST', '/auth_configs', { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' } });
  const id = j.auth_config?.id || j.id;
  if (!id) throw new ComposioError('Composio did not return an auth config for ' + slug);
  await st.put(key, id, Date.now()); acCache.set(slug, id);
  return id;
}

// start a managed sign-in: returns the Composio-hosted URL to send the customer to
export async function composioLink({ id, email, st, callbackUrl }) {
  const slug = TOOLKIT[id]; if (!slug) throw new ComposioError('No Composio toolkit for ' + id, 400);
  const auth_config_id = await authConfigFor(slug, st);
  const j = await call('POST', '/connected_accounts/link', { auth_config_id, user_id: composioUser(email), callback_url: callbackUrl });
  if (!j.redirect_url) throw new ComposioError('Composio did not return a sign-in link');
  return { url: j.redirect_url, ca: j.connected_account_id };
}

// after the redirect: confirm the account is ACTIVE and belongs to this customer
export async function composioConfirm({ ca, email }) {
  const j = await call('GET', '/connected_accounts/' + encodeURIComponent(ca));
  const status = j.status || j.state?.val?.status;
  if (j.user_id && j.user_id !== composioUser(email)) throw new ComposioError('This connection belongs to someone else.', 403);
  if (status !== 'ACTIVE') throw new ComposioError(status === 'FAILED' ? 'The sign-in failed.' : 'The sign-in has not finished yet.', 409);
  const v = j.state?.val || j.connectionData?.val || {};
  return { acct: v.email || v.account_email || v.user_email || '' };
}

export async function composioDelete(ca) { try { await call('DELETE', '/connected_accounts/' + encodeURIComponent(ca)); } catch { /* already gone */ } }

// read tools for a toolkit: configured list → known defaults → discovered (names that read: FETCH/LIST/SEARCH/GET/FIND)
const toolCache = new Map();
async function readTools(slug) {
  const over = env('COMPOSIO_TOOLS_' + slug.toUpperCase());
  if (over) return over.split(',').map((x) => x.trim()).filter(Boolean);
  if (toolCache.has(slug)) return toolCache.get(slug);
  let list = READ_TOOLS[slug] || [];
  try {
    const j = await call('GET', '/tools?limit=60&toolkit_slug=' + encodeURIComponent(slug), null, 8000);
    const found = (j.items || []).map((t) => t.slug).filter((s) => /_(FETCH|LIST|SEARCH|FIND|GET)_?/.test(s) && !/(DELETE|CREATE|SEND|UPDATE|REMOVE|MOVE|PATCH|ADD|REPLY|ARCHIVE|MODIFY|INSERT)/.test(s));
    found.sort((a, b) => /SEARCH|FETCH|LIST/.test(b) - /SEARCH|FETCH|LIST/.test(a));
    list = [...new Set([...list, ...found])].slice(0, 6);
  } catch { /* fall back to the known defaults */ }
  toolCache.set(slug, list);
  return list;
}

// run one read-only tool with the customer's question as a natural-language request; returns plain text
export async function composioRead({ id, ca, email, q }) {
  const slug = TOOLKIT[id], tools = slug ? await readTools(slug) : [];
  if (!tools.length) throw new ComposioError('No read tool available for ' + id, 404);
  // pick the tool whose name shares the most words with the question
  const qw = String(q).toUpperCase().match(/[A-Z]{3,}/g) || [];
  const tool = tools.map((t) => [t, qw.filter((w) => t.includes(w)).length]).sort((a, b) => b[1] - a[1])[0][0];
  const j = await call('POST', '/tools/execute/' + encodeURIComponent(tool), {
    connected_account_id: ca, user_id: composioUser(email),
    text: `Read-only request. ${q}\n(Return the most relevant recent items, at most 8.)`,
  }, 20000);
  if (j.successful === false) throw new ComposioError(j.error || 'The tool failed.');
  return { tool, data: j.data };
}

// run one approved write action (send email, create event, post message, …) described in plain words
const actCache = new Map();
async function writeTools(slug) {
  const over = env('COMPOSIO_ACTIONS_' + slug.toUpperCase());
  if (over) return over.split(',').map((x) => x.trim()).filter(Boolean);
  if (actCache.has(slug)) return actCache.get(slug);
  let list = [];
  try {
    const j = await call('GET', '/tools?limit=100&toolkit_slug=' + encodeURIComponent(slug), null, 8000);
    list = (j.items || []).map((t) => t.slug).filter((s) => /(SEND|CREATE|ADD|POST|REPLY|DRAFT|INSERT|UPDATE|SCHEDULE|INVITE)/.test(s) && !/(DELETE|REMOVE|TRASH|ARCHIVE)/.test(s));
  } catch { /* none */ }
  actCache.set(slug, list);
  return list;
}
export async function composioAct({ id, ca, email, request }) {
  const slug = TOOLKIT[id], tools = slug ? await writeTools(slug) : [];
  if (!tools.length) throw new ComposioError('No action tool available for ' + id, 404);
  const words = String(request).toUpperCase().match(/[A-Z]{3,}/g) || [];
  const score = (t) => words.filter((w) => t.includes(w)).length + (/DRAFT/.test(t) && /DRAFT/.test(words.join(' ')) ? 2 : 0);
  const tool = tools.map((t) => [t, score(t)]).sort((a, b) => b[1] - a[1])[0][0];
  const j = await call('POST', '/tools/execute/' + encodeURIComponent(tool), { connected_account_id: ca, user_id: composioUser(email), text: String(request) }, 30000);
  if (j.successful === false) throw new ComposioError(j.error || 'The action failed.');
  return { tool, data: j.data };
}
