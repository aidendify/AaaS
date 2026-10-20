// Seeds five fictional businesses into the local mock server. No live data, no phone numbers.
import fs from 'node:fs';
import { api, signup, setupDesk, workspace, PW, CRON, BASE } from './lib.mjs';
import { todayAt } from '../../lib/frontdesk.js';

const DAY = 864e5;
// Past days, so the open pixels (recorded at the wall clock) still fall after the send.
// A test clock in the past still runs work that is already due, and stamps that past day.
const MON = Date.UTC(2026, 9, 12, 15);
const WED = Date.UTC(2026, 9, 14, 15);
const REVIEW = MON + 7 * DAY + 3600e3;

async function tick(now) {
  return api(null, 'GET', '/api/cron/tick', undefined, {
    authorization: 'Bearer ' + CRON,
    ...(now ? { 'x-test-now': String(now) } : {}),
  });
}

async function profile(token, fields) {
  await api(token, 'POST', '/api/profile', fields);
}

async function declinePending(token) {
  const box = await api(token, 'GET', '/api/agents/approvals?status=pending&limit=100');
  for (const item of box.items || []) {
    await api(token, 'POST', '/api/agents/approval', { id: item.id, decision: 'reject', note: 'Cleared before the recording' });
  }
}

async function seedMonday(token) {
  const made = await api(token, 'POST', '/api/workflows/compile', {
    text: 'When a new lead comes in, send the welcome email',
  });
  const wf = made.workflow;
  const step = wf.steps.find((s) => s.type === 'send_email' || s.type === 'draft_email');
  await api(token, 'POST', '/api/workflows/update', {
    id: wf.id,
    step: { id: step.id, body: '<p>Hi {{first_name}}, see https://example.com/welcome</p>' },
  });
  await api(token, 'POST', '/api/workflows/update', { id: wf.id, status: 'enabled' });

  const monday = [];
  for (let i = 0; i < 4; i++) {
    monday.push((await api(token, 'POST', '/api/leads', {
      name: 'Monday Sample ' + (i + 1),
      email: `mon${i}@lakeview.example`,
      source: 'Website',
    })).lead);
  }
  await tick(MON);
  let pending = (await api(token, 'GET', '/api/agents/approvals?status=pending&limit=100')).items || [];
  for (const lead of monday) {
    const ap = pending.find((a) => a.lead_id === lead.id && (a.kind === 'email' || a.kind === 'draft'));
    if (!ap) throw new Error('Missing Monday email draft for lead ' + lead.id);
    await api(token, 'POST', '/api/tracking/apply', { lead_id: lead.id, approval_id: ap.id });
    pending = (await api(token, 'GET', '/api/agents/approvals?status=pending&limit=100')).items || [];
    const body = pending.find((a) => a.id === ap.id).body || '';
    const pixel = (body.match(/\/t\/o\/[a-f0-9]{32}\.gif/) || [])[0];
    if (!pixel) throw new Error('No open pixel on Monday draft');
    const opened = await fetch(BASE + pixel, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AIdentify demo)' } });
    if (!opened.ok) throw new Error('Pixel ' + opened.status);
  }

  for (let i = 0; i < 4; i++) {
    await api(token, 'POST', '/api/leads', {
      name: 'Wednesday Sample ' + (i + 1),
      email: `wed${i}@lakeview.example`,
      source: 'Website',
    });
  }
  await tick(WED);
  await tick(REVIEW);
  await api(token, 'POST', '/api/workflows/update', { id: wf.id, status: 'paused' });
  const sug = ((await api(token, 'GET', '/api/cos')).suggestions || []).filter((s) => s.status === 'open');
  const mondayLine = sug.find((s) => /Monday/i.test(s.text));
  if (!mondayLine) throw new Error('Monday suggestion missing: ' + JSON.stringify(sug));
  for (const s of sug) {
    if (s.id !== mondayLine.id) await api(token, 'POST', '/api/cos/suggestions/dismiss', { id: s.id });
  }
  await declinePending(token);
  return mondayLine.text;
}

