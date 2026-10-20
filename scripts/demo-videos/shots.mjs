// Playwright walkthroughs. Each one stays on screens the product already has.
import { captions, beat, hold, openApp, askChief, goTab, approve, widgetSay, widgetNext, backToApp, frameWidget, api, postRaw, slackHeaders, CRON, BASE } from './lib.mjs';

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
  await beat(page, caps, 'Anika tells the Chief of Staff the goal in plain English.', 900);
  await askChief(page, 'Answer Saturday laser questions with the price, offer a slot, and wait for my approval.');
  await beat(page, caps, 'The Chief answers in a sentence. A customer message still waits for Approve.', 2600);

  await goTab(page, 'Front desk');
  const sat = page.locator('#fdAv input[name="open"][value="6"]');
  await sat.waitFor({ timeout: 20000 });
  await page.locator('#fdAv .fd-days').scrollIntoViewIfNeeded();
  if (await page.locator('#fdAv input[aria-label="Mon start"]').inputValue() !== '10:00') throw new Error('Monday hours missing');
  if (await page.locator('#fdAv input[aria-label="Sat start"]').inputValue() !== '11:00') throw new Error('Saturday hours missing');
  if (await page.locator('#fdAv input[name="open"][value="2"]').isChecked()) throw new Error('Tuesday should be closed');
  await page.locator('#fdAv input[aria-label="Sat start"]').scrollIntoViewIfNeeded();
  await beat(page, caps, 'Each weekday has its own hours. Monday is 10:00 to 12:00. Saturday is 11:00 to 13:00. Tuesday is closed.', 3600);

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => localStorage.setItem(key, 'clinicclock1'), 'aidc-' + acc.widgetToken);
  await page.goto(acc.widget, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  await page.getByText('10:47pm').waitFor({ timeout: 20000 });
  await beat(page, caps, '10:47pm is this message’s own time in the studio timezone. Nothing has been sent.', 3200);

  await widgetSay(page, acc.widget, 'Is Saturday free for laser?');
  await beat(page, caps, 'She asks again. The reply is drafted. The 10:47pm line stays in this visitor’s history.', 2600);

  await backToApp(page);
  await approve(page, 'Saturday is open', 1200);
  await page.goto(acc.widget, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  await page.getByText(/₹4,500|Saturday is open/).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Reopening the chat shows the approved price and Saturday hours. Drafts stay hidden until Approve.', 2800);

  await widgetNext(page, acc.widget, 'book 1', /Saturday is open|₹4,500/);
  await beat(page, caps, 'They take the first Saturday time. The confirmation is a second draft.', 1400);
  await backToApp(page);
  await approve(page, 'Booked for', 800);
  await beat(page, caps, 'The appointment is stored only when this confirmation is approved.', 1200);

  await goTab(page, 'Workflows');
  await page.locator('#wfText').pressSequentially('When a new lead comes in, whatsapp them and remind me the evening before', { delay: 8 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage').getByText(/evening before/i).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Evening before is 18:00 the day before the visit. The reminder stays a draft until she approves it.', 3200);
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
  await page.locator('#inbPage').getByText(/draft|approval/i).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Owner chat on Telegram. The Chief answers in a sentence. A customer reply still waits for Approve.', 2200);

  await goTab(page, 'Front desk');
  const qualify = page.locator('select[name="qualify_set"]');
  await qualify.waitFor({ timeout: 20000 });
  await qualify.scrollIntoViewIfNeeded();
  await qualify.selectOption('coach');
  const savedSet = page.waitForResponse((r) => r.url().includes('/api/frontdesk') && r.request().method() === 'POST');
  await page.locator('#fdSet button').click();
  const setRes = await savedSet;
  if (!setRes.ok()) throw new Error('Qualify save failed');
  await page.locator('select[name="qualify_set"]').waitFor({ timeout: 15000 });
  if (await page.locator('select[name="qualify_set"]').inputValue() !== 'coach') throw new Error('Coach qualify set did not save');
  await beat(page, caps, 'Qualify questions are set to Coach / consultant: the offer, the pipeline, or how they close clients.', 1800);

  await widgetSay(page, acc.widget, 'What are your fees?');
  await beat(page, caps, '“What are your fees?” The front desk drafts the discovery fee and the 6-week fee.', 1600);
  await backToApp(page);
  await approve(page, 'discovery call', 800);
  await widgetNext(page, acc.widget, 'Hello', /discovery call is ₹3,000/);
  await beat(page, caps, 'The fee appears only after approval. Hello is a new draft.', 1200);
  await backToApp(page);
  await approve(page, 'pipeline', 1400);
  await page.goto(acc.widget, { waitUntil: 'domcontentloaded' });
  await frameWidget(page);
  await page.getByText(/pipeline|close clients/).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'The coach question asks about the offer, the pipeline, or closing clients. Not ads, email, or a retainer.', 2000);

  await widgetNext(page, acc.widget, 'I want help with email. Budget 20000. Email meera.shah@example.com', /pipeline|close clients/);
  await beat(page, caps, 'Interest, budget, and the example.com address are stored on the lead.', 1400);
  await backToApp(page);
  await approve(page, 'Want me to offer', 700);
  await widgetNext(page, acc.widget, 'book a call', /Want me to offer/);
  await beat(page, caps, 'They ask for a call. Nothing is booked yet.', 1000);
  await backToApp(page);
  await approve(page, 'Here are open times', 700);
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await backToApp(page);
  await approve(page, 'Booked for', 700);
  await beat(page, caps, 'Discovery call confirmed only after this approval.', 1000);

  await goTab(page, 'Workflows');
  await page.locator('#wfText').pressSequentially('When a new lead comes in, draft a follow-up email, and remind me in 3 days if no reply', { delay: 6 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage').getByText(/Following up|no reply|3 day/i).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'A follow-up draft for a quiet lead, plus a reminder in 3 days if there is no reply.', 1400);
  await page.locator('[data-act="wfEnable"]').click();
  await page.locator('#toast').getByText(/Workflow on/i).waitFor({ timeout: 15000 });
  await api(acc.token, 'POST', '/api/leads', { name: 'Silent Lead', email: 'silent.lead@example.com', source: 'Website' });
  await api(null, 'GET', '/api/cron/tick', undefined, { authorization: 'Bearer ' + CRON });
  await approve(page, 'Following up', 1000);
  await beat(page, caps, 'The routine tick wrote “Email: Following up”. Approving that draft does not send it.', 1800);
}

async function brokerShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Meera asks the Chief to answer listing questions and book site visits.', 1400);
  await askChief(page, 'When someone asks if the 3BHK is free, answer from the listing and book a Saturday site visit. Wait for my approval.');
  await beat(page, caps, 'Plain-English goal. The listing answer comes from this account’s catalogue, and it waits for Approve.', 1600);

  await goTab(page, 'Front desk');
  const row = page.locator('#fdList form[data-id] input[name="title"]');
  await row.waitFor({ timeout: 20000 });
  await row.scrollIntoViewIfNeeded();
  if (await row.inputValue() !== 'Lakeview Residency') throw new Error('Listing row missing');
  await beat(page, caps, 'Lakeview Residency, 3BHK, Pune, ₹1.15 crore, available. The chat reads this row.', 1800);

  await widgetSay(page, acc.widget, '3BHK still available?');
  await beat(page, caps, '“3BHK still available?” The draft quotes the listing and asks for a name. Nothing is sent.', 1800);
  await backToApp(page);
  await approve(page, 'Lakeview Residency', 900);
  await widgetNext(page, acc.widget, 'My name is Priya Shah. Phone 9845011122. Email priya.shah@example.com', /your name/i);
  await beat(page, caps, 'The approved reply asks for a name. Phone or email is optional. Priya sends all three.', 1800);
  await backToApp(page);
  await approve(page, 'Thanks, Priya', 700);
  await widgetNext(page, acc.widget, 'Please book a Saturday site visit', /Thanks, Priya/);
  await beat(page, caps, 'Saturday site-visit times are a new draft. Saturday hours are 11:00 to 13:00.', 1400);
  await backToApp(page);
  await approve(page, 'Here are open times', 700);
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await backToApp(page);
  await approve(page, 'Booked for', 700);

  await goTab(page, 'Contacts');
  const priya = page.locator('#crmPage tr', { hasText: 'Priya Shah' });
  await priya.waitFor({ timeout: 20000 });
  await priya.scrollIntoViewIfNeeded();
  await priya.locator('button').click();
  await page.locator('#crmPage').getByText(/Call booked/i).waitFor({ timeout: 20000 });
  await page.locator('#crmPage').getByText('priya.shah@example.com').first().waitFor({ timeout: 10000 });
  await beat(page, caps, 'Priya Shah is saved from the chat, with the phone and email. The timeline shows the site visit.', 2200);

  await goTab(page, 'Suggestions');
  await page.locator('#cosPage').getByText(/Monday/i).waitFor({ timeout: 20000 });
  await beat(page, caps, 'Monday suggestion, from this account’s own email opens. Apply saves a draft. It does not send.', 1400);
  await page.locator('[data-act="cosApply"]').click();
  await page.locator('#toast').getByText(/Nothing was sent|Draft saved/i).waitFor({ timeout: 15000 });
  await beat(page, caps, 'Applied. The reminder is a draft workflow. No email left the building.', 1400);
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
  await page.locator('#inbPage').getByText(/draft|approval/i).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Owner chat in Slack. The Chief answers in a sentence. Customer bookings still need Approve.', 2000);

  await widgetSay(page, acc.widget, 'Slot at 6?');
  await beat(page, caps, '“Slot at 6?” is 18:00. The day also opens at 10:00, so 18:00 is the clock in the question.', 1800);
  await backToApp(page);
  await approve(page, '18:00', 1000);
  await widgetNext(page, acc.widget, 'book 1', /18:00/);
  await beat(page, caps, 'The times show up after approval. They pick 18:00. The confirmation still needs approval.', 1400);
  await backToApp(page);
  await approve(page, 'Booked for', 700);
  await beat(page, caps, '18:00 is confirmed only after this approval.', 1000);

  await widgetSay(page, acc.widget, 'Trial class?', { fresh: true, token: acc.widgetToken });
  await beat(page, caps, 'A second guest asks “Trial class?” The saved answer offers a free first trial.', 1400);
  await backToApp(page);
  await approve(page, 'trial class', 700);
  await widgetNext(page, acc.widget, 'book a slot', /first trial class is free/);
  await beat(page, caps, 'The approved trial answer is in the thread. Asking for a slot is a new draft.', 1200);
  await backToApp(page);
  await approve(page, 'Here are open times', 700);
  await widgetNext(page, acc.widget, 'book 1', /Here are open times/);
  await backToApp(page);
  await approve(page, 'Booked for', 700);
  await beat(page, caps, 'The trial visit is booked only after its own approval.', 1000);

  await goTab(page, 'Workflows');
  const box = page.locator('#wfText');
  await box.pressSequentially('Every Friday, remind people with bookings tomorrow', { delay: 8 });
  await page.locator('#wfNew button').click();
  await page.locator('#wfPage').getByText(/Every Friday/i).first().waitFor({ timeout: 20000 });
  await page.locator('#wfPage').getByText(/needs your approval/i).first().waitFor({ timeout: 20000 });
  await beat(page, caps, 'Every Friday at 09:00. WhatsApp people with a booking tomorrow. The step needs approval, and the workflow is off.', 2200);
  await page.locator('[data-act="wfBack"]').click();
  await page.locator('#wfText').waitFor({ timeout: 15000 });
  await page.locator('#wfText').fill('Every fortnight, remind people with bookings tomorrow');
  await page.locator('#wfNew button').click();
  await page.locator('#toast').getByText(/every day, every weekday, or one weekday/i).waitFor({ timeout: 15000 });
  await beat(page, caps, '“Every fortnight” is refused. The note lists the schedules the Chief can save. No fortnight workflow is created.', 2200);
}

async function agencyShot(page, caps, acc) {
  await openApp(page, acc);
  await beat(page, caps, 'Nisha asks the Chief to set up a client workspace. Nothing here takes a payment.', 800);
  await askChief(page, 'Add a client workspace, set our branding, and keep every client workflow as a draft until I approve it.');
  await beat(page, caps, 'The goal is plain English. Creating a client does not send email, and a hostname does not change DNS.', 1600);

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
