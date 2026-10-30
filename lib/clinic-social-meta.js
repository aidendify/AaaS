// Native clinic social publish (no Buffer, no third-party scheduler, no paid BSP).
// The owner connects THEIR OWN Meta app: a Facebook Page id + Page access token, and optionally the
// Instagram Business account id linked to that Page. Tokens are AES-256-GCM sealed under as_csocial:<email>
// (server-only, per-user key; never readable through /api/kv) and never returned to the browser.
// Flow is approval-first: draft → owner approves → publish. Success stores the live post URL; failure
// keeps a visible error. Nothing is called "published" unless Meta returned an id.
// META_MOCK=on (or CHANNELS_MOCK=on) returns fake ids with no network.
// X and LinkedIn: stubs only (see HANDOFF) — they report "not built yet" and never pretend to post.
import crypto from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const SOCIAL_KEY = (email) => 'as_csocial:' + String(email || '').toLowerCase();
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const last4 = (s) => { const t = String(s || ''); return t ? '••••' + t.slice(-4) : ''; };

async function encKey(secret) { return crypto.createHash('sha256').update(String(await secret()) + ':clinic-social').digest(); }
export async function sealCred(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
export async function openCred(s, secret) {
  const [iv, tag, ct] = String(s || '').split('.').map((x) => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(secret), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
const asSecret = (secret) => (typeof secret === 'function' ? secret : async () => secret);

export const isMetaMock = (env = process.env) => env.META_MOCK === 'on' || env.CHANNELS_MOCK === 'on';

export async function saveMetaCreds(st, email, secret, { pageId, pageToken, igUserId, pageName = '', igUsername = '', userTokenExp = 0 } = {}) {
  pageId = clip(pageId, 40); pageToken = clip(pageToken, 600); igUserId = clip(igUserId, 40); pageName = clip(pageName, 120); igUsername = clip(igUsername, 60);
  if (!/^\d{3,40}$/.test(pageId)) throw Object.assign(new Error('Facebook Page id must be digits.'), { status: 400 });
  if (pageToken.length < 10) throw Object.assign(new Error('Page access token is missing.'), { status: 400 });
  if (igUserId && !/^\d{3,40}$/.test(igUserId)) throw Object.assign(new Error('Instagram account id must be digits.'), { status: 400 });
  const sealed = await sealCred({ pageId, pageToken, igUserId, pageName, igUsername, userTokenExp }, asSecret(secret));
  await st.put(SOCIAL_KEY(email), JSON.stringify({ meta: sealed, at: Date.now() }), Date.now());
  return metaPublic({ pageId, pageToken, igUserId, pageName, igUsername });
}
export async function loadMetaCreds(st, email, secret) {
  let row; try { row = JSON.parse((await st.get(SOCIAL_KEY(email)))?.v || 'null'); } catch { row = null; }
  if (!row || !row.meta) return null;
  try { return await openCred(row.meta, asSecret(secret)); } catch { return null; }
}
export async function clearMetaCreds(st, email) { await st.put(SOCIAL_KEY(email), JSON.stringify({}), Date.now()); }
export function metaPublic(cr) {
  if (!cr) return { connected: false, oauth: oauthReady(), facebook: false, instagram: false, x: 'stub', linkedin: 'stub' };
  return { connected: true, oauth: oauthReady(), facebook: true, instagram: !!cr.igUserId, pageId: cr.pageId, pageName: cr.pageName || '', igUsername: cr.igUsername || '', igUserId: cr.igUserId || '', token: last4(cr.pageToken), x: 'stub', linkedin: 'stub' };
}

async function gjson(fetchImpl, url, body) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch { j = {}; }
  if (!r.ok || j.error) throw new Error('Meta: ' + clip((j.error && j.error.message) || ('HTTP ' + r.status), 200));
  return j;
}

// Publish one approved post. Returns { results: [{network, ok, id, url, error}], published, error }.
// Instagram needs an image: if no imageUrl, IG is reported as an honest failure, Facebook still goes.
export async function publishMeta({ creds, text, imageUrl = '', networks = ['facebook', 'instagram'], env = process.env, fetchImpl = globalThis.fetch }) {
  const results = [];
  if (!creds) return { published: false, results, error: 'Meta is not connected. Add your Page id and token in Social settings.' };
  const mock = isMetaMock(env);
  for (const net of networks) {
    try {
      if (net === 'facebook') {
        let id;
        if (mock) id = creds.pageId + '_mock' + crypto.randomBytes(4).toString('hex');
        else id = (await gjson(fetchImpl, `${GRAPH}/${creds.pageId}/feed`, { message: text, access_token: creds.pageToken })).id;
        if (!id) throw new Error('Meta returned no post id.');
        const [pg, post] = String(id).includes('_') ? String(id).split('_') : [creds.pageId, id];
        results.push({ network: 'facebook', ok: true, id, url: `https://www.facebook.com/${pg}/posts/${post}` });
      } else if (net === 'instagram') {
        if (!creds.igUserId) { results.push({ network: 'instagram', ok: false, error: 'No Instagram account linked.' }); continue; }
        if (!imageUrl) { results.push({ network: 'instagram', ok: false, error: 'Instagram needs an image; not posted.' }); continue; }
        let mediaId, permalink;
        if (mock) { mediaId = 'igmock' + crypto.randomBytes(4).toString('hex'); permalink = 'https://www.instagram.com/p/' + mediaId + '/'; }
        else {
          const cont = await gjson(fetchImpl, `${GRAPH}/${creds.igUserId}/media`, { image_url: imageUrl, caption: text, access_token: creds.pageToken });
          mediaId = (await gjson(fetchImpl, `${GRAPH}/${creds.igUserId}/media_publish`, { creation_id: cont.id, access_token: creds.pageToken })).id;
          try { const r = await fetchImpl(`${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(creds.pageToken)}`); permalink = (await r.json()).permalink; } catch { permalink = ''; }
        }
        if (!mediaId) throw new Error('Meta returned no media id.');
        results.push({ network: 'instagram', ok: true, id: mediaId, url: permalink || '' });
      } else if (net === 'x' || net === 'linkedin') {
        results.push({ network: net, ok: false, error: net + ' native publish is not built yet.' });
      }
    } catch (e) { results.push({ network: net, ok: false, error: clip(String(e.message).replace(creds.pageToken, '[redacted]'), 200) }); }
  }
  const okOnes = results.filter((r) => r.ok);
  return { published: okOnes.length > 0, results, error: results.filter((r) => !r.ok).map((r) => r.network + ': ' + r.error).join('; ') };
}

// ---- Facebook Login (owner OAuth). Platform sets META_APP_ID / META_APP_SECRET / META_REDIRECT_URI. ----
export const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];
const STATE = (s) => 'as_csocst:' + s;
export function oauthReady(env = process.env) { return isMetaMock(env) || !!(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI); }
export async function oauthStart(st, email, env = process.env) {
  if (!oauthReady(env)) throw Object.assign(new Error('Facebook Login is not set up on this server yet (META_APP_ID / META_APP_SECRET / META_REDIRECT_URI).'), { status: 503 });
  const state = crypto.randomBytes(18).toString('base64url');
  await st.put(STATE(state), JSON.stringify({ email: String(email).toLowerCase(), exp: Date.now() + 10 * 60 * 1000 }), Date.now());
  const redirect = env.META_REDIRECT_URI || '/api/clinic/social/meta/callback';
  if (isMetaMock(env) && !env.META_APP_ID) return { url: redirect + '?code=mockcode&state=' + state, state };
  const q = new URLSearchParams({ client_id: env.META_APP_ID, redirect_uri: redirect, state, scope: SCOPES.join(','), response_type: 'code' });
  return { url: 'https://www.facebook.com/v21.0/dialog/oauth?' + q, state };
}
async function gget(fetchImpl, url) {
  const r = await fetchImpl(url); let j = {}; try { j = await r.json(); } catch { j = {}; }
  if (!r.ok || j.error) throw new Error('Meta: ' + clip((j.error && j.error.message) || ('HTTP ' + r.status), 200));
  return j;
}
// Callback: state is single-use and bound to the tenant that started it. A forged/replayed state lands nowhere.
export async function oauthCallback(st, secret, { code, state, error } = {}, env = process.env, fetchImpl = globalThis.fetch) {
  const key = STATE(String(state || '')); let row = null;
  try { row = JSON.parse((await st.get(key))?.v || 'null'); } catch { row = null; }
  if (state) await st.put(key, JSON.stringify({}), Date.now());
  if (!row || !row.email || row.exp < Date.now()) return { ok: false, error: 'This Facebook connect link expired. Start again from Social.' };
  if (error || !code) return { ok: false, email: row.email, error: 'Facebook Login was cancelled.' };
  try {
    let page, userExp = 0;
    if (isMetaMock(env)) page = { id: '1000' + crypto.randomBytes(3).readUIntBE(0, 3), name: 'Mock Clinic Page', access_token: 'EAAmockpage' + crypto.randomBytes(8).toString('hex'), instagram_business_account: { id: '1784' + crypto.randomBytes(3).readUIntBE(0, 3), username: 'mockclinic' } };
    else {
      const base = 'https://graph.facebook.com/v21.0';
      const short = await gget(fetchImpl, `${base}/oauth/access_token?` + new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: env.META_REDIRECT_URI, code }));
      const long = await gget(fetchImpl, `${base}/oauth/access_token?` + new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.access_token }));
      userExp = long.expires_in ? Date.now() + long.expires_in * 1000 : 0;
      const pages = await gget(fetchImpl, `${base}/me/accounts?` + new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: long.access_token }));
      page = (pages.data || [])[0];
      if (!page) return { ok: false, email: row.email, error: 'No Facebook Page was shared. Pick a Page in Facebook Login and try again.' };
    }
    const ig = page.instagram_business_account || {};
    const meta = await saveMetaCreds(st, row.email, secret, { pageId: page.id, pageToken: page.access_token, pageName: page.name, igUserId: ig.id || '', igUsername: ig.username || '', userTokenExp: userExp });
    return { ok: true, email: row.email, meta };
  } catch (e) { return { ok: false, email: row.email, error: clip(String(e.message).replace(/access_token=[^&\s]+/g, 'access_token=[redacted]'), 200) }; }
}
