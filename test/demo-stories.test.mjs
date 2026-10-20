// One real-server walkthrough per demo story. Writes docs/demo-scripts-check.md.
// This file does not record video.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.mjs';
import { eveningBeforeAt } from '../lib/workflows.js';
import { todayAt } from '../lib/frontdesk.js';
import { slackSignature } from '../lib/freech.js';

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/demo-scripts-check.md');
const PW = 'Story-pass-123!';
const CRON = 'c'.repeat(32);
const ENV = { RATE_LIMIT: 'off', AI_PROVIDER: 'mock', AI_MOCK: 'on', CHANNELS_MOCK: 'on', CRON_SECRET: CRON, APP_TIMEZONE: 'Asia/Kolkata', DEMO_SEED: '1' };
const DAY = 864e5;
const reports = [];
let tail = Promise.resolve();

function lock() {
  let release;
  const prev = tail;
  tail = new Promise((r) => { release = r; });
  return prev.then(() => release);
}
function check(steps, title, pass, evidence, required = true) {
  steps.push({ title, result: pass ? 'PASS' : 'FAIL', evidence: String(evidence || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 420) });
  if (required && !pass) {
    const err = new Error(title + ': ' + evidence);
    err.recorded = true;
    throw err;
  }
}
function story(id, title, fn) {
  test(id, { timeout: 180000 }, async () => {
    const release = await lock();
    const steps = [];
    let failed = null;
    try { await fn(steps); }
    catch (e) {
      failed = e;
      if (!e.recorded) steps.push({ title: 'Stopped', result: 'FAIL', evidence: String(e.message || e).slice(0, 300) });
    } finally {
      reports.push({ id, title, steps });
      release();
    }
    if (failed) throw failed;
  });
}
async function req(s, method, p, body, token, headers = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch { d = { raw: text.slice(0, 240) }; }
  return { status: r.status, d, text };
}
const zParts = (ms, tz = 'Asia/Kolkata') => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit',
}).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
function plusDays(ms, n, tz = 'Asia/Kolkata') {
  const p = zParts(ms, tz);
  const t = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function bookNumber(text, day, month) {
  const want = String(day).padStart(2, '0') + ' ' + String(month).padStart(2, '0');
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\d+)\.\s/);
    if (m && line.includes(want)) return Number(m[1]);
  }
  return 0;
}
function mondayForReview(now = Date.now()) {
  let monday = Date.UTC(new Date(now - 8 * DAY).getUTCFullYear(), new Date(now - 8 * DAY).getUTCMonth(), new Date(now - 8 * DAY).getUTCDate(), 15);
  while (new Date(monday).getUTCDay() !== 1) monday -= DAY;
  if (now - monday > 13 * DAY) monday += 7 * DAY;
  return monday;
}
async function signup(s, email, name) {
  const out = await req(s, 'POST', '/api/auth/signup', { email, name, password: PW });
  assert.equal(out.status, 200, JSON.stringify(out.d));
  return out.d.token;
}
async function history(s, token, visitor) {
  const r = await fetch(s.base + '/c/' + token + '/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor }) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}
async function say(s, token, text, visitor) {
  const r = await fetch(s.base + '/c/' + token + '/message', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, visitor }),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}
const blob = (a) => [a && a.summary, a && a.body, a && a.request, a && a.subject, a && a.text].filter(Boolean).join('\n');
async function pending(s, token) {
  return (await req(s, 'GET', '/api/agents/approvals?status=pending&limit=100', undefined, token)).d.items || [];
}
async function approveWhere(s, token, re) {
  const items = await pending(s, token);
  const item = items.find((a) => re.test(blob(a)));
  if (!item) return null;
  const res = await req(s, 'POST', '/api/agents/approval', { id: item.id, decision: 'approve', edit: {} }, token);
  return { item, res };
}
function tick(s, now) {
  return req(s, 'GET', '/api/cron/tick', undefined, undefined, { authorization: 'Bearer ' + CRON, ...(now ? { 'x-test-now': String(now) } : {}) });
}
async function openDesk(s, token, { faqs = [], by_day, calendar = false } = {}) {
  const saved = await req(s, 'POST', '/api/frontdesk', { enabled: true, auto: 'needs_approval', faqs }, token);
  assert.equal(saved.status, 200, JSON.stringify(saved.d));
  const hours = await req(s, 'POST', '/api/frontdesk/availability', { timezone: 'Asia/Kolkata', slot_minutes: 30, by_day, calendar: calendar ? 'mock' : '' }, token);
  assert.equal(hours.status, 200, JSON.stringify(hours.d));
  const widget = await req(s, 'POST', '/api/frontdesk/widget', {}, token);
  assert.equal(widget.status, 200, JSON.stringify(widget.d && widget.d.widget && widget.d.widget.token ? { ok: true } : widget.d));
  return { hours: hours.d, widget: widget.d.widget.token };
}
const allWeek = (start, end) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { start, end }]));

