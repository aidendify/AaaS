// Playwright walkthroughs. Each one stays on screens the product already has.
import { captions, beat, hold, openApp, askChief, goTab, approve, widgetSay, widgetNext, backToApp, api, postRaw, slackHeaders, CRON } from './lib.mjs';

const STORIES = {
  clinic: clinicShot,
  coach: coachShot,
  broker: brokerShot,
  studio: studioShot,
  agency: agencyShot,
};

export const STORY_META = {
  clinic: { title: 'Clinic · Saturday laser', file: 'clinic_laser' },
  coach: { title: 'Coach · Fees and follow-up', file: 'coach_fees' },
  broker: { title: 'Broker · Saturday site visit', file: 'broker_3bhk' },
  studio: { title: 'Studio · Bookings and a Friday reminder', file: 'studio_friday' },
  agency: { title: 'Agency · White-label workspace', file: 'agency_whitelabel' },
};

export async function recordStory(browser, id, manifest, dir) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const caps = captions();
  let failed = null;
  try {
    await STORIES[id](page, caps, manifest[id]);
  } catch (e) {
    failed = e;
    caps.say('Recording stopped: ' + String(e.message || e).slice(0, 140));
    await page.screenshot({ path: dir + '/' + id + '-error.png' }).catch(() => {});
  }
  await hold(page, 800);
  const video = page.video();
  await context.close();
  const src = await video.path();
  if (failed) {
    const err = new Error(id + ' failed: ' + failed.message);
    err.src = src;
    err.captions = caps.items;
    throw err;
  }
  return { src, captions: caps.items };
}

