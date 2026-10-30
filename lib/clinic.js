// AaaS v2 small-business team: one workspace per account (as_clinic:<email>).
// Six agents, drafts only. Nothing here sends email, SMS, a paid WhatsApp message, or a payment.
// Review requests and reminders are wa.me links the owner opens. Approving a draft still does not contact anyone.
// Storage stays in the existing agentsphere_kv table. Keys: as_clinic:<email>, as_cform:<token>, as_cusage:<email>, as_cpay:<link id>, as_cpayev:<event id>.
import crypto from 'node:crypto';
import { runAgent, decideApproval } from './orchestrator.js';
import { llmReady } from './llm.js';
import { startRun } from './activity.js';
import { HERO, INR_PER_USD, PACKS, AGENT_KEYS, packOf, publicPacks } from './clinic-packs.js';
import { PLANS, pricingPublic } from './pricing.js';
import { ekaConnection, otherConnection, pullEka, rowsFromWebhook, softwareStats, isConnectorSource, EKA_SOURCE, OTHER_SOURCE } from './clinic-connectors.js';
import { visitView, normalizeVisit } from './clinic-visit.js';
import { readRazorpayWebhook } from './billing.js';
import { upiDeepLink, attachPayment, paymentLinkId } from './clinic-payments.js';
import { waPublic, waEnv, sendDecision, sendTemplate, parseWaWebhook, nextWaStatus, optWord, safeEqual, metaSignature } from './clinic-whatsapp.js';
import { byokSummary, clinicAiBlock, demoPlatformKey } from './aikeys.js';

const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const uid = () => crypto.randomBytes(4).toString('hex');
const DAY = 864e5;
const TZ = 'Asia/Kolkata';
export const DEMO_EMAIL = 'demo-clinic@aidentify.local';
export const HIGH_VALUE = 20000;
export const LAPSED_DAYS = 180;
export { HERO, PLANS, INR_PER_USD, publicPacks };
const MAX_ROWS = 2000;
const USE = (email) => 'as_cusage:' + email;

const copyFor = (role) => packOf(role) || PACKS.dental;

export const demoLoginAllowed = () => {
  if (process.env.CLINIC_DEMO === '0') return false;
  if (process.env.CLINIC_DEMO === '1') return true;
  const hosted = !!process.env.VERCEL || /^(1|true|yes)$/i.test(process.env.HOSTED || '') || process.env.NODE_ENV === 'production';
  return !hosted;
};

const istDate = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export function weekRange(now = Date.now()) {
  const key = istDate(now);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(now));
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
  const start = addDays(key, idx === 0 ? -6 : 1 - idx);
  return { start, end: addDays(start, 6) };
}
function pastThisMonth(now) {
  const month = istDate(now).slice(0, 7);
  for (const t of [now - 3 * 3600e3, now - 60e3, now]) {
    if (t <= now && istDate(t).slice(0, 7) === month) return new Date(t).toISOString();
  }
  return new Date(now).toISOString();
}
const istStamp = (key, hour = 11) => {
  const [y, m, d] = key.split('-').map(Number);
  let H = hour - 5, M = 0 - 30, day = d;
  if (M < 0) { M += 60; H -= 1; }
  if (H < 0) { H += 24; day -= 1; }
  return new Date(Date.UTC(y, m - 1, day, H, M, 0)).toISOString();
};
const inDates = (ts, start, end) => { const t = Date.parse(ts); if (!t) return false; const k = istDate(t); return k >= start && k <= end; };
const within = (ts, now, days) => { const t = Date.parse(ts); return Number.isFinite(t) && t <= now + 3600e3 && now - t <= days * DAY; };
const digits = (p) => String(p || '').replace(/\D/g, '');
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export function waMe(phone, text) {
  let d = digits(phone);
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  if (d.length < 11 || d.length > 15) return '';
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(String(text || '').slice(0, 900));
}
export function refCode(p) {
  return crypto.createHash('sha256').update('aaas-ref-v1:' + String((p && p.id) || '') + ':' + digits(p && p.phone)).digest('hex').slice(0, 10);
}
function ensureRef(p) {
  if (!p.ref || !/^[a-f0-9]{10}$/.test(String(p.ref))) p.ref = refCode(p);
  return p.ref;
}
function bookLink(c, code) {
  const path = '/book/' + (c.formToken || '') + (code ? '?ref=' + code : '');
  const base = String(process.env.APP_URL || '').replace(/\/$/, '');
  return base + path;
}
export const TRIAL_DAYS = 14;
export function trialDays() {
  const raw = process.env.CLINIC_TRIAL_DAYS;
  if (raw == null || String(raw).trim() === '') return TRIAL_DAYS;
  const n = Math.floor(Number(raw));
  if (Number.isFinite(n) && n >= 0 && n <= 90) return n;
  return TRIAL_DAYS;
}
export function trialOf(c, now = Date.now(), days = trialDays()) {
  const span = Number.isFinite(days) ? days : TRIAL_DAYS;
  const started = Number(c && c.trialStarted) || 0;
  const plan = (c && c.plan) || '';
  const base = { days: span, plan, noCard: true, sample: false };
  if (!started) return { ...base, daysLeft: span, active: span > 0, expired: span === 0, startedAt: '', endsAt: '' };
  const ends = started + span * DAY;
  const expired = now >= ends;
  const daysLeft = expired ? 0 : Math.max(1, Math.ceil((ends - now) / DAY));
  return { ...base, daysLeft, active: !expired, expired, startedAt: new Date(started).toISOString(), endsAt: new Date(ends).toISOString() };
}
export function assertWritable() {
  return; // a stored expiry stamp does not lock the workspace
}
function sampleOnly(c) {
  const people = (c && c.patients) || [];
  if (!people.length) return false;
  const real = (row) => row && row.demo === false;
  return !people.some(real) && !(c.appointments || []).some(real) && !(c.enquiries || []).some(real) && !(c.invoices || []).some(real);
}

const blank = () => ({
  role: '', demo: false, biz: '', city: '', phone: '', formToken: '', seededAt: 0, plan: '', trialStarted: 0,
  profile: { services: '', prices: '', audience: '', offer: '', upi: '', payLink: '' },
  checklist: { form: false },
  rules: { from: '09:00', to: '20:00', everyDays: 7, cap: 2, ask: true, tone: 'Warm and short, the way you speak to the people you serve' },
  toneExamples: [], payIds: [], payEvents: [], waOpt: {}, waPhones: [], waIds: [],
  paused: {}, patients: [], appointments: [], enquiries: [], drafts: [], posts: [], invoices: [], summary: null,
});

const nid = (list) => list.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1;

function person(role, i) {
  const pack = copyFor(role);
  return pack.people[i];
}

export function buildSeed(role, now = Date.now()) {
  const cpy = copyFor(role);
  const week = weekRange(now);
  const patients = [];
  for (let i = 0; i < 18; i++) {
    const p = person(role, i);
    const when = new Date(now - p.days * DAY).toISOString();
    patients.push({
      id: i + 1, name: p.name, phone: '919000000' + String(i + 1).padStart(3, '0'),
      email: p.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@example.com',
      lastVisit: when, value: p.value, createdAt: when, demo: true, source: 'Sample import',
    });
  }
  const fromEka = new Set(['Suresh Patil', 'Kavita Joshi', 'Mohammed Ali', 'Vikram Shah']);
  for (const p of patients) {
    if (!fromEka.has(p.name)) continue;
    p.source = 'Eka.care';
    p.connector = 'eka';
    p.externalId = 'eka-demo-' + p.id;
    if (p.name === 'Suresh Patil') p.broughtBack = true;
  }
  for (const p of patients) ensureRef(p);
  const byName = (n) => patients.find((p) => p.name === n);
  const appt = (id, name, dayOffset, hour, service, status, fee) => ({
    id, patientId: byName(name).id, at: istStamp(addDays(week.start, dayOffset), hour), service, status, fee, demo: true, reminder: null,
  });
  const visit = cpy.visitName, clean = cpy.cleanName, rct = cpy.followName;
  const fees = cpy.fees;
  const appointments = [
    appt(1, 'Ananya Reddy', 0, 11, clean, 'booked', fees[0]),
    appt(2, 'Rohan Mehta', 1, 11, rct, 'booked', fees[1]),
    appt(3, 'Fatima Sheikh', 2, 15, visit, 'booked', fees[2]),
    appt(4, 'Karthik Iyer', 3, 10, clean, 'noshow', fees[3]),
    appt(5, 'Sneha Kapoor', 4, 12, visit, 'booked', fees[4]),
    { id: 6, patientId: byName('Divya Nair').id, at: istStamp(istDate(now), 16), service: visit, status: 'completed', fee: fees[5], demo: true, reminder: null },
  ];
  appointments[0].referral = true;
  appointments[0].referredBy = byName('Rohan Mehta').name;
  const enquiries = [0, 1, 2].map((i) => ({
    id: i + 1, name: ['Priya Menon', 'Omar Farooq', 'Shalini Das'][i], phone: '91900000100' + i,
    email: '', channel: ['Website', 'Instagram', 'Phone'][i],
    message: cpy.enquiry,
    status: 'new', at: istStamp(addDays(week.start, i), 9), demo: true, source: 'Sample',
  }));
  enquiries.push({ id: 4, name: 'Old enquiry', phone: '919000001009', email: '', channel: 'Website', message: 'Already closed.', status: 'closed', at: new Date(now - 40 * DAY).toISOString(), demo: true, source: 'Sample' });
  const reviewBody = (name) => `Hi ${name}, thank you for coming to ${cpy.biz}. If you have a minute, a Google review helps other ${cpy.who} find us. DEMO message — nothing is sent from AaaS.`;
  const recallBody = (name, when) => `Hi ${name}, it has been a while since your last ${cpy.visit} on ${istDate(Date.parse(when))}. Reply here and the desk will book you. DEMO message — nothing is sent from AaaS.`;
  const suresh = byName('Suresh Patil'), ananya = byName('Ananya Reddy'), vikram = byName('Vikram Shah');
  const drafts = [
    { id: 1, agent: 'recall', kind: 'followup', patientId: suresh.id, title: `Follow-up for ${suresh.name}`, body: recallBody(suresh.name, suresh.lastVisit), waLink: waMe(suresh.phone, recallBody(suresh.name, suresh.lastVisit)), status: 'pending', approvalId: '', at: now - 8 * DAY, demo: true },
    { id: 2, agent: 'reviews', kind: 'review', patientId: ananya.id, title: `Review request for ${ananya.name}`, body: reviewBody(ananya.name), waLink: waMe(ananya.phone, reviewBody(ananya.name)), status: 'pending', approvalId: '', at: now - 1800e3, demo: true },
    { id: 3, agent: 'reviews', kind: 'review', patientId: vikram.id, title: `Review request for ${vikram.name}`, body: reviewBody(vikram.name), waLink: waMe(vikram.phone, reviewBody(vikram.name)), status: 'pending', approvalId: '', at: now - 900e3, demo: true },
  ];
  const posts = [
    { id: 1, at: istStamp(addDays(week.start, 2), 9), text: `DEMO post for ${cpy.biz}: ${cpy.post1}. Not published anywhere.`, status: 'scheduled', approvalId: '', demo: true },
    { id: 2, at: istStamp(addDays(week.start, 5), 9), text: `DEMO post for ${cpy.biz}: ${cpy.post2}. Not published anywhere.`, status: 'scheduled', approvalId: '', demo: true },
  ];
  const paidAt = pastThisMonth(now);
  const invoices = [
    { id: 1, number: 'INV-1001', patientId: ananya.id, items: [{ desc: clean, qty: 1, rate: 12000 }], gst: null, status: 'paid', issuedAt: paidAt, dueAt: paidAt, paidAt, upi: cpy.upi, payLink: cpy.payLink, demo: true },
    { id: 2, number: 'INV-1002', patientId: byName('Rohan Mehta').id, items: [{ desc: rct, qty: 1, rate: 3200 }], gst: null, status: 'paid', issuedAt: paidAt, dueAt: paidAt, paidAt, upi: cpy.upi, payLink: cpy.payLink, demo: true },
    { id: 3, number: 'INV-1003', patientId: byName('Fatima Sheikh').id, items: [{ desc: visit, qty: 1, rate: 1500 }], gst: null, status: 'unpaid', issuedAt: paidAt, dueAt: new Date(now + 7 * DAY).toISOString(), paidAt: '', upi: cpy.upi, payLink: cpy.payLink, demo: true },
    { id: 4, number: 'INV-1004', patientId: byName('Suresh Patil').id, items: [{ desc: 'Earlier ' + visit, qty: 1, rate: 2000 }], gst: null, status: 'unpaid', issuedAt: new Date(now - 40 * DAY).toISOString(), dueAt: new Date(now - 10 * DAY).toISOString(), paidAt: '', upi: cpy.upi, payLink: cpy.payLink, demo: true },
    { id: 5, number: 'INV-1005', patientId: byName('Suresh Patil').id, items: [{ desc: 'Return ' + visit, qty: 1, rate: 4500 }], gst: null, status: 'paid', issuedAt: paidAt, dueAt: paidAt, paidAt, upi: cpy.upi, payLink: cpy.payLink, demo: true },
  ];
  for (const inv of invoices) {
    const link = upiDeepLink({ vpa: inv.upi, name: cpy.biz, amount: invoiceTotal(inv), note: inv.number });
    if (link) inv.payLink = link;
    inv.payMode = 'demo';
    inv.payId = 'demo_' + inv.number.replace(/[^A-Za-z0-9]/g, '');
  }
  const weeklyBody = weeklySummaryText({ biz: cpy.biz, appointments, invoices, patients }, now);
  drafts.push({ id: 4, agent: 'insights', kind: 'weekly', patientId: null, title: 'Weekly WhatsApp summary', body: weeklyBody, waLink: waMe(cpy.phone, weeklyBody), status: 'pending', approvalId: '', at: now - 600e3, demo: true });
  return {
    ...blank(), role: cpy.id, demo: true, biz: cpy.biz, city: cpy.city, phone: cpy.phone,
    profile: { services: cpy.services, prices: cpy.prices, audience: cpy.audience, offer: cpy.offer, upi: cpy.upi, payLink: cpy.payLink },
    formToken: crypto.randomBytes(16).toString('hex'), seededAt: now, patients, appointments, enquiries, drafts, posts, invoices,
    rules: { ...blank().rules, tone: cpy.tone }, paused: {},
  };
}