async function harbourUsage(ownerToken) {
  const client = await api(ownerToken, 'POST', '/api/agency/clients', {
    name: 'Harbour Studio',
    email: 'owner@harbour-studio.example',
    password: PW,
  });
  const login = await api(null, 'POST', '/api/auth/login', {
    email: 'owner@harbour-studio.example',
    password: PW,
  });
  const token = login.token;
  await profile(token, {
    name: 'Harbour Studio',
    location: 'Kochi',
    about: 'A fictional design studio used only in this local recording.',
    offer: 'Brand and website projects',
  });
  await workspace(token, 'owner@harbour-studio.example', {
    vertical: 'agency', verticalLabel: 'Agency client', business: 'Harbour Studio', city: 'Kochi',
    phone: '', website: 'https://harbour-studio.example', help: 'Keep client intake in drafts.', at: Date.now(),
  });
  await api(token, 'POST', '/api/leads', { name: 'Sample Enquiry', email: 'enquiry@harbour-studio.example', source: 'Website' });
  await api(token, 'POST', '/api/ai', { prompt: 'One line on this week for Harbour Studio. Fictional only.' });
  const desk = await setupDesk(token, {
    faqs: [{ q: 'What do you design', a: 'Harbour Studio designs brands and websites. This is a fictional sample.' }],
    days: [1, 2, 3, 4, 5], start: '10:00', end: '17:00',
  });
  await fetch(BASE + '/c/' + desk.widget.token + '/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'What do you design', visitor: 'harbourvis01' }),
  });
  const pending = (await api(token, 'GET', '/api/agents/approvals?status=pending&limit=20')).items || [];
  const ap = pending.find((a) => /Front desk/i.test(a.summary || ''));
  if (ap) await api(token, 'POST', '/api/agents/approval', { id: ap.id, decision: 'approve' });
  return client;
}

