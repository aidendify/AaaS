// Live apps: agents work inside the user's deployed apps (FormFirst, AfterJob, Nudge, PartPing, ChangeSlip)
// through each app's own API, signed in with the user's account for that app. What an agent does here shows up
// in the real app's screens (Leads, Jobs, Orders, Slips), and the links it shares are the app's real public links.
// Credentials are stored encrypted (AES-256-GCM) under as_live:<email>; the app's session cookie is cached and
// refreshed by signing in again when it expires.
import crypto from 'node:crypto';
import { assertPublicHttpUrl } from './web.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

export const LIVE = {
  formfirst: { name: 'FormFirst', base: 'https://form-first-6bkb.vercel.app', cookie: 'ff_token', login: '/api/auth/login', role: 'user' },
  afterjob: { name: 'AfterJob', base: 'https://after-job.vercel.app', cookie: 'aj_token', login: '/api/auth/admin/login', role: 'admin' },
  nudge: { name: 'Nudge', base: 'https://nudge-pt49.vercel.app', cookie: 'nd_token', login: '/api/auth/admin/login', role: 'admin' },
  partping: { name: 'PartPing', base: 'https://part-ping-15wg.vercel.app', cookie: 'pp_token', login: '/api/auth/login', role: 'user' },
  changeslip: { name: 'ChangeSlip', base: 'https://change-slips-zoz6.vercel.app', cookie: 'cs_token', login: '/api/auth/login', role: 'user' },
};

// what the agent can do in each live app (goes into its prompt)
const OPS = {
  formfirst: {
    add_lead: '{name, email, phone?, message, form?} submit a lead through your real FormFirst form; FormFirst replies to them instantly and asks question 1',
    qualify: '{lead, q1a, q2a} send the lead\'s two answers into their FormFirst conversation; FormFirst then writes the summary (hot/warm/cold, urgency, next step)',
    mark: '{lead, status: new|contacted|closed} set your status on a lead',
    summarize: '{lead} ask FormFirst to summarise a lead who never finished the conversation',
    create_form: '{title, business?, description?, goals?} create a new lead form; returns its public link',
  },
  afterjob: {
    add_job: '{name, summary, email?, phone?, job?, notes?} create a finished job; returns the customer feedback link',
    rate: '{job, score: 1-5, comment?} record a score the customer gave you by phone',
    close: '{job} close a job',
  },
  nudge: {
    add_lead: '{name, email?, phone?, company?, source?, notes?} add a lead; Nudge schedules the follow-ups',
    mark: '{lead, status: open|won|lost|paused}',
  },
  partping: {
    add_order: '{part, address, quantity?, part_number?, notes?} place a part order; returns the tracking link. Needs the delivery address: ask for it if the user did not give one, never invent it',
    cancel: '{order} cancel an order that is not yet processing',
    update_status: '{order, status: accepted|processing|dispatched|in_transit|out_for_delivery|delivered|cancelled, note?} move an order forward in the pipeline (needs the PartPing admin login); the customer tracking page updates at once',
    get_order: '{order} fetch one order fresh from PartPing with its full status history',
  },
  changeslip: {
    add_slip: '{title, amount: number, currency?, job?, details?, location?} publish a change slip; returns its link',
    cancel: '{slip} cancel an open slip',
  },
};

