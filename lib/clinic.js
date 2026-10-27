// AaaS v2 clinic team: one workspace per account (as_clinic:<email>), five agents, drafts only.
// Nothing here sends email, SMS, or a paid WhatsApp message. Review requests are wa.me links the owner opens.
// Approving a draft records the decision and still does not contact anyone.
// Storage stays in the existing agentsphere_kv table. New keys only: as_clinic:<email> and as_cform:<token>.
import crypto from 'node:crypto';
import { runAgent, decideApproval } from './orchestrator.js';
import { llmReady } from './llm.js';
import { startRun } from './activity.js';

const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const uid = () => crypto.randomBytes(4).toString('hex');
const DAY = 864e5;
const TZ = 'Asia/Kolkata';
export const DEMO_EMAIL = 'demo-clinic@aidentify.local';
export const HIGH_VALUE = 20000;
export const LAPSED_DAYS = 180;
const MAX_ROWS = 2000;

export const AGENTS = {
  dental: [
    { key: 'front', name: 'Front Desk', label: 'Enquiries and bookings', kind: 'formfirst', d: 'Takes enquiries and books appointments alongside reception. Never replaces the receptionist. No IVR. Reminders wait for approval and are not sent from here.' },
    { key: 'recall', name: 'Patient Recall', label: 'Lapsed and high-value patients', kind: 'nudge', d: 'Lists patients who have not been back and patients with a high bill, and drafts a follow-up for the owner to approve.' },
    { key: 'reviews', name: 'Reviews & Referrals', label: 'Review requests', kind: 'afterjob', d: 'Drafts a review request as a WhatsApp click-to-chat link after a visit. No SMS and no paid WhatsApp API.' },
    { key: 'social', name: 'Social Media', label: 'Post calendar', kind: 'social', d: 'Drafts posts onto a weekly calendar. The owner approves first. Nothing is published.' },
    { key: 'insights', name: 'Owner Insights', label: 'Weekly numbers', kind: 'finance', d: 'Shows bookings, no-shows, recalls and estimated revenue from the clinic records, plus a weekly summary.' },
  ],
  realestate: [
    { key: 'front', name: 'Lead Desk', label: 'Enquiries and site visits', kind: 'formfirst', d: 'Takes buyer enquiries and books site visits. Hands the conversation to the desk. Reminders wait for approval.' },
    { key: 'recall', name: 'Lead Follow-up', label: 'Cold and high-value leads', kind: 'nudge', d: 'Lists leads who have gone quiet and high-value leads, and drafts a follow-up for the owner to approve.' },
    { key: 'reviews', name: 'Reviews & Referrals', label: 'Review requests', kind: 'afterjob', d: 'Drafts a review request as a WhatsApp click-to-chat link. No SMS and no paid WhatsApp API.' },
    { key: 'social', name: 'Social Media', label: 'Post calendar', kind: 'social', d: 'Drafts listing and offer posts onto a weekly calendar. The owner approves first. Nothing is published.' },
    { key: 'insights', name: 'Owner Insights', label: 'Weekly numbers', kind: 'finance', d: 'Shows site visits, missed follow-ups and estimated pipeline value from the records, plus a weekly summary.' },
  ],
};

const copyFor = (role) => {
  const re = role === 'realestate';
  return {
    role: re ? 'realestate' : 'dental',
    who: re ? 'leads' : 'patients',
    whoSingular: re ? 'lead' : 'patient',
    visit: re ? 'site visit' : 'visit',
    booking: re ? 'Site visits this week' : 'Bookings this week',
    noshow: re ? 'Missed follow-ups' : 'No-shows',
    recall: re ? 'Leads gone cold' : 'Recalls due',
    revenue: re ? 'Est. pipeline this month' : 'Est. revenue this month',
    pitch: re
      ? 'Your desk never misses a lead, a follow-up or a review, and you see every week what the pipeline is worth.'
      : 'Your clinic never misses an enquiry, a follow-up or a review, and you see every week whether you are making money.',
    biz: re ? 'Sample Realty' : 'Smile Dental (sample)',
    city: 'Hyderabad',
    phone: '919000000000',
  };
};

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

const blank = () => ({
  role: '', demo: false, biz: '', city: '', phone: '', formToken: '', seededAt: 0,
  rules: { from: '09:00', to: '20:00', ask: true, tone: 'Warm and short, the way you speak to patients' },
  paused: {}, patients: [], appointments: [], enquiries: [], drafts: [], posts: [], summary: null,
});

