// Buffer (buffer.com): one API key reaches every social account connected in Buffer —
// X/Twitter, LinkedIn, Facebook, Instagram, Threads, Bluesky, Mastodon, TikTok, YouTube, Pinterest, Google Business.
// GraphQL API: POST https://api.buffer.com with "Authorization: Bearer <key>" (key from publish.buffer.com/settings/api).
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const API = () => env('BUFFER_API_URL', 'https://api.buffer.com');

export async function bufferGql(key, query, variables = {}) {
  let r;
  try { r = await fetch(API(), { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ query, variables }) }); }
  catch (e) { throw new Error('Couldn’t reach Buffer (' + e.message + ')'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new Error('Buffer rejected the API key. Create a new one at publish.buffer.com/settings/api.');
  if (!r.ok) throw new Error('Buffer answered ' + r.status + (j.errors && j.errors[0] ? ': ' + j.errors[0].message : ''));
  if (j.errors && j.errors.length && !j.data) throw new Error('Buffer: ' + j.errors.map((e) => e.message).join('; '));
  return j.data || {};
}

// every channel in every organization of this Buffer account
export async function bufferChannels(key) {
  const d = await bufferGql(key, 'query GetOrganizations { account { organizations { id name } } }');
  const orgs = (d.account && d.account.organizations) || [];
  const out = [];
  for (const o of orgs) {
    const c = await bufferGql(key, 'query GetChannels($input: ChannelsInput!) { channels(input: $input) { id name service } }', { input: { organizationId: o.id } });
    for (const ch of c.channels || []) out.push({ id: ch.id, name: ch.name, service: ch.service, org: o.name });
  }
  return out;
}

// match "all", "linkedin", "x", "twitter", "instagram", a channel name or id
export function pickChannels(all, want) {
  const list = (Array.isArray(want) ? want : String(want || 'all').split(/[,;]| and /)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.includes('all') || list.includes('everywhere')) return all;
  const alias = { x: 'twitter', tweet: 'twitter', ig: 'instagram', insta: 'instagram', fb: 'facebook', li: 'linkedin', yt: 'youtube', gbp: 'googlebusiness', google: 'googlebusiness' };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = new Map();
  for (const w of list) {
    const n = norm(alias[w] || w);
    for (const c of all) if (c.id === w || norm(c.service) === n || norm(c.service).startsWith(n) || norm(c.name) === n || norm(c.name).includes(n)) hit.set(c.id, c);
  }
  return [...hit.values()];
}

// mode: queue (next free slot) | now | next (top of queue) | ISO date-time (custom schedule)
export async function bufferPost(key, { channelId, text, when }) {
  const w = String(when || 'queue').trim().toLowerCase();
  const input = { channelId, text: String(text), schedulingType: 'automatic' };
  if (w === 'now') input.mode = 'shareNow';
  else if (w === 'next') input.mode = 'shareNext';
  else if (w && w !== 'queue' && !isNaN(Date.parse(when))) { input.mode = 'customScheduled'; input.dueAt = new Date(when).toISOString(); }
  else input.mode = 'addToQueue';
  const d = await bufferGql(key, `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`, { input });
  const r = d.createPost || {};
  if (r.message) throw new Error(r.message);
  return { id: r.post && r.post.id, dueAt: r.post && r.post.dueAt, mode: input.mode };
}
