// Native Meta publish + Facebook Login OAuth for the clinic social path. All Meta network is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers.mjs';
import { publishMeta, oauthCallback, oauthStart, saveMetaCreds, loadMetaCreds, SOCIAL_KEY } from '../lib/clinic-social-meta.js';

const PW = 'Clinic-pass-123!';
const TOK = 'EAAsecretPageToken1234567890';
const mem = () => { const m = new Map(); return { get: async (k) => (m.has(k) ? { v: m.get(k) } : null), put: async (k, v) => { m.set(k, v); }, m }; };
const secret = async () => 'unit-secret';

test('publishMeta posts to Graph, returns live URLs, redacts token on failure, IG needs image', async () => {
  const creds = { pageId: '12345', pageToken: TOK, igUserId: '17841' };
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); if (url.endsWith('/feed')) return { ok: true, json: async () => ({ id: '12345_999' }) }; if (url.endsWith('/media')) return { ok: true, json: async () => ({ id: 'c1' }) }; if (url.endsWith('/media_publish')) return { ok: true, json: async () => ({ id: 'm1' }) }; return { ok: true, json: async () => ({ permalink: 'https://www.instagram.com/p/abc/' }) }; };
  const r = await publishMeta({ creds, text: 'Hello', imageUrl: 'https://x.test/a.jpg', networks: ['facebook', 'instagram'], env: {}, fetchImpl: f });
  assert.equal(r.published, true);
  assert.equal(r.results[0].url, 'https://www.facebook.com/12345/posts/999');
  assert.equal(r.results[1].url, 'https://www.instagram.com/p/abc/');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/12345/feed');
  const noImg = await publishMeta({ creds, text: 'x', networks: ['instagram'], env: {}, fetchImpl: f });
  assert.equal(noImg.published, false); assert.match(noImg.error, /needs an image/);
  const bad = await publishMeta({ creds, text: 'x', networks: ['facebook'], env: {}, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token ' + TOK } }) }) });
  assert.equal(bad.published, false); assert.doesNotMatch(JSON.stringify(bad), new RegExp(TOK));
  const stub = await publishMeta({ creds, text: 'x', networks: ['x', 'linkedin'], env: {} });
  assert.equal(stub.published, false);
  assert.equal((await publishMeta({ creds: null, text: 'x' })).published, false);
});