// High-value bar depends on the role: dental bills are thousands of rupees, property values are lakhs.
export function isHighValue(p, role) {
  const bar = (copyFor(role).highValue) || HIGH_VALUE;
  return Number(p.value) >= bar;
}
export function isLapsed(p, now = Date.now()) {
  const t = Date.parse(p.lastVisit || '');
  if (!t) return false;
  return !within(p.lastVisit, now, LAPSED_DAYS);
}

export function invoiceTotal(inv) {
  const sub = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);
  const gst = inv.gst == null || inv.gst === '' ? null : Number(inv.gst);
  const tax = gst == null || !Number.isFinite(gst) ? 0 : Math.round(sub * gst) / 100;
  return Math.round((sub + tax) * 100) / 100;
}
export function invoiceState(inv, now = Date.now()) {
  if (inv.status === 'paid') return 'paid';
  const due = Date.parse(inv.dueAt || '');
  if (due && due < now) return 'overdue';
  return 'unpaid';
}
function invoiceLines(c, inv) {
  const p = (c.patients || []).find((x) => x.id === inv.patientId);
  const sub = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0);
  const total = invoiceTotal(inv);
  const gst = inv.gst == null || inv.gst === '' ? null : Number(inv.gst);
  const lines = [
    c.biz || 'AaaS',
    c.city || '',
    'Invoice ' + (inv.number || ''),
    'To: ' + (p ? p.name : 'Customer'),
    'Status: ' + invoiceState(inv),
    'GST: ' + (gst == null ? 'not applied (no GSTIN on file)' : gst + '%'),
  ];
  for (const it of inv.items || []) lines.push(`${it.desc}  x${it.qty}  ₹${Number(it.rate) || 0}`);
  lines.push('Subtotal ₹' + sub);
  if (gst != null) lines.push('GST ₹' + (total - sub));
  lines.push('Total ₹' + total);
  if (inv.upi) lines.push('UPI: ' + inv.upi);
  if (inv.payLink) lines.push('Payment link: ' + inv.payLink);
  lines.push('Manual invoice. AaaS does not collect this payment.');
  if (inv.demo) lines.push('DEMO invoice. Not a real bill.');
  return lines.filter(Boolean);
}
export function invoicePdf(lines) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const body = lines.slice(0, 40).map((line, i) => `BT /F1 12 Tf 48 ${780 - i * 18} Td (${esc(line).slice(0, 110)}) Tj ET`).join('\n');
  const objects = [];
  const add = (s) => { objects.push(s); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

export function statsOf(c, now = Date.now()) {
  const week = weekRange(now), month = istDate(now).slice(0, 7);
  const ap = c.appointments || [], en = c.enquiries || [], pts = c.patients || [];
  const inWeek = (a) => inDates(a.at, week.start, week.end);
  const inMonth = (a) => { const t = Date.parse(a.at); return t && istDate(t).slice(0, 7) === month; };
  const bookingsWeek = ap.filter((a) => inWeek(a) && (a.status === 'booked' || a.status === 'completed')).length;
  const noshows = ap.filter((a) => inWeek(a) && a.status === 'noshow').length;
  const revenue = (c.invoices || []).filter((inv) => inv.status === 'paid' && inMonth({ at: inv.paidAt || inv.issuedAt })).reduce((s, inv) => s + invoiceTotal(inv), 0);
  const invoiceOpen = (c.invoices || []).filter((inv) => invoiceState(inv, now) !== 'paid').length;
  const last2 = pts.filter((p) => within(p.createdAt, now, 62) || within(p.lastVisit, now, 62));
  const recalls = pts.filter((p) => isLapsed(p, now));
  const reviews = (c.drafts || []).filter((d) => d.kind === 'review' && d.status !== 'rejected').length;
  const posts = (c.posts || []).filter((p) => p.status === 'scheduled').length;
  const referralBookings = ap.filter((a) => a.referral && (a.status === 'booked' || a.status === 'completed')).length;
  const recovered = recoveredOf(c, now);
  return {
    enquiriesWeek: en.filter((e) => inDates(e.at, week.start, week.end)).length,
    enquiriesOpen: en.filter((e) => e.status === 'new').length,
    bookingsWeek, noshows, recallsDue: recalls.length, reviews, posts, revenue, referralBookings,
    patientsLast2Months: last2.length, patientsTotal: pts.length,
    invoicesOpen: invoiceOpen,
    highValue: pts.filter((p) => isHighValue(p, c.role)).length,
    recovered,
    weekStart: week.start, weekEnd: week.end, month,
    last2Names: last2.map((p) => p.name),
    ...softwareStats(pts, c.invoices || [], (inv) => inMonth({ at: inv.paidAt || inv.issuedAt }), invoiceTotal),
  };
}

export function answerQuestion(q, c, now = Date.now()) {
  const s = statsOf(c, now), cpy = copyFor(c.role), who = cpy.who, ql = String(q || '').toLowerCase();
  const countish = /how many|number of|count|total/.test(ql);
  const aboutWho = ql.includes(who) || ql.includes(cpy.whoSingular) || /patient|lead|client|member|student|customer/.test(ql);
  if (countish && aboutWho && /2 month|two month|60 day|last 2/.test(ql)) return `There are ${s.patientsLast2Months} ${who} in the last 2 months, counted from this account’s records.`;
  if (countish && aboutWho && /week/.test(ql)) return `There are ${s.enquiriesWeek} enquiries this week, and ${s.patientsLast2Months} ${who} in the last 2 months, counted from this account’s records.`;
  if (countish && aboutWho) return `There are ${s.patientsTotal} ${who} on file, and ${s.patientsLast2Months} in the last 2 months, counted from this account’s records.`;
  if (/no-show|noshow|missed follow/.test(ql)) return `No-shows this week: ${s.noshows}, counted from this account’s records.`;
  if (/revenue|profit|pipeline|making|paid|invoice/.test(ql)) return `Paid invoices this month come to ${money(s.revenue)}, counted from invoices marked paid in this account.`;
  if (/recall|lapsed|gone cold|follow-up/.test(ql)) return `${s.recallsDue} ${who} are due for a recall, counted from this account’s records.`;
  if (/enquir/.test(ql)) return `${s.enquiriesWeek} enquiries this week, ${s.enquiriesOpen} still open, counted from this account’s records.`;
  if (/book|appointment|site visit/.test(ql)) return `${s.bookingsWeek} bookings this week, counted from this account’s records.`;
  return '';
}

export function chiefBrief(c, now = Date.now()) {
  const s = statsOf(c, now);
  const pending = (c.drafts || []).filter((d) => d.status === 'pending').length;
  const today = istDate(now);
  const appointmentsToday = (c.appointments || []).filter((a) => a.status === 'booked' && istDate(Date.parse(a.at)) === today).length;
  const openInv = (c.invoices || []).filter((inv) => invoiceState(inv, now) !== 'paid');
  const dueInr = openInv.reduce((n, inv) => n + invoiceTotal(inv), 0);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const opener = `${hello}. I’m Chief. At ${c.biz || 'this business'} today: ${s.enquiriesOpen} open enquiries, ${pending} drafts waiting for approval, and ${money(dueInr)} unpaid on ${openInv.length} invoices. ${appointmentsToday} visits are booked today. Ask me about the records. Nothing is sent until you approve a draft.`;
  return { name: 'Chief', opener, pending, paymentsDue: openInv.length, paymentsDueInr: dueInr, appointmentsToday, enquiriesOpen: s.enquiriesOpen };
}

function digest(c, now) {
  const s = statsOf(c, now), who = copyFor(c.role).who;
  const lines = [
    `Snapshot for ${c.biz}. Sample rows are marked demo.`,
    `${who} in the last 2 months: ${s.patientsLast2Months}. Names: ${s.last2Names.join(', ') || 'none'}.`,
    `${who} on file: ${s.patientsTotal}. Recalls due: ${s.recallsDue}. High-value: ${s.highValue}.`,
    `Enquiries this week: ${s.enquiriesWeek} (${s.enquiriesOpen} open). Bookings this week: ${s.bookingsWeek}. No-shows this week: ${s.noshows}.`,
    `Review requests on file: ${s.reviews}. Posts scheduled: ${s.posts}. Estimated revenue this month: ${money(s.revenue)}.`,
  ];
  for (const p of (c.patients || []).slice(0, 40)) lines.push(`${copyFor(c.role).whoSingular}: ${p.name}, phone ${p.phone}, last ${copyFor(c.role).visit} ${p.lastVisit ? istDate(Date.parse(p.lastVisit)) : 'unknown'}, value ${p.value}${p.demo ? ', DEMO' : ''}.`);
  return lines.join('\n');
}

const baseSummary = (c, s) => `Week of ${s.weekStart} for ${c.biz}${c.demo ? ' (sample data)' : ''}. ${s.bookingsWeek} bookings this week, ${s.noshows} no-shows, ${s.enquiriesWeek} enquiries (${s.enquiriesOpen} still open). ${s.recallsDue} due for a recall. ${s.reviews} review requests. ${s.posts} posts on the calendar. Paid invoices this month: ${money(s.revenue)}.`;

const REMINDER_KINDS = new Set(['reminder', 'followup', 'payment']);
export function rulesOf(c) {
  const base = blank().rules;
  const r = { ...base, ...((c && c.rules) || {}) };
  const every = Math.round(Number(r.everyDays));
  const cap = Math.round(Number(r.cap));
  const time = (v, fb) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : fb);
  return {
    from: time(r.from, base.from), to: time(r.to, base.to),
    everyDays: every >= 1 && every <= 30 ? every : base.everyDays,
    cap: cap >= 1 && cap <= 10 ? cap : base.cap,
    ask: r.ask !== false, tone: clip(r.tone || base.tone, 240),
  };
}
function reminderGate(c, patientId, now) {
  const rules = rulesOf(c);
  const mine = (c.drafts || []).filter((d) => d.patientId === patientId && REMINDER_KINDS.has(d.kind) && d.status !== 'rejected');
  const recent = mine.filter((d) => now - (d.at || 0) < 7 * DAY);
  if (recent.length >= rules.cap) throw new Error('Cap is ' + rules.cap + ' reminders per person in 7 days. Change it in Settings. Nothing was sent.');
  const last = mine.reduce((m, d) => Math.max(m, d.at || 0), 0);
  if (last && now - last < rules.everyDays * DAY) throw new Error('This business reminds at most every ' + rules.everyDays + ' days. The last note is still inside that gap. Nothing was sent.');
  return rules;
}
export function shapeWithTone(c, agent, name, fallback, kind) {
  const ex = (c.toneExamples || []).find((e) => e && e.agent === agent && e.after && (!kind || !e.kind || e.kind === kind));
  if (!ex) return fallback;
  let text = ex.after;
  if (ex.name && name && ex.name !== name) text = text.split(ex.name).join(name);
  return clip(text, 4000);
}
function rememberTone(c, d, before, after, name) {
  if (!before || !after || before === after) return;
  c.toneExamples = Array.isArray(c.toneExamples) ? c.toneExamples : [];
  c.toneExamples.unshift({ at: Date.now(), agent: d.agent || '', kind: d.kind || '', name: name || '', before: clip(before, 500), after: clip(after, 500) });
  c.toneExamples = c.toneExamples.slice(0, 12);
}
function toneHint(c) {
  const rows = (c.toneExamples || []).slice(0, 4);
  if (!rows.length) return '';
  return ' Match the owner\'s edits. Examples:\n' + rows.map((e) => `They changed "${e.before}" to "${e.after}".`).join('\n');
}

