# Local demo videos

Five social walkthroughs of AIdentify, recorded against a local server. The videos are not committed. This folder is the recorder.

The server is started with `AI_PROVIDER=mock`, `AI_MOCK=on`, and `CHANNELS_MOCK=on`, and a fresh data directory under `/tmp`. Nothing here talks to a hosted demo, a real inbox, or a real phone number. Every email is on `.example` or `example.com`.

```bash
node scripts/demo-videos/run.mjs
ONLY=clinic node scripts/demo-videos/run.mjs
```

`ONLY` is a comma list: `clinic`, `coach`, `broker`, `studio`, `agency`. `ONLY=seed` stops after the fake accounts exist.

Finished files are written to `/opt/cursor/artifacts/` (override with `DEMO_ARTIFACTS`):

- `clinic_laser_16x9.mp4` and `clinic_laser_9x16.mp4`
- `coach_fees_16x9.mp4` and `coach_fees_9x16.mp4`
- `broker_3bhk_16x9.mp4` and `broker_3bhk_9x16.mp4`
- `studio_friday_16x9.mp4` and `studio_friday_9x16.mp4`
- `agency_whitelabel_16x9.mp4` and `agency_whitelabel_9x16.mp4`

Each file is a 3.5s title card plus the walkthrough, with burned-in captions, silent stereo audio, 60–90 seconds. The 9:16 cut scales the full 16:9 frame into a 1080×1920 canvas and redraws the captions larger underneath. It is not a centre crop.

Playwright records at 1920×1080. The website-chat page is only a short title and a small box in the corner, so the recorder centres and enlarges that box in the page for the camera. The usage summary is the real HTML from `GET /api/agency/invoice.html`; the recorder restacks those same figures in larger type so they survive the vertical frame. Neither change is in the product.

## What the product actually does

These beats are what a recording can show today. `docs/demo-scripts-check.md` is the PASS/FAIL list from `test/demo-stories.test.mjs`. Do not record a video until that file is current.

- **Saturday hours.** Front desk has a checkbox and times for each weekday. The form sends `by_day`. Saturday-only hours, and a different Monday window, are used for the reply and the slots.
- **“Is Saturday free for laser?”** returns the saved price and that day’s hours, and offers Saturday times in the same draft. Nothing is sent until Approve.
- **Website chat history.** Opening the chat loads this visitor’s earlier messages, including replies that were approved. Another visitor’s thread stays empty. Drafts stay hidden until Approve.
- **10:47pm** is the message’s own time in the account timezone. `DEMO_SEED=1` lets the owner store one website-chat line at a chosen `at`. The public widget ignores `createdAt`.
- **Chief replies** on this mock server are canned sentences for the message, not a `[mock …]` line. The mock does not call a model. Customer sends still sit in Approvals until Approve. An owner’s own Telegram or Slack chat is delivered, because that chat is the owner talking to the Chief.
- **Approve on a channel reply.** The button sends `edit: {}`. An empty edit is ignored, and the reply is sent only after Approve.
- **“Evening before”** is 18:00 on the day before the appointment (or the time named in the sentence). The reminder is drafted when a tick reaches that time. It stays in Approvals.
- **“Every Friday, remind people with bookings tomorrow”** told to the Chief saves a weekly draft. Turning it on and ticking that time drafts one reminder per booking tomorrow. The WhatsApp stays on needs approval. “Every fortnight” is refused with a clear error.
- **“Slot at 6?”** is read as 18:00. With hours 10:00–19:30, the offer is 18:00 rather than the first opening of the day.
- **3BHK.** The answer comes from this account’s listings (title, type, location, price, status, notes), including a CSV import. It is not a saved FAQ.
- **Qualify.** Questions follow the business type: coach or consultant, clinic, real estate, salon or gym, and agency. The seeded coach uses the coach set. Front desk can pick another set, or replace the lines. A fee answer does not also qualify.
- **Website chat names.** The chat asks for a name. A phone or email is optional, and “My name is …” is saved on the lead. The broker shot still sets Ananya Rao on the contact before the timeline, after that ask.
- **Monday suggestion.** It appears after a weekly review of this account’s own email opens (four Monday sends opened, four mid-week sends not opened). Apply saves a draft. It does not send.
- **Silent-lead follow-up.** Creating the lead only queues the workflow. The draft appears in Approvals after the routine tick (`GET /api/cron/tick`). The row is titled “Email: Following up”, and approving a draft does not send it.
- **Agency.** A client is created without an email. Branding a hostname does not change DNS. Playbooks install as drafts. View-as is read only for about two hours. The usage page is a summary with markup, not a tax invoice and not a payment.