const nid = (list) => list.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1;

function person(role, i) {
  const dental = [
    ['Ananya Reddy', 12, 4500], ['Rohan Mehta', 20, 6000], ['Fatima Sheikh', 8, 3500], ['Karthik Iyer', 35, 9000],
    ['Sneha Kapoor', 5, 2200], ['Imran Qureshi', 48, 7000], ['Divya Nair', 3, 5000], ['Arjun Deshmukh', 15, 2800],
    ['Lakshmi Rao', 18, 15000], ['Vikram Shah', 25, 32000], ['Pooja Banerjee', 40, 41000],
    ['Suresh Patil', 210, 8000], ['Kavita Joshi', 240, 5400], ['Mohammed Ali', 190, 12000],
    ['Deepa Krishnan', 300, 26000], ['Harish Gupta', 220, 45000], ['Neha Bansal', 400, 3000], ['Ravi Teja', 160, 6400],
  ];
  const realty = [
    ['Ayesha Khan', 12, 4500000], ['Nikhil Rao', 20, 6200000], ['Farhan Syed', 8, 3800000], ['Meera Iyer', 35, 5100000],
    ['Aditya Kapoor', 5, 2900000], ['Salma Qureshi', 48, 7400000], ['Divya Nair', 3, 4300000], ['Arjun Deshmukh', 15, 3600000],
    ['Lakshmi Rao', 18, 8000000], ['Vikram Shah', 25, 22000000], ['Pooja Banerjee', 40, 18500000],
    ['Suresh Patil', 210, 4100000], ['Kavita Joshi', 240, 3900000], ['Mohammed Ali', 190, 5600000],
    ['Deepa Krishnan', 300, 24000000], ['Harish Gupta', 220, 31000000], ['Neha Bansal', 400, 2700000], ['Ravi Teja', 160, 4800000],
  ];
  const row = (role === 'realestate' ? realty : dental)[i];
  return { name: row[0], days: row[1], value: row[2] };
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
  const byName = (n) => patients.find((p) => p.name === n);
  const appt = (id, name, dayOffset, hour, service, status, fee) => ({
    id, patientId: byName(name).id, at: istStamp(addDays(week.start, dayOffset), hour), service, status, fee, demo: true, reminder: null,
  });
  const visit = role === 'realestate' ? 'Site visit' : 'Check-up';
  const clean = role === 'realestate' ? '2BHK viewing' : 'Cleaning';
  const rct = role === 'realestate' ? 'Follow-up call' : 'RCT review';
  const appointments = [
    appt(1, 'Ananya Reddy', 0, 11, clean, 'booked', role === 'realestate' ? 0 : 1500),
    appt(2, 'Rohan Mehta', 1, 11, rct, 'booked', role === 'realestate' ? 0 : 8000),
    appt(3, 'Fatima Sheikh', 2, 15, visit, 'booked', role === 'realestate' ? 0 : 1200),
    appt(4, 'Karthik Iyer', 3, 10, clean, 'noshow', role === 'realestate' ? 0 : 1500),
    appt(5, 'Sneha Kapoor', 4, 12, visit, 'booked', role === 'realestate' ? 0 : 2000),
    { id: 6, patientId: byName('Divya Nair').id, at: istStamp(istDate(now), 16), service: visit, status: 'completed', fee: role === 'realestate' ? 0 : 2500, demo: true, reminder: null },
  ];
  if (role === 'realestate') {
    appointments.forEach((a, i) => { a.fee = [500000, 800000, 350000, 0, 420000, 250000][i]; });
  }
  const enquiries = [0, 1, 2].map((i) => ({
    id: i + 1, name: ['Priya Menon', 'Omar Farooq', 'Shalini Das'][i], phone: '91900000100' + i,
    email: '', channel: ['Website', 'Instagram', 'Phone'][i],
    message: role === 'realestate' ? 'Looking at a 2BHK this week.' : 'Tooth pain, hoping for an appointment.',
    status: 'new', at: istStamp(addDays(week.start, i), 9), demo: true, source: 'Sample',
  }));
  enquiries.push({ id: 4, name: 'Old enquiry', phone: '919000001009', email: '', channel: 'Website', message: 'Already closed.', status: 'closed', at: new Date(now - 40 * DAY).toISOString(), demo: true, source: 'Sample' });
  const reviewBody = (name) => `Hi ${name}, thank you for coming to ${cpy.biz}. If you have a minute, a Google review helps other ${cpy.who} find us. DEMO message — nothing is sent from AaaS.`;
  const recallBody = (name, when) => `Hi ${name}, it has been a while since your last ${cpy.visit} on ${istDate(Date.parse(when))}. Reply here and the desk will book you. DEMO message — nothing is sent from AaaS.`;
  const suresh = byName('Suresh Patil'), ananya = byName('Ananya Reddy'), vikram = byName('Vikram Shah');
  const drafts = [
    { id: 1, agent: 'recall', kind: 'followup', patientId: suresh.id, title: `Follow-up for ${suresh.name}`, body: recallBody(suresh.name, suresh.lastVisit), waLink: waMe(suresh.phone, recallBody(suresh.name, suresh.lastVisit)), status: 'pending', approvalId: '', at: now - 3600e3, demo: true },
    { id: 2, agent: 'reviews', kind: 'review', patientId: ananya.id, title: `Review request for ${ananya.name}`, body: reviewBody(ananya.name), waLink: waMe(ananya.phone, reviewBody(ananya.name)), status: 'pending', approvalId: '', at: now - 1800e3, demo: true },
    { id: 3, agent: 'reviews', kind: 'review', patientId: vikram.id, title: `Review request for ${vikram.name}`, body: reviewBody(vikram.name), waLink: waMe(vikram.phone, reviewBody(vikram.name)), status: 'pending', approvalId: '', at: now - 900e3, demo: true },
  ];
  const posts = [
    { id: 1, at: istStamp(addDays(week.start, 2), 9), text: `DEMO post for ${cpy.biz}: open slots this weekend. Not published anywhere.`, status: 'scheduled', approvalId: '', demo: true },
    { id: 2, at: istStamp(addDays(week.start, 5), 9), text: `DEMO post for ${cpy.biz}: a short offer for the week. Not published anywhere.`, status: 'scheduled', approvalId: '', demo: true },
  ];
  return {
    ...blank(), role: cpy.role, demo: true, biz: cpy.biz, city: cpy.city, phone: cpy.phone,
    formToken: crypto.randomBytes(16).toString('hex'), seededAt: now, patients, appointments, enquiries, drafts, posts,
    rules: blank().rules, paused: {},
  };
}