async function clinicShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Anika tells the Chief of Staff the goal in plain English.', 1600);
  await askChief(page, 'Answer Saturday laser questions with the price, offer a slot, and wait for my approval.');
  await beat(page, caps, 'The local mock model marks this as a draft. A customer message still waits for Approve.', 3200);

  await widgetSay(page, acc.widget, 'Is Saturday free for laser?');
  await beat(page, caps, '10:47pm: “Is Saturday free for laser?” The widget uses the server clock, not 10:47. Nothing is sent yet.', 3400);

  await backToApp(page);
  await approve(page, 'Saturday is open');
  await beat(page, caps, 'She approves the price and the Saturday hours. The chat stays blank until the patient writes again.', 1800);

  await widgetNext(page, acc.widget, 'Please book a slot', /Saturday is open/);
  await beat(page, caps, 'The next message shows the approved price. The slot offer is a new draft. Saturday hours were set through the API. There is no day picker.', 3400);

  await backToApp(page);
  await approve(page, 'Here are open times');
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await beat(page, caps, 'Three Saturday times are in the thread. They take the first. The confirmation still needs approval.', 2800);

  await backToApp(page);
  await approve(page, 'Booked for');
  await beat(page, caps, 'The appointment is stored only when this confirmation is approved.', 1800);

  await backToApp(page);
  await goTab(page, 'Front desk');
  await page.locator('#fdPage').getByText(/mock-gcal/).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Confirmed appointment, plus a mock calendar id. Full auto is not available.', 3200);

  await goTab(page, 'Workflows');
  await page.locator('#wfText').pressSequentially('When a new lead comes in, whatsapp them and remind me the evening before', { delay: 12 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage .card').waitFor({ timeout: 20000 });
  await beat(page, caps, '“Evening before” is not a clock here. WhatsApp still needs approval. The reminder stays in the app and does not message the patient.', 7000);
}

async function coachShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Ravi’s goal goes to the Chief in his own Telegram chat.', 1200);
  await goTab(page, 'Inbox');
  await page.locator('#inbPage').waitFor();
  const hook = acc.telegram.webhook_url.replace(/^https?:\/\/[^/]+/, '');
  const body = JSON.stringify({
    update_id: Date.now() % 1000000000,
    message: {
      message_id: 11,
      from: { id: 424242, first_name: 'Ravi' },
      chat: { id: 424242, type: 'private' },
      text: 'Answer fee questions, qualify the lead, book a discovery call, and draft a follow-up if they go quiet. Wait for my approval.',
    },
  });
  await postRaw(hook, body, {
    'content-type': 'application/json',
    'x-telegram-bot-api-secret-token': acc.telegram.secret_token,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#wpIn').waitFor({ timeout: 20000 });
  await goTab(page, 'Inbox');
  const openTg = page.locator('#inbPage button[data-act="inbOpen"]').first();
  await openTg.scrollIntoViewIfNeeded();
  await openTg.click();
  await page.locator('#inbPage').getByText(/Here is a draft/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'Owner chat with the Chief. The mock line is delivered here. A customer reply still waits in Approvals.', 3800);

  await widgetSay(page, acc.widget, 'What are your fees?');
  await beat(page, caps, '“What are your fees?” The front desk drafts the discovery fee and the 6-week fee.', 2800);
  await backToApp(page);
  await approve(page, 'discovery call');
  await widgetNext(page, acc.widget, 'I want help with email. Budget 20000. Email meera.shah@example.com', /discovery call is ₹3,000/);
  await beat(page, caps, 'The fees appear only after approval. The built-in questions are ads, email, website, or a retainer. This note stores email, budget, and an example.com address.', 3400);
  await backToApp(page);
  await approve(page, 'Want me to offer');
  await widgetNext(page, acc.widget, 'book a call', /Want me to offer/);
  await beat(page, caps, 'Qualified. They ask for a call. Nothing is booked yet.', 2200);
  await backToApp(page);
  await approve(page, 'Here are open times');
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await beat(page, caps, 'Open times from the saved hours. The lead picks the first. The confirmation still needs approval.', 2400);
  await backToApp(page);
  await approve(page, 'Booked for');
  await beat(page, caps, 'Discovery call confirmed only after this approval.', 1600);

  await goTab(page, 'Workflows');
  await page.locator('#wfText').pressSequentially('When a new lead comes in, draft a follow-up email, and remind me in 3 days if no reply', { delay: 10 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage .card').waitFor({ timeout: 20000 });
  await beat(page, caps, 'A follow-up draft for a quiet lead, plus a reminder in 3 days if there is no reply.', 2800);
  await page.locator('[data-act="wfEnable"]').click();
  await page.locator('#toast').getByText(/Workflow on/i).waitFor({ timeout: 15000 });
  await api(acc.token, 'POST', '/api/leads', { name: 'Silent Lead', email: 'silent.lead@example.com', source: 'Website' });
  await api(null, 'GET', '/api/cron/tick', undefined, { authorization: 'Bearer ' + CRON });
  await approve(page, 'Following up', 1800);
  await beat(page, caps, 'The routine tick wrote “Email: Following up”. Approving that draft does not send it.', 3200);
}

async function brokerShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Meera asks the Chief to answer listing questions and book site visits.', 1400);
  await askChief(page, 'When someone asks if the 3BHK is free, answer from the listing and book a Saturday site visit. Wait for my approval.');
  await beat(page, caps, 'Plain-English goal. The mock reply stays a draft. The listing answer is a saved FAQ, not a property database.', 3400);

  await widgetSay(page, acc.widget, '3BHK still available?');
  await beat(page, caps, 'Saturday night: “3BHK still available?” The draft quotes Lakeview Residency. Nothing is sent.', 3000);
  await backToApp(page);
  await approve(page, 'Lakeview Residency');
  await widgetNext(page, acc.widget, 'Please book a slot', /Lakeview Residency/);
  await beat(page, caps, 'The next message shows the approved listing. The visit times are a new draft.', 2600);
  await backToApp(page);
  await approve(page, 'Here are open times');
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await beat(page, caps, 'Saturday-only hours, so the three times are Saturday site visits. The confirmation still needs approval.', 2600);
  await backToApp(page);
  await approve(page, 'Booked for');

  const leads = await api(acc.token, 'GET', '/api/leads?limit=100');
  const visitor = (leads.leads || []).find((l) => /website visitor/i.test(l.name || ''));
  if (!visitor) throw new Error('Web chat lead missing');
  await api(acc.token, 'PATCH', '/api/leads/' + visitor.id, { name: 'Ananya Rao' });
  await goTab(page, 'Contacts');
  const ananya = page.locator('#crmPage tr', { hasText: 'Ananya Rao' });
  await ananya.waitFor({ timeout: 20000 });
  await ananya.scrollIntoViewIfNeeded();
  await ananya.locator('button').click();
  await page.locator('#crmPage').getByText(/Call booked/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'CRM timeline for the site visit. The website chat does not ask for a name, so the owner set Ananya Rao on the contact.', 3800);

  await goTab(page, 'Suggestions');
  await page.locator('#cosPage').getByText(/Monday/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'Monday weekly suggestion, from this account’s own email opens. Apply saves a draft. It does not send.', 2800);
  await page.locator('[data-act="cosApply"]').click();
  await page.locator('#toast').getByText(/Nothing was sent|Draft saved/i).waitFor({ timeout: 15000 });
  await beat(page, caps, 'Applied. The reminder is a draft workflow. No email left the building.', 2800);
}

async function studioShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Kabir types the goal in Slack, to the Chief of Staff.', 1200);
  await goTab(page, 'Inbox');
  await page.locator('#inbPage').waitFor();
  const hook = acc.slack.webhook_url.replace(/^https?:\/\/[^/]+/, '');
  const raw = JSON.stringify({
    type: 'event_callback',
    team_id: acc.slack.team_id,
    event_id: 'Edemo' + Date.now(),
    event: {
      type: 'message', channel_type: 'im', user: 'U0OWNER1',
      text: 'Book the 6pm slot and the trial class, and hold every customer message for my approval.',
      channel: 'D0DEMO1', ts: String(Date.now() / 1000),
    },
  });
  await postRaw(hook, raw, slackHeaders(acc.signing_secret, raw));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#wpIn').waitFor({ timeout: 20000 });
  await goTab(page, 'Inbox');
  const openSl = page.locator('#inbPage button[data-act="inbOpen"]').first();
  await openSl.scrollIntoViewIfNeeded();
  await openSl.click();
  await page.locator('#inbPage').getByText(/Here is a draft/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'Slack DM with the Chief. The mock reply is in the owner’s own chat. Customer bookings still need Approve.', 3600);

  await widgetSay(page, acc.widget, 'Slot at 6?');
  await beat(page, caps, '“Slot at 6?” matches the word slot. Hours are 6:00–7:30, so the first time is 6:00. “At 6” is not read as a clock.', 3200);
  await backToApp(page);
  await approve(page, 'Here are open times');
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await beat(page, caps, 'The times show up on the next message. They pick 6:00. The confirmation still needs approval.', 2200);
  await backToApp(page);
  await approve(page, 'Booked for');
  await beat(page, caps, '6:00 is confirmed only after this approval.', 1400);

  await widgetSay(page, acc.widget, 'Trial class?', { fresh: true, token: acc.widgetToken });
  await beat(page, caps, 'A second guest asks “Trial class?” A saved answer offers a free first trial.', 2400);
  await backToApp(page);
  await approve(page, 'trial class');
  await widgetNext(page, acc.widget, 'book a slot', /first trial class is free/);
  await beat(page, caps, 'The approved trial answer is in the thread. Asking for a slot is a new draft.', 2200);
  await backToApp(page);
  await approve(page, 'Here are open times');
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await backToApp(page);
  await approve(page, 'Booked for');
  await beat(page, caps, 'Trial class booked the same way: draft, then one approval.', 1800);

  await goTab(page, 'Workflows');
  const box = page.locator('#wfText');
  await box.pressSequentially('Every Friday, remind people with bookings tomorrow', { delay: 14 });
  await page.locator('#wfNew button').click();
  await page.locator('#toast .toast').waitFor({ timeout: 15000 });
  await beat(page, caps, '“Every Friday” does not compile. The product asks for a new lead, a stage, a tag, or a schedule it knows.', 3200);
  await box.fill('');
  await box.pressSequentially('Every week, whatsapp them a reminder for people with bookings tomorrow', { delay: 12 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage .card').waitFor({ timeout: 20000 });
  await beat(page, caps, 'The working line is weekly. The WhatsApp stays on needs approval. “Bookings tomorrow” is not its own rule.', 4000);
}

async function agencyShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Nisha asks the Chief to set up a client workspace. Nothing here takes a payment.', 1400);
  await askChief(page, 'Add a client workspace, set our branding, and keep every client workflow as a draft until I approve it.');
  await beat(page, caps, 'The goal is plain English. Client mail is not sent from this screen.', 2800);

  await goTab(page, 'Agency');
  const harbour = page.locator('#agPage li', { hasText: 'Harbour Studio' }).first();
  await harbour.waitFor({ timeout: 20000 });
  await harbour.scrollIntoViewIfNeeded();
  await beat(page, caps, 'Harbour Studio is already a client. Its usage is from a sample lead, one AI call, and one approved chat reply.', 3200);

  const form = page.locator('#agClient');
  await form.scrollIntoViewIfNeeded();
  await form.locator('input[name="name"]').fill('Lakeview Homes');
  await form.locator('input[name="email"]').fill('studio@lakeview-homes.example');
  await form.locator('input[name="password"]').fill('Glow-atelier-123!');
  await beat(page, caps, 'A second client workspace. Creating it does not email anyone.', 1800);
  await form.getByRole('button', { name: 'Create client' }).click();
  await page.locator('#agPage li', { hasText: 'studio@lakeview-homes.example' }).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Lakeview Homes is on the list. No email was sent.', 2200);

  const brand = page.locator('#agBrand');
  await brand.scrollIntoViewIfNeeded();
  await brand.locator('input[name="color"]').fill('#1f6b4a');
  await brand.locator('input[name="accent"]').fill('#143d2c');
  await brand.locator('input[name="support_email"]').fill('hello@northandco.example');
  await brand.locator('input[name="domain"]').fill('app.northandco.example');
  await brand.locator('button').click();
  await page.locator('#toast').getByText(/Branding saved/i).waitFor({ timeout: 15000 });
  await beat(page, caps, 'Branding saved. The hostname does not change DNS or issue a certificate.', 2800);

  const mark = page.locator('#agMark');
  await mark.scrollIntoViewIfNeeded();
  await mark.locator('input[name="percent"]').fill('20');
  await mark.locator('input[name="message_inr"]').fill('2');
  await mark.locator('input[name="lead_inr"]').fill('40');
  await mark.locator('button').click();
  await page.locator('#toast').getByText(/Markup saved/i).waitFor({ timeout: 15000 });
  await beat(page, caps, '20% on AI cost, ₹2 a message, ₹40 a lead. The app does not take the payment.', 2600);

  const pb = page.locator('#agPb');
  await pb.scrollIntoViewIfNeeded();
  await pb.locator('select[name="email"]').selectOption('studio@lakeview-homes.example');
  await pb.locator('select[name="id"]').selectOption('pb_agency');
  await page.locator('#agPbPrev').click();
  await page.locator('#agPbNote').getByText(/Preview only/i).waitFor({ timeout: 15000 });
  await beat(page, caps, 'Playbook preview for the new client. Nothing is installed yet.', 2200);
  const installed = page.waitForResponse((r) => r.url().includes('/api/agency/playbook') && r.request().method() === 'POST');
  await pb.locator('button.btn.dk').click();
  const installRes = await installed;
  if (!installRes.ok()) throw new Error('Playbook install ' + installRes.status());
  await page.locator('#agPage li', { hasText: 'studio@lakeview-homes.example' }).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Installed as drafts. The page reloads after install, so the proof is inside the client workspace.', 1800);

  await page.locator('[data-act="agView"][data-em="studio@lakeview-homes.example"]').click();
  await page.locator('#imp').getByText(/read only/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'View as Lakeview Homes. The bar says read only. This session cannot send.', 1800);
  await goTab(page, 'Workflows');
  await page.locator('#wfPage').getByText('New enquiry welcome').waitFor({ timeout: 20000 });
  await page.locator('#wfPage').getByText('draft').first().waitFor();
  await beat(page, caps, 'Agency client intake is in as drafts. View-as cannot turn them on.', 2800);
  await goTab(page, 'Agency');
  await page.locator('#agPage').getByText(/View-as is read only/i).waitFor({ timeout: 15000 });
  await beat(page, caps, 'The agency page refuses edits while view-as is on.', 1800);
  await page.locator('[data-a="stopImp"]').click();
  await page.locator('#agClient').waitFor({ timeout: 20000 });

  await page.locator('#agHtml').scrollIntoViewIfNeeded();
  await beat(page, caps, 'The printable usage summary, with the markup on Harbour’s sample activity. Not a tax invoice.', 1600);
  const html = await page.evaluate(async () => {
    const r = await fetch('/api/agency/invoice.html', { headers: { Authorization: 'Bearer ' + localStorage.getItem('as_tok') } });
    if (!r.ok) throw new Error('summary ' + r.status);
    return r.text();
  });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const text = (el) => (el ? el.textContent.trim() : '');
    const heads = [...document.querySelectorAll('thead th')].map((th) => text(th));
    const rows = [...document.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => text(td)));
    const title = text(document.querySelector('h1')) || 'Usage summary';
    const intro = text(document.querySelector('p'));
    const note = text(document.querySelector('.note'));
    const cards = rows.filter((r) => r.length > 2).map((r) => {
      const pick = (name) => r[heads.indexOf(name)] || '';
      return `<section style="border:1px solid #ccc;border-radius:16px;padding:22px 26px;margin:18px 0">
        <div style="font-size:40px;font-weight:700">${r[0] || ''}</div>
        <div style="font-size:28px;color:#333;margin:4px 0 14px">${r[1] || ''}</div>
        <div style="font-size:32px">AI billed ${pick('AI billed USD') || r[4] || ''} USD · Messages ${pick('Messages billed INR') || r[6] || ''} INR · Leads ${pick('Leads billed INR') || r[8] || ''} INR</div>
      </section>`;
    }).join('');
    document.body.innerHTML = `<h1 style="font-size:64px;margin:0 0 12px">${title}</h1><p style="font-size:32px;margin:0 0 8px">${intro}</p>${cards}<p style="font-size:28px;margin-top:18px">${note}</p>`;
    document.body.style.cssText = 'font:32px/1.4 system-ui,sans-serif;color:#111;margin:48px;background:#fff';
  });
  await beat(page, caps, 'Same numbers as the printable page, set larger for the camera. USD and INR stay apart. No payment is taken.', 4200);
}