export async function seedAll() {
  const clinic = await signup('anika.deshmukh@glow-atelier.example', 'Anika Deshmukh');
  await profile(clinic.token, {
    name: 'Glow Atelier', location: 'Hyderabad',
    about: 'A fictional skin studio. Laser sessions are by appointment.',
    offer: 'Laser sessions', audience: 'People booking a Saturday laser visit', voice: 'Calm and direct',
  });
  clinic.data = await workspace(clinic.token, clinic.email, {
    vertical: 'clinic_skin', verticalLabel: 'Skin / aesthetic clinic', business: 'Glow Atelier', city: 'Hyderabad',
    phone: '', website: 'https://glow-atelier.example', help: 'Answer after-hours laser questions and book Saturday slots.', at: Date.now(),
  });
  const clinicDesk = await setupDesk(clinic.token, {
    faqs: [{
      q: 'Is Saturday free for laser',
      a: 'Saturday is open for laser from 11:00 to 13:00. A full-face session is ₹4,500. A patch test is ₹500. Reply book a slot and I will offer times.',
    }],
    days: [6], start: '11:00', end: '13:00',
  });
  await api(clinic.token, 'POST', '/api/frontdesk/demo-message', {
    visitor: 'clinicclock1', text: 'Is Saturday free for laser?', at: todayAt(22, 47, 'Asia/Kolkata'),
  });
  const clockDrafts = (await api(clinic.token, 'GET', '/api/agents/approvals?status=pending&limit=20')).items || [];
  for (const item of clockDrafts) {
    await api(clinic.token, 'POST', '/api/agents/approval', { id: item.id, decision: 'reject', note: 'Clock seed only' });
  }

  const coach = await signup('ravi.menon@northstar-coach.example', 'Ravi Menon');
  await profile(coach.token, {
    name: 'Northstar Coaching', location: 'Bengaluru',
    about: 'A fictional coach for consultants who want a clearer pipeline.',
    offer: 'A discovery call, then a 6-week engagement', audience: 'Independent consultants', voice: 'Plain and specific',
  });
  coach.data = await workspace(coach.token, coach.email, {
    vertical: 'coach', verticalLabel: 'Coach', business: 'Northstar Coaching', city: 'Bengaluru',
    phone: '', website: 'https://northstar-coach.example', help: 'Qualify fee questions and book discovery calls.', at: Date.now(),
  });
  const coachDesk = await setupDesk(coach.token, {
    faqs: [{
      q: 'What are your fees',
      a: 'A discovery call is ₹3,000. The 6-week engagement is ₹24,000. Reply book a call if you want times.',
    }],
    days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00',
  });
  const tg = await api(coach.token, 'POST', '/api/channels/telegram', {
    bot_token: 'mock_tg_coach_demo', owner_user_id: '424242', customers: true,
  });

  const broker = await signup('meera.iyer@lakeview-homes.example', 'Meera Iyer');
  await profile(broker.token, {
    name: 'Lakeview Homes', location: 'Pune',
    about: 'A fictional brokerage. Listing facts live in the saved answers, not a property database.',
    offer: 'Site visits for listed homes', audience: 'Buyers asking on weekends', voice: 'Specific',
  });
  broker.data = await workspace(broker.token, broker.email, {
    vertical: 'realestate', verticalLabel: 'Real estate', business: 'Lakeview Homes', city: 'Pune',
    phone: '', website: 'https://lakeview-homes.example', help: 'Answer listing questions and book site visits.', at: Date.now(),
  });
  const brokerDesk = await setupDesk(broker.token, {
    faqs: [{
      q: 'Is the 3BHK still available',
      a: 'Yes. The 3BHK at Lakeview Residency is available. It is 1,450 sq ft, listed at ₹1.15 crore. Saturday site visits are 11:00 to 13:00. Reply book a slot.',
    }],
    days: [6], start: '11:00', end: '13:00',
  });
  const mondayText = await seedMonday(broker.token);

  const studio = await signup('kabir.shah@pulse-studio.example', 'Kabir Shah');
  await profile(studio.token, {
    name: 'Pulse Studio', location: 'Mumbai',
    about: 'A fictional salon and gym studio. Evening slots and a trial class.',
    offer: 'Cuts, training, and a first trial class', audience: 'People booking after work', voice: 'Short',
  });
  studio.data = await workspace(studio.token, studio.email, {
    vertical: 'gym', verticalLabel: 'Salon / gym', business: 'Pulse Studio', city: 'Mumbai',
    phone: '', website: 'https://pulse-studio.example', help: 'Book the 6pm block and trial classes.', at: Date.now(),
  });
  const studioDesk = await setupDesk(studio.token, {
    faqs: [{
      q: 'Trial class',
      a: 'A first trial class is free. Evening openings start at 6:00. Reply book a slot and I will offer times.',
    }],
    days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '19:30',
  });
  const sl = await api(studio.token, 'POST', '/api/channels/slack', {
    bot_token: 'mock_sl_studio_demo',
    signing_secret: 'studio-signing-secret-demo',
    owner_user_id: 'U0OWNER1',
    customers: true,
  });

  const agency = await signup('nisha.rao@northandco.example', 'Nisha Rao');
  await profile(agency.token, {
    name: 'North & Co', location: 'Mumbai',
    about: 'A fictional agency that runs client workspaces.',
    offer: 'White-label front desk for client businesses',
  });
  agency.data = await workspace(agency.token, agency.email, {
    vertical: 'agency', verticalLabel: 'Agency', business: 'North & Co', city: 'Mumbai',
    phone: '', website: 'https://northandco.example', help: 'Add a client workspace and keep every send in draft.', at: Date.now(),
  });
  await api(agency.token, 'POST', '/api/agency', { name: 'North & Co' });
  await harbourUsage(agency.token);

  const manifest = {
    base: BASE,
    clinic: { ...publicAccount(clinic), widget: clinicDesk.widget.page, widgetToken: clinicDesk.widget.token, slots: clinicDesk.slots.map((s) => s.label) },
    coach: { ...publicAccount(coach), widget: coachDesk.widget.page, widgetToken: coachDesk.widget.token, telegram: tg.telegram },
    broker: { ...publicAccount(broker), widget: brokerDesk.widget.page, widgetToken: brokerDesk.widget.token, monday: mondayText },
    studio: { ...publicAccount(studio), widget: studioDesk.widget.page, widgetToken: studioDesk.widget.token, slack: sl.slack, signing_secret: 'studio-signing-secret-demo' },
    agency: { ...publicAccount(agency) },
  };
  const file = process.env.DEMO_MANIFEST || '/tmp/aidentify-demo-data/manifest.json';
  fs.mkdirSync('/tmp/aidentify-demo-data', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

function publicAccount(row) {
  return { email: row.email, name: row.user && row.user.name, token: row.token, password: PW, data: row.data || '' };
}

if (process.argv[1] && process.argv[1].endsWith('seed.mjs')) {
  seedAll().then((m) => {
    console.log(JSON.stringify({
      clinic: m.clinic.slots,
      monday: m.broker.monday,
      tg: !!(m.coach.telegram && m.coach.telegram.webhook_url),
      sl: !!(m.studio.slack && m.studio.slack.webhook_url),
    }, null, 2));
  }).catch((e) => { console.error(e); process.exit(1); });
}