// High-value bar depends on the role: dental bills are thousands of rupees, property values are lakhs.
export function isHighValue(p, role) {
  const bar = role === 'realestate' ? 10000000 : HIGH_VALUE;
  return Number(p.value) >= bar;
}
export function isLapsed(p, now = Date.now()) {
  const t = Date.parse(p.lastVisit || '');
  if (!t) return false;
  return !within(p.lastVisit, now, LAPSED_DAYS);
}

export function statsOf(c, now = Date.now()) {
  const week = weekRange(now), month = istDate(now).slice(0, 7);
  const ap = c.appointments || [], en = c.enquiries || [], pts = c.patients || [];
  const inWeek = (a) => inDates(a.at, week.start, week.end);
  const inMonth = (a) => { const t = Date.parse(a.at); return t && istDate(t).slice(0, 7) === month; };
  const bookingsWeek = ap.filter((a) => inWeek(a) && (a.status === 'booked' || a.status === 'completed')).length;
  const noshows = ap.filter((a) => inWeek(a) && a.status === 'noshow').length;
  const revenue = ap.filter((a) => inMonth(a) && (a.status === 'booked' || a.status === 'completed')).reduce((s, a) => s + (Number(a.fee) || 0), 0);
  const last2 = pts.filter((p) => within(p.createdAt, now, 62) || within(p.lastVisit, now, 62));
  const recalls = pts.filter((p) => isLapsed(p, now));
  const reviews = (c.drafts || []).filter((d) => d.kind === 'review' && d.status !== 'rejected').length;
  const posts = (c.posts || []).filter((p) => p.status === 'scheduled').length;
  return {
    enquiriesWeek: en.filter((e) => inDates(e.at, week.start, week.end)).length,
    enquiriesOpen: en.filter((e) => e.status === 'new').length,
    bookingsWeek, noshows, recallsDue: recalls.length, reviews, posts, revenue,
    patientsLast2Months: last2.length, patientsTotal: pts.length,
    highValue: pts.filter((p) => isHighValue(p, c.role)).length,
    weekStart: week.start, weekEnd: week.end, month,
    last2Names: last2.map((p) => p.name),
  };
}