story('clinic laser Saturday', 'Clinic · Saturday laser', async (steps) => {
  const s = await startServer(ENV);
  try {
    const token = await signup(s, 'anika.deshmukh@glow-atelier.example', 'Anika Deshmukh');
    await req(s, 'POST', '/api/profile', { name: 'Glow Atelier', location: 'Hyderabad', about: 'A fictional skin studio. Laser sessions are by appointment.', offer: 'Laser sessions' }, token);
    const chief = await req(s, 'POST', '/api/workplace/chat', { message: 'Answer Saturday laser questions with the price, offer a slot, and wait for my approval.' }, token);
    check(steps, 'Chief answers the goal in plain English', chief.status === 200 && chief.d && chief.d.answer && !/\[mock/.test(chief.d.answer) && /approval/i.test(chief.d.answer), 'The Chief reply is a sentence about approval and does not contain a [mock] line.');

    const page = await (await fetch(s.base + '/')).text();
    const empty = await req(s, 'POST', '/api/frontdesk/availability', { by_day: {} }, token);
    const uiOk = page.includes('name="open"') && page.includes('fd-days') && page.includes("['Sat',6]") && page.includes('id="fdListNew"') && page.includes('Import CSV') && page.includes('by_day');
    check(steps, 'Weekday hours picker is on Front desk', uiOk && empty.status === 400 && /at least one open day/i.test(empty.d.message || ''), 'The served page builds a checkbox and time for each day, including Saturday, and posts by_day. An empty week is rejected.');

    const desk = await openDesk(s, token, {
      faqs: [{ q: 'Is Saturday free for laser', a: 'A full-face laser session is ₹4,500. A patch test is ₹500.' }],
      by_day: { 6: { start: '11:00', end: '13:00' }, 1: { start: '10:00', end: '12:00' } },
      calendar: true,
    });
    const monday = await say(s, desk.widget, 'Is Monday free?', 'clinicmon1');
    const monItem = (await pending(s, token)).find((a) => /Monday is open/.test(blob(a)));
    const tuesday = await say(s, desk.widget, 'Is Tuesday free?', 'clinictue1');
    const tueItem = (await pending(s, token)).find((a) => /Tuesday is closed/.test(blob(a)));
    check(steps, 'Different hours per day are used in replies', !!(monItem && /10:00 to 12:00/.test(blob(monItem)) && /Mon /.test(blob(monItem)) && tueItem && !/person from the team/.test(blob(tueItem))), 'Monday is offered 10:00–12:00. Tuesday is closed, in those words.');

    const asked = await say(s, desk.widget, 'Is Saturday free for laser?', 'clinicvis01');
    const hold = (await pending(s, token)).find((a) => /Saturday is open from 11:00 to 13:00/.test(blob(a)) && /₹4,500/.test(blob(a)));
    const bookingsBefore = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    const thread = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'clinicvis01');
    const draftBody = ((thread && thread.messages) || []).filter((m) => m.dir === 'out' && m.status === 'draft').map((m) => m.body || '').join('\n');
    const sentBefore = thread && (thread.messages || []).some((m) => m.dir === 'out' && m.status === 'sent');
    check(steps, 'Saturday laser question is drafted with Saturday slots', asked.status === 200 && !!hold && hold.status === 'pending' && /book 1/.test(draftBody) && /Sat /.test(draftBody) && !/Mon /.test(draftBody) && bookingsBefore.length === 0 && !sentBefore, 'The draft has the price, Saturday 11:00–13:00, and Saturday times. Nothing is booked or sent.');

    const script = await (await fetch(s.base + '/c/' + desk.widget + '.js')).text();
    const at = todayAt(22, 47, 'Asia/Kolkata');
    const seeded = await req(s, 'POST', '/api/frontdesk/demo-message', { visitor: 'clinicclock1', text: 'Is Saturday free for laser?', at }, token);
    const seededHist = await history(s, desk.widget, 'clinicclock1');
    const seededIn = (seededHist.d.messages || []).find((m) => m.dir === 'in');
    const spoofAt = Date.now() - 5 * DAY;
    const spoof = await fetch(s.base + '/c/' + desk.widget + '/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello there', visitor: 'clinicspoof1', createdAt: spoofAt, at: spoofAt }) });
    const spoofJson = await spoof.json().catch(() => ({}));
    const spoofIn = (spoofJson.messages || []).find((m) => m.dir === 'in');
    const clockReal = seeded.status === 200 && seeded.d.time === '10:47pm' && seededIn && seededIn.at === at && seededIn.time === '10:47pm' && script.includes('m.time') && spoofIn && spoofIn.at !== spoofAt && Math.abs(spoofIn.at - Date.now()) < 120000;
    check(steps, 'Widget shows 10:47pm', clockReal, clockReal ? 'A demo-seeded message at 22:47 Asia/Kolkata is shown as 10:47pm. The public widget ignores a createdAt in the body.' : 'Seed status ' + seeded.status + ', shown ' + (seededIn && seededIn.time) + ', spoof at ' + (spoofIn && spoofIn.at) + '.');

    const approved = hold
      ? { item: hold, res: await req(s, 'POST', '/api/agents/approval', { id: hold.id, decision: 'approve', edit: {} }, token) }
      : null;
    const opened = await history(s, desk.widget, 'clinicvis01');
    const other = await history(s, desk.widget, 'clinicother1');
    const scriptFetchesOnLoad = script.includes('/history') && script.indexOf('fetch(') < script.indexOf('form.onsubmit');
    const sawApprovedOnOpen = (opened.d.messages || []).some((m) => m.dir === 'out' && /₹4,500|Saturday is open/.test(m.body || ''));
    const draftsHidden = !(opened.d.messages || []).some((m) => m.status === 'draft');
    check(steps, 'Opening the chat shows the approved reply', opened.status === 200 && scriptFetchesOnLoad && sawApprovedOnOpen && draftsHidden && (other.d.messages || []).length === 0, sawApprovedOnOpen ? 'Opening the chat fetches this visitor’s history, including the approved Saturday reply. Another visitor’s history is empty. Drafts stay hidden.' : 'History did not include the approved reply.');

    const next = await say(s, desk.widget, 'thanks', 'clinicvis01');
    const sawApproved = (next.d.messages || []).some((m) => m.dir === 'out' && /₹4,500|Saturday is open/.test(m.body || ''));
    check(steps, 'The approved reply is delivered, and booking still needs a second approval', approved && approved.res.status === 200 && /Sent/.test(approved.res.d.approval.result || '') && sawApproved, 'Approve with an empty edit delivers the Saturday reply. It is visible on the visitor’s next message.');

    const picked = await say(s, desk.widget, 'book 1', 'clinicvis01');
    const confirm = (await pending(s, token)).find((a) => /Booked for/.test(blob(a)));
    const notYet = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    check(steps, 'The first slot is a second draft', picked.status === 200 && !!confirm && notYet.length === 0, 'book 1 drafts a confirmation. The appointment is not stored yet.');

    const compiled = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, whatsapp them and remind me the evening before' }, token);
    const wf = compiled.d.workflow;
    const eveningStep = wf && (wf.steps || []).find((st) => st.when === 'evening_before');
    await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, token);
    const booked = await approveWhere(s, token, /Booked for/);
    const stored = ((await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [])[0];
    check(steps, 'The appointment is stored only after the confirmation is approved', booked && booked.res.status === 200 && stored && stored.status === 'booked' && /^mock-gcal-/.test(stored.event_id || ''), 'The booking appears after Approve, with a mock calendar id.');

    const runsBefore = (await req(s, 'GET', '/api/workflows/' + wf.id, undefined, token)).d.runs || [];
    const armed = runsBefore.find((r) => r.event === 'evening_before');
    const expectDue = stored ? eveningBeforeAt(stored.start, 'Asia/Kolkata', 18, 0) : 0;
    let early = [];
    if (expectDue - 3600e3 > Date.now() + 5000) {
      await tick(s, expectDue - 3600e3);
      early = await pending(s, token);
    }
    await tick(s, expectDue > Date.now() ? expectDue : undefined);
    const late = await pending(s, token);
    const reminder = late.find((a) => a.kind === 'webchat' && /Reminder/.test(blob(a)) && /Sat /.test(blob(a)));
    const threadAfter = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'clinicvis01');
    const reminderSent = threadAfter && (threadAfter.messages || []).some((m) => /appointment/.test(m.body || '') && m.status === 'sent');
    check(steps, 'Evening-before reminder is drafted at 18:00 the day before', compiled.status === 200 && wf.trigger.type === 'lead.created' && eveningStep && eveningStep.hour === 18 && eveningStep.autonomy === 'needs_approval' && armed && armed.due === expectDue && !early.some((a) => /Reminder/.test(blob(a))) && !!reminder && reminder.status === 'pending' && !reminderSent, 'The run is due at 18:00 the day before. An earlier tick does not draft it. The tick at that time drafts a web chat reminder and does not send it.');
  } finally { await s.stop(); }
});

