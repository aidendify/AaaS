// Live data from the apps a customer connected (Plugins → Connectors).
// For each question, the readers below call the connected apps' official APIs with that customer's own
// access, and turn what they find into numbered sources the agents cite. Read-only: nothing is changed in the apps.
import { connectorCredentials, connectedList } from './connectors.js';
import { composioRead } from './composio.js';

const STOP = new Set('the a an and or of to in on for with is are was were be been it its this that these those what which who whom how why when where my me i you your our we us do does did can could should would will shall about from as at by any all some have has had not no yes please give show tell list get find there their them they than then so if but just also into out up over more most much many very each per latest recent last new today tomorrow week month summarize summary check see look'.split(' '));
const words = (q) => [...new Set((String(q).toLowerCase().match(/[a-z0-9@._-]{2,}/g) || []).filter((w) => !STOP.has(w)))];
const has = (q, re) => re.test(String(q).toLowerCase());
const clip = (s, n = 600) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const day = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function getJSON(url, opts = {}, ms = 7000) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) { const e = new Error(j.error?.message || j.error_description || (typeof j.error === 'string' ? j.error : '') || j.message || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(timer); }
}
const bearer = (t, extra = {}) => ({ headers: { Authorization: 'Bearer ' + t, Accept: 'application/json', ...extra } });

// which apps to ask, for a given question (an app named in the question is always asked)
const TOPIC = {
  gmail: /\b(e-?mails?|mails?|inbox|gmail|unread|sender|replied|reply|thread)\b/,
  outlook: /\b(e-?mails?|mails?|inbox|outlook|unread|sender|reply)\b/,
  m365: /\b(e-?mails?|mails?|inbox|outlook|sharepoint|onedrive|files?|docs?)\b/,
  gcal: /\b(calendar|meetings?|events?|schedule|agenda|today|tomorrow|this week|free time|busy|appointments?)\b/,
  gdrive: /\b(drive|files?|docs?|documents?|sheets?|spreadsheets?|slides?|pdfs?|folders?)\b/,
  github: /\b(github|repos?|repositor(y|ies)|pull requests?|prs?|issues?|commits?|code|branch(es)?)\b/,
  slack: /\b(slack|channels?|messages?|dms?|said|mentioned|team chat)\b/,
  notion: /\b(notion|pages?|wiki|notes?|docs?|database)\b/,
  stripe: /\b(stripe|payments?|charges?|revenue|balance|payouts?|refunds?|invoices?|paid|sales)\b/,
  box: /\b(box|files?|docs?|documents?|folders?)\b/,
  twilio: /\b(twilio|sms|texts?|text messages?)\b/,
  hubspot: /\b(hubspot|crm|contacts?|leads?|deals?|customers?|prospects?)\b/,
};
const NAME = { gmail: 'Gmail', outlook: 'Outlook', m365: 'Microsoft 365', gcal: 'Google Calendar', gdrive: 'Google Drive', github: 'GitHub', slack: 'Slack', notion: 'Notion', stripe: 'Stripe', box: 'Box', twilio: 'Twilio', hubspot: 'HubSpot' };
export const LIVE_READERS = Object.keys(NAME);