const SAMPLE_RUNS = [
  { agent: 'front', in: 18400, out: 2100 },
  { agent: 'recall', in: 16220, out: 1860 },
  { agent: 'reviews', in: 14110, out: 1640 },
  { agent: 'social', in: 20150, out: 2480 },
  { agent: 'insights', in: 22340, out: 2710 },
  { agent: 'billing', in: 12080, out: 1390 },
];
const sampleCost = (r) => ((Number(r.in) || 0) * 3 + (Number(r.out) || 0) * 15) / 1e6;
export function sampleRuns(now = Date.now()) {
  return SAMPLE_RUNS.map((r, i) => ({ ...r, at: now - (i + 1) * 3600e3, source: 'sample', costUsd: sampleCost(r) }));
}
export function recoveredOf(c, now = Date.now()) {
  const month = istDate(now).slice(0, 7);
  const inMonth = (ts) => { const t = Date.parse(ts || ''); return !!(t && istDate(t).slice(0, 7) === month); };
  const visits = (c.appointments || []).filter((a) => a && inMonth(a.at) && (a.status === 'booked' || a.status === 'completed'));
  const fee = (a) => Math.max(0, Number(a.fee) || 0);
  const referrals = visits.filter((a) => a.referral).reduce((s, a) => s + fee(a), 0);
  const bookings = visits.filter((a) => !a.referral).reduce((s, a) => s + fee(a), 0);
  const paid = (c.invoices || []).filter((inv) => inv && inv.status === 'paid' && inMonth(inv.paidAt || inv.issuedAt));
  const backIds = new Set((c.patients || []).filter((p) => p && p.broughtBack).map((p) => p.id));
  const reactivated = paid.filter((inv) => backIds.has(inv.patientId)).reduce((s, inv) => s + invoiceTotal(inv), 0);
  const invoices = paid.filter((inv) => !backIds.has(inv.patientId)).reduce((s, inv) => s + invoiceTotal(inv), 0);
  const total = Math.round((bookings + referrals + reactivated + invoices) * 100) / 100;
  return {
    total, bookings, referrals, reactivated, invoices, month,
    method: 'Bookings are visit fees this month, apart from referral visits. Referrals are fees on visits booked from a forwarded link. Reactivated is paid invoices this month for people a follow-up brought back. Paid invoices are the rest of this month’s paid invoices, so a rupee is counted once.',
  };
}
export function weeklySummaryText(c, now = Date.now()) {
  const rec = recoveredOf(c, now);
  const week = weekRange(now);
  return `Week of ${week.start} for ${c.biz}. ₹ recovered this month: ${money(rec.total)}. Bookings ${money(rec.bookings)}. Reactivated ${money(rec.reactivated)}. Referrals ${money(rec.referrals)}. Paid invoices ${money(rec.invoices)}. Forward this on WhatsApp. Nothing is sent until you approve it.`;
}
export function forecastOf(c, now = Date.now()) {
  const days = 28, span = 30, since = now - days * DAY;
  const inWindow = (ts) => { const t = Date.parse(ts || ''); return Number.isFinite(t) && t >= since && t <= now + 36e5; };
  const bookingsBase = (c.appointments || []).filter((a) => inWindow(a.at) && (a.status === 'booked' || a.status === 'completed')).length;
  const billed = (c.invoices || []).filter((inv) => inWindow(inv.issuedAt));
  const paid = (c.invoices || []).filter((inv) => inv.status === 'paid' && inWindow(inv.paidAt || inv.issuedAt));
  const revenueBase = billed.reduce((s, inv) => s + invoiceTotal(inv), 0);
  const collectionsBase = paid.reduce((s, inv) => s + invoiceTotal(inv), 0);
  const scale = span / days;
  return {
    days, span,
    bookings: Math.round(bookingsBase * scale),
    revenue: Math.round(revenueBase * scale),
    collections: Math.round(collectionsBase * scale),
    bookingsBase, revenueBase, collectionsBase,
    method: 'Next month is the last 28 days on file, scaled to 30 days (30/28). Bookings count visits marked booked or completed. Revenue is invoices issued in that window. Collections are invoices marked paid. It is a straight scale, not a seasonal model, and it is not a promise.',
  };
}

function cleanItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const it of list.slice(0, 12)) {
    const desc = clip(it && (it.desc || it.description), 120);
    const qty = Math.max(0, Number(it && it.qty) || 0);
    const rate = Math.max(0, Number(it && it.rate) || 0);
    if (!desc || !qty) continue;
    out.push({ desc, qty, rate });
  }
  if (!out.length) throw new Error('Add at least one line with a description, a quantity and a rate.');
  return out;
}
const monthKey = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date(ts));
function agentTitle(role, key) {
  if (!key) return 'Agent';
  if (key === 'Chief of Staff' || key === 'chief') return 'Chief';
  const hit = copyFor(role).agents.find((a) => a.key === key || a.name === key);
  return hit ? hit.name : String(key);
}
function presentRun(role, r) {
  const costUsd = typeof r.costUsd === 'number' ? r.costUsd : sampleCost(r);
  return {
    at: r.at, agent: r.agent, name: agentTitle(role, r.agent), source: r.source || 'model',
    tokensIn: r.in || 0, tokensOut: r.out || 0, tokens: (r.in || 0) + (r.out || 0),
    costUsd: Math.round(costUsd * 1e6) / 1e6, costInr: Math.round(costUsd * INR_PER_USD * 100) / 100,
  };
}
export async function ensureSampleRuns(st, email) {
  const key = USE(email);
  const all = parse((await st.get(key))?.v, null) || { months: {}, runs: [] };
  if ((all.runs || []).some((r) => r && r.source === 'sample')) return all;
  const samples = sampleRuns();
  all.runs = [...samples, ...(all.runs || [])].slice(0, 40);
  await st.put(key, JSON.stringify(all), Date.now());
  return all;
}
export async function noteClinicAi(st, email, u) {
  if (!st || !email || !u) return;
  const month = monthKey();
  const key = USE(email);
  const cost = typeof u.cost === 'number' ? u.cost : ((Number(u.in) || 0) * 3 + (Number(u.out) || 0) * 15) / 1e6;
  const apply = (cur) => {
    const all = parse(cur, null) || { months: {}, runs: [] };
    const m = { calls: 0, in: 0, out: 0, costUsd: 0, ...(all.months[month] || {}) };
    m.calls += 1; m.in += Number(u.in) || 0; m.out += Number(u.out) || 0; m.costUsd += cost;
    all.months[month] = m;
    const keys = Object.keys(all.months).sort();
    for (const k of keys.slice(0, -18)) delete all.months[k];
    if (u.agent) {
      all.runs = Array.isArray(all.runs) ? all.runs : [];
      all.runs.unshift({ at: Date.now(), agent: clip(u.agent, 80), in: Number(u.in) || 0, out: Number(u.out) || 0, costUsd: cost, source: 'model' });
      const samples = all.runs.filter((r) => r && r.source === 'sample');
      const logged = all.runs.filter((r) => r && r.source !== 'sample').slice(0, 40);
      all.runs = [...samples, ...logged].slice(0, 48);
    }
    return JSON.stringify(all);
  };
  try {
    if (st.update) await st.update(key, apply);
    else await st.put(key, apply((await st.get(key))?.v), Date.now());
  } catch { /* a usage row must not fail the owner's request */ }
}
export async function clinicUsage(st, email, clinic, aiKey) {
  const month = monthKey();
  const keyCard = aiKey || { source: 'none', billedTo: 'no AI key saved' };
  const all = parse((await st.get(USE(email)))?.v, null) || { months: {}, runs: [] };
  const m = all.months[month] || { calls: 0, in: 0, out: 0, costUsd: 0 };
  const role = clinic && clinic.role;
  const demo = !!(clinic && clinic.demo);
  let runs = Array.isArray(all.runs) ? all.runs.slice() : [];
  if (demo && !runs.some((r) => r && r.source === 'sample')) runs = [...sampleRuns(), ...runs];
  if (!demo) runs = runs.filter((r) => r && r.source !== 'sample');
  const shown = runs.slice(0, 48).map((r) => presentRun(role, r));
  const byAgent = [];
  for (const r of shown) {
    let row = byAgent.find((x) => x.agent === r.agent);
    if (!row) { row = { agent: r.agent, name: r.name, calls: 0, tokensIn: 0, tokensOut: 0, costInr: 0 }; byAgent.push(row); }
    row.calls += 1; row.tokensIn += r.tokensIn; row.tokensOut += r.tokensOut; row.costInr = Math.round((row.costInr + r.costInr) * 100) / 100;
  }
  const tokensIn = shown.reduce((s, r) => s + r.tokensIn, 0);
  const tokensOut = shown.reduce((s, r) => s + r.tokensOut, 0);
  const costUsd = shown.reduce((s, r) => s + r.costUsd, 0);
  const loggedUsd = Math.round((Number(m.costUsd) || 0) * 1e6) / 1e6;
  return {
    month, calls: m.calls || 0, loggedTokensIn: m.in || 0, loggedTokensOut: m.out || 0,
    tokensIn, tokensOut, tokens: tokensIn + tokensOut,
    costUsd: Math.round(costUsd * 1e6) / 1e6, costInr: Math.round(costUsd * INR_PER_USD * 100) / 100,
    loggedCostUsd: loggedUsd, loggedCostInr: Math.round(loggedUsd * INR_PER_USD * 100) / 100,
    inrPerUsd: INR_PER_USD, runs: shown, byAgent, sample: demo && shown.some((r) => r.source === 'sample'),
    billedTo: keyCard.label || keyCard.billedTo || '',
    aiKey: { source: keyCard.source || 'none', provider: keyCard.provider || '', name: keyCard.name || '', hint: keyCard.hint || '', model: keyCard.model || '', label: keyCard.label || '' },
    note: (demo ? 'Sample runs are recorded numbers for this demo, not a live bill. ' : '') + 'Token counts are informational. Rupees use ₹' + INR_PER_USD + ' per US dollar, a fixed estimate, not a live rate.' + (keyCard.label ? ' ' + keyCard.label + '.' : ''),
  };
}

async function presentClinic(st, email, c, now, extras = {}, secret) {
  const aiKey = await byokSummary(st, email, secret);
  return { ...view(c, now, extras), account: email, aiKey, usage: await clinicUsage(st, email, c, aiKey) };
}

async function polish(ai, ip, base) {
  if (!ai || !llmReady()) return '';
  try {
    const r = await ai('Rewrite the weekly summary below in two short sentences for the owner. Keep every number exactly as written. Do not add numbers, names, or claims.\n\n' + base, ip, { max: 280, agent: 'insights' });
    return String(r.text || '').trim().slice(0, 1200);
  } catch { return ''; }
}

function snapshotRec(c, now) {
  const s = statsOf(c, now);
  return {
    name: 'Snapshot', title: 'Snapshot', at: now,
    patients_last_2_months: s.patientsLast2Months, patients_total: s.patientsTotal,
    bookings_this_week: s.bookingsWeek, no_shows_this_week: s.noshows, recalls_due: s.recallsDue,
    enquiries_this_week: s.enquiriesWeek, reviews_requested: s.reviews, posts_scheduled: s.posts,
    estimated_revenue_this_month_inr: s.revenue, note: s.last2Names.join(', '),
  };
}

function syncWorkspace(data, c, now) {
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  data.wp = data.wp && typeof data.wp === 'object' ? data.wp : {};
  const spec = copyFor(c.role).agents;
  const cpy = copyFor(c.role);
  data.wp.profile = { vertical: cpy.vertical, verticalLabel: cpy.verticalLabel, business: c.biz, city: c.city || cpy.city, phone: c.phone || '', website: '', help: cpy.pitch + ' ' + HERO };
  const ids = {};
  for (const a of spec) {
    let ag = data.agents.find((x) => x && x.clinicKey === a.key);
    if (!ag) {
      const id = data.agents.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1;
      ag = { id, clinicKey: a.key, kind: a.kind, name: a.name, label: a.label, d: a.d, status: 'active', recs: [], kb: [], n: 0, at: now };
      data.agents.push(ag);
    }
    ag.name = a.name; ag.label = a.label; ag.d = a.d; ag.kind = a.kind;
    ag.status = c.paused && c.paused[a.key] ? 'paused' : 'active';
    ids[a.key] = ag.id;
  }
  let crm = data.agents.find((x) => x && x.kind === 'crm');
  if (!crm) {
    const id = data.agents.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1;
    crm = { id, kind: 'crm', name: 'CRM Agent', label: 'CRM', d: cpy.who + ' imported from ' + (c.biz || 'this account') + '.', status: 'active', recs: [], kb: [], n: 0, at: now, db: { lead: [] } };
    data.agents.push(crm);
  }
  crm.db = crm.db && typeof crm.db === 'object' ? crm.db : {};
  crm.db.lead = Array.isArray(crm.db.lead) ? crm.db.lead : [];
    const snap = { ...snapshotRec(c, now), name: cpy.place + ' snapshot', title: cpy.place + ' snapshot' };
  const text = digest(c, now);
  const front = data.agents.find((x) => x.clinicKey === 'front');
  const recall = data.agents.find((x) => x.clinicKey === 'recall');
  const reviews = data.agents.find((x) => x.clinicKey === 'reviews');
  const social = data.agents.find((x) => x.clinicKey === 'social');
  const insights = data.agents.find((x) => x.clinicKey === 'insights');
  if (front) front.recs = [snap, ...(c.enquiries || []).slice(0, 30).map((e) => ({ name: e.name, title: 'Enquiry ' + e.name, phone: e.phone, channel: e.channel, message: e.message, status: e.status, at: Date.parse(e.at) || now })), ...(c.appointments || []).slice(0, 30).map((a) => ({ name: (c.patients.find((p) => p.id === a.patientId) || {}).name || 'Appointment', title: a.service, when: a.at, status: a.status, fee: a.fee, at: Date.parse(a.at) || now }))].slice(0, 70);
  if (recall) recall.recs = [snap, ...(c.patients || []).filter((p) => isLapsed(p, now) || isHighValue(p, c.role)).slice(0, 40).map((p) => ({ name: p.name, title: p.name, phone: p.phone, last_visit: p.lastVisit, value: p.value, lapsed: isLapsed(p, now) ? 'yes' : 'no', high_value: isHighValue(p, c.role) ? 'yes' : 'no', at: Date.parse(p.lastVisit) || now }))];
  if (reviews) reviews.recs = [snap, ...(c.drafts || []).filter((d) => d.kind === 'review').map((d) => ({ name: d.title, title: d.title, body: d.body, link: d.waLink, status: d.status, at: d.at }))];
  if (social) social.recs = [snap, ...(c.posts || []).map((p) => ({ name: 'Post', title: 'Social post', text: p.text, when: p.at, status: p.status, at: Date.parse(p.at) || now }))];
  if (insights) { insights.recs = [snap]; insights.kb = [{ title: 'Clinic numbers', at: now, text }]; }
  for (const p of c.patients || []) {
    const phone = digits(p.phone);
    let lead = crm.db.lead.find((l) => l && (l.clinic_patient_id === p.id || (phone && digits(l.phone) === phone)));
    const bits = String(p.name || '').trim().split(/\s+/);
    const row = { first_name: bits.shift() || 'Unknown', last_name: bits.join(' '), phone: p.phone || '', email: p.email || '', source: p.source || 'Clinic', status: 'New', notes: p.demo ? 'DEMO sample record. Not a real ' + copyFor(c.role).whoSingular + '.' : (p.notes || ''), tags: p.demo ? ['demo', 'clinic'] : ['clinic'], clinic_patient_id: p.id, interest: isLapsed(p, now) ? 'Recall' : '', upd: now };
    if (!lead) { lead = { id: crm.db.lead.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1, at: Date.parse(p.createdAt) || now, hist: [{ at: now, t: 'Added from the business team' }] }; crm.db.lead.unshift(lead); }
    Object.assign(lead, row);
  }
  data.rev = (Number(data.rev) || 0) + 1;
  return { ids, text };
}