export function answerQuestion(q, c, now = Date.now()) {
  const s = statsOf(c, now), who = copyFor(c.role).who, ql = String(q || '').toLowerCase();
  const countish = /how many|number of|count|total/.test(ql);
  if (countish && /patient|lead/.test(ql) && /2 month|two month|60 day|last 2/.test(ql)) return `There are ${s.patientsLast2Months} ${who} in the last 2 months, counted from this clinic’s records.`;
  if (countish && /patient|lead/.test(ql) && /week/.test(ql)) return `There are ${s.enquiriesWeek} enquiries this week, and ${s.patientsLast2Months} ${who} in the last 2 months, counted from this clinic’s records.`;
  if (countish && /patient|lead/.test(ql)) return `There are ${s.patientsTotal} ${who} on file, and ${s.patientsLast2Months} in the last 2 months, counted from this clinic’s records.`;
  if (/no-show|noshow|missed follow/.test(ql)) return `No-shows this week: ${s.noshows}, counted from this clinic’s records.`;
  if (/revenue|profit|pipeline|making/.test(ql)) return `Estimated revenue this month is ${money(s.revenue)}, counted from booked and completed visits in the records.`;
  if (/recall|lapsed|gone cold|follow-up/.test(ql)) return `${s.recallsDue} ${who} are due for a recall, counted from this clinic’s records.`;
  if (/enquir/.test(ql)) return `${s.enquiriesWeek} enquiries this week, ${s.enquiriesOpen} still open, counted from this clinic’s records.`;
  if (/book|appointment|site visit/.test(ql)) return `${s.bookingsWeek} bookings this week, counted from this clinic’s records.`;
  return '';
}

function digest(c, now) {
  const s = statsOf(c, now), who = copyFor(c.role).who;
  const lines = [
    `Clinic snapshot for ${c.biz}. Sample rows are marked demo.`,
    `${who} in the last 2 months: ${s.patientsLast2Months}. Names: ${s.last2Names.join(', ') || 'none'}.`,
    `${who} on file: ${s.patientsTotal}. Recalls due: ${s.recallsDue}. High-value: ${s.highValue}.`,
    `Enquiries this week: ${s.enquiriesWeek} (${s.enquiriesOpen} open). Bookings this week: ${s.bookingsWeek}. No-shows this week: ${s.noshows}.`,
    `Review requests on file: ${s.reviews}. Posts scheduled: ${s.posts}. Estimated revenue this month: ${money(s.revenue)}.`,
  ];
  for (const p of (c.patients || []).slice(0, 40)) lines.push(`${copyFor(c.role).whoSingular}: ${p.name}, phone ${p.phone}, last ${copyFor(c.role).visit} ${p.lastVisit ? istDate(Date.parse(p.lastVisit)) : 'unknown'}, value ${p.value}${p.demo ? ', DEMO' : ''}.`);
  return lines.join('\n');
}

const baseSummary = (c, s) => `Week of ${s.weekStart} for ${c.biz}${c.demo ? ' (sample data, not a real clinic)' : ''}. ${s.bookingsWeek} bookings this week, ${s.noshows} no-shows, ${s.enquiriesWeek} enquiries (${s.enquiriesOpen} still open). ${s.recallsDue} due for a recall. ${s.reviews} review requests. ${s.posts} posts on the calendar. Estimated revenue this month is ${money(s.revenue)}.`;

async function polish(ai, ip, base) {
  if (!ai || !llmReady()) return '';
  try {
    const r = await ai('Rewrite the weekly summary below in two short sentences for the clinic owner. Keep every number exactly as written. Do not add numbers, names, or claims.\n\n' + base, ip, { max: 280 });
    return String(r.text || '').trim().slice(0, 1200);
  } catch { return ''; }
}

function snapshotRec(c, now) {
  const s = statsOf(c, now);
  return {
    name: 'Clinic snapshot', title: 'Clinic snapshot', at: now,
    patients_last_2_months: s.patientsLast2Months, patients_total: s.patientsTotal,
    bookings_this_week: s.bookingsWeek, no_shows_this_week: s.noshows, recalls_due: s.recallsDue,
    enquiries_this_week: s.enquiriesWeek, reviews_requested: s.reviews, posts_scheduled: s.posts,
    estimated_revenue_this_month_inr: s.revenue, note: s.last2Names.join(', '),
  };
}