test('OAuth callback: real exchange path (mocked fetch), single-use state, tenant bound, sealed at rest', async () => {
  const st = mem();
  const env = { META_APP_ID: 'app1', META_APP_SECRET: 'appsecret', META_REDIRECT_URI: 'https://example.test/api/clinic/social/meta/callback' };
  const { url, state } = await oauthStart(st, 'a@x.test', env);
  assert.match(url, /^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/); assert.match(url, /pages_manage_posts/);
  const f = async (u) => { if (u.includes('fb_exchange_token')) return { ok: true, json: async () => ({ access_token: 'LONG', expires_in: 5184000 }) }; if (u.includes('/oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'SHORT' }) }; return { ok: true, json: async () => ({ data: [{ id: '555', name: 'Smile Dental', access_token: TOK, instagram_business_account: { id: '1784', username: 'smiledental' } }] }) }; };
  const r = await oauthCallback(st, secret, { code: 'c', state }, env, f);
  assert.equal(r.ok, true); assert.equal(r.email, 'a@x.test'); assert.equal(r.meta.igUsername, 'smiledental');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOK));
  assert.doesNotMatch(st.m.get(SOCIAL_KEY('a@x.test')), new RegExp(TOK));
  assert.equal((await loadMetaCreds(st, 'a@x.test', secret)).pageToken, TOK);
  assert.equal(await loadMetaCreds(st, 'b@x.test', secret), null);
  const replay = await oauthCallback(st, secret, { code: 'c', state }, env, f);
  assert.equal(replay.ok, false);
  assert.equal((await oauthCallback(st, secret, { code: 'c', state: 'forged' }, env, f)).ok, false);
  await saveMetaCreds(st, 'b@x.test', secret, { pageId: '777', pageToken: 'EAAbbbbbbbbbbbbb' });
  assert.equal((await loadMetaCreds(st, 'a@x.test', secret)).pageId, '555');
});

test('clinic flow: connect via OAuth (mock), approve publishes with live URL, no token leak, isolation, disconnect', async () => {
  const s = await startServer({ RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CLINIC_DEMO_PLATFORM_KEY: '1', META_MOCK: 'on' });
  try {
    const mk = async (e) => { const u = await s.api('/api/auth/signup', { email: e, name: 'Owner', password: PW }); await s.api('/api/clinic/profile', { biz: 'Clinic', city: 'Hyderabad', services: 'Check-up', prices: '₹1500', audience: 'Local', offer: 'This week' }, u.d.token); await s.api('/api/clinic/role', { role: 'dental' }, u.d.token); return u.d.token; };
    const a = await mk('meta-a@example.com'), b = await mk('meta-b@example.com');
    // B approves before connecting: honest "not published"
    const pb = await s.api('/api/clinic/social/draft', { topic: 'Flu shots' }, b);
    const db = await s.api('/api/clinic/decide', { id: pb.d.post.approvalId, decision: 'approve' }, b);
    assert.match(db.d.approval.result, /not published/i);
    let vb = await s.api('/api/clinic', undefined, b);
    assert.equal(vb.d.posts.find((p) => p.approvalId === pb.d.post.approvalId).status, 'approved');
    // A connects
    const start = await s.api('/api/clinic/social/meta/start', {}, a);
    assert.equal(start.status, 200);
    const cb = await fetch(s.base + start.d.url);
    assert.match(await cb.text(), /Connected Mock Clinic Page and Instagram @mockclinic/);
    const va = await s.api('/api/clinic', undefined, a);
    assert.equal(va.d.socialMeta.connected, true); assert.equal(va.d.socialMeta.igUsername, 'mockclinic');
    assert.doesNotMatch(JSON.stringify(va.d), /EAAmockpage[a-f0-9]{16}/);
    vb = await s.api('/api/clinic', undefined, b);
    assert.equal(vb.d.socialMeta.connected, false);
    // kv cannot read sealed creds
    const kv = await s.api('/api/kv?key=' + encodeURIComponent('as_csocial:meta-a@example.com'), undefined, a);
    assert.doesNotMatch(JSON.stringify(kv.d || {}), /EAAmock|"meta"/);
    // A draft → approve → published with live URL
    const pa = await s.api('/api/clinic/social/draft', { topic: 'Open on Sunday' }, a);
    const da = await s.api('/api/clinic/decide', { id: pa.d.post.approvalId, decision: 'approve' }, a);
    assert.match(da.d.approval.result, /^Published: https:\/\/www\.facebook\.com\//);
    const post = (await s.api('/api/clinic', undefined, a)).d.posts.find((p) => p.approvalId === pa.d.post.approvalId);
    assert.equal(post.status, 'published'); assert.match(post.liveUrls[0], /facebook\.com/);
    // rejected stays rejected
    const pr = await s.api('/api/clinic/social/draft', { topic: 'No' }, a);
    await s.api('/api/clinic/decide', { id: pr.d.post.approvalId, decision: 'reject' }, a);
    assert.equal((await s.api('/api/clinic', undefined, a)).d.posts.find((p) => p.approvalId === pr.d.post.approvalId).status, 'rejected');
    // disconnect clears
    await s.api('/api/clinic/social/meta', { disconnect: true }, a);
    assert.equal((await s.api('/api/clinic/social/meta', undefined, a)).d.meta.connected, false);
    // clinic social path never imports Buffer
    assert.doesNotMatch(fs.readFileSync(new URL('../lib/clinic.js', import.meta.url), 'utf8'), /buffer\.js/);
    assert.doesNotMatch(fs.readFileSync(new URL('../lib/clinic-social-meta.js', import.meta.url), 'utf8'), /buffer\.js/);
  } finally { await s.stop(); }
});