story('coach fees and follow-up', 'Coach · Fees, discovery call, follow-up', async (steps) => {
  const s = await startServer(ENV);
  try {
    const token = await signup(s, 'ravi.menon@northstar-coach.example', 'Ravi Menon');
    await req(s, 'POST', '/api/profile', { name: 'Northstar Coaching', location: 'Bengaluru', about: 'A fictional coach for consultants.', offer: 'A discovery call' }, token);
    await req(s, 'PUT', '/api/kv', { k: 'as_data:ravi.menon@northstar-coach.example', v: JSON.stringify({ agents: [], wp: { profile: { vertical: 'coach', verticalLabel: 'Coach / consultant', business: 'Northstar Coaching', city: 'Bengaluru' } }, rev: 0 }), at: Date.now() }, token);
    const tg = await req(s, 'POST', '/api/channels/telegram', { bot_token: 'mock_tg_coach_story', owner_user_id: '424242', customers: true }, token);
    const hook = (tg.d.telegram.webhook_url || '').split('/').pop();
    const secret = tg.d.telegram.secret_token;
    const body = JSON.stringify({ update_id: 51, message: { message_id: 51, from: { id: 424242, first_name: 'Ravi' }, chat: { id: 424242, type: 'private' }, text: 'Answer fee questions, qualify the lead, book a discovery call, and draft a follow-up if they go quiet. Wait for my approval.' } });
    const posted = await fetch(s.base + '/api/channels/telegram/webhook/' + hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body });
    const postedJson = await posted.json().catch(() => ({}));
    const mine = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.channel === 'telegram' && c.peer === '424242');
    const reply = mine && (mine.messages || []).find((m) => m.dir === 'out' && m.status === 'sent');
    check(steps, 'Telegram owner message reaches the Chief as a real sentence', tg.status === 200 && posted.status === 200 && postedJson.route === 'chief' && reply && !/\[mock/.test(reply.body) && /draft|approval|fee/i.test(reply.body), 'The owner chat is delivered. The reply is a canned sentence, not a [mock] line.');

    const desk = await openDesk(s, token, {
      faqs: [{ q: 'What are your fees', a: 'A discovery call is ₹3,000. The 6-week engagement is ₹24,000.' }],
      by_day: allWeek('10:00', '18:00'),
    });
    await say(s, desk.widget, 'What are your fees?', 'coachvis01');
    const fee = (await pending(s, token)).find((a) => /discovery call is ₹3,000/.test(blob(a)));
    const conv = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'coachvis01');
    check(steps, 'The fee answer is drafted and held', !!fee && fee.status === 'pending' && !(conv.messages || []).some((m) => m.status === 'sent' && m.dir === 'out'), '“What are your fees?” waits in Approvals.');
    const feeOk = await approveWhere(s, token, /discovery call is ₹3,000/);
    check(steps, 'Approving the fee delivers it and does not book a call', feeOk && /Sent/.test(feeOk.res.d.approval.result || '') && ((await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || []).length === 0, 'The fee reply is sent only after Approve. No appointment is stored.');

    const hello = await say(s, desk.widget, 'Hello', 'coachvis01');
    const helloThread = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'coachvis01');
    const helloBody = ((helloThread && helloThread.messages) || []).map((m) => m.body || '').join('\n');
    const coachQ = /your offer, your pipeline, or how you close clients/.test(helloBody);
    const genericQ = /ads, email, the website, or a retainer/.test(helloBody);
    check(steps, 'Qualify questions are specific to a coach', hello.status === 200 && coachQ && !genericQ, coachQ ? 'Hello drafts the coach question about the offer, the pipeline, or closing clients. It does not ask about ads, email, the website, or a retainer.' : 'Hello status ' + hello.status + '. The draft was: ' + helloBody.slice(0, 180));

    await say(s, desk.widget, 'I want help with email. Budget 20000. Email meera.shah@example.com', 'coachvis01');
    const leads = (await req(s, 'GET', '/api/leads?limit=20', undefined, token)).d.leads || [];
    const lead = leads.find((l) => l.email === 'meera.shah@example.com');
    check(steps, 'Interest, budget, and email are stored', !!lead && lead.interest === 'email' && String(lead.budget) === '20000', 'The contact keeps interest email, budget 20000, and the example.com address.');

    await approveWhere(s, token, /Want me to offer|offer a few call times|Noted: email/);
    await say(s, desk.widget, 'book a call', 'coachvis01');
    await approveWhere(s, token, /Here are open times/);
    await say(s, desk.widget, 'book 1', 'coachvis01');
    const before = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    const confirm = await approveWhere(s, token, /Booked for/);
    const after = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    check(steps, 'The discovery call is booked only after approval', before.length === 0 && confirm && after.length === 1 && after[0].status === 'booked', 'book 1 stays a draft. The booking exists after that confirmation is approved.');

    const made = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, draft a follow-up email, and remind me in 3 days if no reply' }, token);
    await req(s, 'POST', '/api/workflows/update', { id: made.d.workflow.id, status: 'enabled' }, token);
    await req(s, 'POST', '/api/leads', { name: 'Silent Lead', email: 'silent.lead@example.com', source: 'Website' }, token);
    await tick(s);
    const follow = await approveWhere(s, token, /Following up/);
    check(steps, 'A quiet-lead follow-up is drafted by the tick, and approving it does not send', made.status === 200 && follow && follow.item.kind === 'draft' && /Nothing was sent/.test(follow.res.d.approval.result || ''), 'The cron tick queues “Following up”. Approving that draft does not send it.');
  } finally { await s.stop(); }
});