const KEY = (email) => 'as_clinic:' + email;
const FKEY = (token) => 'as_cform:' + token;

async function load(st, email) {
  const c = parse((await st.get(KEY(email)))?.v, null);
  return c && typeof c === 'object' ? { ...blank(), ...c } : null;
}
async function save(st, email, c) {
  await st.put(KEY(email), JSON.stringify(c), Date.now());
  if (c.formToken) await st.put(FKEY(c.formToken), JSON.stringify({ email }), Date.now());
}
async function loadData(st, email) { return parse((await st.get('as_data:' + email))?.v, null) || { agents: [], rev: 0 }; }
async function saveData(st, email, data) { await st.put('as_data:' + email, JSON.stringify(data), Date.now()); }

export async function forgetClinic(st, email) {
  const c = parse((await st.get(KEY(email)))?.v, null);
  const keys = [KEY(email), USE(email)];
  if (c && /^[a-f0-9]{32}$/.test(c.formToken || '')) keys.push(FKEY(c.formToken));
  const payIds = new Set(Array.isArray(c && c.payIds) ? c.payIds : []);
  for (const inv of (c && c.invoices) || []) if (inv && inv.payId) payIds.add(inv.payId);
  for (const id of payIds) if (/^plink_[A-Za-z0-9]{1,40}$/.test(id)) keys.push('as_cpay:' + id);
  for (const id of (c && c.payEvents) || []) if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) keys.push('as_cpayev:' + id);
  for (const phone of (c && c.waPhones) || []) if (/^\d{8,15}$/.test(phone)) keys.push('as_cwaphone:' + phone);
  for (const id of (c && c.waIds) || []) if (/^[A-Za-z0-9._=-]{1,160}$/.test(id)) keys.push('as_cwamid:' + id);
  if (st.delMany) await st.delMany(keys);
  else for (const k of keys) { if (st.del) await st.del(k); else await st.put(k, null, Date.now()); }
}

function cleanName(v) { const s = clip(v, 80); if (s.length < 2) throw new Error('Give a name.'); return s; }
function cleanPhone(v) { const s = clip(v, 24); if (s && !/^\+?[0-9 ()\-.]{8,24}$/.test(s)) throw new Error('Phone should be digits, spaces, + or -.'); return s; }
function cleanEmail(v) { const s = String(v || '').trim().toLowerCase().slice(0, 200); if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error('Email is not valid.'); return s; }

function view(c, now, extras = {}) {
  const s = statsOf(c, now);
  const cpy = copyFor(c.role || 'dental');
  const spec = c.role ? copyFor(c.role).agents : [];
  const week = { start: s.weekStart, end: s.weekEnd };
  const agents = spec.map((a) => {
    const mine = (c.drafts || []).filter((d) => d.agent === a.key);
    return {
      ...a, paused: !!(c.paused && c.paused[a.key]),
      done: mine.filter((d) => d.status === 'approved' && inDates(d.decidedAt || d.at, week.start, week.end)).length,
      waiting: mine.filter((d) => d.status === 'pending').length + (a.key === 'front' ? (c.appointments || []).filter((x) => x.reminder && x.reminder.status === 'queued').length : 0),
      scheduled: a.key === 'social' ? (c.posts || []).filter((p) => p.status === 'scheduled' || p.status === 'draft').length : mine.filter((d) => d.status === 'pending').length,
    };
  });
  const pending = (c.drafts || []).filter((d) => d.status === 'pending');
  return {
    product: 'AaaS', hero: HERO, role: c.role || '', roleTitle: cpy.title, demo: !!c.demo, plan: c.plan || '',
    sample: (c.patients || []).some((p) => p.demo), biz: c.biz, city: c.city, phone: c.phone,
    pitch: cpy.pitch, profile: c.profile || blank().profile, checklist: checklistOf(c, now),
    labels: { who: cpy.who, whoSingular: cpy.whoSingular, visit: cpy.visit, booking: cpy.booking, noshow: cpy.noshow, recall: cpy.recall, revenue: cpy.revenue, service: cpy.visitName, place: cpy.place || 'business', highValue: cpy.highValue, example: cpy.post1, agents: spec.map((a) => a.name) },
    rules: rulesOf(c), agents, stats: s, summary: c.summary, forecast: forecastOf(c, now),
    toneExamples: (c.toneExamples || []).slice(0, 12),
    patients: c.patients, appointments: c.appointments, enquiries: c.enquiries, drafts: c.drafts, posts: c.posts,
    invoices: (c.invoices || []).map((inv) => ({ ...inv, total: invoiceTotal(inv), state: invoiceState(inv, now) })),
    pending: pending.sort((a, b) => (b.at || 0) - (a.at || 0)),
    connections: c.role ? connections(c) : [],
    plans: PLANS, pricing: pricingPublic(), packs: publicPacks(),
    whatsapp: waPublic(),
    setupCall: c.setupCall || null,
    setup: c.setup || null,
    formPath: c.formToken ? '/book/' + c.formToken : '',
    visit: visitView(c),
    chief: chiefBrief(c, now),
    ...extras,
  };
}

function checklistOf(c, now) {
  const imported = (c.patients || []).some((p) => p && p.demo === false);
  const approved = (c.drafts || []).some((d) => d.status === 'approved');
  return [
    { id: 'import', title: 'Import your records', detail: 'Upload a CSV of people and visits, or wait for the website form. Sample rows do not count.', done: imported },
    { id: 'form', title: 'Connect the booking form', detail: 'Copy the form link onto your website. It writes into this account only.', done: !!(c.checklist && c.checklist.form) },
    { id: 'approve', title: 'Approve the first drafts', detail: 'Outbound notes stay here until you approve them. Approving still sends nothing.', done: approved },
  ];
}

function waConnection(c) {
  const wa = waPublic();
  if (wa.configured) {
    const name = wa.provider === 'gupshup' ? 'Gupshup' : 'Meta';
    return { id: 'whatsapp', name: 'WhatsApp Business (' + name + ')', detail: 'Approved drafts send as the template ' + wa.template + '. Opt-out is honoured. Nothing is sent before you approve.', status: 'ready' };
  }
  return { id: 'whatsapp', name: 'WhatsApp click-to-chat', detail: 'A wa.me link you open yourself. Official WhatsApp sends only after you approve, and only when a Meta or Gupshup key is set on the server.', status: 'ready', url: waMe(c.phone, 'Hi, I would like to book.') };
}
function connections(c) {
  const who = copyFor(c.role).who;
  return [
    { id: 'csv', name: 'CSV of ' + who + ' and visits', detail: 'The way in today. Upload the file you already keep.', status: 'ready' },
    { id: 'form', name: 'Website booking form', detail: 'Writes into this account. Nothing is emailed.', status: 'ready', url: '/book/' + c.formToken },
    waConnection(c),
    ekaConnection(c),
    otherConnection(c),
    { id: 'gcal', name: 'Google Calendar', detail: 'Coming soon. Bookings stay in AaaS until a calendar is connected.', status: 'placeholder', label: 'Coming soon' },
  ];
}

async function queueApproval(st, email, { aid, summary, request }) {
  const key = 'as_appr:' + email;
  const all = parse((await st.get(key))?.v, []) || [];
  const a = { id: 'a' + uid(), aid: aid || 'assistant', app: 'clinic', kind: 'draft', summary: clip(summary, 200), request: clip(request, 4000), status: 'pending', at: Date.now() };
  all.unshift(a);
  await st.put(key, JSON.stringify(all.slice(0, 200)), Date.now());
  return a;
}

function splitCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  row.push(cur); if (row.some((c) => String(c).trim())) rows.push(row);
  return rows;
}
export function parseCsv(text) {
  const lines = splitCsv(text).filter((r) => r.some((c) => String(c).trim()));
  if (lines.length < 2) throw new Error('Add a header row and at least one record.');
  const head = lines[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const out = [];
  for (const line of lines.slice(1)) {
    const o = {}; head.forEach((h, i) => { o[h] = line[i] == null ? '' : String(line[i]).trim(); });
    if (Object.values(o).some(Boolean)) out.push(o);
  }
  if (!out.length) throw new Error('The CSV has no records.');
  if (out.length > MAX_ROWS) throw new Error('Up to ' + MAX_ROWS + ' rows.');
  return out;
}

export function parsePaste(text) {
  const rows = [];
  for (const line of String(text || '').split(/\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 2 || /^name$/i.test(parts[0])) continue;
    if (!parts[0] || !parts[1]) continue;
    rows.push({ type: 'patient', name: parts[0], phone: parts[1], email: parts[2] || '' });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

async function queueSetupDrafts(st, email, c, data) {
  const cpy = copyFor(c.role);
  const real = (c.patients || []).filter((p) => p && p.demo === false);
  const list = real.length ? real : (c.patients || []);
  const blocked = (p) => (c.drafts || []).some((d) => d.patientId === p.id && REMINDER_KINDS.has(d.kind) && d.status !== 'rejected');
  const person = list.find((p) => !blocked(p)) || null;
  const reviewFor = (real.length ? real : list).find((p) => p && (!person || p.id !== person.id)) || person || list[0] || null;
  const aid = (key) => ((data.agents || []).find((x) => x && x.clinicKey === key) || {}).id;
  const made = [];
  const push = async (agent, kind, title, body, phone, patientId) => {
    const waLink = phone ? waMe(phone, body) : '';
    const ap = await queueApproval(st, email, { aid: aid(agent), summary: title, request: body + (waLink ? '\n\nWhatsApp link (opens on your phone, nothing is sent by AaaS): ' + waLink : '') });
    const draft = { id: nid(c.drafts), agent, kind, patientId: patientId || null, title, body, waLink, status: 'pending', approvalId: ap.id, at: Date.now(), demo: !(real.length), setup: true };
    c.drafts.unshift(draft);
    made.push(draft);
  };
  if (person) {
    const follow = `Hi ${person.name}, it has been a while since your last ${cpy.visit} at ${c.biz}. Reply here and the desk will book you. This note waits for your approval.`;
    await push('recall', 'followup', 'Setup follow-up for ' + person.name, follow, person.phone, person.id);
  } else {
    const text = weeklySummaryText(c, Date.now());
    await push('insights', 'weekly', 'Setup weekly summary', text, c.phone, null);
  }
  if (reviewFor) {
    const review = `Hi ${reviewFor.name}, thank you for coming to ${c.biz}. If you have a minute, a Google review helps other ${cpy.who} find us. This note waits for your approval.`;
    await push('reviews', 'review', 'Setup review for ' + reviewFor.name, review, reviewFor.phone, reviewFor.id);
  }
  const post = `DRAFT intro for ${c.biz}${c.city ? ' in ' + c.city : ''}. ${c.profile && c.profile.services ? c.profile.services + '. ' : ''}The owner still has to approve this. Nothing is published.`;
  await push('social', 'post', 'Setup intro post', post, '', null);
  return made.slice(0, 3);
}

function sourceBits(source, row) {
  const bits = { source };
  if (source === EKA_SOURCE) bits.connector = 'eka';
  else if (source === OTHER_SOURCE) bits.connector = 'other';
  else bits.connector = '';
  if (row && row.external_id) bits.externalId = clip(String(row.external_id), 80);
  return bits;
}
function applyImport(c, rows, now, source = 'CSV') {
  let patients = 0, appointments = 0;
  const errors = [];
  for (const [i, row] of rows.entries()) {
    const type = String(row.type || '').toLowerCase();
    const isAppt = type === 'appointment' || type === 'visit' || (!type && row.when);
    try {
      if (!isAppt) {
        const name = cleanName(row.name || row.patient);
        const phone = cleanPhone(row.phone || '');
        if (!phone && !cleanEmail(row.email || '')) throw new Error('Give a phone or an email.');
        const email = cleanEmail(row.email || '');
        let p = c.patients.find((x) => (phone && digits(x.phone) === digits(phone)) || (email && x.email === email));
        const last = row.last_visit || row.lastvisit || '';
        const lastIso = last ? (Date.parse(last) ? new Date(Date.parse(last)).toISOString() : (() => { throw new Error('last_visit must be a date.'); })()) : '';
        const value = row.value || row.lifetime_value || row.fee || '';
        if (!p) { p = { id: nid(c.patients), createdAt: new Date(now).toISOString(), demo: false, source }; c.patients.unshift(p); patients++; }
        Object.assign(p, { name, phone: phone || p.phone || '', email: email || p.email || '', ...(lastIso ? { lastVisit: lastIso } : {}), ...(value !== '' ? { value: Number(String(value).replace(/[, ]/g, '')) || 0 } : {}), demo: false, ...sourceBits(source, row) });
      } else {
        const name = cleanName(row.name || row.patient);
        const phone = cleanPhone(row.phone || '');
        let p = c.patients.find((x) => x.name.toLowerCase() === name.toLowerCase() || (phone && digits(x.phone) === digits(phone)));
        if (!p) { p = { id: nid(c.patients), name, phone, email: cleanEmail(row.email || ''), createdAt: new Date(now).toISOString(), lastVisit: '', value: 0, demo: false, ...sourceBits(source, row) }; c.patients.unshift(p); patients++; }
        else Object.assign(p, sourceBits(source, row), { demo: false });
        const at = Date.parse(row.when || ''); if (!at) throw new Error('when must be a date-time.');
        const status = ['booked', 'completed', 'noshow', 'cancelled'].includes(String(row.status || 'booked').toLowerCase()) ? String(row.status || 'booked').toLowerCase() : 'booked';
        c.appointments.unshift({ id: nid(c.appointments), patientId: p.id, at: new Date(at).toISOString(), service: clip(row.service || 'Visit', 80), status, fee: Number(row.fee || 0) || 0, demo: false, reminder: null });
        appointments++;
      }
    } catch (e) { errors.push({ row: i + 2, message: e.message }); }
  }
  return { patients, appointments, errors };
}

function requireClinic(c, HttpError) { if (!c || !c.role) throw new HttpError(409, 'no_role', 'Pick a role first.'); return c; }

function bad(HttpError, e) {
  if (e instanceof HttpError) throw e;
  throw new HttpError(e.status || 400, e.code || 'bad_request', e.message || 'Check that and try again.');
}

async function mutate(ctx, fn) {
  const { st, email, withDataLock, HttpError } = ctx;
  return withDataLock(email, async () => {
    const c = requireClinic(await load(st, email), HttpError);
    const data = await loadData(st, email);
    try { await fn(c, data); } catch (e) { bad(HttpError, e); }
    const now = Date.now();
    syncWorkspace(data, c, now);
    if (!c.summary || c.summary.weekOf !== statsOf(c, now).weekStart) c.summary = { weekOf: statsOf(c, now).weekStart, text: baseSummary(c, statsOf(c, now)), at: now, demo: !!c.demo };
    await save(st, email, c);
    await saveData(st, email, data);
    return c;
  });
}

const hookHits = new Map();
function noteHook(key, HttpError) {
  const now = Date.now(), list = (hookHits.get(key) || []).filter((t) => now - t < 15 * 60e3);
  list.push(now); hookHits.set(key, list);
  if (list.length > 60) throw new HttpError(429, 'rate_limited', 'Too many connector posts. Try again in a few minutes.');
}
function hookSecretOk(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!want || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
async function ingestRows(st, email, rows, source, withDataLock, HttpError) {
  const result = { patients: 0, appointments: 0, errors: [] };
  await withDataLock(email, async () => {
    const c = await load(st, email);
    if (!c || !c.role) throw new HttpError(409, 'no_role', 'Pick an industry before syncing records.');
    const data = await loadData(st, email);
    const r = applyImport(c, rows, Date.now(), source);
    Object.assign(result, r);
    if (!r.patients && !r.appointments) throw new HttpError(400, 'bad_request', r.errors[0] ? r.errors[0].message : 'Nothing matched.');
    syncWorkspace(data, c, Date.now());
    await save(st, email, c);
    await saveData(st, email, data);
  });
  return result;
}

export async function clinicPublic({ method, pathname, body, headers = {}, query, ip, st, json, HttpError, getUsers, saveUsers, hashPassword, signToken, presentUser, withDataLock }) {
  if (pathname === '/api/clinic/payments/razorpay' && method === 'POST') return razorpayWebhook({ body, headers, st, HttpError, withDataLock });
  if (pathname === '/api/clinic/whatsapp/webhook') return whatsappWebhook({ method, body, headers, query, st, HttpError, withDataLock });
  if (pathname === '/api/clinic/meta' && method === 'GET') {
    const google = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    return { product: 'AaaS', hero: HERO, demoLogin: demoLoginAllowed(), email: demoLoginAllowed() ? DEMO_EMAIL : '', google, packs: publicPacks(), plans: PLANS, pricing: pricingPublic() };
  }
  if (pathname === '/api/clinic/demo' && method === 'POST') {
    if (!demoLoginAllowed()) throw new HttpError(404, 'not_found', 'The sample clinic sign-in is only on a local server.');
    const users = await getUsers(st);
    const email = DEMO_EMAIL;
    const prev = users[email];
    if (prev && prev.role && prev.role !== 'customer') throw new HttpError(409, 'exists', 'That email belongs to a staff account.');
    const sv = (prev && prev.sv) || 1;
    users[email] = { ...(prev || {}), name: (prev && prev.name) || 'Sample Clinic Owner', role: 'customer', hash: hashPassword(crypto.randomBytes(18).toString('base64url')), joined: (prev && prev.joined) || Date.now(), last: Date.now(), sv };
    await saveUsers(st, users);
    const token = await signToken(email, 'customer', sv);
    return { token, user: await presentUser(st, email, users[email]) };
  }
  const hook = pathname.match(/^\/api\/clinic\/connectors\/webhook\/([a-f0-9]{32})$/);
  if (hook) {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const want = String(process.env.CLINIC_CONNECTOR_WEBHOOK_SECRET || '');
    if (!want) throw new HttpError(404, 'not_found', 'This webhook is not turned on.');
    const got = headers['x-aaas-connector-secret'] || '';
    if (!hookSecretOk(got, want)) throw new HttpError(401, 'unauthorized', 'The connector secret does not match.');
    noteHook(hook[1], HttpError);
    const hit = parse((await st.get(FKEY(hook[1])))?.v, null);
    if (!hit || !hit.email) throw new HttpError(404, 'not_found', 'This connector link is not active.');
    const payload = typeof body === 'string' ? parse(body, {}) : (body || {});
    let rows;
    try { rows = payload && payload.csv ? parseCsv(String(payload.csv)) : rowsFromWebhook(payload); }
    catch (e) { bad(HttpError, e); }
    const result = await ingestRows(st, hit.email, rows, OTHER_SOURCE, withDataLock, HttpError);
    return { ok: true, source: OTHER_SOURCE, ...result };
  }
  const book = pathname.match(/^\/book\/([a-f0-9]{32})$/);
  const form = pathname.match(/^\/api\/clinic\/form\/([a-f0-9]{32})$/);
  const token = (book || form)?.[1];
  if (!token) return undefined;
  const hit = parse((await st.get(FKEY(token)))?.v, null);
  if (!hit || !hit.email) throw new HttpError(404, 'not_found', 'This booking form is not active.');
  if (method === 'GET') {
    const ref = query && typeof query.get === 'function' ? query.get('ref') : '';
    return { __html: formHtml(token, await load(st, hit.email), ref) };
  }
  if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  noteForm(ip, HttpError);
  const b = readForm(body, json);
  const name = cleanName(b.name);
  const phone = cleanPhone(b.phone || '');
  if (!phone) throw new HttpError(400, 'bad_request', 'Add a phone number so the desk can call back.');
  const email = cleanEmail(b.email || '');
  const message = clip(b.message || '', 1000);
  const serviceRaw = clip(b.service || '', 80);
  const when = b.when ? Date.parse(b.when) : 0;
  if (b.when && !when) throw new HttpError(400, 'bad_request', 'The time is not a valid date.');
  const out = await withDataLock(hit.email, async () => {
    const c = requireClinic(await load(st, hit.email), HttpError);
    assertWritable(c, HttpError);
    const data = await loadData(st, hit.email);
    const service = serviceRaw || copyFor(c.role).visitName || 'Visit';
    const referrer = referralOf(c, b.ref);
    const source = referrer ? 'Referral' : 'Website form';
    let p = c.patients.find((x) => digits(x.phone) === digits(phone));
    if (!p) { p = { id: nid(c.patients), name, phone, email, lastVisit: '', value: 0, createdAt: new Date().toISOString(), demo: false, source }; ensureRef(p); c.patients.unshift(p); }
    else { p.name = name; if (email) p.email = email; ensureRef(p); }
    const enq = { id: nid(c.enquiries), name, phone, email, channel: 'Website', message: message || service, status: when ? 'booked' : 'new', at: new Date().toISOString(), demo: false, source, referredBy: referrer ? referrer.name : '' };
    c.enquiries.unshift(enq);
    let appointmentId = null;
    if (when) {
      const a = { id: nid(c.appointments), patientId: p.id, at: new Date(when).toISOString(), service, status: 'booked', fee: 0, demo: false, reminder: null, referral: !!referrer, referredBy: referrer ? referrer.name : '' };
      c.appointments.unshift(a); appointmentId = a.id;
    }
    syncWorkspace(data, c, Date.now());
    await save(st, hit.email, c); await saveData(st, hit.email, data);
    return { enquiryId: enq.id, appointmentId };
  });
  if (book) return { __html: thanksHtml() };
  return { ok: true, ...out };
}

const formHits = new Map();
function noteForm(ip, HttpError) {
  const now = Date.now(), list = (formHits.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  list.push(now); formHits.set(ip, list);
  if (list.length > 30) throw new HttpError(429, 'rate_limited', 'Too many form submissions. Try again in a few minutes.');
}
function readForm(body, json) {
  if (typeof body === 'string' && body.trim().startsWith('{')) return json();
  if (typeof body === 'string' && body.includes('=')) return Object.fromEntries(new URLSearchParams(body).entries());
  return json();
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function safeRef(ref) { const s = String(ref || '').trim().toLowerCase(); return /^[a-f0-9]{10}$/.test(s) ? s : ''; }
function referralOf(c, code) {
  const ref = safeRef(code);
  if (!ref) return null;
  return (c.patients || []).find((p) => ensureRef(p) === ref) || null;
}
function formHtml(token, c, ref) {
  const cpy = copyFor(c && c.role);
  const visit = cpy.visit || 'visit';
  const service = cpy.visitName || 'Visit';
  const code = safeRef(ref);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book — AaaS</title>
<style>body{margin:0;font:16px/1.45 "Segoe UI",system-ui,sans-serif;background:#f4f6f8;color:#1b2430}main{max-width:440px;margin:48px auto;background:#fff;border:1px solid #e7eaee;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#5c6b7a;margin:0 0 16px}label{display:block;font-size:13px;margin:12px 0 4px}input,textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dbe3;border-radius:8px;font:inherit;font-size:16px}button{margin-top:16px;background:#0b5fff;color:#fff;border:0;border-radius:8px;padding:12px 16px;font:inherit;cursor:pointer;min-height:44px}small{display:block;margin-top:12px;color:#5c6b7a}@media (max-width:800px){main{margin:12px auto;padding:16px}h1{font-size:22px}}</style></head>
<body><main><h1>Book a ${esc(visit)}</h1><p>Tell the desk what you need. This form only saves the enquiry. It does not send a text or an email.</p>
<form method="post" action="/book/${esc(token)}"><label>Name</label><input name="name" required maxlength="80"><label>Phone</label><input name="phone" required maxlength="24"><label>What do you need?</label><textarea name="message" rows="3" maxlength="1000"></textarea><label>Preferred time (optional)</label><input name="when" type="datetime-local"><input type="hidden" name="service" value="${esc(service)}"><input type="hidden" name="ref" value="${esc(code)}"><button>Send to the desk</button></form>
<small>Sample rows are marked demo inside AaaS. Do not enter a private history.</small>
<script>try{var q=new URLSearchParams(location.search).get('ref')||'';var i=document.querySelector('input[name=ref]');if(i&&/^[a-f0-9]{10}$/i.test(q))i.value=q.toLowerCase()}catch(e){}</script>
</main></body></html>`;
}
async function razorpayWebhook({ body, headers, st, HttpError, withDataLock }) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '');
  if (!secret) throw new HttpError(404, 'not_found', 'This webhook is not turned on.');
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  let parsed;
  try {
    parsed = await readRazorpayWebhook({
      rawBody: raw, headers, secret,
      seen: async (id) => !!(parse((await st.get('as_cpayev:' + id))?.v, null) || {}).seen,
    });
  } catch (e) {
    throw new HttpError(e.status || 400, e.message === 'bad json' ? 'bad_request' : 'bad_signature', e.message || 'bad signature');
  }
  if (parsed.duplicate) return { ok: true, duplicate: true };
  const event = parsed.event || {};
  if (event.event !== 'payment_link.paid') return { ok: true, ignored: true };
  const plink = paymentLinkId(event);
  if (!/^plink_[A-Za-z0-9]{1,40}$/.test(plink)) throw new HttpError(400, 'bad_request', 'That payment link id is not valid.');
  const hit = parse((await st.get('as_cpay:' + plink))?.v, null);
  if (!hit || !hit.email) throw new HttpError(404, 'not_found', 'That payment link is not on file.');
  let paid = false;
  await withDataLock(hit.email, async () => {
    const c = await load(st, hit.email);
    if (!c) return;
    const inv = (c.invoices || []).find((x) => x.payId === plink || x.id === Number(hit.invoiceId));
    if (inv && inv.status !== 'paid') {
      inv.status = 'paid';
      inv.paidAt = new Date().toISOString();
      inv.paidVia = 'razorpay';
      paid = true;
    }
    if (parsed.id) {
      c.payEvents = Array.isArray(c.payEvents) ? c.payEvents : [];
      if (!c.payEvents.includes(parsed.id)) c.payEvents.push(parsed.id);
    }
    await save(st, hit.email, c);
  });
  if (parsed.id) await st.put('as_cpayev:' + parsed.id, JSON.stringify({ seen: true, email: hit.email }), Date.now());
  return { ok: true, paid };
}
function rememberWaPhone(c, phone) {
  const key = digits(phone);
  if (!/^\d{8,15}$/.test(key)) return '';
  c.waPhones = Array.isArray(c.waPhones) ? c.waPhones : [];
  if (!c.waPhones.includes(key)) c.waPhones.push(key);
  return key;
}
function waOptOf(c, phone) {
  const key = digits(phone);
  const row = c && c.waOpt && c.waOpt[key];
  return row && (row.status === 'in' || row.status === 'out') ? row.status : '';
}
async function deliverApprovedDraft(st, email, c, d) {
  const person = d.patientId ? (c.patients || []).find((x) => x.id === d.patientId) : null;
  const to = person ? person.phone : (d.kind === 'weekly' ? c.phone : '');
  const cfg = waEnv();
  const owner = !!(digits(to) && digits(c.phone) && digits(to) === digits(c.phone));
  const decision = sendDecision({ configured: cfg.configured, demo: !!c.demo, opt: person ? (person.waOpt || waOptOf(c, to)) : waOptOf(c, to), to, owner });
  if (!decision.send) {
    if (decision.reason === 'opt_out') return 'Approved. Not sent: this person has opted out of WhatsApp.';
    if (decision.reason === 'no_opt_in') return 'Approved. Not sent: there is no WhatsApp opt-in on file.';
    return '';
  }
  let sent;
  try { sent = await sendTemplate({ to, body: d.body }); }
  catch { d.waStatus = 'failed'; return 'Approved. WhatsApp did not accept the template. Nothing else was sent.'; }
  if (!sent || !sent.sent || !/^[A-Za-z0-9._=-]{1,160}$/.test(sent.id || '')) {
    d.waStatus = 'failed';
    return 'Approved. WhatsApp did not accept the template. Nothing else was sent.';
  }
  d.waMessageId = sent.id;
  d.waStatus = 'sent';
  d.waProvider = sent.provider;
  c.waIds = Array.isArray(c.waIds) ? c.waIds : [];
  if (!c.waIds.includes(sent.id)) c.waIds.push(sent.id);
  rememberWaPhone(c, to);
  await st.put('as_cwamid:' + sent.id, JSON.stringify({ email, draftId: d.id }), Date.now());
  await st.put('as_cwaphone:' + digits(to), JSON.stringify({ email }), Date.now());
  const who = sent.provider === 'gupshup' ? 'Gupshup' : 'Meta';
  return 'Sent on WhatsApp (' + who + '). Nothing else was emailed or posted.';
}
async function applyWaStatus(st, row, withDataLock) {
  if (!/^[A-Za-z0-9._=-]{1,160}$/.test(row.id || '')) return;
  const hit = parse((await st.get('as_cwamid:' + row.id))?.v, null);
  if (!hit || !hit.email) return;
  await withDataLock(hit.email, async () => {
    const c = await load(st, hit.email);
    if (!c) return;
    const d = (c.drafts || []).find((x) => x.waMessageId === row.id);
    if (d) d.waStatus = nextWaStatus(d.waStatus, row.status);
    await save(st, hit.email, c);
  });
}
async function applyWaInbound(st, msg, withDataLock) {
  const word = optWord(msg.text);
  if (!word || !/^\d{8,15}$/.test(msg.from || '')) return;
  const hit = parse((await st.get('as_cwaphone:' + msg.from))?.v, null);
  if (!hit || !hit.email) return;
  await withDataLock(hit.email, async () => {
    const c = await load(st, hit.email);
    if (!c) return;
    c.waOpt = c.waOpt && typeof c.waOpt === 'object' ? c.waOpt : {};
    c.waOpt[msg.from] = { status: word, at: new Date().toISOString(), source: 'whatsapp' };
    const person = (c.patients || []).find((p) => digits(p.phone) === msg.from);
    if (person) person.waOpt = word;
    rememberWaPhone(c, msg.from);
    await save(st, hit.email, c);
  });
}
async function whatsappWebhook({ method, body, headers, query, st, HttpError, withDataLock }) {
  const cfg = waEnv();
  if (!cfg.configured) throw new HttpError(404, 'not_found', 'This webhook is not turned on.');
  if (method === 'GET') {
    if (cfg.id !== 'meta') throw new HttpError(404, 'not_found', 'This webhook is not turned on.');
    const mode = query && query.get ? query.get('hub.mode') : '';
    const token = query && query.get ? query.get('hub.verify_token') : '';
    const challenge = query && query.get ? query.get('hub.challenge') : '';
    if (mode !== 'subscribe' || !safeEqual(token, cfg.metaVerify)) throw new HttpError(403, 'bad_signature', 'Webhook verification failed.');
    if (!/^[\w.\-]{1,200}$/.test(String(challenge || ''))) throw new HttpError(400, 'bad_request', 'That challenge is not valid.');
    return { __text: String(challenge) };
  }
  if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const raw = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (cfg.id === 'meta') {
    if (!cfg.metaSecret) throw new HttpError(404, 'not_found', 'This webhook is not turned on.');
    if (!safeEqual(headers['x-hub-signature-256'] || '', metaSignature(raw, cfg.metaSecret))) throw new HttpError(401, 'bad_signature', 'Webhook signature does not match.');
  } else if (!cfg.webhookSecret || !safeEqual(headers['x-aaas-wa-secret'] || '', cfg.webhookSecret)) {
    throw new HttpError(cfg.webhookSecret ? 401 : 404, cfg.webhookSecret ? 'bad_signature' : 'not_found', cfg.webhookSecret ? 'Webhook signature does not match.' : 'This webhook is not turned on.');
  }
  let event;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_request', 'bad json'); }
  const parsed = parseWaWebhook(cfg.id, event);
  for (const row of parsed.statuses) await applyWaStatus(st, row, withDataLock);
  for (const msg of parsed.inbound) await applyWaInbound(st, msg, withDataLock);
  return { ok: true };
}
function thanksHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Received — AaaS</title>
<style>body{margin:0;font:16px/1.45 "Segoe UI",system-ui,sans-serif;background:#f4f6f8;color:#1b2430}main{max-width:440px;margin:48px auto;background:#fff;border:1px solid #e7eaee;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#5c6b7a}</style></head>
<body><main><h1>Received</h1><p>The desk has the enquiry. Nothing was emailed or texted. Someone on the team will confirm.</p></main></body></html>`;
}

export async function clinicRoutes(ctx) {
  const { method, pathname, st, email, HttpError, json, ip, secret, wpSearch, wpChunks, withDataLock, userName, staff } = ctx;
  const ai = async (...args) => {
    const card = await byokSummary(st, email, secret);
    const msg = clinicAiBlock(card);
    if (msg) throw new HttpError(403, 'needs_ai_key', msg);
    return ctx.ai(...args);
  };
  if (staff) throw new HttpError(403, 'customers_only', 'The clinic team is for customer accounts.');
  const now = Date.now();
  const body = method === 'GET' ? {} : json();
  if (method === 'POST' && pathname !== '/api/clinic/plan' && pathname !== '/api/clinic/setup/call') {
    const existing = await load(st, email);
    if (existing && existing.role) assertWritable(existing, HttpError, now);
  }

  if (pathname === '/api/clinic' && method === 'GET') {
    let c = await load(st, email);
    if (!c || !c.role) return { product: 'AaaS', hero: HERO, role: '', needsRole: true, pitch: HERO, profile: (c && c.profile) || blank().profile, packs: publicPacks(), plans: PLANS, pricing: pricingPublic(), setupCall: (c && c.setupCall) || null };
    return presentClinic(st, email, c, now, {}, secret);
  }
  if (pathname === '/api/clinic/plan' && method === 'POST') {
    const id = String(body.plan || '');
    if (!PLANS.some((p) => p.id === id)) throw new HttpError(400, 'bad_plan', 'Pick a plan from the list.');
    await withDataLock(email, async () => {
      const cur = requireClinic(await load(st, email), HttpError);
      cur.plan = id;
      await save(st, email, cur);
    });
    const saved = await load(st, email);
    return presentClinic(st, email, saved, now, {}, secret);
  }
  if (pathname === '/api/clinic/profile' && method === 'POST') {
    await withDataLock(email, async () => {
      const cur = await load(st, email) || blank();
      const data = await loadData(st, email);
      cur.biz = clip(body.biz || body.name || cur.biz, 80);
      cur.city = clip(body.city || cur.city, 80);
      cur.profile = {
        services: clip(body.services ?? cur.profile?.services, 400),
        prices: clip(body.prices ?? cur.profile?.prices, 400),
        audience: clip(body.audience ?? cur.profile?.audience, 400),
        offer: clip(body.offer ?? cur.profile?.offer, 400),
        upi: clip(body.upi ?? cur.profile?.upi, 80),
        payLink: clip(body.payLink ?? cur.profile?.payLink, 300),
      };
      if (cur.profile.upi) cur.phone = cur.phone || '';
      await save(st, email, cur);
      if (cur.role) { syncWorkspace(data, cur, now); await saveData(st, email, data); }
    });
    const saved = await load(st, email);
    return saved.role ? presentClinic(st, email, saved, now, {}, secret) : { ok: true, profile: saved.profile, biz: saved.biz, city: saved.city };
  }
  if (pathname === '/api/clinic/role' && method === 'POST') {
    const role = packOf(body.role) ? body.role : '';
    if (!role) throw new HttpError(400, 'bad_role', 'Pick an industry.');
    const c = await withDataLock(email, async () => {
      let cur = await load(st, email) || blank();
      const data = await loadData(st, email);
      const first = !cur.role;
      const prev = cur.role;
      const kept = cur.profile && (cur.profile.services || cur.biz);
      cur.role = role;
      const switching = !!(prev && prev !== role);
      const demoAccount = email === DEMO_EMAIL || !!cur.demo;
      const keepTrial = cur.trialStarted || 0;
      const keepPlan = cur.plan || '';
      const keepCall = cur.setupCall || null;
      const keepSetup = cur.setup || null;
      const keepPhone = cur.phone || '';
      if (!cur.patients.length || (switching && (demoAccount || sampleOnly(cur)))) {
        const seeded = buildSeed(role, now);
        const token = cur.formToken;
        const prevBiz = prev ? copyFor(prev).biz : '';
        if (demoAccount) seeded.demo = true;
        else {
          seeded.demo = false;
          for (const inv of seeded.invoices || []) if (inv && inv.payMode === 'demo') { inv.payMode = 'upi'; inv.payId = ''; }
          const namedByOwner = !!(cur.biz && cur.biz !== prevBiz);
          if (namedByOwner) seeded.biz = cur.biz;
          if (cur.city) seeded.city = cur.city;
          if (!switching && kept) {
            seeded.biz = cur.biz || seeded.biz;
            seeded.city = cur.city || seeded.city;
            seeded.profile = { ...seeded.profile, ...(cur.profile || {}) };
          }
        }
        if (switching && cur.rules) seeded.rules = { ...seeded.rules, ...rulesOf(cur) };
        if (switching && Array.isArray(cur.toneExamples) && cur.toneExamples.length) seeded.toneExamples = cur.toneExamples;
        if (switching && cur.checklist) seeded.checklist = cur.checklist;
        if (switching && cur.paused && Object.keys(cur.paused).length) seeded.paused = cur.paused;
        cur = { ...seeded, role, formToken: token || seeded.formToken, demo: seeded.demo, plan: keepPlan, trialStarted: seeded.demo ? 0 : (keepTrial || now) };
        if (keepCall) cur.setupCall = keepCall;
        if (keepSetup) cur.setup = keepSetup;
        if (keepPhone) cur.phone = keepPhone;
      } else {
        const cpy = copyFor(role);
        cur.city = cur.city || cpy.city;
        cur.rules = { ...(cur.rules || blank().rules), tone: (cur.rules && cur.rules.tone) || cpy.tone };
      }
      if (!cur.formToken) cur.formToken = crypto.randomBytes(16).toString('hex');
      if (!cur.demo && !cur.trialStarted) cur.trialStarted = now;
      const s = statsOf(cur, now);
      const base = baseSummary(cur, s);
      const extra = await polish(ai, ip, base);
      cur.summary = { weekOf: s.weekStart, text: extra ? base + '\n\n' + extra : base, at: now, demo: !!cur.demo };
      syncWorkspace(data, cur, now);
      await save(st, email, cur); await saveData(st, email, data);
      if (cur.demo) await ensureSampleRuns(st, email);
      return { cur, first };
    });
    // Seeded drafts need approval rows. Create them once, when the id is still empty.
    await withDataLock(email, async () => {
      const cur = await load(st, email);
      const data = await loadData(st, email);
      const ids = {};
      for (const a of data.agents || []) if (a && a.clinicKey) ids[a.clinicKey] = a.id;
      let changed = false;
      for (const d of cur.drafts || []) {
        if (d.status === 'pending' && !d.approvalId) {
          const a = await queueApproval(st, email, { aid: ids[d.agent] || 'assistant', summary: d.title, request: (d.body || '') + (d.waLink ? '\n\nWhatsApp link (opens on your phone, nothing is sent by AaaS): ' + d.waLink : '') });
          d.approvalId = a.id; changed = true;
        }
      }
      if (changed) { syncWorkspace(data, cur, Date.now()); await save(st, email, cur); await saveData(st, email, data); }
      return cur;
    });
    const saved = await load(st, email);
    return presentClinic(st, email, saved, Date.now(), { created: c.first }, secret);
  }

  if (pathname === '/api/clinic/import' && method === 'POST') {
    let rows; try { rows = parseCsv(String(body.csv || '')); } catch (e) { bad(HttpError, e); }
    const result = { patients: 0, appointments: 0, errors: [] };
    await mutate(ctx, (c) => { const r = applyImport(c, rows, now); Object.assign(result, r); if (!r.patients && !r.appointments) throw new Error(r.errors[0] ? r.errors[0].message : 'Nothing matched. Use a name and a phone, or a when column for visits.'); });
    return { ...result, clinic: await presentClinic(st, email, await load(st, email), Date.now(), {}, secret) };
  }

  if (pathname === '/api/clinic/enquiries' && method === 'POST') {
    let enq;
    await mutate(ctx, (c) => {
      const name = cleanName(body.name), phone = cleanPhone(body.phone || '');
      if (!phone && !cleanEmail(body.email || '')) throw new Error('Give a phone or an email.');
      enq = { id: nid(c.enquiries), name, phone, email: cleanEmail(body.email || ''), channel: clip(body.channel || 'Phone', 40), message: clip(body.message || '', 1000), status: 'new', at: new Date().toISOString(), demo: false, source: 'Desk' };
      c.enquiries.unshift(enq);
    });
    return { enquiry: enq };
  }
  if (pathname === '/api/clinic/enquiries/update' && method === 'POST') {
    await mutate(ctx, (c) => {
      const e = c.enquiries.find((x) => x.id === Number(body.id)); if (!e) { const err = new Error('That enquiry is not on file.'); err.status = 404; err.code = 'not_found'; throw err; }
      if (body.name != null) e.name = cleanName(body.name);
      if (body.phone != null) e.phone = cleanPhone(body.phone);
      if (body.email != null) e.email = cleanEmail(body.email);
      if (body.message != null) e.message = clip(body.message, 1000);
      if (body.channel != null) e.channel = clip(body.channel, 40);
      if (body.status != null) { if (!['new', 'booked', 'closed'].includes(body.status)) throw new Error('Status must be new, booked or closed.'); e.status = body.status; }
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/enquiries/delete' && method === 'POST') {
    await mutate(ctx, (c) => {
      const i = c.enquiries.findIndex((x) => x.id === Number(body.id)); if (i < 0) { const err = new Error('That enquiry is not on file.'); err.status = 404; throw err; }
      c.enquiries.splice(i, 1);
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/appointments' && method === 'POST') {
    let ap;
    await mutate(ctx, (c) => {
      const p = c.patients.find((x) => x.id === Number(body.patientId)); if (!p) throw new Error('Pick someone who is already on file, or add them first.');
      const at = Date.parse(body.at || ''); if (!at) throw new Error('Give a date and time.');
      const status = ['booked', 'completed', 'noshow', 'cancelled'].includes(body.status) ? body.status : 'booked';
      ap = { id: nid(c.appointments), patientId: p.id, at: new Date(at).toISOString(), service: clip(body.service || copyFor(c.role).visitName, 80), status, fee: Math.max(0, Number(body.fee) || 0), demo: false, reminder: null };
      c.appointments.unshift(ap);
    });
    return { appointment: ap };
  }
  if (pathname === '/api/clinic/appointments/update' && method === 'POST') {
    await mutate(ctx, (c) => {
      const a = c.appointments.find((x) => x.id === Number(body.id)); if (!a) { const err = new Error('That appointment is not on file.'); err.status = 404; throw err; }
      if (body.at != null) { const t = Date.parse(body.at); if (!t) throw new Error('Give a date and time.'); a.at = new Date(t).toISOString(); }
      if (body.service != null) a.service = clip(body.service, 80);
      if (body.fee != null) a.fee = Math.max(0, Number(body.fee) || 0);
      if (body.status != null) { if (!['booked', 'completed', 'noshow', 'cancelled'].includes(body.status)) throw new Error('Status must be booked, completed, noshow or cancelled.'); a.status = body.status; }
      if (body.patientId != null) { const p = c.patients.find((x) => x.id === Number(body.patientId)); if (!p) throw new Error('That person is not on file.'); a.patientId = p.id; }
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/appointments/delete' && method === 'POST') {
    await mutate(ctx, (c) => {
      const i = c.appointments.findIndex((x) => x.id === Number(body.id)); if (i < 0) { const err = new Error('That appointment is not on file.'); err.status = 404; throw err; }
      c.appointments.splice(i, 1);
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/reminders' && method === 'POST') {
    let draft;
    await mutate(ctx, async (c, data) => {
      const a = c.appointments.find((x) => x.id === Number(body.appointmentId)); if (!a) throw new Error('That appointment is not on file.');
      const p = c.patients.find((x) => x.id === a.patientId);
      const rules = reminderGate(c, p ? p.id : null, Date.now());
      const who = p ? p.name : copyFor(c.role).whoSingular;
      const stock = `Reminder for ${who}: ${a.service} on ${istDate(Date.parse(a.at))} at ${c.biz}. Reply if you need another time. Send window ${rules.from}–${rules.to}. Quiet hours are outside that window. AaaS does not send this.`;
      const text = shapeWithTone(c, 'front', p && p.name, stock);
      const aid = ((data.agents || []).find((x) => x.clinicKey === 'front') || {}).id;
      const ap = await queueApproval(st, email, { aid, summary: 'Reminder queued for ' + (p ? p.name : 'appointment'), request: text + (p ? '\n\nWhatsApp link (you open it, AaaS does not send): ' + waMe(p.phone, text) : '') });
      a.reminder = { status: 'queued', approvalId: ap.id, at: Date.now() };
      draft = { id: nid(c.drafts), agent: 'front', kind: 'reminder', patientId: p ? p.id : null, appointmentId: a.id, title: 'Reminder for ' + (p ? p.name : 'a visit'), body: text, waLink: p ? waMe(p.phone, text) : '', status: 'pending', approvalId: ap.id, at: Date.now(), demo: !!c.demo };
      c.drafts.unshift(draft);
    });
    return { draft };
  }
  if (pathname === '/api/clinic/recall/draft' && method === 'POST') return draftFor(ctx, 'recall', 'followup', body.patientId, (c, p) => {
    const cpy = copyFor(c.role);
    reminderGate(c, p.id, Date.now());
    const stock = `Hi ${p.name}, it has been a while since your last ${cpy.visit}${p.lastVisit ? ' on ' + istDate(Date.parse(p.lastVisit)) : ''}. ${c.biz} can book you in. Reply and the desk will confirm. Nothing is sent until you approve this draft.`;
    return { title: 'Follow-up for ' + p.name, body: shapeWithTone(c, 'recall', p.name, stock) };
  });
  if (pathname === '/api/clinic/reviews/draft' && method === 'POST') return draftFor(ctx, 'reviews', 'review', body.patientId, (c, p) => {
    const cpy = copyFor(c.role);
    const stock = `Hi ${p.name}, thank you for coming to ${c.biz}. If it went well, a Google review helps other people find this ${cpy.place}. AaaS will not text or email this.`;
    return { title: 'Review request for ' + p.name, body: shapeWithTone(c, 'reviews', p.name, stock) };
  });
  if (pathname === '/api/clinic/referrals/draft' && method === 'POST') return draftFor(ctx, 'social', 'referral', body.patientId, (c, p) => {
    const cpy = copyFor(c.role);
    const link = bookLink(c, ensureRef(p));
    const stock = `I have been coming to ${c.biz}. If you would like a ${cpy.visitName}, book with my link: ${link}. Forward this on WhatsApp.`;
    return { title: 'Forwardable referral for ' + p.name, body: shapeWithTone(c, 'social', p.name, stock, 'referral') };
  });
  if (pathname === '/api/clinic/social/draft' && method === 'POST') {
    const topic = clip(body.topic || 'this week', 160);
    const when = body.when && Date.parse(body.when) ? new Date(Date.parse(body.when)).toISOString() : istStamp(addDays(weekRange(now).end, 1), 9);
    const known = await load(st, email);
    const cpy = copyFor(known && known.role);
    let text = '';
    if (llmReady()) {
      try {
        const r = await ai(`Topic: ${topic}. Write one short social post for ${known?.biz || cpy.biz} in ${known?.city || cpy.city}. This is a ${cpy.place}. Services: ${known?.profile?.services || cpy.services}. Prices: ${known?.profile?.prices || cpy.prices}. Audience: ${known?.profile?.audience || cpy.audience}. Offer: ${known?.profile?.offer || cpy.offer}.${toneHint(known || { toneExamples: [] })} Under 400 characters. No invented discounts, no hashtag spam. End with the word DRAFT. This post will not be published.`, ip, { max: 400, agent: 'social' });
        text = String(r.text || '').trim();
      } catch (e) { if (e.status !== 503 && e.code !== 'no_key') throw e; }
    }
    if (!text) text = `DRAFT (no AI key on this server): ${topic}. The owner still has to approve this. Nothing is published.`;
    let post;
    await mutate(ctx, async (c, data) => {
      const aid = ((data.agents || []).find((x) => x.clinicKey === 'social') || {}).id;
      const ap = await queueApproval(st, email, { aid, summary: 'Social post: ' + topic, request: text });
      post = { id: nid(c.posts), at: when, text, status: 'draft', approvalId: ap.id, topic, demo: !!c.demo };
      c.posts.unshift(post);
      c.drafts.unshift({ id: nid(c.drafts), agent: 'social', kind: 'post', title: 'Social post: ' + topic, body: text, waLink: '', status: 'pending', approvalId: ap.id, at: Date.now(), demo: !!c.demo });
    });
    return { post };
  }
  if (pathname === '/api/clinic/summary/weekly' && method === 'POST') {
    let draft;
    await mutate(ctx, async (c, data) => {
      const existing = (c.drafts || []).find((d) => d.kind === 'weekly' && d.status === 'pending');
      if (existing) { draft = existing; return; }
      const text = weeklySummaryText(c, Date.now());
      const aid = ((data.agents || []).find((x) => x.clinicKey === 'insights') || {}).id;
      const waLink = waMe(c.phone, text);
      const ap = await queueApproval(st, email, { aid, summary: 'Weekly WhatsApp summary', request: text + (waLink ? '\n\nWhatsApp link (opens on your phone, nothing is sent by AaaS): ' + waLink : '') });
      draft = { id: nid(c.drafts), agent: 'insights', kind: 'weekly', patientId: null, title: 'Weekly WhatsApp summary', body: text, waLink, status: 'pending', approvalId: ap.id, at: Date.now(), demo: !!c.demo };
      c.drafts.unshift(draft);
    });
    return { draft };
  }
  if (pathname === '/api/clinic/insights/refresh' && method === 'POST') {
    await mutate(ctx, async (c) => {
      const s = statsOf(c, now);
      const base = baseSummary(c, s);
      const extra = await polish(ai, ip, base);
      c.summary = { weekOf: s.weekStart, text: extra ? base + '\n\n' + extra : base, at: Date.now(), demo: !!c.demo };
    });
    return { summary: (await load(st, email)).summary };
  }
  if (pathname === '/api/clinic/rules' && method === 'POST') {
    await mutate(ctx, (c) => {
      const next = rulesOf({ rules: { ...rulesOf(c), ...body, ask: body.ask !== false && body.ask !== 'false' } });
      if (!/^\d{2}:\d{2}$/.test(next.from) || !/^\d{2}:\d{2}$/.test(next.to)) throw new Error('Use times like 09:00 and 20:00.');
      c.rules = next;
    });
    return { rules: (await load(st, email)).rules };
  }
  if (pathname === '/api/clinic/agent' && method === 'POST') {
    const key = String(body.key || '');
    if (!AGENT_KEYS.includes(key)) throw new HttpError(400, 'bad_agent', 'Unknown agent.');
    await mutate(ctx, (c) => { c.paused = c.paused || {}; c.paused[key] = !!body.paused; });
    return { ok: true, paused: !!(await load(st, email)).paused[key] };
  }
  if (pathname === '/api/clinic/drafts/edit' && method === 'POST') {
    await mutate(ctx, async (c) => {
      const d = (c.drafts || []).find((x) => x.id === Number(body.id) || x.approvalId === body.approvalId);
      if (!d || d.status !== 'pending') throw new Error('That draft is not waiting for approval.');
      const before = d.body;
      const after = clip(body.body || d.body, 4000);
      const person = d.patientId ? c.patients.find((x) => x.id === d.patientId) : null;
      rememberTone(c, d, before, after, person && person.name);
      d.body = after;
      if (person) d.waLink = waMe(person.phone, d.body);
      const all = parse((await st.get('as_appr:' + email))?.v, []) || [];
      const a = all.find((x) => x.id === d.approvalId);
      if (a && a.status === 'pending') { a.request = clip(d.body + (d.waLink ? '\n\nWhatsApp link (opens on your phone, nothing is sent by AaaS): ' + d.waLink : ''), 4000); a.edited = true; await st.put('as_appr:' + email, JSON.stringify(all), Date.now()); }
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/decide' && method === 'POST') {
    const id = String(body.id || body.approvalId || '');
    if (!['approve', 'reject'].includes(body.decision)) throw new HttpError(400, 'bad_decision', 'Decision must be approve or reject.');
    const out = await decideApproval({ st, email, id, approve: body.decision === 'approve', secret });
    let resultNote = '';
    if (out.error) throw new HttpError(404, 'not_found', 'That approval is not in the queue.');
    await withDataLock(email, async () => {
      const c = await load(st, email); if (!c) return;
      const data = await loadData(st, email);
      const ok = out.approval.status === 'done', no = out.approval.status === 'declined';
      for (const d of c.drafts || []) if (d.approvalId === id) {
        d.status = ok ? 'approved' : no ? 'rejected' : d.status; d.decidedAt = Date.now(); d.result = out.approval.result || '';
        if (ok && d.kind === 'followup' && d.patientId) {
          const person = (c.patients || []).find((x) => x.id === d.patientId);
          if (person && isConnectorSource(person.source)) person.broughtBack = true;
        }
        if (ok) {
          const note = await deliverApprovedDraft(st, email, c, d);
          if (note) { d.result = note; resultNote = note; }
        }
      }
      for (const p of c.posts || []) if (p.approvalId === id) { if (ok) p.status = 'scheduled'; if (no) p.status = 'rejected'; }
      for (const a of c.appointments || []) if (a.reminder && a.reminder.approvalId === id) { a.reminder.status = ok ? 'approved' : no ? 'rejected' : a.reminder.status; a.reminder.result = out.approval.result || ''; }
      for (const inv of c.invoices || []) if (inv.reminder && inv.reminder.approvalId === id) inv.reminder.status = ok ? 'approved' : no ? 'rejected' : inv.reminder.status;
      syncWorkspace(data, c, Date.now());
      await save(st, email, c); await saveData(st, email, data);
    });
    if (resultNote) {
      const all = parse((await st.get('as_appr:' + email))?.v, []) || [];
      const a = all.find((x) => x.id === id);
      if (a) { a.result = resultNote; await st.put('as_appr:' + email, JSON.stringify(all), Date.now()); }
    }
    return { approval: { id: out.approval.id, status: out.approval.status, result: resultNote || out.approval.result || '' } };
  }
  if (pathname === '/api/clinic/whatsapp/opt' && method === 'POST') {
    const status = body.status === 'out' ? 'out' : body.status === 'in' ? 'in' : '';
    if (!status) throw new HttpError(400, 'bad_request', 'Opt in or opt out.');
    await mutate(ctx, async (c) => {
      const person = (c.patients || []).find((x) => x.id === Number(body.patientId));
      if (!person) throw new Error('That person is not on file.');
      const key = rememberWaPhone(c, person.phone);
      if (!key) throw new Error('That phone is not a WhatsApp number.');
      c.waOpt = c.waOpt && typeof c.waOpt === 'object' ? c.waOpt : {};
      c.waOpt[key] = { status, at: new Date().toISOString(), source: 'owner' };
      person.waOpt = status;
      await st.put('as_cwaphone:' + key, JSON.stringify({ email }), Date.now());
    });
    return { ok: true, status };
  }
  if (pathname === '/api/clinic/connectors/sync' && method === 'POST') {
    if (String(body.provider || 'eka') !== 'eka') throw new HttpError(400, 'bad_request', 'Sync Eka.care here. Other software uses CSV or the webhook.');
    const current = requireClinic(await load(st, email), HttpError);
    if (current.demo) {
      const s = statsOf(current, now);
      return { ok: true, mode: 'demo', label: 'Connected (demo)', calledNetwork: false, patients: s.fromSoftware, broughtBackInr: s.broughtBackInr };
    }
    let pulled;
    try { pulled = await pullEka(); }
    catch (e) { throw new HttpError(e.status && e.status < 500 ? e.status : 502, 'connector_failed', e.message || 'Eka.care did not answer.'); }
    const result = await ingestRows(st, email, [...pulled.patients, ...pulled.appointments], EKA_SOURCE, withDataLock, HttpError);
    return { ok: true, mode: 'live', label: 'Connected', calledNetwork: true, ...result };
  }
  if (pathname === '/api/clinic/visit' && method === 'GET') return visitView(requireClinic(await load(st, email), HttpError));
  if (pathname === '/api/clinic/visit' && method === 'POST') {
    await mutate(ctx, (c) => { try { c.visit = normalizeVisit(body, now); } catch (e) { bad(HttpError, e); } });
    return { ok: true, visit: visitView(await load(st, email)) };
  }
  if (pathname === '/api/clinic/setup/call' && method === 'POST') {
    const name = cleanName(body.name);
    const phone = cleanPhone(body.phone || '');
    if (!phone) throw new HttpError(400, 'bad_request', 'Add a phone number for the call.');
    const when = clip(body.when || '', 80);
    if (!when) throw new HttpError(400, 'bad_request', 'Add a time that suits you.');
    await withDataLock(email, async () => {
      const cur = await load(st, email) || blank();
      cur.setupCall = { name, phone, when, note: clip(body.note || '', 400), at: new Date().toISOString() };
      await save(st, email, cur);
    });
    const saved = await load(st, email);
    return { ok: true, sent: false, setupCall: saved.setupCall };
  }
  if (pathname === '/api/clinic/setup/finish' && method === 'POST') {
    let drafts = [];
    await mutate(ctx, async (c, data) => {
      const keyCard = await byokSummary(st, email, secret);
      const demoContinue = demoPlatformKey() && (body.demoKey === true || body.demoKey === 'true');
      if (keyCard.source !== 'own' && !demoContinue) throw new HttpError(400, 'needs_ai_key', 'Save your AI key before the setup can finish. Agent calls use that key, and you pay your provider directly.');
      if (body.phone) {
        const phone = cleanPhone(body.phone);
        if (phone) c.phone = phone;
      }
      if (body.tone) c.rules = { ...rulesOf(c), tone: clip(body.tone, 240) };
      c.setup = { ...(c.setup || {}), ack: body.ack !== false && body.ack !== 'false', at: Date.now(), minutes: 15 };
      if (body.paste) {
        const rows = parsePaste(body.paste);
        if (rows.length) applyImport(c, rows, Date.now(), 'Paste');
      }
      if (body.csv) {
        let rows; try { rows = parseCsv(String(body.csv)); } catch (e) { bad(HttpError, e); }
        if (rows.length) applyImport(c, rows, Date.now(), 'CSV');
      }
      const pending = (c.drafts || []).filter((d) => d.setup && d.status === 'pending');
      drafts = pending.length >= 3 ? pending.slice(0, 3) : await queueSetupDrafts(st, email, c, data);
    });
    return { drafts, clinic: await presentClinic(st, email, await load(st, email), Date.now(), {}, secret) };
  }
  if (pathname === '/api/clinic/checklist' && method === 'POST') {
    const id = String(body.id || '');
    if (id !== 'form') throw new HttpError(400, 'bad_request', 'That step is completed by importing or by approving a draft.');
    await mutate(ctx, (c) => { c.checklist = { ...(c.checklist || {}), form: true }; });
    return { checklist: checklistOf(await load(st, email), Date.now()) };
  }
  if (pathname === '/api/clinic/invoices' && method === 'POST') {
    let inv;
    await mutate(ctx, async (c) => {
      const p = c.patients.find((x) => x.id === Number(body.patientId));
      if (!p) throw new Error('Pick someone who is already on file.');
      const items = cleanItems(body.items);
      const gst = body.gst == null || String(body.gst).trim() === '' ? null : Number(body.gst);
      if (gst != null && (!Number.isFinite(gst) || gst < 0 || gst > 100)) throw new Error('GST is a percent, or leave it blank. There is no GSTIN on file.');
      const due = body.due ? Date.parse(body.due) : Date.now() + 7 * DAY;
      if (!due) throw new Error('The due date is not valid.');
      const n = (c.invoices || []).reduce((m, x) => Math.max(m, Number(String(x.number || '').replace(/\D/g, '')) || 0), 1000) + 1;
      inv = {
        id: nid(c.invoices || []), number: 'INV-' + n, patientId: p.id, items, gst, status: 'unpaid',
        issuedAt: new Date().toISOString(), dueAt: new Date(due).toISOString(), paidAt: '',
        upi: clip(body.upi || c.profile?.upi || '', 80), payLink: clip(body.payLink || c.profile?.payLink || '', 300),
        demo: !!p.demo,
      };
      await attachPayment(c, inv, p, { amount: invoiceTotal(inv), st, email });
      c.invoices = c.invoices || [];
      c.invoices.unshift(inv);
    });
    return { invoice: { ...inv, total: invoiceTotal(inv), state: invoiceState(inv) } };
  }
  if (pathname === '/api/clinic/payments/simulate' && method === 'POST') {
    await mutate(ctx, (c) => {
      if (!c.demo) throw new Error('Simulate is only for the sample business. A live payment is marked paid by the Razorpay webhook.');
      const inv = (c.invoices || []).find((x) => x.id === Number(body.id));
      if (!inv) throw new Error('That invoice is not on file.');
      if (inv.status === 'paid') return;
      inv.status = 'paid';
      inv.paidAt = new Date().toISOString();
      inv.paidVia = 'demo';
    });
    return { ok: true, via: 'demo' };
  }
  if (pathname === '/api/clinic/invoices/update' && method === 'POST') {
    await mutate(ctx, (c) => {
      const inv = (c.invoices || []).find((x) => x.id === Number(body.id));
      if (!inv) throw new Error('That invoice is not on file.');
      if (body.status === 'paid') { inv.status = 'paid'; inv.paidAt = new Date().toISOString(); }
      else if (body.status === 'unpaid') { inv.status = 'unpaid'; inv.paidAt = ''; }
      else throw new Error('Mark it paid or unpaid.');
    });
    return { ok: true };
  }
  if (pathname === '/api/clinic/invoices/remind' && method === 'POST') {
    let draft;
    await mutate(ctx, async (c, data) => {
      const inv = (c.invoices || []).find((x) => x.id === Number(body.id));
      if (!inv) throw new Error('That invoice is not on file.');
      const p = c.patients.find((x) => x.id === inv.patientId);
      const total = invoiceTotal(inv);
      if (p) reminderGate(c, p.id, Date.now());
      const stock = `Hi ${p ? p.name : 'there'}, invoice ${inv.number} from ${c.biz} for ${money(total)} is ${invoiceState(inv)}. ${inv.upi ? 'UPI: ' + inv.upi + '. ' : ''}${inv.payLink ? 'Payment link: ' + inv.payLink + '. ' : ''}Email draft: this note can be copied into mail. AaaS does not send it.`;
      let text = shapeWithTone(c, 'billing', p && p.name, stock);
      if (inv.payLink && !text.includes(inv.payLink)) text = clip(text + ' Payment link: ' + inv.payLink + '.', 4000);
      const aid = ((data.agents || []).find((x) => x.clinicKey === 'billing') || {}).id;
      const wa = p ? waMe(p.phone, text) : '';
      const ap = await queueApproval(st, email, { aid, summary: 'Payment reminder ' + inv.number, request: text + (wa ? '\n\nWhatsApp link (you open it, AaaS does not send): ' + wa : '') });
      inv.reminder = { status: 'queued', approvalId: ap.id, at: Date.now() };
      draft = { id: nid(c.drafts), agent: 'billing', kind: 'payment', patientId: p ? p.id : null, invoiceId: inv.id, title: 'Payment reminder ' + inv.number, body: text, waLink: wa, status: 'pending', approvalId: ap.id, at: Date.now(), demo: !!inv.demo };
      c.drafts.unshift(draft);
    });
    return { draft };
  }
  const printId = pathname.match(/^\/api\/clinic\/invoices\/(\d+)\/(print|pdf)$/);
  if (printId && method === 'GET') {
    const c = requireClinic(await load(st, email), HttpError);
    const inv = (c.invoices || []).find((x) => x.id === Number(printId[1]));
    if (!inv) throw new HttpError(404, 'not_found', 'That invoice is not on file.');
    const lines = invoiceLines(c, inv);
    if (printId[2] === 'pdf') return { __bytes: invoicePdf(lines), __type: 'application/pdf', __name: (inv.number || 'invoice') + '.pdf' };
    const bodyHtml = lines.map((l) => `<p>${esc(l)}</p>`).join('');
    return { __html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>body{font:15px/1.45 system-ui,sans-serif;color:#1b2430;margin:32px}p{margin:4px 0}@media print{.no{display:none}}</style></head><body><button class="no" onclick="print()">Print or save as PDF</button>${bodyHtml}</body></html>` };
  }
  if (pathname === '/api/clinic/usage' && method === 'GET') {
    const aiKey = await byokSummary(st, email, secret);
    return { usage: await clinicUsage(st, email, await load(st, email), aiKey), aiKey, plans: PLANS, pricing: pricingPublic(), inrPerUsd: INR_PER_USD };
  }
  if (pathname === '/api/clinic/tone/reset' && method === 'POST') {
    await mutate(ctx, (c) => { c.toneExamples = []; });
    return { ok: true, toneExamples: [] };
  }
  if (pathname === '/api/clinic/export' && method === 'GET') {
    const c = requireClinic(await load(st, email), HttpError);
    const pack = { product: 'AaaS', exportedAt: new Date().toISOString(), account: email, clinic: { ...c, formToken: c.formToken ? 'redacted' : '' } };
    return { __bytes: Buffer.from(JSON.stringify(pack, null, 2), 'utf8'), __type: 'application/json; charset=utf-8', __name: 'aaas-clinic-export.json' };
  }
  if (pathname === '/api/clinic/data/delete' && method === 'POST') {
    if (String(body.confirm || '') !== 'delete my data') throw new HttpError(400, 'bad_request', 'Type “delete my data” to confirm. The account stays. The records go.');
    await forgetClinic(st, email);
    return { ok: true, deleted: true };
  }
  if (pathname === '/api/clinic/chat' && method === 'POST') {
    const q = clip(body.message, 2000);
    if (!q) throw new HttpError(400, 'empty', 'Type a question first.');
    const packed = await withDataLock(email, async () => {
      const c = requireClinic(await load(st, email), HttpError);
      const data = await loadData(st, email);
      syncWorkspace(data, c, Date.now());
      await saveData(st, email, data);
      return { c, data, text: digest(c, Date.now()) };
    });
    const grounded = answerQuestion(q, packed.c, Date.now());
    const hist = (Array.isArray(body.history) ? body.history : []).filter((m) => m && typeof m === 'object' && clip(m.t, 800)).slice(-6).map((m) => ({ r: m.r === 'u' ? 'u' : 'a', t: clip(m.t, 800) }));
    let agentOut = null;
    if (llmReady()) {
      const msg = clinicAiBlock(await byokSummary(st, email, secret));
      if (msg) throw new HttpError(403, 'needs_ai_key', msg);
      const run = startRun(st, email, { rid: String(body.run_id || ''), agent: null });
      try {
        agentOut = await runAgent({
          st, email, userName: userName || '', data: packed.data, agent: null, message: q, history: hist,
          tz: TZ, mode: 'chat', secret, wpSearch, wpChunks,
          app: 'BUSINESS RECORDS counted from the database. Use these numbers exactly. Do not invent people, fees, or dates.\n' + packed.text + (grounded ? '\nCounted answer to prefer: ' + grounded : ''),
          onStep: run.step,
        });
        await run.done(agentOut ? 'ok' : 'fallback', agentOut && agentOut.steps, agentOut && agentOut.approvals);
      } catch (e) {
        await run.done('error', null, null, e);
        if (e && (e.status === 429 || e.code === 'client_limit' || e.code === 'ai_timeout')) throw e;
        agentOut = null;
      }
    }
    const said = agentOut && agentOut.answer ? String(agentOut.answer) : '';
    const n = statsOf(packed.c, Date.now()).patientsLast2Months;
    const hasCount = grounded && (said.includes(String(n)) || said.includes(grounded.slice(0, 24)));
    const answer = grounded && !hasCount ? grounded + (said ? '\n\n' + said : '') : (said || grounded || 'I could not find that in this account’s records.');
    return { answer, mode: agentOut ? 'agent' : 'records', facts: { patientsLast2Months: n }, steps: (agentOut && agentOut.steps) || [], sources: (agentOut && agentOut.sources) || [] };
  }
  return undefined;
}

async function draftFor(ctx, agent, kind, patientId, build) {
  const { st, email } = ctx;
  let draft;
  await mutate(ctx, async (c, data) => {
    const p = c.patients.find((x) => x.id === Number(patientId));
    if (!p) throw new Error('That person is not on file.');
    const made = build(c, p);
    const aid = ((data.agents || []).find((x) => x.clinicKey === agent) || {}).id;
    const waLink = waMe(p.phone, made.body);
    const ap = await queueApproval(st, email, { aid, summary: made.title, request: made.body + (waLink ? '\n\nWhatsApp link (opens on your phone, nothing is sent by AaaS): ' + waLink : '') });
    draft = { id: nid(c.drafts), agent, kind, patientId: p.id, title: made.title, body: made.body, waLink, status: 'pending', approvalId: ap.id, at: Date.now(), demo: !!p.demo };
    c.drafts.unshift(draft);
  });
  return { draft };
}