function syncWorkspace(data, c, now) {
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  data.wp = data.wp && typeof data.wp === 'object' ? data.wp : {};
  const spec = AGENTS[c.role] || AGENTS.dental;
  const cpy = copyFor(c.role);
  data.wp.profile = { vertical: c.role === 'realestate' ? 'real_estate' : 'clinic_dental', verticalLabel: c.role === 'realestate' ? 'Real estate' : 'Clinic: dental', business: c.biz, city: c.city || 'Hyderabad', phone: c.phone || '', website: '', help: cpy.pitch };
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
    crm = { id, kind: 'crm', name: 'CRM Agent', label: 'CRM', d: 'Clinic contacts imported from the dental team.', status: 'active', recs: [], kb: [], n: 0, at: now, db: { lead: [] } };
    data.agents.push(crm);
  }
  crm.db = crm.db && typeof crm.db === 'object' ? crm.db : {};
  crm.db.lead = Array.isArray(crm.db.lead) ? crm.db.lead : [];
  const snap = snapshotRec(c, now);
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
    const row = { first_name: bits.shift() || 'Unknown', last_name: bits.join(' '), phone: p.phone || '', email: p.email || '', source: p.source || 'Clinic', status: 'New', notes: p.demo ? 'DEMO sample record. Not a real patient.' : (p.notes || ''), tags: p.demo ? ['demo', 'clinic'] : ['clinic'], clinic_patient_id: p.id, interest: isLapsed(p, now) ? 'Recall' : '', upd: now };
    if (!lead) { lead = { id: crm.db.lead.reduce((m, x) => Math.max(m, Number(x && x.id) || 0), 0) + 1, at: Date.parse(p.createdAt) || now, hist: [{ at: now, t: 'Added from the clinic team' }] }; crm.db.lead.unshift(lead); }
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
  const keys = [KEY(email)];
  if (c && /^[a-f0-9]{32}$/.test(c.formToken || '')) keys.push(FKEY(c.formToken));
  if (st.delMany) await st.delMany(keys);
  else for (const k of keys) { if (st.del) await st.del(k); else await st.put(k, null, Date.now()); }
}

function cleanName(v) { const s = clip(v, 80); if (s.length < 2) throw new Error('Give a name.'); return s; }
function cleanPhone(v) { const s = clip(v, 24); if (s && !/^\+?[0-9 ()\-.]{8,24}$/.test(s)) throw new Error('Phone should be digits, spaces, + or -.'); return s; }
function cleanEmail(v) { const s = String(v || '').trim().toLowerCase().slice(0, 200); if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error('Email is not valid.'); return s; }

function view(c, now, extras = {}) {
  const s = statsOf(c, now);
  const cpy = copyFor(c.role || 'dental');
  const spec = c.role ? (AGENTS[c.role] || []) : [];
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
    product: 'AaaS', role: c.role || '', demo: !!c.demo, biz: c.biz, city: c.city, phone: c.phone,
    pitch: cpy.pitch, labels: { ...cpy, agents: spec.map((a) => a.name) },
    rules: c.rules, agents, stats: s, summary: c.summary,
    patients: c.patients, appointments: c.appointments, enquiries: c.enquiries, drafts: c.drafts, posts: c.posts,
    pending: pending.sort((a, b) => (b.at || 0) - (a.at || 0)),
    connections: c.role ? connections(c) : [],
    formPath: c.formToken ? '/book/' + c.formToken : '',
    ...extras,
  };
}