/* ----- encrypted storage ----- */
async function encKey(secret) { return crypto.createHash('sha256').update(String(await secret()) + ':liveapps').digest(); }
async function seal(obj, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
async function unseal(s, secret) {
  const [iv, tag, ct] = String(s || '').split('.').map((x) => Buffer.from(x || '', 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(secret), iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
async function loadAll(st, email, secret) {
  const raw = parse((await st.get('as_live:' + email))?.v, {}) || {}, out = {};
  for (const [k, v] of Object.entries(raw)) { try { out[k] = await unseal(v, secret); } catch {} }
  return out;
}
async function saveAll(st, email, all, secret) {
  const raw = {}; for (const [k, v] of Object.entries(all)) raw[k] = await seal(v, secret);
  await st.put('as_live:' + email, JSON.stringify(raw), Date.now());
}
const normBase = (u, d) => { const s = clip(u, 300).replace(/\/+$/, ''); return /^https?:\/\/[^\s/]+/.test(s) ? s : d; };

/* ----- HTTP against an app ----- */
class LiveError extends Error { constructor(m, status) { super(m); this.status = status; } }
async function call(base, path, { method = 'GET', body, cookie } = {}) {
  let r;
  try {
    r = await fetch(base + path, { method, signal: AbortSignal.timeout(25000), redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new LiveError('Couldn’t reach ' + base.replace(/^https?:\/\//, '') + ' (' + (e.name === 'TimeoutError' ? 'timed out' : e.message) + ')', 502); }
  const text = await r.text(), j = parse(text, null);
  if (!r.ok) throw new LiveError((j && j.error) || ('The app answered ' + r.status), r.status);
  return { j: j || {}, headers: r.headers };
}
function cookieFrom(headers, name) {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  for (const c of all) { const m = String(c).match(new RegExp('(?:^|[,;\\s])' + name + '=([^;]+)')); if (m) return name + '=' + m[1]; }
  return '';
}
async function signIn(app, conn) {
  const A = LIVE[app];
  const { j, headers } = await call(conn.base, A.login, { method: 'POST', body: { email: conn.email, password: conn.password } });
  const cookie = cookieFrom(headers, A.cookie);
  if (!cookie) throw new LiveError('Signed in, but ' + A.name + ' didn’t return a session. Check the app URL.', 502);
  return { cookie, user: j.user || null };
}
const PP_ADMIN_LOGIN = '/api/auth/admin/login';
async function signInAdmin(app, adm, base) {
  const { headers } = await call(base, PP_ADMIN_LOGIN, { method: 'POST', body: { email: adm.email, password: adm.password } });
  const cookie = cookieFrom(headers, LIVE[app].cookie);
  if (!cookie) throw new LiveError('Signed in, but ' + LIVE[app].name + ' didn’t return an admin session.', 502);
  return cookie;
}
async function authedAdmin(ctx, app, path, opts = {}) {
  const conn = ctx.all[app], adm = conn.admin;
  if (!adm) throw new LiveError('Moving an order needs the ' + LIVE[app].name + ' admin login. Add it in this agent’s Settings → Live app.', 403);
  if (!adm.cookie) { adm.cookie = await signInAdmin(app, adm, conn.base); ctx.dirty = true; }
  try { return (await call(conn.base, path, { ...opts, cookie: adm.cookie })).j; }
  catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    adm.cookie = await signInAdmin(app, adm, conn.base); ctx.dirty = true;
    return (await call(conn.base, path, { ...opts, cookie: adm.cookie })).j;
  }
}
// authed request with one automatic re-sign-in
async function authed(ctx, app, path, opts = {}) {
  const conn = ctx.all[app];
  if (!conn.cookie) { const s = await signIn(app, conn); conn.cookie = s.cookie; ctx.dirty = true; }
  try { return (await call(conn.base, path, { ...opts, cookie: conn.cookie })).j; }
  catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    const s = await signIn(app, conn); conn.cookie = s.cookie; ctx.dirty = true;
    return (await call(conn.base, path, { ...opts, cookie: conn.cookie })).j;
  }
}

/* ----- routes: connect / list / disconnect ----- */
export async function liveRoutes({ method, pathname, json, st, email, secret, HttpError }) {
  if (pathname === '/api/liveapps' && method === 'GET') {
    const all = await loadAll(st, email, secret);
    return { apps: Object.entries(LIVE).map(([id, A]) => ({ id, name: A.name, base: (all[id] && all[id].base) || A.base, connected: !!all[id], account: all[id] ? all[id].email : '', admin: !!(all[id] && all[id].admin), adminOnly: !!(all[id] && all[id].adminOnly), adminAccount: all[id] && all[id].admin ? all[id].admin.email : '', at: all[id] ? all[id].at : null })) };
  }
  if (pathname === '/api/liveapps/connect' && method === 'POST') {
    const b = json(), app = String(b.app || ''), A = LIVE[app];
    if (!A) throw new HttpError(400, 'bad_app', 'Unknown app.');
    const conn = { base: normBase(b.base, A.base), email: clip(b.email, 200).toLowerCase(), password: String(b.password || '').slice(0, 200), at: Date.now() };
    try { await assertPublicHttpUrl(conn.base); } catch (e) { throw new HttpError(400, 'bad_url', e.message || 'That address is not allowed.'); }
    if (!conn.email || !conn.password) throw new HttpError(400, 'missing', 'Enter the email and password you use in ' + A.name + '.');
    let s = null;
    try { s = await signIn(app, conn); }
    catch (e) {
      // PartPing: the shop's admin account can connect on its own (manages orders; placing orders needs a customer login)
      if (app === 'partping' && e.status === 401) { try { conn.admin = { email: conn.email, password: conn.password, cookie: await signInAdmin(app, conn, conn.base) }; conn.adminOnly = true; } catch { throw new HttpError(401, 'live_login', A.name + ': ' + e.message); } }
      else throw new HttpError(e.status === 401 ? 401 : 502, 'live_login', A.name + ': ' + e.message);
    }
    if (s) conn.cookie = s.cookie;
    if (app === 'partping' && !conn.admin && b.admin_email && b.admin_password) {
      const adm = { email: clip(b.admin_email, 200).toLowerCase(), password: String(b.admin_password).slice(0, 200) };
      try { adm.cookie = await signInAdmin(app, adm, conn.base); conn.admin = adm; } catch (e) { throw new HttpError(401, 'live_login', A.name + ' admin: ' + e.message); }
    }
    const all = await loadAll(st, email, secret); all[app] = conn; await saveAll(st, email, all, secret);
    return { ok: true, app, name: A.name, base: conn.base, account: conn.email, admin: !!conn.admin };
  }
  if (pathname === '/api/liveapps/disconnect' && method === 'POST') {
    const app = String(json().app || ''); const all = await loadAll(st, email, secret);
    delete all[app]; await saveAll(st, email, all, secret); return { ok: true };
  }
  if (pathname === '/api/liveapps/records' && method === 'GET') return null; // handled by liveRecords via backend
  return undefined;
}
export async function liveConnected(st, email, secret) { return Object.keys(await loadAll(st, email, secret)); }

/* ----- records (for the prompt and the UI) ----- */
async function records(ctx, app) {
  if (app === 'formfirst') {
    const [{ forms = [] }, { leads = [] }] = await Promise.all([authed(ctx, app, '/api/owner/forms'), authed(ctx, app, '/api/owner/leads')]);
    return { forms, leads };
  }
  if (app === 'afterjob') return { jobs: (await authed(ctx, app, '/api/admin/jobs')).jobs || [] };
  if (app === 'nudge') return { leads: (await authed(ctx, app, '/api/admin/leads')).leads || [] };
  if (app === 'partping') return { orders: (ctx.all[app].admin ? (await authedAdmin(ctx, app, '/api/admin/orders')).orders : (await authed(ctx, app, '/api/orders')).orders) || [] };
  if (app === 'changeslip') { const j = await authed(ctx, app, '/api/my'); return { slips: j.published || [] }; }
  return {};
}
const line = {
  formfirst: (l) => `${l.name}${l.email ? ' <' + l.email + '>' : ''} · ${clip(l.message, 70)} · form "${l.form_name}" · ${l.qualification ? l.qualification.toUpperCase() : 'not scored'} · ${l.status === 'done' ? 'conversation done' : 'asked ' + (l.asked || 0) + '/2'} · you: ${l.owner_status}${l.summary && l.summary.next_step ? ' · next: ' + clip(l.summary.next_step, 80) : ''}`,
  afterjob: (j) => `${j.customer_name}${j.job_ref ? ' · ' + j.job_ref : ''} · ${clip(j.service_summary, 60)} · ${j.status}${j.score ? ' ' + j.score + '/5' : ''}`,
  nudge: (l) => `${l.name}${l.company ? ' (' + l.company + ')' : ''}${l.email ? ' <' + l.email + '>' : ''} · ${l.status}`,
  partping: (o) => `${o.code} · ${o.part_name}${o.part_number ? ' (#' + o.part_number + ')' : ''} ×${o.quantity || 1} · ${o.status}${o.customer_email ? ' · ' + (o.customer_name ? o.customer_name + ' ' : '') + '<' + o.customer_email + '>' : ''}${o.delivery_address ? ' · to ' + clip(o.delivery_address, 60) : ''}`,
  changeslip: (s) => `#${s.id} ${s.title} · ${s.amount_cents != null ? (s.amount_cents / 100).toFixed(2) + ' ' + (s.currency || '') : ''} · ${s.status}`,
};
function listOf(app, r) { return app === 'formfirst' ? r.leads : r.jobs || r.leads || r.orders || r.slips || []; }

export async function liveContext(st, email, secret) {
  const all = await loadAll(st, email, secret);
  return { st, email, secret, all, dirty: false, async save() { if (this.dirty) { await saveAll(st, email, this.all, secret); this.dirty = false; } } };
}

// prompt section for one agent kind when its app is connected
export async function liveSpec(ctx, kind) {
  const A = LIVE[kind]; if (!A || !ctx.all[kind]) return '';
  let r = {}, err = '';
  try { r = await records(ctx, kind); } catch (e) { err = e.message; }
  const L = listOf(kind, r) || [];
  return `\nWORKING IN YOUR LIVE APP (${A.name}, ${ctx.all[kind].base}, signed in as ${ctx.all[kind].email})
You are connected to the user's real ${A.name} app. What you do here appears in their ${A.name} screens. To act, end your reply with one line per action, exactly like this:
<<DO: action || {"key":"value"}>>
Actions:
${Object.entries(OPS[kind]).filter(([k]) => opAllowed(ctx.all[kind], kind, k)).map(([k, v]) => '- ' + k + ' ' + v).join('\n')}
Rules: act when the user asks or hands you the data. Use only real details from the user, never [placeholders]; if a required detail is missing, ask in one line instead. Each action line is hidden and replaced by a result card with the real link, so don't invent links; just say in one line what you did.
${err ? 'Could not read the app just now: ' + err : `Current ${kind === 'formfirst' ? 'leads' : 'records'} in ${A.name} (newest first):${L.length ? '\n' + L.slice(0, 15).map((x) => '- ' + line[kind](x)).join('\n') : ' none yet.'}`}${kind === 'formfirst' && r.forms ? `\nForms: ${r.forms.length ? r.forms.map((f) => `"${f.name}" ${ctx.all[kind].base}/f/${f.slug}${f.active ? '' : ' (paused)'}`).join('; ') : 'none yet (create_form first, or add_lead creates one)'}` : ''}\n`;
}

/* ----- actions ----- */
function opAllowed(conn, kind, op) {
  if (kind !== 'partping') return true;
  if (op === 'update_status') return !!conn.admin;
  if (op === 'add_order' || op === 'cancel') return !conn.adminOnly;
  return true;
}
const PP_STATUS = { requested: 'requested', placed: 'requested', accepted: 'accepted', accept: 'accepted', confirmed: 'accepted', processing: 'processing', dispatched: 'dispatched', shipped: 'dispatched', in_transit: 'in_transit', transit: 'in_transit', on_the_way: 'in_transit', out_for_delivery: 'out_for_delivery', delivered: 'delivered', fitted: 'delivered', arrived: 'delivered', cancelled: 'cancelled', canceled: 'cancelled', cancel: 'cancelled' };
const ppLabel = (k) => ({ requested: 'Request placed', accepted: 'Request accepted', processing: 'Processing', dispatched: 'Dispatched', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' })[k] || k;
const find = (list, q, keys) => {
  const s = String(q ?? '').trim().toLowerCase(); if (!list.length) return null; if (!s) return list[0];
  const vals = (x) => keys.map((k) => String(x[k] ?? '').toLowerCase()).filter(Boolean);
  return list.find((x) => String(x.id) === s || String(x.code || '').toLowerCase() === s) || list.find((x) => vals(x).includes(s)) || list.find((x) => vals(x).some((v) => v.includes(s) || (v.length > 2 && s.includes(v)))) || null;
};
async function ffForm(ctx, want, base) {
  const { forms = [] } = await authed(ctx, 'formfirst', '/api/owner/forms');
  const act = forms.filter((f) => f.active !== false);
  let f = want ? find(act, want, ['name', 'slug']) : act[0];
  if (!f) { // no form yet: create one so the lead has somewhere to land
    const me = (await authed(ctx, 'formfirst', '/api/auth/me')).user || {};
    const r = await authed(ctx, 'formfirst', '/api/owner/forms', { method: 'POST', body: { name: 'Website enquiries', business_name: me.business || me.name || 'Our business' } });
    f = { id: r.id, slug: r.slug, name: 'Website enquiries' };
  }
  return { ...f, link: base + '/f/' + f.slug };
}

export async function liveAct(ctx, kind, op, args, memo) {
  const A = LIVE[kind], conn = ctx.all[kind], base = conn.base;
  if (!OPS[kind] || !OPS[kind][op]) return { err: `${A.name} can’t do “${op}”.` };
  const a = args || {};
  if (kind === 'formfirst') {
    if (op === 'create_form') {
      const me = (await authed(ctx, kind, '/api/auth/me')).user || {};
      const r = await authed(ctx, kind, '/api/owner/forms', { method: 'POST', body: { name: clip(a.title, 100) || 'Website enquiries', business_name: clip(a.business, 120) || me.business || me.name || 'Our business', description: clip(a.description, 600), goals: clip(a.goals, 300) } });
      const link = base + '/f/' + r.slug;
      return { t: 'Lead form created in FormFirst: ' + (clip(a.title, 100) || 'Website enquiries'), sub: 'Share this link — every lead gets an instant reply and two questions.', link, copy: [['Form link', link], ['Embed code', `<iframe src="${link}" width="100%" height="640" style="border:0" title="Contact form"></iframe>`]] };
    }
    if (op === 'add_lead') {
      const name = clip(a.name, 100), email = clip(a.email, 200), phone = clip(a.phone, 20), message = clip(a.message, 2000) || clip(a.notes, 2000);
      if (!name || !message || (!email && !phone)) return { err: 'A FormFirst lead needs a name, a message and an email or phone.' };
      const f = await ffForm(ctx, a.form, base);
      const { j } = await call(base, '/api/f/' + f.slug + '/submit', { method: 'POST', body: { name, email, phone, message } });
      let reply = '';
      try { const c = (await call(base, '/api/lead/' + j.token)).j; reply = ((c.messages || []).filter((m) => m.role === 'ai').pop() || {}).content || ''; } catch {}
      if (memo) { memo.tokens[(email || phone).toLowerCase()] = j.token; const k = Object.keys(memo.tokens); if (k.length > 300) delete memo.tokens[k[0]]; ctx.dirty = true; }
      return { t: 'Lead added to FormFirst: ' + name, sub: 'Form “' + f.name + '” · FormFirst replied instantly and asked question 1', link: f.link, token: j.token, copy: reply ? [['FormFirst’s reply to ' + first(name), reply]] : null, open: base + '/leads' };
    }
    const { leads = [] } = await authed(ctx, kind, '/api/owner/leads');
    const lead = find(leads, a.lead ?? a.email ?? a.name, ['email', 'name', 'phone']);
    if (!lead) return { err: 'Couldn’t find that lead in FormFirst.' };
    if (op === 'mark') {
      const s = String(a.status || '').toLowerCase(); if (!['new', 'contacted', 'closed'].includes(s)) return { err: 'Status must be new, contacted or closed.' };
      await authed(ctx, kind, '/api/owner/leads/' + lead.id + '/status', { method: 'POST', body: { status: s } });
      return { t: lead.name + ' marked ' + s + ' in FormFirst', open: base + '/leads/' + lead.id };
    }
    if (op === 'summarize' || op === 'qualify') {
      if (op === 'qualify') {
        const token = (memo && memo.tokens[String(lead.email || lead.phone || '').toLowerCase()]) || clip(a.token, 80);
        const ans = [clip(a.q1a, 1000), clip(a.q2a, 1000)].filter(Boolean);
        if (!ans.length) return { err: 'Qualifying needs the lead’s answers.' };
        if (token && lead.status !== 'done') {
          let c = (await call(base, '/api/lead/' + token)).j;
          for (const x of ans) { if (c.status === 'done') break; c = (await call(base, '/api/lead/' + token + '/reply', { method: 'POST', body: { content: x } })).j; }
        } else if (lead.status !== 'done') {
          // the conversation belongs to the visitor's browser: summarise from what FormFirst has
          await authed(ctx, kind, '/api/owner/leads/' + lead.id + '/summarize', { method: 'POST', body: {} });
        }
      } else await authed(ctx, kind, '/api/owner/leads/' + lead.id + '/summarize', { method: 'POST', body: {} });
      const d = await authed(ctx, kind, '/api/owner/leads/' + lead.id);
      const L = d.lead || {}, s = L.summary || {};
      return { t: `${L.name} — ${String(L.qualification || s.qualification || 'scored').toUpperCase()} lead in FormFirst`, sub: [s.summary, s.urgency ? 'Urgency: ' + s.urgency : '', s.next_step ? 'Next: ' + s.next_step : ''].filter(Boolean).join(' · '), open: base + '/leads/' + lead.id };
    }
  }
  if (kind === 'afterjob') {
    if (op === 'add_job') {
      const name = clip(a.name, 100), summary = clip(a.summary || a.service || a.notes, 500);
      if (!name || !summary) return { err: 'An AfterJob job needs the customer name and what was done.' };
      const { job } = await authed(ctx, kind, '/api/admin/jobs', { method: 'POST', body: { customer_name: name, customer_email: clip(a.email, 200), customer_phone: clip(a.phone, 30), job_ref: clip(a.job, 60), service_summary: summary, notes: clip(a.notes, 1000) } });
      const link = base + '/f/' + job.token;
      return { t: 'Job added to AfterJob: ' + name, sub: 'Send the feedback link: happy customers go to your Google review, unhappy ones stay private.', link, copy: [['Feedback link', link], ['Message', `Hi ${first(name)}, thanks for choosing us. How did we do? It takes 10 seconds: ${link}`]], open: base + '/admin/jobs/' + job.id };
    }
    const { jobs = [] } = await authed(ctx, kind, '/api/admin/jobs');
    const job = find(jobs, a.job ?? a.name, ['customer_name', 'customer_email', 'job_ref']);
    if (!job) return { err: 'Couldn’t find that job in AfterJob.' };
    if (op === 'close') { await authed(ctx, kind, '/api/admin/jobs/' + job.id + '/close', { method: 'POST', body: {} }); return { t: 'Job closed: ' + job.customer_name, open: base + '/admin/jobs/' + job.id }; }
    if (op === 'rate') {
      const n = Math.round(+a.score); if (!(n >= 1 && n <= 5)) return { err: 'A score must be 1 to 5.' };
      const { j } = await call(base, '/api/public/jobs/' + job.token + '/feedback', { method: 'POST', body: { score: n, feedback: clip(a.comment, 2000) } });
      return { t: `${job.customer_name}: ${n}/5 recorded (${j.happy ? 'happy' : 'complaint, kept private'})`, open: base + '/admin/jobs/' + job.id };
    }
  }
  if (kind === 'nudge') {
    if (op === 'add_lead') {
      const name = clip(a.name, 100); if (!name) return { err: 'A Nudge lead needs a name.' };
      const r = await authed(ctx, kind, '/api/admin/leads', { method: 'POST', body: { name, email: clip(a.email, 200), phone: clip(a.phone, 30), company: clip(a.company, 120), source: clip(a.source, 80) || 'AIdentify', notes: clip(a.notes, 1000) } });
      const id = (r.lead && r.lead.id) || r.id;
      return { t: 'Lead added to Nudge: ' + name, sub: 'Follow-ups are scheduled in Nudge.', open: base + (id ? '/admin/leads/' + id : '/admin/leads') };
    }
    const { leads = [] } = await authed(ctx, kind, '/api/admin/leads');
    const lead = find(leads, a.lead ?? a.name, ['email', 'name', 'company']);
    if (!lead) return { err: 'Couldn’t find that lead in Nudge.' };
    const s = String(a.status || '').toLowerCase(); if (!['open', 'won', 'lost', 'paused'].includes(s)) return { err: 'Status must be open, won, lost or paused.' };
    await authed(ctx, kind, '/api/admin/leads/' + lead.id + '/status', { method: 'POST', body: { status: s } });
    return { t: lead.name + ' marked ' + s + ' in Nudge', open: base + '/admin/leads/' + lead.id };
  }
  if (kind === 'partping') {
    if (!opAllowed(conn, kind, op)) return { err: op === 'update_status' ? 'Moving an order needs the PartPing admin login. Add it in this agent’s Settings → Live app.' : 'Placing or cancelling orders needs a PartPing customer login (you’re connected as admin).' };
    const want = String(a.order ?? a.code ?? a.part ?? '').trim();
    if (op === 'get_order') {
      const list = (await records(ctx, kind)).orders || [];
      const o = /^PP-/i.test(want) ? { code: want.toUpperCase() } : find(list, want, ['code', 'part_name', 'part_number', 'customer_email', 'customer_name']);
      if (!o) return { err: 'Couldn’t find that order in PartPing.' };
      const { order } = (await call(base, '/api/track/' + encodeURIComponent(o.code))).j;
      const hist = (order.logs || []).map((l) => ppLabel(l.status) + (l.note ? ' (' + clip(l.note, 80) + ')' : '') + ' · ' + new Date(l.at || l.created_at).toLocaleString('en-IN')).join(' → ');
      return { t: order.code + ' · ' + order.part_name + ': ' + ppLabel(order.status), sub: hist ? 'History: ' + hist : '', link: base + '/track/' + order.code };
    }
    if (op === 'update_status') {
      const key = PP_STATUS[String(a.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_')];
      if (!key) return { err: 'Unknown status “' + a.status + '”. Use accepted, processing, dispatched, in transit, out for delivery, delivered or cancelled.' };
      const list = (await authedAdmin(ctx, kind, '/api/admin/orders')).orders || [];
      const o = find(list, want, ['code', 'part_name', 'part_number', 'customer_email', 'customer_name']);
      if (!o) return { err: 'Couldn’t find that order in PartPing.' };
      await authedAdmin(ctx, kind, '/api/admin/orders/' + o.code + '/status', { method: 'POST', body: { status: key, note: clip(a.note, 500) } });
      const link = base + '/track/' + o.code;
      return { t: o.code + ' moved to ' + ppLabel(key), sub: o.part_name + (a.note ? ' · ' + clip(a.note, 120) : '') + ' · the customer’s tracking page shows it now.', link, copy: [['Tracking link', link]], open: base + '/admin/orders/' + o.code };
    }
    if (op === 'add_order') {
      const part = clip(a.part || a.part_name, 200), address = clip(a.address || a.delivery_address, 500);
      if (!part || !address) return { err: 'A PartPing order needs the part and the delivery address.' };
      const { code } = await authed(ctx, kind, '/api/orders', { method: 'POST', body: { part_name: part, part_number: clip(a.part_number, 100), quantity: Math.max(1, Math.round(+a.quantity || 1)), delivery_address: address, notes: clip(a.notes, 1000) } });
      const link = base + '/track/' + code;
      return { t: 'Order placed in PartPing: ' + part + ' (' + code + ')', sub: 'Share the tracking link with your customer.', link, copy: [['Tracking link', link]], open: base + '/orders/' + code };
    }
    const { orders = [] } = await authed(ctx, kind, '/api/orders');
    const o = find(orders, a.order ?? a.part, ['code', 'part_name']);
    if (!o) return { err: 'Couldn’t find that order in PartPing.' };
    await authed(ctx, kind, '/api/orders/' + o.code + '/cancel', { method: 'POST', body: {} });
    return { t: 'Order cancelled: ' + o.code, open: base + '/orders/' + o.code };
  }
  if (kind === 'changeslip') {
    if (op === 'add_slip') {
      const title = clip(a.title || a.summary, 200), amount = Number(a.amount);
      if (!title || !(amount >= 0)) return { err: 'A change slip needs a title and an amount.' };
      const { id } = await authed(ctx, kind, '/api/slips', { method: 'POST', body: { title, amount, currency: clip(a.currency || a.cur, 3).toUpperCase() || undefined, job_ref: clip(a.job, 60), details: clip(a.details, 3000), location: clip(a.location, 150) } });
      const link = base + '/slips/' + id;
      return { t: 'Change slip published in ChangeSlip: ' + title, link, copy: [['Slip link', link]], open: link };
    }
    const j = await authed(ctx, kind, '/api/my'); const list = j.published || [];
    const s = find(list, a.slip ?? a.title, ['title', 'job_ref']);
    if (!s) return { err: 'Couldn’t find that slip in ChangeSlip.' };
    await authed(ctx, kind, '/api/slips/' + s.id + '/cancel', { method: 'POST', body: {} });
    return { t: 'Slip cancelled: ' + s.title, open: base + '/slips/' + s.id };
  }
  return { err: 'Nothing done.' };
}

// run the <<DO: …>> lines of an answer against connected live apps; returns the cleaned text and result cards
export function takeDo(text) {
  const acts = []; let s = String(text || ''), out = '', i = 0;
  for (;;) {
    const j = s.indexOf('<<DO:', i); if (j < 0) { out += s.slice(i); break; }
    out += s.slice(i, j); const bar = s.indexOf('||', j); let end = -1, args = null;
    if (bar > 0) { let k = s.indexOf('>>', bar); while (k > 0) { try { args = JSON.parse(s.slice(bar + 2, k).trim()); end = k; break; } catch {} k = s.indexOf('>>', k + 1); } }
    if (end < 0) { const k = s.indexOf('>>', j); i = k < 0 ? s.length : k + 2; continue; }
    acts.push({ op: s.slice(j + 5, bar).trim(), args: args && typeof args === 'object' ? args : {}, raw: s.slice(j, end + 2) }); i = end + 2;
  }
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), acts };
}
export async function runLiveActs(ctx, text, agent, agents) {
  const { acts } = takeDo(text); if (!acts.length) return { text, acts: [] };
  const ff = ctx.all.formfirst; if (ff && !ff.tokens) ff.tokens = {};
  const results = [], memo = { tokens: ff ? ff.tokens : {} }; let rest = String(text);
  for (const x of acts.slice(0, 8)) {
    let ag = agent, op = x.op;
    const d = op.lastIndexOf('.');
    if (d > 0) { const nm = op.slice(0, d).trim().toLowerCase(); op = op.slice(d + 1).trim(); ag = agents.find((y) => String(y.name || '').toLowerCase() === nm) || agents.find((y) => nm && String(y.name || '').toLowerCase().includes(nm)) || ag; }
    if (!ag || !LIVE[ag.kind] || !ctx.all[ag.kind]) continue; // not a live app: the page runs it on its own records
    let r; try { r = await liveAct(ctx, ag.kind, op, x.args, memo); } catch (e) { r = { err: LIVE[ag.kind].name + ': ' + e.message }; }
    results.push({ aid: ag.id, ag: ag.name, live: LIVE[ag.kind].name, t: r.t || '', sub: r.sub || '', err: r.err || '', link: r.link || '', open: r.open || '', copy: r.copy || null });
    rest = rest.replace(x.raw, '');
  }
  await ctx.save();
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), acts: results };
}
