// Server-wide settings edited in Settings (settings.html), stored in the KV store under "as_settings".
// Precedence: a value saved in Settings > the value from .env > the code default.
// Settings are applied by writing them into process.env, so every module that reads process.env at call time
// picks them up live (no restart). Clearing a value restores what .env had. Secrets are AES-256-GCM encrypted at rest
// and the API only ever returns { set, last4, source }.
import crypto from 'node:crypto';

const ENV0 = { ...process.env }; // .env + real environment, as loaded before any setting was applied
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

// ---------- schema ----------
// k = environment variable name (also the storage key). s = section id. g = card (group) inside the section.
// t: text | secret | number | bool | select | textarea. live: false = needs a server restart; 'slack' = reconnects Slack.
const F = (s, g, k, label, t = 'text', o = {}) => ({ s, g, k, label, t, ...o });
const P = (id, name, keyVar, baseVar, modelVar, baseDef, modelDef, url) => [
  F('models', name, keyVar, name + ' API key', 'secret', { help: 'Get a key: ' + url, test: id }),
  F('models', name, baseVar, 'Base URL', 'text', { def: baseDef }),
  F('models', name, modelVar, 'Default model for ' + name, 'text', { def: modelDef, models: id }),
];
export const SCHEMA = [
  // Models & keys
  F('models', 'Routing', 'AI_PROVIDER', 'Provider to try first', 'select', { opts: ['', 'openrouter', 'anthropic', 'openai', 'xai', 'google', 'ollama'], help: 'Empty = Anthropic, then OpenRouter, OpenAI, xAI, Google, Ollama (only providers with a key).' }),
  F('models', 'Routing', 'AI_MODEL_CHEAP', 'Cheap model (routine work, briefs, chats)', 'text', { models: 'any', help: 'Empty = the provider default. Use provider:model to pin a provider, e.g. openai:gpt-4o-mini. OpenRouter ids look like vendor/model.' }),
  F('models', 'Routing', 'AI_MODEL_STRONG', 'Strong model (planning, research, Factory)', 'text', { models: 'any', help: 'Used for goal planning and for agents set to "strong". Empty = the cheap model.' }),
  F('models', 'Routing', 'AI_FALLBACKS', 'Fallback models (in order)', 'textarea', { help: 'One per line, provider:model, e.g. openrouter:openai/gpt-4o-mini. Tried when the main call fails (error, rate limit, timeout) before any tool ran.' }),
  F('models', 'Generation', 'LLM_TEMPERATURE', 'Temperature', 'number', { min: 0, max: 2, step: 0.1, help: 'Empty = the model default.' }),
  F('models', 'Generation', 'LLM_MAX_TOKENS', 'Max output tokens per call', 'number', { def: '2000', min: 256, max: 32000 }),
  F('models', 'Generation', 'LLM_TIMEOUT_MS', 'Timeout per model call (ms)', 'number', { def: '180000', min: 30000, max: 600000 }),
  ...P('openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_MODEL', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4.5', 'https://openrouter.ai/keys'),
  ...P('anthropic', 'Anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'https://api.anthropic.com', 'claude-sonnet-4-5', 'https://console.anthropic.com/settings/keys'),
  ...P('openai', 'OpenAI', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'https://api.openai.com/v1', 'gpt-4o-mini', 'https://platform.openai.com/api-keys'),
  ...P('xai', 'xAI', 'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_MODEL', 'https://api.x.ai/v1', 'grok-4.5', 'https://console.x.ai'),
  ...P('google', 'Google Gemini', 'GOOGLE_AI_API_KEY', 'GOOGLE_AI_BASE_URL', 'GOOGLE_AI_MODEL', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash', 'https://aistudio.google.com/apikey'),
  F('models', 'Ollama / local (OpenAI-compatible)', 'OLLAMA_BASE_URL', 'Base URL (turns it on)', 'text', { help: 'e.g. http://127.0.0.1:11434/v1 for Ollama, or any OpenAI-compatible server.', test: 'ollama' }),
  F('models', 'Ollama / local (OpenAI-compatible)', 'OLLAMA_API_KEY', 'API key (if the server needs one)', 'secret'),
  F('models', 'Ollama / local (OpenAI-compatible)', 'OLLAMA_MODEL', 'Default model', 'text', { def: 'llama3.1', models: 'ollama' }),
  F('models', 'Web search', 'WEB_SEARCH', 'Web search', 'select', { opts: ['', 'off'], help: 'Empty = on (DuckDuckGo, or Tavily when a key is set).' }),
  F('models', 'Web search', 'TAVILY_API_KEY', 'Tavily API key', 'secret', { test: 'tavily' }),
  // Usage & spending
  F('usage', 'Spending cap', 'SPEND_CAP_MONTH_USD', 'Monthly cap (USD, estimated)', 'number', { min: 0, step: 0.5, help: 'Empty = no cap. Based on estimated cost (OpenRouter prices).' }),
  F('usage', 'Spending cap', 'SPEND_CAP_ACTION', 'When the cap is reached', 'select', { opts: ['block', 'warn'], def: 'block', help: 'block = agents stop calling models until next month or until you raise the cap; warn = keep going, alert only.' }),
  // Agents
  F('agents', 'Defaults', 'AGENT_MAX_STEPS', 'Tool steps per run (chat)', 'number', { def: '7', min: 2, max: 40 }),
  F('agents', 'Defaults', 'AGENT_TIER_DEFAULT', 'Default model tier for agents', 'select', { opts: ['cheap', 'strong'], def: 'cheap' }),
  F('agents', 'Defaults', 'AGENT_PERSONA', 'Business-wide instructions for every agent', 'textarea', { help: 'Tone, house rules, what never to say. Added to every agent\'s instructions.' }),
  // Approvals & safety
  ...[['APPROVAL_EMAIL', 'Send emails'], ['APPROVAL_SOCIAL', 'Social posts (Buffer)'], ['APPROVAL_ACTION', 'Actions in connected apps'], ['APPROVAL_BROWSER', 'Browser: pay, submit, sign in, delete'], ['APPROVAL_REPLY', 'Replies to leads (propose_reply)'], ['APPROVAL_GITHUB', 'GitHub publishing'], ['APPROVAL_GUMROAD', 'Gumroad drafts']]
    .map(([k, l]) => F('approvals', 'What needs approval', k, l, 'select', { opts: ['ask', 'block'], def: 'ask', help: 'ask = wait for your Approve (default). block = agents may not do this at all. Nothing runs without approval.' })),
  // Messaging
  F('slack', 'Slack bot', 'SLACK_BOT_TOKEN', 'Bot token (xoxb-…)', 'secret', { live: 'slack', test: 'slack' }),
  F('slack', 'Slack bot', 'SLACK_APP_TOKEN', 'App-level token (xapp-…)', 'secret', { live: 'slack' }),
  F('slack', 'Slack bot', 'SLACK_OWNER_USER_ID', 'Owner member ID', 'text', { live: 'slack', help: 'Only this Slack user is obeyed.' }),
  F('slack', 'Slack bot', 'SLACK_ACCOUNT_EMAIL', 'AIdentify account the bot works for', 'text', { live: 'slack' }),
  F('slack', 'Slack bot', 'SLACK_AGENT_ID', 'Agent that answers DMs (id)', 'text', { live: 'slack', help: 'Empty = the lead of the orchestrator group.' }),
  F('slack', 'Slack bot', 'SLACK_NOTIFY_CHANNEL', 'Notifications channel ID', 'text', { live: 'slack', help: 'e.g. C0123ABCD. Empty = the owner DM.' }),
  F('slack', 'Connection health', 'SLACK_HEARTBEAT_MIN', 'Heartbeat log every N minutes', 'number', { def: '15', live: 'slack' }),
  F('slack', 'Connection health', 'SLACK_WATCHDOG_SEC', 'Force reconnect after socket down (s)', 'number', { def: '60', live: 'slack' }),
  // Browser
  F('browser', 'Agents\' browser', 'BROWSER_HEADLESS', 'Headless', 'select', { opts: ['', 'true', 'false'], help: 'Empty = headless. false shows the window on BROWSER_DISPLAY.' }),
  F('browser', 'Agents\' browser', 'BROWSER_CHANNEL', 'Browser', 'select', { opts: ['', 'chrome', 'chromium'], help: 'Empty = Google Chrome when installed.' }),
  F('browser', 'Agents\' browser', 'BROWSER_DISPLAY', 'X display for a visible window', 'text'),
  F('browser', 'Agents\' browser', 'BROWSER_PROFILE_DIR', 'Profile folder', 'text', { live: false, help: 'Changing it signs the agents out of every site.' }),
  F('browser', 'Remote browser', 'REMOTE_BROWSER_IDLE_MIN', 'Close after idle minutes', 'number', { def: '20', min: 1, max: 240 }),
  F('browser', 'Remote browser', 'REMOTE_BROWSER_TUNNEL', 'Public tunnel', 'select', { opts: ['auto', 'ngrok', 'cloudflared', 'none'], def: 'auto' }),
  F('browser', 'Remote browser', 'NGROK_AUTHTOKEN', 'ngrok authtoken', 'secret', { help: 'Free at dashboard.ngrok.com.' }),
  // Schedules
  F('schedules', 'Time', 'APP_TIMEZONE', 'Timezone', 'text', { def: 'Asia/Kolkata', help: 'IANA name, e.g. Asia/Kolkata, Europe/London. Used for routines, briefs and times in Slack.' }),
  // Connectors & tools
  F('connectors', 'GitHub (Factory publishing)', 'GITHUB_TOKEN', 'Token', 'secret', { test: 'github' }),
  F('connectors', 'GitHub (Factory publishing)', 'GITHUB_OWNER', 'Owner (user or org)', 'text'),
  F('connectors', 'Gumroad', 'GUMROAD_ACCESS_TOKEN', 'Access token', 'secret', { test: 'gumroad' }),
  F('connectors', 'Buffer (social posting)', 'BUFFER_API_KEY', 'API key', 'secret', { test: 'buffer' }),
  F('connectors', 'Composio (managed sign-in)', 'COMPOSIO_API_KEY', 'API key', 'secret', { test: 'composio' }),
  F('connectors', 'Gmail (server-wide)', 'GMAIL_USER', 'Gmail address', 'text', { test: 'gmail' }),
  F('connectors', 'Gmail (server-wide)', 'GMAIL_APP_PASSWORD', 'App password', 'secret'),
  ...['GOOGLE', 'MICROSOFT', 'GITHUB', 'SLACK', 'NOTION', 'HUBSPOT'].flatMap((p) => [
    F('connectors', 'OAuth apps', p + '_CLIENT_ID', p[0] + p.slice(1).toLowerCase() + ' client ID', 'text'),
    F('connectors', 'OAuth apps', p + '_CLIENT_SECRET', p[0] + p.slice(1).toLowerCase() + ' client secret', 'secret')]),
  // Memory
  F('memory', 'Memory', 'AGENT_MEMORY', 'Agents can save memories', 'select', { opts: ['on', 'off'], def: 'on' }),
  // Notifications
  F('notifications', 'Slack notifications', 'NOTIFY_REVIEW', 'Items that need approval', 'select', { opts: ['on', 'off'], def: 'on' }),
  F('notifications', 'Slack notifications', 'NOTIFY_FAILED', 'Failed tasks', 'select', { opts: ['on', 'off'], def: 'on' }),
  F('notifications', 'Slack notifications', 'NOTIFY_BRIEF', 'Routine briefs', 'select', { opts: ['on', 'off'], def: 'on' }),
  F('notifications', 'Slack notifications', 'NOTIFY_SPEND', 'Spending alerts (50 / 80 / 100 %)', 'select', { opts: ['on', 'off'], def: 'on' }),
  // Workspace & branding
  F('workspace', 'Branding', 'BRAND_NAME', 'Product name', 'text', { def: 'AIdentify' }),
  F('workspace', 'Branding', 'BRAND_COLOR', 'Accent colour', 'text', { def: '#6d5efc', help: 'Hex, e.g. #6d5efc.' }),
  F('workspace', 'Branding', 'BRAND_LOGO_URL', 'Logo URL (https)', 'text'),
  F('workspace', 'Server', 'APP_URL', 'Public address', 'text', { help: 'Used for OAuth return URLs.' }),
  // Updates
  F('updates', 'Updates', 'UPDATE_CHANNEL', 'Update channel', 'select', { opts: ['releases', 'main'], def: 'releases' }),
  // Security
  F('security', 'Sign-in', 'RATE_LIMIT', 'Sign-in rate limit', 'select', { opts: ['', 'off'], help: 'Empty = on. Only turn off for a private demo.' }),
];
const BY = Object.fromEntries(SCHEMA.map((f) => [f.k, f]));
// read-only, env-only facts shown in Settings
export const ENV_ONLY = ['PORT', 'HOST', 'DATABASE_URL', 'SESSION_SECRET', 'DEMO_MODE', 'ADMIN_EMAIL'];

// ---------- validation ----------
export function validate(k, v) {
  const f = BY[k]; if (!f) throw new Error('Unknown setting ' + k);
  v = v == null ? '' : String(v).trim();
  if (v === '') return '';
  if (v.length > 8000) throw new Error(f.label + ': too long');
  if (f.t === 'number') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(f.label + ': enter a number'); if (f.min != null && n < f.min) throw new Error(`${f.label}: at least ${f.min}`); if (f.max != null && n > f.max) throw new Error(`${f.label}: at most ${f.max}`); }
  if (f.t === 'select' && !f.opts.includes(v)) throw new Error(f.label + ': choose one of ' + f.opts.filter(Boolean).join(', '));
  if (/_BASE_URL$|^APP_URL$|^BRAND_LOGO_URL$/.test(k) && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error(f.label + ': enter a URL starting with http:// or https://');
  if (k === 'BRAND_LOGO_URL' && !/^https:\/\//.test(v)) throw new Error('Logo URL must start with https://');
  if (k === 'BRAND_COLOR' && !/^#[0-9a-f]{6}$/i.test(v)) throw new Error('Accent colour: use a hex colour like #6d5efc');
  if (k === 'APP_TIMEZONE') { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw new Error('Timezone: not a valid IANA name (e.g. Asia/Kolkata)'); } }
  if (k === 'SLACK_NOTIFY_CHANNEL' && !/^[CGD][A-Z0-9]{6,}$/.test(v)) throw new Error('Notifications channel: use the channel ID (e.g. C0123ABCD)');
  if (k === 'SLACK_OWNER_USER_ID' && !/^[UW][A-Z0-9]{6,}$/.test(v)) throw new Error('Owner member ID looks wrong (e.g. U0123ABCD)');
  if (k === 'AI_FALLBACKS') for (const line of v.split(/\n|,/).map((x) => x.trim()).filter(Boolean)) if (!/^(openrouter|anthropic|openai|xai|google|ollama):\S+$/.test(line)) throw new Error('Fallbacks: each line must be provider:model, e.g. openrouter:openai/gpt-4o-mini');
  if (/[\r\n]/.test(v) && f.t !== 'textarea') throw new Error(f.label + ': one line only');
  return v;
}

// ---------- encryption ----------
let secretFn = null;
async function encKey() { return crypto.createHash('sha256').update(String(await secretFn()) + ':settings').digest(); }
async function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
async function unseal(s) {
  const [iv, tag, ct] = String(s).slice(4).split('.').map((x) => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------- store + apply ----------
let ST = null, values = {}; // plain values in memory (secrets decrypted), only for keys saved in Settings
const listeners = [];
export const onSettingsChanged = (fn) => listeners.push(fn);
export async function initSettings(st, secret) {
  ST = st; secretFn = secret;
  const raw = parse((await st.get('as_settings'))?.v, {}) || {};
  values = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!BY[k]) continue;
    try { values[k] = typeof v === 'string' && v.startsWith('enc:') ? await unseal(v) : String(v); }
    catch { console.error('Settings: could not decrypt ' + k + ' (SESSION_SECRET changed?); using .env'); }
  }
  apply();
  const n = Object.keys(values).length; if (n) console.log(`Settings: ${n} value(s) from Settings applied (Settings > .env > default)`);
}
function apply() {
  for (const f of SCHEMA) {
    if (values[f.k] != null && values[f.k] !== '') process.env[f.k] = values[f.k];
    else if (ENV0[f.k] != null) process.env[f.k] = ENV0[f.k];
    else delete process.env[f.k];
  }
}
export function sourceOf(k) { return values[k] ? 'settings' : (ENV0[k] || '').trim() ? 'env' : 'default'; }
const last4 = (s) => (s && s.length > 8 ? s.slice(-4) : '');
export function publicView() {
  const out = {};
  for (const f of SCHEMA) {
    const v = (process.env[f.k] || '').trim(), src = sourceOf(f.k);
    out[f.k] = f.t === 'secret' ? { set: !!v, last4: last4(v), source: v ? src : 'unset' } : { value: values[f.k] ?? '', effective: v || f.def || '', source: v ? src : 'default' };
  }
  return out;
}
export async function saveSettings(patch, who) {
  const changed = [];
  const next = { ...values };
  for (const [k, raw] of Object.entries(patch || {})) {
    const f = BY[k]; if (!f) throw new Error('Unknown setting ' + k);
    if (f.t === 'secret' && raw === undefined) continue;
    const v = validate(k, raw);
    if ((next[k] || '') === v) continue;
    if (v === '') delete next[k]; else next[k] = v;
    changed.push(k);
  }
  if (!changed.length) return { changed };
  const stored = {};
  for (const [k, v] of Object.entries(next)) stored[k] = BY[k].t === 'secret' ? await seal(v) : v;
  await ST.put('as_settings', JSON.stringify(stored), Date.now());
  values = next; apply();
  await audit(who, 'save', changed);
  const live = changed.map((k) => BY[k].live ?? true);
  for (const fn of listeners) { try { await fn(changed); } catch (e) { console.error('Settings listener:', e.message); } }
  return { changed, restart: changed.filter((k, i) => live[i] === false) };
}
export async function audit(who, action, keys = []) {
  if (!ST) return;
  const all = parse((await ST.get('as_settings_audit'))?.v, []) || [];
  all.unshift({ at: Date.now(), by: who || '?', action, keys });
  await ST.put('as_settings_audit', JSON.stringify(all.slice(0, 300)), Date.now());
}
export async function auditLog() { return ST ? parse((await ST.get('as_settings_audit'))?.v, []) || [] : []; }
// values that must never appear in logs, exports or API answers
export function secretValues() {
  const s = new Set();
  for (const f of SCHEMA) if (f.t === 'secret') { const v = (process.env[f.k] || '').trim(); if (v.length >= 8) s.add(v); }
  for (const k of ['SESSION_SECRET', 'JWT_SECRET', 'ADMIN_PASSWORD', 'TEAM_PASSWORD', 'DEMO_USER_PASSWORD', 'CRON_SECRET', 'DATABASE_URL', 'SLACK_SIGNING_SECRET', 'X_CHAT_PIN']) { const v = (process.env[k] || '').trim(); if (v.length >= 6) s.add(v); }
  return [...s];
}
export function redact(text) {
  let t = String(text ?? '');
  for (const v of secretValues()) t = t.split(v).join('[redacted]');
  return t.replace(/\b(sk-or-v1-|sk-ant-|xox[bpa]-|xapp-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '$1[redacted]');
}