story('broker 3BHK and Monday', 'Broker · 3BHK, site visit, Monday suggestion', async (steps) => {
  const s = await startServer(ENV);
  try {
    const token = await signup(s, 'meera.iyer@lakeview-homes.example', 'Meera Iyer');
    const other = await signup(s, 'other.agent@lakeview-homes.example', 'Other Agent');
    await req(s, 'POST', '/api/profile', { name: 'Lakeview Homes', location: 'Pune', about: 'A fictional brokerage.', offer: 'Site visits' }, token);
    const chief = await req(s, 'POST', '/api/workplace/chat', { message: 'When someone asks if the 3BHK is free, answer from the listing and book a Saturday site visit. Wait for my approval.' }, token);
    check(steps, 'Chief answers the listing goal in plain English', chief.status === 200 && chief.d.answer && !/\[mock/.test(chief.d.answer), 'The Chief reply is a sentence and does not contain a [mock] line.');

    const csv = 'title,type,location,price,status,notes\nLakeview Residency,3BHK,Pune,₹1.15 crore,available,1450 sq ft\n=cmd,2BHK,Pune,1,sold,formula\n';
    const imported = await req(s, 'POST', '/api/listings/import', { csv }, token);
    const rows = imported.d.listings || [];
    const home = rows.find((r) => r.title === 'Lakeview Residency');
    const formula = rows.find((r) => r.type === '2BHK');
    const edited = await req(s, 'POST', '/api/listings/update', { id: home.id, title: home.title, type: home.type, location: home.location, price: home.price, status: 'available', notes: 'Ground floor' }, token);
    const removed = await req(s, 'POST', '/api/listings/delete', { id: formula.id }, token);
    const hidden = await req(s, 'GET', '/api/listings', undefined, other);
    const stolen = await req(s, 'POST', '/api/listings/update', { id: home.id, title: 'Stolen', type: '3BHK' }, other);
    check(steps, 'Listings support add, edit, delete, and CSV import', imported.status === 200 && imported.d.imported === 2 && formula.title.startsWith("'=") && edited.d.listing.notes === 'Ground floor' && removed.status === 200 && (hidden.d.listings || []).length === 0 && stolen.status === 404, 'CSV import stored the 3BHK and kept a formula cell as text. Edit and delete work. The other account cannot see or change the row.');

    const desk = await openDesk(s, token, { by_day: { 6: { start: '11:00', end: '13:00' } }, calendar: true });
    await say(s, desk.widget, '3BHK still available?', 'brokervis01');
    const listed = (await pending(s, token)).find((a) => /Lakeview Residency/.test(blob(a)));
    const conv = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'brokervis01');
    check(steps, '“3BHK still available?” is answered from the listing and held', !!listed && /available/.test(blob(listed)) && !/Here are open times/.test(blob(listed)) && !(conv.messages || []).some((m) => m.dir === 'out' && m.status === 'sent'), 'The draft quotes Lakeview Residency and does not offer slots. Nothing is sent.');
    await approveWhere(s, token, /Lakeview Residency/);

    const leads = (await req(s, 'GET', '/api/leads?limit=20', undefined, token)).d.leads || [];
    const visitor = leads.find((l) => l.web_visitor === 'brokervis01');
    const thread = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'brokervis01');
    const askedName = ((thread && thread.messages) || []).some((m) => m.dir === 'out' && /your name/i.test(m.body || '') && /optional/i.test(m.body || ''));
    const introduced = await say(s, desk.widget, 'My name is Priya Shah. Phone 9845011122. Email priya.shah@example.com', 'brokervis01');
    const savedLead = ((await req(s, 'GET', '/api/leads?limit=20', undefined, token)).d.leads || []).find((l) => visitor && l.id === visitor.id);
    const savedName = !!(visitor && /website visitor/i.test(visitor.name || '') && askedName && introduced.status === 200 && savedLead && savedLead.name === 'Priya Shah' && String(savedLead.phone || '').includes('9845011122') && savedLead.email === 'priya.shah@example.com');
    check(steps, 'Website chat asks for a name', savedName, savedName ? 'The 3BHK reply asks for a name and says a phone or email is optional. “My name is Priya Shah…” saves Priya Shah, the phone, and the email.' : 'Lead ' + (visitor && visitor.name) + ', saved ' + (savedLead && savedLead.name) + ' ' + (savedLead && savedLead.phone) + ' ' + (savedLead && savedLead.email) + ', asked ' + askedName + '.');
    if (!visitor) throw new Error('Web chat lead missing');

    await say(s, desk.widget, 'Please book a Saturday site visit', 'brokervis01');
    const slots = (await pending(s, token)).find((a) => /Here are open times/.test(blob(a)) && /Saturday is open from 11:00 to 13:00/.test(blob(a)));
    check(steps, 'Saturday site-visit times are offered', !!slots && /Sat /.test(blob(slots)) && !/Mon /.test(blob(slots)), 'The visit draft offers Saturday 11:00–13:00 only.');
    await approveWhere(s, token, /Here are open times/);
    await say(s, desk.widget, 'book 1', 'brokervis01');
    const before = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    await approveWhere(s, token, /Booked for/);
    const afterBook = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    check(steps, 'The site visit is confirmed only after approval', before.length === 0 && afterBook.length === 1, 'The confirmation stays a draft until Approve.');

    const renamed = await req(s, 'PATCH', '/api/leads/' + visitor.id, { name: 'Ananya Rao' }, token);
    const timeline = await req(s, 'GET', '/api/leads/' + visitor.id + '/timeline', undefined, token);
    const call = (timeline.d.events || []).some((e) => /Call booked/.test(e.title || ''));
    check(steps, 'Owner sets Ananya Rao and the timeline shows the visit', renamed.status === 200 && renamed.d.lead.name === 'Ananya Rao' && call, 'The contact name is Ananya Rao. The timeline includes Call booked.');

    const mondayText = await seedMonday(s, token);
    const open = ((await req(s, 'GET', '/api/cos', undefined, token)).d.suggestions || []).filter((x) => x.status === 'open');
    const monday = open.find((x) => /Monday/i.test(x.text || mondayText || ''));
    const applied = monday && await req(s, 'POST', '/api/cos/suggestions/apply', { id: monday.id }, token);
    check(steps, 'Monday suggestion applies as a draft and does not send', !!monday && applied.status === 200 && applied.d.sent === false && applied.d.workflow && applied.d.workflow.status === 'draft', monday ? 'Apply saved a draft workflow. sent is false.' : 'No Monday suggestion was open.');
  } finally { await s.stop(); }
});