function connections(c) {
  const src = c.role === 'realestate' ? 'CRM / Google Sheet / CSV' : 'Clinic software (e.g. Eka.care) / CSV';
  return [
    { id: 'csv', name: 'CSV of ' + copyFor(c.role).who + ' and visits', detail: 'Read history you already have', status: 'ready' },
    { id: 'form', name: 'Website booking form', detail: 'Writes into the CRM. Nothing is emailed.', status: 'ready', url: '/book/' + c.formToken },
    { id: 'whatsapp', name: 'WhatsApp click-to-chat link', detail: 'Free channel. No paid API and no SMS.', status: 'ready', url: waMe(c.phone, 'Hi, I would like to book.') },
    { id: 'eka', name: src, detail: 'Placeholder only. CSV upload is the way in today.', status: 'placeholder' },
    { id: 'google', name: 'Google Business Profile', detail: 'Review links are drafted here. Connecting the profile comes later.', status: 'placeholder' },
    { id: 'instagram', name: 'Instagram / Facebook', detail: 'Posts stay on the calendar until you approve them. Nothing is published.', status: 'placeholder' },
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

function applyImport(c, rows, now) {
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
        if (!p) { p = { id: nid(c.patients), createdAt: new Date(now).toISOString(), demo: false, source: 'CSV' }; c.patients.unshift(p); patients++; }
        Object.assign(p, { name, phone: phone || p.phone || '', email: email || p.email || '', ...(lastIso ? { lastVisit: lastIso } : {}), ...(value !== '' ? { value: Number(String(value).replace(/[, ]/g, '')) || 0 } : {}), demo: false });
      } else {
        const name = cleanName(row.name || row.patient);
        const phone = cleanPhone(row.phone || '');
        let p = c.patients.find((x) => x.name.toLowerCase() === name.toLowerCase() || (phone && digits(x.phone) === digits(phone)));
        if (!p) { p = { id: nid(c.patients), name, phone, email: cleanEmail(row.email || ''), createdAt: new Date(now).toISOString(), lastVisit: '', value: 0, demo: false, source: 'CSV' }; c.patients.unshift(p); patients++; }
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

export async function clinicPublic({ method, pathname, body, ip, st, json, HttpError, getUsers, saveUsers, hashPassword, signToken, presentUser, withDataLock }) {
  if (pathname === '/api/clinic/meta' && method === 'GET') return { product: 'AaaS', demoLogin: demoLoginAllowed(), email: demoLoginAllowed() ? DEMO_EMAIL : '' };
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
  const book = pathname.match(/^\/book\/([a-f0-9]{32})$/);
  const form = pathname.match(/^\/api\/clinic\/form\/([a-f0-9]{32})$/);
  const token = (book || form)?.[1];
  if (!token) return undefined;
  const hit = parse((await st.get(FKEY(token)))?.v, null);
  if (!hit || !hit.email) throw new HttpError(404, 'not_found', 'This booking form is not active.');
  if (method === 'GET') return { __html: formHtml(token, hit.email) };
  if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  noteForm(ip, HttpError);
  const b = readForm(body, json);
  const name = cleanName(b.name);
  const phone = cleanPhone(b.phone || '');
  if (!phone) throw new HttpError(400, 'bad_request', 'Add a phone number so the desk can call back.');
  const email = cleanEmail(b.email || '');
  const message = clip(b.message || '', 1000);
  const service = clip(b.service || 'Check-up', 80);
  const when = b.when ? Date.parse(b.when) : 0;
  if (b.when && !when) throw new HttpError(400, 'bad_request', 'The time is not a valid date.');
  const out = await withDataLock(hit.email, async () => {
    const c = requireClinic(await load(st, hit.email), HttpError);
    const data = await loadData(st, hit.email);
    let p = c.patients.find((x) => digits(x.phone) === digits(phone));
    if (!p) { p = { id: nid(c.patients), name, phone, email, lastVisit: '', value: 0, createdAt: new Date().toISOString(), demo: false, source: 'Website form' }; c.patients.unshift(p); }
    else { p.name = name; if (email) p.email = email; }
    const enq = { id: nid(c.enquiries), name, phone, email, channel: 'Website', message: message || service, status: when ? 'booked' : 'new', at: new Date().toISOString(), demo: false, source: 'Website form' };
    c.enquiries.unshift(enq);
    let appointmentId = null;
    if (when) {
      const a = { id: nid(c.appointments), patientId: p.id, at: new Date(when).toISOString(), service, status: 'booked', fee: 0, demo: false, reminder: null };
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
function formHtml(token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Book — AaaS</title>
<style>body{margin:0;font:16px/1.45 "Segoe UI",system-ui,sans-serif;background:#f4f6f8;color:#1b2430}main{max-width:440px;margin:48px auto;background:#fff;border:1px solid #e7eaee;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#5c6b7a;margin:0 0 16px}label{display:block;font-size:13px;margin:12px 0 4px}input,textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dbe3;border-radius:8px;font:inherit}button{margin-top:16px;background:#0b5fff;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}small{display:block;margin-top:12px;color:#5c6b7a}</style></head>
<body><main><h1>Book a visit</h1><p>Tell the desk what you need. This form only saves the enquiry. It does not send a text or an email.</p>
<form method="post" action="/book/${esc(token)}"><label>Name</label><input name="name" required maxlength="80"><label>Phone</label><input name="phone" required maxlength="24"><label>What do you need?</label><textarea name="message" rows="3" maxlength="1000"></textarea><label>Preferred time (optional)</label><input name="when" type="datetime-local"><input type="hidden" name="service" value="Check-up"><button>Send to the desk</button></form>
<small>Sample clinics are marked as demo inside AaaS. Do not enter a real medical history.</small></main></body></html>`;
}
function thanksHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Received — AaaS</title>
<style>body{margin:0;font:16px/1.45 "Segoe UI",system-ui,sans-serif;background:#f4f6f8;color:#1b2430}main{max-width:440px;margin:48px auto;background:#fff;border:1px solid #e7eaee;border-radius:12px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#5c6b7a}</style></head>
<body><main><h1>Received</h1><p>The desk has the enquiry. Nothing was emailed or texted. Someone at the clinic will confirm.</p></main></body></html>`;
}

export async function clinicRoutes(ctx) {
  const { method, pathname, st, email, HttpError, json, ip, secret, wpSearch, wpChunks, ai, withDataLock, userName, staff } = ctx;
  if (staff) throw new HttpError(403, 'customers_only', 'The clinic team is for customer accounts.');
  const now = Date.now();
  const body = method === 'GET' ? {} : json();

  if (pathname === '/api/clinic' && method === 'GET') {
    const c = await load(st, email);
    if (!c || !c.role) return { product: 'AaaS', role: '', needsRole: true, pitch: copyFor('dental').pitch };
    return view(c, now);
  }
  if (pathname === '/api/clinic/role' && method === 'POST') {
    const role = body.role === 'realestate' ? 'realestate' : body.role === 'dental' ? 'dental' : '';
    if (!role) throw new HttpError(400, 'bad_role', 'Pick Dental or Real estate.');
    const c = await withDataLock(email, async () => {
      let cur = await load(st, email) || blank();
      const data = await loadData(st, email);
      const first = !cur.role;
      cur.role = role;
      if (!cur.patients.length) {
        const seeded = buildSeed(role, now);
        cur = { ...seeded, role };
      } else {
        const cpy = copyFor(role);
        if (cur.demo) { cur.biz = cpy.biz; }
        cur.city = cur.city || cpy.city;
      }
      if (!cur.formToken) cur.formToken = crypto.randomBytes(16).toString('hex');
      const s = statsOf(cur, now);
      const base = baseSummary(cur, s);
      const extra = await polish(ai, ip, base);
      cur.summary = { weekOf: s.weekStart, text: extra ? base + '\n\n' + extra : base, at: now, demo: !!cur.demo };
      syncWorkspace(data, cur, now);
      await save(st, email, cur); await saveData(st, email, data);
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
    return view(await load(st, email), Date.now(), { created: c.first });
  }

  if (pathname === '/api/clinic/import' && method === 'POST') {
    let rows; try { rows = parseCsv(String(body.csv || '')); } catch (e) { bad(HttpError, e); }
    const result = { patients: 0, appointments: 0, errors: [] };
    await mutate(ctx, (c) => { const r = applyImport(c, rows, now); Object.assign(result, r); if (!r.patients && !r.appointments) throw new Error(r.errors[0] ? r.errors[0].message : 'Nothing matched. Use a name and a phone, or a when column for visits.'); });
    return { ...result, clinic: view(await load(st, email), Date.now()) };
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
      const p = c.patients.find((x) => x.id === Number(body.patientId)); if (!p) throw new Error('Pick a patient who is already on file, or add them first.');
      const at = Date.parse(body.at || ''); if (!at) throw new Error('Give a date and time.');
      const status = ['booked', 'completed', 'noshow', 'cancelled'].includes(body.status) ? body.status : 'booked';
      ap = { id: nid(c.appointments), patientId: p.id, at: new Date(at).toISOString(), service: clip(body.service || 'Check-up', 80), status, fee: Math.max(0, Number(body.fee) || 0), demo: false, reminder: null };
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
      if (body.patientId != null) { const p = c.patients.find((x) => x.id === Number(body.patientId)); if (!p) throw new Error('That patient is not on file.'); a.patientId = p.id; }
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
      const text = `Reminder for ${p ? p.name : 'the patient'}: ${a.service} on ${istDate(Date.parse(a.at))} at ${c.biz}. Reply if you need another time. Window ${c.rules.from}–${c.rules.to}. DEMO queue — AaaS does not send this.`;
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
    const text = `Hi ${p.name}, it has been a while since your last ${cpy.visit}${p.lastVisit ? ' on ' + istDate(Date.parse(p.lastVisit)) : ''}. ${c.biz} can book you in. Reply and the desk will confirm. Nothing is sent until you approve this draft.`;
    return { title: 'Follow-up for ' + p.name, body: text };
  });
  if (pathname === '/api/clinic/reviews/draft' && method === 'POST') return draftFor(ctx, 'reviews', 'review', body.patientId, (c, p) => {
    const text = `Hi ${p.name}, thank you for visiting ${c.biz}. If the visit went well, a Google review helps other people find the clinic. DEMO draft — AaaS will not text or email this.`;
    return { title: 'Review request for ' + p.name, body: text };
  });
  if (pathname === '/api/clinic/social/draft' && method === 'POST') {
    const topic = clip(body.topic || 'this week at the clinic', 160);
    const when = body.when && Date.parse(body.when) ? new Date(Date.parse(body.when)).toISOString() : istStamp(addDays(weekRange(now).end, 1), 9);
    let text = '';
    if (llmReady()) {
      try {
        const r = await ai(`Write one short social post for ${body.biz || 'a clinic'} in Hyderabad. Topic: ${topic}. Under 400 characters. No medical claims, no invented discounts, no hashtag spam. End with the word DRAFT. This post will not be published.`, ip, { max: 400 });
        text = String(r.text || '').trim();
      } catch (e) { if (e.status !== 503 && e.code !== 'no_key') throw e; }
    }
    if (!text) text = `DRAFT (no AI key on this server): ${topic}. ${copyFor('dental').biz} — the owner still has to approve this. Nothing is published.`;
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
      const from = String(body.from || c.rules.from), to = String(body.to || c.rules.to);
      if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) throw new Error('Use times like 09:00 and 20:00.');
      c.rules = { from, to, ask: body.ask !== false, tone: clip(body.tone || c.rules.tone, 240) };
    });
    return { rules: (await load(st, email)).rules };
  }
  if (pathname === '/api/clinic/agent' && method === 'POST') {
    const key = String(body.key || '');
    if (!AGENTS.dental.some((a) => a.key === key)) throw new HttpError(400, 'bad_agent', 'Unknown agent.');
    await mutate(ctx, (c) => { c.paused = c.paused || {}; c.paused[key] = !!body.paused; });
    return { ok: true, paused: !!(await load(st, email)).paused[key] };
  }
  if (pathname === '/api/clinic/drafts/edit' && method === 'POST') {
    await mutate(ctx, async (c) => {
      const d = (c.drafts || []).find((x) => x.id === Number(body.id) || x.approvalId === body.approvalId);
      if (!d || d.status !== 'pending') throw new Error('That draft is not waiting for approval.');
      d.body = clip(body.body || d.body, 4000);
      if (d.patientId) { const p = c.patients.find((x) => x.id === d.patientId); if (p) d.waLink = waMe(p.phone, d.body); }
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
    if (out.error) throw new HttpError(404, 'not_found', 'That approval is not in the queue.');
    await withDataLock(email, async () => {
      const c = await load(st, email); if (!c) return;
      const data = await loadData(st, email);
      const ok = out.approval.status === 'done', no = out.approval.status === 'declined';
      for (const d of c.drafts || []) if (d.approvalId === id) { d.status = ok ? 'approved' : no ? 'rejected' : d.status; d.decidedAt = Date.now(); d.result = out.approval.result || ''; }
      for (const p of c.posts || []) if (p.approvalId === id) { if (ok) p.status = 'scheduled'; if (no) p.status = 'rejected'; }
      for (const a of c.appointments || []) if (a.reminder && a.reminder.approvalId === id) { a.reminder.status = ok ? 'approved' : no ? 'rejected' : a.reminder.status; a.reminder.result = out.approval.result || ''; }
      syncWorkspace(data, c, Date.now());
      await save(st, email, c); await saveData(st, email, data);
    });
    return { approval: { id: out.approval.id, status: out.approval.status, result: out.approval.result || '' } };
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
    const hist = (Array.isArray(body.history) ? body.history : []).slice(-6).map((m) => ({ r: m.r === 'u' ? 'u' : 'a', t: clip(m.t, 800) }));
    let agentOut = null;
    if (llmReady()) {
      const run = startRun(st, email, { rid: String(body.run_id || ''), agent: null });
      try {
        agentOut = await runAgent({
          st, email, userName: userName || '', data: packed.data, agent: null, message: q, history: hist,
          tz: TZ, mode: 'chat', secret, wpSearch, wpChunks,
          app: 'CLINIC RECORDS counted from the database. Use these numbers exactly. Do not invent patients, fees, or dates.\n' + packed.text + (grounded ? '\nCounted answer to prefer: ' + grounded : ''),
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
    const answer = grounded && !hasCount ? grounded + (said ? '\n\n' + said : '') : (said || grounded || 'I could not find that in the clinic records.');
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