export const READERS = {
  async gmail(cr, q) {
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages', kw = words(q).filter((w) => !TOPIC.gmail.test(w));
    const unread = has(q, /\bunread\b/), fromM = String(q).match(/\bfrom\s+([\w.@-]+)/i);
    const qs = [unread ? 'is:unread' : '', fromM ? 'from:' + fromM[1] : '', kw.length && !unread && !fromM ? kw.slice(0, 4).join(' ') : '', 'newer_than:30d'].filter(Boolean).join(' ');
    let list = await getJSON(`${base}?maxResults=8&q=${encodeURIComponent(qs)}`, bearer(cr.access_token));
    if (!(list.messages || []).length && kw.length) list = await getJSON(`${base}?maxResults=8&q=newer_than:14d`, bearer(cr.access_token));
    const out = [];
    for (const m of (list.messages || []).slice(0, 8)) {
      const d = await getJSON(`${base}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, bearer(cr.access_token));
      const h = Object.fromEntries((d.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      out.push({ title: h.subject || '(no subject)', at: Number(d.internalDate) || null, text: `Email from ${h.from || 'unknown'} on ${h.date || ''}${(d.labelIds || []).includes('UNREAD') ? ' (unread)' : ''}. Subject: ${h.subject || ''}. Preview: ${clip(d.snippet, 400)}`, url: `https://mail.google.com/mail/u/0/#all/${m.id}` });
    }
    return out;
  },
  async gcal(cr, q) {
    const now = new Date(), from = has(q, /\btomorrow\b/) ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) : now;
    const to = new Date(from.getTime() + (has(q, /\b(today|tomorrow)\b/) ? 1 : 7) * 864e5);
    const j = await getJSON(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`, bearer(cr.access_token));
    return (j.items || []).map((e) => { const st = e.start?.dateTime || e.start?.date; return { title: e.summary || '(no title)', at: Date.parse(st) || null,
      text: `Calendar event "${e.summary || ''}" ${e.start?.dateTime ? 'at ' + day(st) : 'on ' + st}${e.end?.dateTime ? ' until ' + day(e.end.dateTime) : ''}${e.location ? ', location: ' + e.location : ''}${(e.attendees || []).length ? ', with ' + e.attendees.slice(0, 8).map((a) => a.email).join(', ') : ''}.${e.description ? ' Notes: ' + clip(e.description, 300) : ''}`, url: e.htmlLink }; });
  },
  async gdrive(cr, q) {
    const kw = words(q).filter((w) => !TOPIC.gdrive.test(w)).slice(0, 3), esc = (s) => s.replace(/['\\]/g, '');
    const query = kw.length ? kw.map((w) => `fullText contains '${esc(w)}'`).join(' and ') + ' and trashed=false' : 'trashed=false';
    const order = kw.length ? '' : '&orderBy=modifiedTime desc';
    const j = await getJSON(`https://www.googleapis.com/drive/v3/files?pageSize=8${order}&q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))`, bearer(cr.access_token));
    return (j.files || []).map((f) => ({ title: f.name, at: Date.parse(f.modifiedTime) || null, text: `Drive file "${f.name}" (${String(f.mimeType || '').split('.').pop()}), last modified ${day(f.modifiedTime)}${f.owners?.[0] ? ' by ' + f.owners[0].displayName : ''}.`, url: f.webViewLink }));
  },
  async outlook(cr, q) {
    const kw = words(q).filter((w) => !TOPIC.outlook.test(w)).slice(0, 4);
    const url = kw.length ? `https://graph.microsoft.com/v1.0/me/messages?$top=8&$search="${encodeURIComponent(kw.join(' '))}"&$select=subject,from,receivedDateTime,bodyPreview,webLink,isRead`
      : `https://graph.microsoft.com/v1.0/me/messages?$top=8&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview,webLink,isRead${has(q, /\bunread\b/) ? '&$filter=isRead eq false' : ''}`;
    const j = await getJSON(url, bearer(cr.access_token));
    const mail = (j.value || []).map((m) => ({ title: m.subject || '(no subject)', at: Date.parse(m.receivedDateTime) || null, text: `Email from ${m.from?.emailAddress?.name || ''} <${m.from?.emailAddress?.address || ''}> on ${day(m.receivedDateTime)}${m.isRead ? '' : ' (unread)'}. Subject: ${m.subject || ''}. Preview: ${clip(m.bodyPreview, 400)}`, url: m.webLink }));
    if (!has(q, TOPIC.gcal)) return mail;
    const s = new Date(), e = new Date(s.getTime() + 7 * 864e5);
    const ev = await getJSON(`https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${s.toISOString()}&endDateTime=${e.toISOString()}&$top=15&$orderby=start/dateTime&$select=subject,start,end,location,organizer,webLink`, bearer(cr.access_token, { Prefer: 'outlook.timezone="UTC"' }));
    return mail.concat((ev.value || []).map((x) => ({ title: x.subject || '(no title)', at: Date.parse(x.start?.dateTime + 'Z') || null, text: `Calendar event "${x.subject || ''}" at ${day(x.start?.dateTime + 'Z')} until ${day(x.end?.dateTime + 'Z')}${x.location?.displayName ? ', location: ' + x.location.displayName : ''}, organizer ${x.organizer?.emailAddress?.name || ''}.`, url: x.webLink })));
  },
  async m365(cr, q) { return READERS.outlook(cr, q); },
  async github(cr, q) {
    const H = bearer(cr.access_token, { Accept: 'application/vnd.github+json', 'User-Agent': 'AIdentify', 'X-GitHub-Api-Version': '2022-11-28' });
    const kw = words(q).filter((w) => !TOPIC.github.test(w)).slice(0, 4);
    const type = has(q, /\b(issues?)\b/) && !has(q, /\b(prs?|pull)\b/) ? ' is:issue' : has(q, /\b(prs?|pull)\b/) ? ' is:pr' : '';
    const j = await getJSON(`https://api.github.com/search/issues?per_page=8&sort=updated&q=${encodeURIComponent('involves:@me' + type + (has(q, /\b(open|pending|review)\b/) ? ' is:open' : '') + (kw.length ? ' ' + kw.join(' ') : ''))}`, H);
    const out = (j.items || []).map((i) => ({ title: i.title, at: Date.parse(i.updated_at) || null, text: `${i.pull_request ? 'Pull request' : 'Issue'} #${i.number} "${i.title}" in ${String(i.repository_url || '').split('/repos/')[1] || ''}, ${i.state}, by ${i.user?.login || ''}, updated ${day(i.updated_at)}, ${i.comments} comments.${i.body ? ' ' + clip(i.body, 300) : ''}`, url: i.html_url }));
    if (out.length < 3 || has(q, /\brepos?|repositor/)) {
      const r = await getJSON('https://api.github.com/user/repos?sort=pushed&per_page=6', H);
      out.push(...(Array.isArray(r) ? r : []).map((x) => ({ title: x.full_name, at: Date.parse(x.pushed_at) || null, text: `Repository ${x.full_name}${x.private ? ' (private)' : ''}: ${x.description || 'no description'}. Last push ${day(x.pushed_at)}, ${x.open_issues_count} open issues, default branch ${x.default_branch}.`, url: x.html_url })));
    }
    return out;
  },
  async slack(cr, q) {
    const t = cr.authed_user?.access_token || cr.access_token, kw = words(q).filter((w) => !TOPIC.slack.test(w)).slice(0, 4);
    if (!kw.length) return [];
    const j = await getJSON(`https://slack.com/api/search.messages?count=8&sort=timestamp&query=${encodeURIComponent(kw.join(' '))}`, bearer(t));
    return (j.messages?.matches || []).map((m) => ({ title: '#' + (m.channel?.name || 'direct message'), at: Math.round(Number(m.ts) * 1000) || null, text: `Slack message by ${m.username || m.user || ''} in #${m.channel?.name || 'DM'} on ${day(Number(m.ts) * 1000)}: ${clip(m.text, 500)}`, url: m.permalink }));
  },
  async notion(cr, q) {
    const H = { headers: { Authorization: 'Bearer ' + cr.access_token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } };
    const kw = words(q).filter((w) => !TOPIC.notion.test(w)).slice(0, 4).join(' ');
    const j = await getJSON('https://api.notion.com/v1/search', { method: 'POST', ...H, body: JSON.stringify({ query: kw, page_size: 6, sort: { direction: 'descending', timestamp: 'last_edited_time' } }) });
    const out = [];
    for (const r of (j.results || []).slice(0, 6)) {
      const tp = Object.values(r.properties || {}).find((p) => p.type === 'title');
      const title = (tp?.title || r.title || []).map((x) => x.plain_text).join('') || 'Untitled';
      let body = '';
      if (r.object === 'page' && out.length < 3) {
        try { const b = await getJSON(`https://api.notion.com/v1/blocks/${r.id}/children?page_size=30`, H); body = (b.results || []).map((x) => (x[x.type]?.rich_text || []).map((y) => y.plain_text).join('')).filter(Boolean).join(' '); } catch {}
      }
      out.push({ title, at: Date.parse(r.last_edited_time) || null, text: `Notion ${r.object} "${title}", last edited ${day(r.last_edited_time)}.${body ? ' Content: ' + clip(body, 700) : ''}`, url: r.url });
    }
    return out;
  },
  async stripe(cr) {
    const H = bearer(cr.key), out = [], amt = (a, c) => (a / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' ' + String(c || '').toUpperCase();
    try { const b = await getJSON('https://api.stripe.com/v1/balance', H); out.push({ title: 'Stripe balance', at: Date.now(), text: `Stripe balance right now — available: ${(b.available || []).map((x) => amt(x.amount, x.currency)).join(', ') || '0'}; pending: ${(b.pending || []).map((x) => amt(x.amount, x.currency)).join(', ') || '0'}.${cr.key.includes('_test_') ? ' (test mode)' : ''}` }); } catch (e) { if (e.status !== 403) throw e; }
    try { const c = await getJSON('https://api.stripe.com/v1/charges?limit=10', H);
      out.push(...(c.data || []).map((x) => ({ title: 'Payment ' + amt(x.amount, x.currency), at: x.created * 1000, text: `Stripe payment of ${amt(x.amount, x.currency)} on ${day(x.created * 1000)}, status ${x.status}${x.refunded ? ' (refunded)' : ''}${x.billing_details?.email ? ', customer ' + x.billing_details.email : ''}${x.description ? ', "' + clip(x.description, 120) + '"' : ''}.`, url: `https://dashboard.stripe.com/${cr.key.includes('_test_') ? 'test/' : ''}payments/${x.payment_intent || x.id}` }))); } catch (e) { if (e.status !== 403) throw e; }
    return out;
  },
  async box(cr, q) {
    const kw = words(q).filter((w) => !TOPIC.box.test(w)).slice(0, 4).join(' ');
    if (!kw) return [];
    const j = await getJSON(`https://api.box.com/2.0/search?limit=8&query=${encodeURIComponent(kw)}&fields=name,type,modified_at,description,parent`, bearer(cr.access_token));
    return (j.entries || []).map((f) => ({ title: f.name, at: Date.parse(f.modified_at) || null, text: `Box ${f.type} "${f.name}"${f.parent?.name ? ' in folder ' + f.parent.name : ''}, modified ${day(f.modified_at)}.${f.description ? ' ' + clip(f.description, 200) : ''}`, url: `https://app.box.com/${f.type === 'folder' ? 'folder' : 'file'}/${f.id}` }));
  },
  async twilio(cr) {
    const j = await getJSON(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cr.sid)}/Messages.json?PageSize=10`, { headers: { Authorization: 'Basic ' + Buffer.from(cr.sid + ':' + cr.token).toString('base64') } });
    return (j.messages || []).map((m) => ({ title: `SMS ${m.direction?.startsWith('inbound') ? 'from ' + m.from : 'to ' + m.to}`, at: Date.parse(m.date_sent || m.date_created) || null, text: `${m.direction?.startsWith('inbound') ? 'Received SMS from ' + m.from : 'Sent SMS to ' + m.to} on ${day(m.date_sent || m.date_created)}, status ${m.status}: ${clip(m.body, 300)}` }));
  },
  async hubspot(cr, q) {
    const H = { headers: { Authorization: 'Bearer ' + cr.access_token, 'Content-Type': 'application/json' } }, kw = words(q).filter((w) => !TOPIC.hubspot.test(w)).slice(0, 3).join(' ');
    const props = ['firstname', 'lastname', 'email', 'company', 'lifecyclestage', 'lastmodifieddate'];
    const j = kw ? await getJSON('https://api.hubapi.com/crm/v3/objects/contacts/search', { method: 'POST', ...H, body: JSON.stringify({ query: kw, limit: 8, properties: props }) })
      : await getJSON(`https://api.hubapi.com/crm/v3/objects/contacts?limit=8&properties=${props.join(',')}`, H);
    return (j.results || []).map((c) => { const p = c.properties || {}, n = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || 'Contact';
      return { title: n, at: Date.parse(p.lastmodifieddate || c.updatedAt) || null, text: `HubSpot contact ${n}${p.email ? ' <' + p.email + '>' : ''}${p.company ? ', company ' + p.company : ''}${p.lifecyclestage ? ', stage ' + p.lifecyclestage : ''}, updated ${day(p.lastmodifieddate || c.updatedAt)}.` }; });
  },
};

// Live sources for one question. Returns { sources, used, errors } — sources look like agent sources (agent/kind/title/at/text).
// names for connectors that only Composio reads
const NAME2 = { gsheets: 'Google Sheets', teams: 'Microsoft Teams', dropbox: 'Dropbox', zoom: 'Zoom', salesforce: 'Salesforce', asana: 'Asana', jira: 'Jira', confluence: 'Confluence', linear: 'Linear', figma: 'Figma', canva: 'Canva', calendly: 'Calendly', airtable: 'Airtable', quickbooks: 'QuickBooks', mailchimp: 'Mailchimp', xero: 'Xero', docusign: 'DocuSign', zendesk: 'Zendesk', shopify: 'Shopify', intercom: 'Intercom', trello: 'Trello', wix: 'Wix', vercel: 'Vercel' };
const nameOf = (id) => NAME[id] || NAME2[id] || id;
const TOPIC2 = { gsheets: /\b(sheets?|spreadsheets?)\b/, jira: /\b(jira|tickets?|issues?|sprint)\b/, linear: /\b(linear|issues?)\b/, asana: /\b(asana|tasks?|projects?)\b/, trello: /\b(trello|cards?|boards?)\b/, salesforce: /\b(salesforce|crm|leads?|opportunit(y|ies)|accounts?)\b/, zendesk: /\b(zendesk|tickets?|support)\b/, intercom: /\b(intercom|conversations?|support)\b/, calendly: /\b(calendly|bookings?|meetings?)\b/, zoom: /\b(zoom|meetings?|recordings?)\b/, shopify: /\b(shopify|orders?|products?|store)\b/, quickbooks: /\b(quickbooks|invoices?|bills?)\b/, xero: /\b(xero|invoices?)\b/, airtable: /\b(airtable|records?|bases?)\b/, confluence: /\b(confluence|wiki|pages?)\b/, dropbox: /\b(dropbox|files?)\b/, docusign: /\b(docusign|signatures?|envelopes?)\b/, mailchimp: /\b(mailchimp|campaigns?|audience)\b/ };

// turn whatever a Composio tool returned into a few readable source rows
function rowsFromData(data) {
  let arr = null;
  const find = (o, d) => { if (arr || !o || typeof o !== 'object' || d > 4) return; if (Array.isArray(o)) { if (o.length && typeof o[0] === 'object') arr = o; else o.forEach((x) => find(x, d + 1)); return; } Object.values(o).forEach((x) => find(x, d + 1)); };
  find(data, 0);
  const flatTxt = (o) => Object.entries(o || {}).filter(([k, v]) => (typeof v === 'string' || typeof v === 'number') && String(v).length < 500 && !/token|secret|password|^id$|thread_?id|label/i.test(k)).slice(0, 12).map(([k, v]) => k + ': ' + v).join('; ');
  if (arr) return arr.slice(0, 8).map((o) => {
    const title = o.subject || o.title || o.summary || o.name || o.messageText?.slice?.(0, 60) || o.text?.slice?.(0, 60) || o.id || 'Item';
    const when = o.messageTimestamp || o.internalDate || o.updated_at || o.updatedAt || o.created_at || o.createdAt || o.modifiedTime || o.start?.dateTime || o.date;
    const at = when ? (isNaN(Number(when)) ? Date.parse(when) : Number(when) < 1e12 ? Number(when) * 1000 : Number(when)) || null : null;
    const url = [o.html_url, o.url, o.webViewLink, o.htmlLink, o.permalink, o.webLink, o.link].find((u) => typeof u === 'string' && /^https:\/\//.test(u)) || '';
    return { title: String(title), at, url, text: clip(flatTxt(o) || JSON.stringify(o), 700) };
  });
  return [{ title: 'Result', at: Date.now(), url: '', text: clip(JSON.stringify(data), 1500) }];
}

// Live sources for one question. Returns { sources, used, errors, connected } — sources look like agent sources (agent/kind/title/at/text).
export async function liveSources(st, email, q, secret, { limit = 10 } = {}) {
  const conns = (await connectedList(st, email)).filter((c) => READERS[c.id] || c.via === 'composio' || c.via === 'smtp');
  const ql = String(q).toLowerCase();
  const named = conns.filter((c) => new RegExp('\\b' + nameOf(c.id).toLowerCase().split(' ').pop().replace(/[^a-z0-9]/g, '') + '\\b').test(ql)).map((c) => c.id);
  const topic = (id) => (TOPIC[id] || TOPIC2[id] || /$^/).test(ql);
  const pick = conns.filter((c) => named.includes(c.id) || topic(c.id) || (!named.length && words(q).length && ['slack', 'notion', 'box', 'gdrive'].includes(c.id)));
  const used = [], errors = [], sources = [];
  await Promise.all(pick.map(async ({ id, via }) => {
    try {
      const cr = await connectorCredentials(st, email, id, secret);
      let rows;
      if (via === 'composio' || cr.via === 'composio') rows = rowsFromData((await composioRead({ id, ca: cr.ca, email, q })).data);
      else if (cr.via === 'smtp') rows = await (await import('./mailer.js')).imapRecent(cr, q); // Gmail connected with an app password: read it over IMAP
      else rows = await READERS[id](cr, q);
      used.push(id);
      for (const r of rows.slice(0, 8)) sources.push({ agent: nameOf(id), kind: 'Live · ' + nameOf(id), title: clip(r.title, 120), at: r.at, text: r.text + (r.url ? `\nLink: ${r.url}` : ''), url: r.url || '', live: true });
    } catch (e) {
      errors.push({ id, name: nameOf(id), error: e.status === 401 ? 'access expired — reconnect it in Plugins' : clip(e.message, 120) });
    }
  }));
  sources.sort((a, b) => (b.at || 0) - (a.at || 0));
  // keep a fair mix when several apps answered
  const per = {}, out = [];
  for (const s of sources) { if ((per[s.agent] = (per[s.agent] || 0) + 1) <= Math.max(3, Math.ceil(limit / Math.max(1, used.length)))) out.push(s); if (out.length >= limit) break; }
  return { sources: out, used: used.map(nameOf), errors, connected: conns.map((c) => nameOf(c.id)) };
}