async function seedMonday(s, token) {
  const made = await req(s, 'POST', '/api/workflows/compile', { text: 'When a new lead comes in, send the welcome email' }, token);
  const wf = made.d.workflow;
  const step = (wf.steps || []).find((st) => st.type === 'send_email' || st.type === 'draft_email');
  await req(s, 'POST', '/api/workflows/update', { id: wf.id, step: { id: step.id, body: '<p>Hi {{first_name}}, see https://example.com/welcome</p>' } }, token);
  await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' }, token);
  const mondayAt = mondayForReview();
  const leads = [];
  for (let i = 0; i < 4; i++) leads.push((await req(s, 'POST', '/api/leads', { name: 'Monday Sample ' + (i + 1), email: 'mon' + i + '@lakeview.example', source: 'Website' }, token)).d.lead);
  await tick(s, mondayAt);
  for (const lead of leads) {
    let items = await pending(s, token);
    const ap = items.find((a) => Number(a.lead_id) === Number(lead.id) && a.kind === 'email');
    if (!ap) throw new Error('Missing Monday email draft');
    await req(s, 'POST', '/api/tracking/apply', { lead_id: lead.id, approval_id: ap.id }, token);
    items = await pending(s, token);
    const body = (items.find((a) => a.id === ap.id) || {}).body || '';
    const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
    if (!pixel) throw new Error('No open pixel on Monday draft');
    const opened = await fetch(s.base + pixel);
    if (!opened.ok) throw new Error('Pixel ' + opened.status);
    await opened.arrayBuffer();
  }
  for (let i = 0; i < 4; i++) await req(s, 'POST', '/api/leads', { name: 'Wednesday Sample ' + (i + 1), email: 'wed' + i + '@lakeview.example', source: 'Website' }, token);
  await tick(s, mondayAt + 2 * DAY);
  await tick(s, mondayAt + 7 * DAY + 3600e3);
  await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'paused' }, token);
  const sug = ((await req(s, 'GET', '/api/cos', undefined, token)).d.suggestions || []).filter((x) => x.status === 'open');
  const line = sug.find((x) => /Monday/i.test(x.text));
  if (!line) throw new Error('Monday suggestion missing');
  return line.text;
}

story('studio slot and Friday', 'Salon / gym · Slot, trial, every Friday', async (steps) => {
  const s = await startServer(ENV);
  try {
    const token = await signup(s, 'kabir.shah@pulse-studio.example', 'Kabir Shah');
    await req(s, 'POST', '/api/profile', { name: 'Pulse Studio', location: 'Mumbai', about: 'A fictional salon and gym.', offer: 'Cuts and a trial class' }, token);
    const sl = await req(s, 'POST', '/api/channels/slack', { bot_token: 'mock_sl_studio_story', signing_secret: 'studio-signing-secret-story', owner_user_id: 'U0OWNER1', customers: true }, token);
    const hook = (sl.d.slack.webhook_url || '').split('/').pop();
    const team = sl.d.slack.team_id;
    const raw = JSON.stringify({ type: 'event_callback', team_id: team, event_id: 'Estory1', event: { type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'Book the 6pm slot and the trial class, and hold every customer message for my approval.', channel: 'D0DEMO1', ts: '11.1' } });
    const ts = Math.floor(Date.now() / 1000);
    const posted = await fetch(s.base + '/api/channels/slack/webhook/' + hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignature('studio-signing-secret-story', String(ts), raw) },
      body: raw,
    });
    const postedJson = await posted.json().catch(() => ({}));
    const dm = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.channel === 'slack' && c.peer === 'D0DEMO1');
    const reply = dm && (dm.messages || []).find((m) => m.dir === 'out' && m.status === 'sent');
    check(steps, 'Slack owner DM reaches the Chief as a real sentence', sl.status === 200 && posted.status === 200 && postedJson.route === 'chief' && reply && !/\[mock/.test(reply.body) && /approval/i.test(reply.body), 'The Slack DM is delivered. The reply is a canned sentence, not a [mock] line.');

    const desk = await openDesk(s, token, {
      faqs: [{ q: 'Trial class', a: 'A first trial class is free.' }],
      by_day: allWeek('10:00', '19:30'),
    });
    const preview = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.slots || [];
    await say(s, desk.widget, 'Slot at 6?', 'studiovis01');
    const six = (await pending(s, token)).find((a) => /Here are open times/.test(blob(a)));
    const previewHasOther = preview.some((slot) => !/, 18:00/.test(slot.label || ''));
    check(steps, '“Slot at 6?” offers 18:00', !!six && /, 18:00/.test(blob(six)) && !/, 10:/.test(blob(six)) && !/, 18:30/.test(blob(six)) && previewHasOther, 'The draft offers 18:00. The unfiltered openings include another time, so 18:00 is the clock in the question.');
    await approveWhere(s, token, /Here are open times/);
    await say(s, desk.widget, 'book 1', 'studiovis01');
    const before = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    await approveWhere(s, token, /Booked for/);
    const afterBook = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    check(steps, 'The 6pm booking waits for approval', before.length === 0 && afterBook.length === 1 && /, 18:00/.test(afterBook[0].label || ''), 'The confirmation is stored only after Approve, at 18:00.');

    await say(s, desk.widget, 'Trial class?', 'studiotrial1');
    const trial = (await pending(s, token)).find((a) => /first trial class is free/.test(blob(a)));
    check(steps, 'The trial answer is its own draft', !!trial && !/Here are open times/.test(blob(trial)), '“Trial class?” drafts the saved answer and does not book a slot.');
    await approveWhere(s, token, /first trial class is free/);
    await say(s, desk.widget, 'book a slot', 'studiotrial1');
    const trialSlot = (await pending(s, token)).find((a) => /Here are open times/.test(blob(a)));
    await approveWhere(s, token, /Here are open times/);
    await say(s, desk.widget, 'book 1', 'studiotrial1');
    const trialBefore = (await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || [];
    await approveWhere(s, token, /Booked for/);
    check(steps, 'The trial slot is a separate approval', !!trialSlot && trialBefore.length === 1 && ((await req(s, 'GET', '/api/frontdesk', undefined, token)).d.bookings || []).length === 2, 'Asking for a slot after the trial answer is a new draft. The booking waits for its own approval.');

    const beforeCount = ((await req(s, 'GET', '/api/workflows', undefined, token)).d.workflows || []).length;
    const friday = await req(s, 'POST', '/api/workplace/chat', { message: 'Every Friday, remind people with bookings tomorrow' }, token);
    const wfs = (await req(s, 'GET', '/api/workflows', undefined, token)).d.workflows || [];
    const wf = wfs.find((w) => w.trigger && w.trigger.weekday === 5 && w.trigger.audience === 'bookings_tomorrow');
    const step = wf && (wf.steps || []).find((st) => st.audience === 'bookings_tomorrow');
    check(steps, '“Every Friday…” told to the Chief creates a weekly draft', friday.status === 200 && !/\[mock/.test(friday.d.answer || '') && /Friday/.test(friday.d.answer || '') && wf && wf.status === 'draft' && step && step.autonomy === 'needs_approval', 'The Chief saved a Friday workflow. It is off, and the WhatsApp step needs approval.');

    await req(s, 'POST', '/api/frontdesk/availability', { timezone: 'Asia/Kolkata', slot_minutes: 30, by_day: { 6: { start: '11:00', end: '13:00' } } }, token);
    const enabled = await req(s, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled', step: { id: step.id, autonomy: 'auto' } }, token);
    const next = enabled.d.workflow.trigger.next;
    const target = plusDays(next, 1);
    await say(s, desk.widget, 'Please book a Saturday slot', 'studiofri01');
    const offer = (await pending(s, token)).find((a) => /Here are open times/.test(blob(a)));
    const n = offer && bookNumber(blob(offer), target.day, target.month);
    check(steps, 'A booking exists on the day after the Friday run', !!n, n ? 'The offered Saturday matches the day after the scheduled Friday.' : 'No offered Saturday matched the day after the Friday run.');
    await approveWhere(s, token, /Here are open times/);
    await say(s, desk.widget, 'book ' + n, 'studiofri01');
    await approveWhere(s, token, /Booked for/);
    let early = [];
    if (next - 3600e3 > Date.now() + 5000) {
      await tick(s, next - 3600e3);
      early = await pending(s, token);
    }
    await tick(s, next);
    const late = await pending(s, token);
    const reminder = late.find((a) => a.kind === 'webchat' && /booking tomorrow/.test(blob(a)));
    const friThread = ((await req(s, 'GET', '/api/channels', undefined, token)).d.conversations || []).find((c) => c.peer === 'studiofri01');
    const sent = friThread && (friThread.messages || []).some((m) => /booking tomorrow/.test(m.body || '') && m.status === 'sent');
    const draftedToVisitor = friThread && (friThread.messages || []).some((m) => /booking tomorrow/.test(m.body || '') && m.status === 'draft');
    check(steps, 'The Friday tick drafts the reminder and does not send it', !!reminder && reminder.status === 'pending' && draftedToVisitor && !sent && !early.some((a) => /booking tomorrow/.test(blob(a))), 'Ticking an hour early does nothing. Ticking the stored Friday time drafts the web chat reminder even if the step was set to auto.');

    const fortnight = await req(s, 'POST', '/api/workplace/chat', { message: 'Every fortnight, remind people with bookings tomorrow' }, token);
    const afterCount = ((await req(s, 'GET', '/api/workflows', undefined, token)).d.workflows || []).length;
    const compiled = await req(s, 'POST', '/api/workflows/compile', { text: 'Every fortnight, remind people with bookings tomorrow' }, token);
    const afterCompile = ((await req(s, 'GET', '/api/workflows', undefined, token)).d.workflows || []).length;
    check(steps, '“Every fortnight…” is refused', fortnight.status === 200 && /every day, every weekday/i.test(fortnight.d.answer || '') && afterCount === beforeCount + 1 && compiled.status === 400 && afterCompile === afterCount, 'The Chief and the workflow box both explain the supported schedules. No fortnight workflow is saved.');
  } finally { await s.stop(); }
});

story('agency white label', 'Agency · White-label workspace', async (steps) => {
  const s = await startServer(ENV);
  try {
    const token = await signup(s, 'nisha.rao@northandco.example', 'Nisha Rao');
    await req(s, 'POST', '/api/profile', { name: 'North & Co', location: 'Mumbai', about: 'A fictional agency.', offer: 'White-label front desk' }, token);
    const chief = await req(s, 'POST', '/api/workplace/chat', { message: 'Add a client workspace, set our branding, and keep every client workflow as a draft until I approve it.' }, token);
    check(steps, 'Chief answers the agency goal in plain English', chief.status === 200 && chief.d.answer && !/\[mock/.test(chief.d.answer) && /draft|email|DNS|approval/i.test(chief.d.answer), 'The Chief reply is a sentence and does not contain a [mock] line.');

    const agency = await req(s, 'POST', '/api/agency', { name: 'North & Co' }, token);
    const client = await req(s, 'POST', '/api/agency/clients', { name: 'Harbour Studio', email: 'owner@harbour-studio.example', password: 'Client-pass-123!' }, token);
    check(steps, 'Creating a client does not send email', agency.d.mailed === false && client.status === 200 && client.d.mailed === false && client.d.payment === false, 'The client response says no email was sent and no payment was taken.');

    const login = await req(s, 'POST', '/api/auth/login', { email: 'owner@harbour-studio.example', password: 'Client-pass-123!' });
    await req(s, 'POST', '/api/leads', { name: 'Sample Enquiry', email: 'enquiry@harbour-studio.example', source: 'Website' }, login.d.token);
    await req(s, 'POST', '/api/ai', { prompt: 'One line on this week for Harbour Studio. Fictional only.' }, login.d.token);

    const brand = await req(s, 'POST', '/api/agency/branding', { color: '#1f6b4a', accent: '#143d2c', support_email: 'hello@northandco.example', domain: 'app.northandco.example' }, token);
    const dns = (brand.d.dns && brand.d.dns.steps || []).join(' ');
    check(steps, 'Saving a hostname does not change DNS', brand.status === 200 && /does not buy the name or change DNS/.test(dns) && /does not issue a certificate/.test(dns), 'The branding response documents the CNAME and says saving it does not change DNS or issue a certificate.');

    const mark = await req(s, 'POST', '/api/agency/markup', { percent: 20, message_inr: 2, lead_inr: 40 }, token);
    check(steps, 'Markup is saved and is not a charge', mark.status === 200 && mark.d.markup.percent === 20 && mark.d.payment === false, '20% AI markup, ₹2 a message, and ₹40 a lead are saved. payment is false.');

    const second = await req(s, 'POST', '/api/agency/clients', { name: 'Lakeview Homes', email: 'studio@lakeview-client.example', password: 'Client-pass-123!' }, token);
    const preview = await req(s, 'POST', '/api/agency/playbook', { email: 'studio@lakeview-client.example', id: 'pb_agency' }, token);
    const installed = await req(s, 'POST', '/api/agency/playbook', { email: 'studio@lakeview-client.example', id: 'pb_agency', confirm: true }, token);
    check(steps, 'The agency playbook installs as drafts', second.d.mailed === false && preview.d.installed === false && preview.d.needs_confirmation === true && installed.d.installed === true && installed.d.sent === false && (installed.d.result.workflows || []).every((w) => w.status === 'draft'), 'Preview does not install. Confirm writes the workflows as drafts and sends nothing.');

    const view = await req(s, 'POST', '/api/agency/view-as', { email: 'studio@lakeview-client.example' }, token);
    const seen = await req(s, 'GET', '/api/workflows', undefined, view.d.token);
    const welcome = (seen.d.workflows || []).find((w) => w.name === 'New enquiry welcome');
    const blocked = await req(s, 'POST', '/api/workflows/update', { id: welcome && welcome.id, status: 'enabled' }, view.d.token);
    const agencyBlocked = await req(s, 'GET', '/api/agency', undefined, view.d.token);
    check(steps, 'View-as is read only', view.d.read_only === true && welcome && welcome.status === 'draft' && blocked.status === 403 && /read only/i.test(blocked.d.message || '') && agencyBlocked.status === 403, 'The view-as session can read the draft workflow and cannot turn it on.');

    const summary = await req(s, 'GET', '/api/agency/invoice', undefined, token);
    const html = await fetch(s.base + '/api/agency/invoice.html', { headers: { authorization: 'Bearer ' + token } });
    const page = await html.text();
    check(steps, 'The usage summary is not a payment', summary.d.payment === false && /not a tax invoice/i.test(page) && /does not take payment/i.test(page), 'The invoice route sets payment false. The printable page says it is not a tax invoice and does not take payment.');
  } finally { await s.stop(); }
});

after(() => {
  const order = ['clinic laser Saturday', 'coach fees and follow-up', 'broker 3BHK and Monday', 'studio slot and Friday', 'agency white label'];
  reports.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const lines = [
    '# Demo script check',
    '',
    'Checked by `node --test test/demo-stories.test.mjs` against a local server with `AI_PROVIDER=mock`, `AI_MOCK=on`, and `CHANNELS_MOCK=on`. No video was recorded.',
    '',
  ];
  let pass = 0, fail = 0;
  for (const story of reports) {
    lines.push('## ' + story.title, '', '| Step | Result | What the app did |', '|---|---|---|');
    for (const step of story.steps) {
      lines.push('| ' + step.title + ' | ' + step.result + ' | ' + (step.evidence || '') + ' |');
      if (step.result === 'PASS') pass++; else fail++;
    }
    lines.push('');
  }
  if (!reports.length) lines.push('No story finished, so there is no result to record.', '');
  lines.splice(4, 0, fail ? 'A FAIL is a step that did not pass in this run.' : 'Every step passed. The widget shows each message’s own time in the account timezone, reopening the chat loads that visitor’s history, qualify questions follow the business type, and website chat saves the visitor’s name.', '');
  lines.push('Totals: ' + pass + ' passed, ' + fail + ' failed.', '');
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.writeFileSync(DOC, lines.join('\n'));
});
